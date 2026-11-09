import { useState, type ReactNode } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { ListInput } from '@/shared/ui/ListInput';
import type { CreateBucketInput, StorageBucket } from '@/features/storage/components/storage.types';
import { Field } from '@/shared/ui/Field';

interface Props {
  saving: boolean;
  existingSlugs?: string[];
  /** The bucket being edited. Absent means "create a new one". */
  initial?: StorageBucket | null;
  /** Shown above the footer, e.g. a partial-failure summary from the settings editor. */
  notice?: ReactNode;
  onClose: () => void;
  onCreate: (data: CreateBucketInput) => void;
}

type ByteUnit = 'MB' | 'GB';
const UNIT_BYTES: Record<ByteUnit, number> = { MB: 1024 ** 2, GB: 1024 ** 3 };
const MIME_RE = /^[a-z0-9.+-]+\/(\*|[a-z0-9.+-]+)$/i;

/** A stored byte count as the value + unit pair the form edits. */
function toUnits(bytes: number | null | undefined, fallback: string): { value: string; unit: ByteUnit } {
  if (!bytes) return { value: fallback, unit: 'MB' };
  return bytes % UNIT_BYTES.GB === 0
    ? { value: String(bytes / UNIT_BYTES.GB), unit: 'GB' }
    : { value: String(Math.round(bytes / UNIT_BYTES.MB)), unit: 'MB' };
}

/** The checkbox + amount + unit trio, shared by the quota and the file size limit. */
function ByteLimitField({
  label, enabled, onEnabledChange, value, onValueChange, unit, onUnitChange, error,
}: {
  label: string;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  value: string;
  onValueChange: (next: string) => void;
  unit: ByteUnit;
  onUnitChange: (next: ByteUnit) => void;
  error: boolean;
}) {
  return (
    <div>
      <label className="flex items-center gap-2 text-[12px] cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => onEnabledChange(e.target.checked)}
          className="accent-current"
        />
        {label}
      </label>
      {enabled && (
        <div className="mt-2 flex gap-2">
          <input
            type="number"
            min="1"
            max={QUOTA_MAX}
            step="1"
            value={value}
            onChange={e => onValueChange(e.target.value)}
            className="input w-28 tabular-nums"
          />
          <div className="flex overflow-hidden border hairline-strong" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
            {(['MB', 'GB'] as const).map(u => (
              <button
                key={u}
                type="button"
                onClick={() => onUnitChange(u)}
                className="px-3 py-1.5 text-[11px]"
                style={{
                  background: unit === u ? 'var(--hover)' : 'transparent',
                  color: unit === u ? 'var(--text)' : 'var(--text-mute)',
                }}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      )}
      {error && (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
          Enter a whole number between 1 and {QUOTA_MAX.toLocaleString()} {unit}
        </p>
      )}
    </div>
  );
}

function limitError(enabled: boolean, value: string): boolean {
  const n = Number(value);
  return enabled && (value.trim() === '' || !Number.isInteger(n) || n < 1 || n > QUOTA_MAX);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;
const QUOTA_MAX = 1_000_000; // per unit, guards against overflow garbage

// Best-effort slug from a free-text name: lowercase, strip accents, collapse
// non-alphanumerics to single hyphens, trim leading/trailing hyphens.
function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/** Create a bucket, or edit one when `initial` is given (the slug is then fixed). */
export function NewBucketModal({ saving, existingSlugs = [], initial, notice, onClose, onCreate }: Props) {
  const editing = Boolean(initial);
  const initialQuota = toUnits(initial?.quotaBytes, '500');
  const initialFileLimit = toUnits(initial?.fileSizeLimit, '50');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(editing);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [visibility, setVisibility] = useState<'public' | 'private'>(initial?.visibility ?? 'private');
  const [quotaEnabled, setQuotaEnabled] = useState(Boolean(initial?.quotaBytes));
  const [quotaValue, setQuotaValue] = useState(initialQuota.value);
  const [quotaUnit, setQuotaUnit] = useState<ByteUnit>(initialQuota.unit);
  const [fileLimitEnabled, setFileLimitEnabled] = useState(Boolean(initial?.fileSizeLimit));
  const [fileLimitValue, setFileLimitValue] = useState(initialFileLimit.value);
  const [fileLimitUnit, setFileLimitUnit] = useState<ByteUnit>(initialFileLimit.unit);
  const [mimeTypes, setMimeTypes] = useState<string[]>(initial?.allowedMimeTypes ?? []);

  const slugValid = SLUG_RE.test(slug);
  const slugFormatError = slug.length > 0 && !slugValid;
  const slugDuplicate = !editing && slugValid && existingSlugs.includes(slug);

  const nameTrimmed = name.trim();
  const nameError = name.length > 0 && nameTrimmed.length === 0;
  const nameTooLong = nameTrimmed.length > NAME_MAX;
  const descriptionTooLong = description.trim().length > DESCRIPTION_MAX;

  const quotaError = limitError(quotaEnabled, quotaValue);
  const fileLimitError = limitError(fileLimitEnabled, fileLimitValue);
  const mimeInvalid = mimeTypes.some(type => !MIME_RE.test(type));

  const valid =
    slugValid &&
    !slugDuplicate &&
    nameTrimmed.length > 0 &&
    !nameTooLong &&
    !descriptionTooLong &&
    !quotaError &&
    !fileLimitError &&
    !mimeInvalid;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    // Null rather than undefined when a limit is switched off, so an edit
    // clears it instead of leaving the stored one in place.
    onCreate({
      slug,
      name: nameTrimmed,
      description: description.trim() || undefined,
      visibility,
      quotaBytes: quotaEnabled ? Number(quotaValue) * UNIT_BYTES[quotaUnit] : editing ? null : undefined,
      fileSizeLimit: fileLimitEnabled ? Number(fileLimitValue) * UNIT_BYTES[fileLimitUnit] : null,
      allowedMimeTypes: mimeTypes,
    });
  }

  return (
    <Modal onClose={onClose} width="520px">
      <form onSubmit={submit} className="flex flex-col min-h-0 flex-1">
        <ModalHeader title={editing ? `Edit ${initial?.name}` : 'New bucket'} />
        <ModalBody className="space-y-4">
          {notice}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Slug">
              <input
                value={slug}
                disabled={Boolean(initial)}
                onChange={e => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }}
                className="input mono"
                placeholder="my-bucket"
                readOnly={editing}
                required
              />
              {slugFormatError ? (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
                  Lowercase alphanum + hyphens, 3–63 chars
                </p>
              ) : slugDuplicate ? (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
                  A bucket with this slug already exists
                </p>
              ) : (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>
                  Used in URLs · immutable after creation
                </p>
              )}
            </Field>
            <Field label="Name">
              <input
                value={name}
                onChange={e => {
                  setName(e.target.value);
                  // Mirror the name into the slug until the user edits the slug by hand.
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
                className="input"
                placeholder="My Bucket"
                maxLength={NAME_MAX}
                required
              />
              {nameError && (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
                  Name is required
                </p>
              )}
            </Field>
          </div>

          <Field label="Description">
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="input"
              placeholder="Optional description"
              maxLength={DESCRIPTION_MAX}
            />
            {descriptionTooLong && (
              <p className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
                Description must be {DESCRIPTION_MAX} characters or fewer
              </p>
            )}
          </Field>

          <div>
            <span className="label mb-1.5 block">Visibility</span>
            <div className="flex overflow-hidden border hairline-strong" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
              {(['private', 'public'] as const).map(v => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVisibility(v)}
                  className="flex-1 px-3 py-2 text-[11px] capitalize"
                  style={{
                    background: visibility === v ? 'var(--hover)' : 'transparent',
                    color: visibility === v ? 'var(--text)' : 'var(--text-mute)',
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>
              {visibility === 'public'
                ? 'Files accessible without authentication via public URL.'
                : 'Files require a signed URL or access token.'}
            </p>
          </div>

          <ByteLimitField
            label="Enable quota limit"
            enabled={quotaEnabled}
            onEnabledChange={setQuotaEnabled}
            value={quotaValue}
            onValueChange={setQuotaValue}
            unit={quotaUnit}
            onUnitChange={setQuotaUnit}
            error={quotaError}
          />

          <ByteLimitField
            label="Restrict file size"
            enabled={fileLimitEnabled}
            onEnabledChange={setFileLimitEnabled}
            value={fileLimitValue}
            onValueChange={setFileLimitValue}
            unit={fileLimitUnit}
            onUnitChange={setFileLimitUnit}
            error={fileLimitError}
          />

          <div>
            <label htmlFor="bucket-mime-types" className="label mb-1.5 block">Allowed MIME types</label>
            <ListInput
              id="bucket-mime-types"
              value={mimeTypes}
              onChange={setMimeTypes}
              placeholder="image/*, application/pdf"
              mono
              validate={type => (MIME_RE.test(type) ? null : 'Expected type/subtype, or type/*')}
            />
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>
              Empty accepts any type the project allows. Both lists apply.
            </p>
          </div>
        </ModalBody>
        <ModalFooter>
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={!valid || saving} className="btn btn-primary">
            {saving ? 'Saving…' : editing ? 'Save bucket' : 'Create bucket'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
