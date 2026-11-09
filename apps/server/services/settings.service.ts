import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import BaseContext from '../context/base-context';
import { getGroup, SECRET_SENTINEL, type FieldDef } from '../config/settings';
import { emailDeliveryMissing, emailFeaturesEnabledBy } from '../config/settings/email-dependencies';
import { encryptSecret, decryptSecret, isEncryptionConfigured } from '../helpers/crypto.helper';
import { HttpException } from '../exceptions/http-exception';

interface MaskedSettings {
  group: string;
  label: string;
  description?: string;
  source: 'db' | 'env';
  fields: FieldDef[];
  values: Record<string, unknown>;
}

export class SettingsService extends BaseContext {
  private cache = new Map<string, Record<string, unknown>>();

  /** Returns the id only if it belongs to a real User row, else null (avoids FK violation). */
  private async resolveUserId(userId?: string): Promise<string | null> {
    if (!userId) return null;
    const user = await this.di.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    return user ? user.id : null;
  }

  private group(key: string) {
    const g = getGroup(key);
    if (!g) throw new HttpException(`Unknown settings group: ${key}`, 404);
    return g;
  }

  /**
   * Walk each entry of a json field value, applying fn to every secretKeys prop.
   * Clones first: the caller's argument is often a row out of `this.cache`, and
   * rewriting it in place would leave decrypted or masked secrets in the cache.
   */
  private mapJsonSecrets(input: unknown, secretKeys: string[], fn: (v: unknown) => unknown): unknown {
    if (!input || typeof input !== 'object') return input;
    const value = structuredClone(input);
    const entries = Array.isArray(value) ? value : Object.values(value);
    for (const entry of entries) {
      if (entry && typeof entry === 'object') {
        for (const sk of secretKeys) {
          if (sk in (entry as any)) (entry as any)[sk] = fn((entry as any)[sk]);
        }
      }
    }
    return value;
  }

  /** Raw (still-encrypted) stored value object for a group, or {}. */
  private async rawStored(key: string): Promise<Record<string, any>> {
    const row = await this.di.prisma.appSetting.findUnique({ where: { key } });
    return (row?.value as Record<string, any>) ?? {};
  }

  async source(key: string): Promise<'db' | 'env'> {
    this.group(key);
    const row = await this.di.prisma.appSetting.findUnique({ where: { key } });
    return row ? 'db' : 'env';
  }

  /** Fully decrypted, typed payload for server-side use. Cached per group. */
  async get<T = Record<string, unknown>>(key: string): Promise<T> {
    const cached = this.cache.get(key);
    if (cached) return cached as T;
    const g = this.group(key);
    const row = await this.di.prisma.appSetting.findUnique({ where: { key } });
    const secretKeys = new Set(g.fields.filter(f => f.secret).map(f => f.key));
    let resolved: Record<string, unknown>;
    if (row) {
      const stored = (row.value as Record<string, unknown>) || {};
      // A field added to a group AFTER this row was written is absent from it,
      // so seed the absent keys from the env fallback. Anything the row does
      // carry still wins, which is what makes clearing a value from Studio work.
      const fallback = g.envFallback();
      resolved = { ...stored };
      for (const [fallbackKey, fallbackValue] of Object.entries(fallback)) {
        if (!(fallbackKey in stored)) resolved[fallbackKey] = fallbackValue;
      }
      for (const sk of secretKeys) {
        // Only decrypt what the row actually stores. A secret the row does not
        // carry keeps the fallback's plaintext env value; a secret the operator
        // cleared IS stored (as ''), so clearing is still honoured.
        if (!(sk in stored)) continue;
        const v = stored[sk];
        resolved[sk] = typeof v === 'string' && v ? decryptSecret(v) : '';
      }
    } else {
      resolved = { ...g.envFallback() };
    }
    for (const f of g.fields) {
      if (f.type === 'json' && f.secretKeys?.length) {
        // Clone so decrypting never mutates the stored row's value in place.
        resolved[f.key] = this.mapJsonSecrets(resolved[f.key] ?? null, f.secretKeys, v =>
          typeof v === 'string' && v ? decryptSecret(v) : '');
      }
    }
    for (const f of g.fields) {
      if (resolved[f.key] === undefined && f.default !== undefined) resolved[f.key] = f.default;
    }
    this.cache.set(key, resolved);
    return resolved as T;
  }

  /** API-facing view: secrets masked, field defs + source attached. */
  async getMasked(key: string): Promise<MaskedSettings> {
    const g = this.group(key);
    const values = { ...(await this.get<Record<string, unknown>>(key)) };
    for (const f of g.fields) {
      if (f.secret) values[f.key] = values[f.key] ? SECRET_SENTINEL : '';
      if (f.type === 'json' && f.secretKeys?.length) {
        values[f.key] = this.mapJsonSecrets(values[f.key], f.secretKeys, v =>
          v ? SECRET_SENTINEL : '');
      }
    }
    return { group: g.key, label: g.label, description: g.description, source: await this.source(key), fields: g.fields, values };
  }

  /** Validate + persist. Sentinel secret ⇒ keep stored; new secret ⇒ encrypt. */
  async set(key: string, input: Record<string, unknown>, userId?: string) {
    const g = this.group(key);
    const current = await this.get<Record<string, unknown>>(key);
    const merged: Record<string, unknown> = { ...input };
    for (const f of g.fields.filter(x => x.secret)) {
      if (input[f.key] === SECRET_SENTINEL || input[f.key] === undefined) merged[f.key] = current[f.key] ?? '';
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = g.schema.parse(merged) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ZodError) {
        const detail = err.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
        throw new HttpException(`Invalid ${g.label} settings, ${detail}`, 400);
      }
      throw err;
    }
    // An auth feature that emails its users is unusable without a transport:
    // turning it on with no SMTP produces sign-ups that never receive their
    // link. Refuse the change and name the group to configure first.
    const enabling = emailFeaturesEnabledBy(key, parsed, current);
    if (enabling.length) {
      const missing = emailDeliveryMissing(
        await this.get<Record<string, unknown>>('email.smtp'),
        await this.get<Record<string, unknown>>('auth.hooks.send'),
      );
      if (missing.length) {
        throw new HttpException(
          `Email delivery is not configured (missing ${missing.join(', ')}). ` +
            `Set up Email · SMTP first, then enable: ${enabling.join(', ')}.`,
          400,
        );
      }
    }

    const toStore: Record<string, unknown> = { ...parsed };
    for (const f of g.fields.filter(x => x.secret)) {
      const v = parsed[f.key];
      if (typeof v === 'string' && v) {
        if (!isEncryptionConfigured())
          throw new HttpException('Set CONFIG_ENCRYPTION_KEY to store secret settings.', 400);
        toStore[f.key] = encryptSecret(v);
      } else {
        toStore[f.key] = '';
      }
    }
    // json fields: encrypt each entry's secretKeys; a sentinel/blank keeps the
    // currently stored ciphertext (paired to the old entry by its key/providerId).
    const jsonFields = g.fields.filter(x => x.type === 'json' && x.secretKeys?.length);
    if (jsonFields.length) {
      const stored = await this.rawStored(key);
      for (const f of jsonFields) {
        const incoming = parsed[f.key];
        const prev = stored[f.key];
        const prevByKey = (entryKey: string) =>
          Array.isArray(prev)
            ? (prev as any[]).find(e => e?.providerId === entryKey)
            : (prev as any)?.[entryKey];
        const walk = (entryKey: string, entry: any) => {
          if (!entry || typeof entry !== 'object') return;
          for (const sk of f.secretKeys!) {
            const val = entry[sk];
            if (val === SECRET_SENTINEL || val === undefined || val === '') {
              entry[sk] = prevByKey(entryKey)?.[sk] ?? '';
            } else {
              if (!isEncryptionConfigured())
                throw new HttpException('Set CONFIG_ENCRYPTION_KEY to store secret settings.', 400);
              entry[sk] = encryptSecret(String(val));
            }
          }
        };
        if (Array.isArray(incoming)) incoming.forEach(e => walk(e?.providerId, e));
        else if (incoming && typeof incoming === 'object')
          for (const [k, e] of Object.entries(incoming)) walk(k, e);
        toStore[f.key] = incoming;
      }
    }
    const value = toStore as Prisma.InputJsonObject;
    // updatedById is a FK to User. The Console proxy authenticates as a synthetic
    // platform admin (id 'platform') that has no User row, and a stale JWT could
    // also carry a now-deleted id: either would trip app_settings_updatedById_fkey.
    // Only attribute the change when the id maps to a real user; otherwise store null.
    const updatedById = await this.resolveUserId(userId);
    await this.di.prisma.appSetting.upsert({
      where: { key },
      create: { key, value, updatedById },
      update: { value, updatedById },
    });
    this.cache.delete(key);
    return this.getMasked(key);
  }

  /** Remove the persisted override so the group resolves from its environment fallback. */
  async reset(key: string, _userId?: string): Promise<MaskedSettings> {
    this.group(key);
    await this.di.prisma.appSetting.deleteMany({ where: { key } });
    this.cache.delete(key);
    return this.getMasked(key);
  }
}
