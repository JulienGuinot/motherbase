import { useId } from 'react';

interface ProviderFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  help?: string;
  secret?: boolean;
  storedSecret?: boolean;
  type?: 'text' | 'url';
  className?: string;
  disabled?: boolean;
}

export function ProviderField({
  label,
  value,
  onChange,
  placeholder,
  help,
  secret = false,
  storedSecret = false,
  type = 'text',
  className,
  disabled,
}: ProviderFieldProps) {
  const helpId = useId();
  return (
    <label className={className ?? 'block'}>
      <span className="text-[11.5px] font-medium" style={{ color: 'var(--text-dim)' }}>
        {label}
      </span>
      <input
        className="input mt-1 w-full"
        type={secret ? 'password' : type}
        value={value}
        placeholder={secret && storedSecret ? '•••••• stored. Leave blank to keep' : placeholder}
        aria-describedby={help ? helpId : undefined}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      />
      {help && (
        <span id={helpId} className="mt-1 block text-[10.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
          {help}
        </span>
      )}
    </label>
  );
}
