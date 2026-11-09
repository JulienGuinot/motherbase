import type { AiCatalogue } from '@/features/assistant/api/assistant.api';
import Select from '@/shared/ui/Select';

/**
 * The provider default first, then every listed model. A model saved earlier
 * that the provider no longer lists stays selectable rather than vanishing.
 */
export function modelOptions(catalogue: AiCatalogue | undefined, selected: string) {
  const models = catalogue?.models ?? [];
  return [
    { value: '', label: catalogue?.model ? `Default · ${catalogue.model}` : 'Default model' },
    ...models.map(m => ({ value: m.id, label: m.label === m.id ? m.id : `${m.label} · ${m.id}` })),
    ...(selected && !models.some(m => m.id === selected) ? [{ value: selected, label: selected }] : []),
  ];
}

export function ModelPicker({
  catalogue,
  value,
  onChange,
}: {
  catalogue: AiCatalogue | undefined;
  value: string;
  onChange: (model: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: 'var(--border)' }}>
      <Select
        value={value}
        onChange={onChange}
        options={modelOptions(catalogue, value)}
        ariaLabel="Model for this conversation"
        className="min-w-0 flex-1"
        style={{ width: '100%', fontSize: 11, padding: '3px 6px' }}
        searchable
      />
    </div>
  );
}
