import BaseContext from '../../context/base-context';
import { HttpException } from '../../exceptions/http-exception';
import { encryptSecret, decryptSecret, isEncryptionConfigured } from '../../helpers/crypto.helper';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SecretSummary {
  id: string;
  name: string;
  preview: string;
  updatedAt: Date;
}

export class SecretsService extends BaseContext {
  /** Names + a masked preview. Raw values are never returned to the client. */
  async list(): Promise<SecretSummary[]> {
    const rows = await this.delegate().findMany({ orderBy: { name: 'asc' } });
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      preview: this.preview(row.value),
      updatedAt: row.updatedAt,
    }));
  }

  async set(name: string, value: string): Promise<SecretSummary> {
    const clean = String(name ?? '').trim();
    if (!NAME_RE.test(clean)) {
      throw new HttpException('Secret name must match [A-Za-z_][A-Za-z0-9_]*', 400);
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new HttpException('Secret value is required', 400);
    }
    if (!isEncryptionConfigured()) {
      throw new HttpException('CONFIG_ENCRYPTION_KEY is not set. Set a 32-byte base64 key to store secrets.', 500);
    }

    const encrypted = encryptSecret(value);
    const row = await this.delegate().upsert({
      where: { name: clean },
      create: { name: clean, value: encrypted },
      update: { value: encrypted },
    });
    return { id: row.id, name: row.name, preview: this.preview(row.value), updatedAt: row.updatedAt };
  }

  async delete(name: string): Promise<void> {
    const clean = String(name ?? '').trim();
    if (!clean) throw new HttpException('Secret name is required', 400);
    await this.delegate().deleteMany({ where: { name: clean } });
  }

  /** Decrypted name→value map for injecting into the edge-function sandbox. */
  async resolve(): Promise<Record<string, string>> {
    if (!isEncryptionConfigured()) return {};
    const rows = await this.delegate().findMany();
    const out: Record<string, string> = {};
    for (const row of rows) {
      try {
        out[row.name] = decryptSecret(row.value);
      } catch {
        // Skip secrets we cannot decrypt (e.g. key rotated) rather than failing the whole invoke.
      }
    }
    return out;
  }

  private preview(_encrypted: string): string {
    // Values are stored encrypted; we deliberately do not expose any plaintext bytes.
    return '••••••••';
  }

  private delegate() {
    const delegate = this.di.prisma.edgeFunctionSecret;
    if (!delegate) throw new HttpException('EdgeFunctionSecret delegate is unavailable. Run prisma generate.', 500);
    return delegate;
  }
}
