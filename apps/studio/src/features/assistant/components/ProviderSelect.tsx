import { Plug } from 'lucide-react';
import { BrandLogo } from '@/shared/ui/BrandLogo';
import Select from '@/shared/ui/Select';

/** `compatible` is no vendor, so it gets a plug rather than grey initials. */
function ProviderLogo({ provider, label }: { provider: string; label: string }) {
  return provider === 'compatible' ? <Plug size={14} aria-hidden /> : <BrandLogo brand={provider} label={label} size={14} />;
}

/**
 * The provider picker shared by the project and organization AI forms: a list
 * of a dozen vendors reads faster by logo than by name.
 */
export function ProviderSelect({
  value,
  onChange,
  options,
  disabled,
  align,
}: {
  value: string;
  onChange: (provider: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  /** `right` where the picker sits in a right-hand column, so its popover
   *  opens inward instead of past the edge of the dock. */
  align?: 'left' | 'right';
}) {
  const current = options.find(o => o.value === value);
  return (
    <Select
      value={value}
      onChange={onChange}
      options={options.map(o => ({ ...o, icon: <ProviderLogo provider={o.value} label={o.label} /> }))}
      leadingIcon={current && <ProviderLogo provider={current.value} label={current.label} />}
      disabled={disabled}
      align={align}
      ariaLabel="Provider"
      style={{ width: '100%' }}
    />
  );
}
