import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useDialogBehavior } from './useDialogBehavior';

function Overlay({ label, onClose, children }: { label: string; onClose: () => void; children?: React.ReactNode }) {
  const ref = useDialogBehavior(onClose);
  return (
    <div ref={ref} role="dialog" aria-label={label} tabIndex={-1}>
      <button type="button" onClick={onClose}>Close {label}</button>
      {children}
    </div>
  );
}

function Stack() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(true);
  return (
    <>
      {outer && <Overlay label="outer" onClose={() => setOuter(false)} />}
      {inner && <Overlay label="inner" onClose={() => setInner(false)} />}
    </>
  );
}

describe('useDialogBehavior', () => {
  it('Escape closes only the top overlay when two are stacked', () => {
    render(<Stack />);
    expect(screen.getByRole('dialog', { name: 'inner' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'inner' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'outer' })).not.toBeInTheDocument();
  });

  it('keeps focus in the field being typed in when the parent re-renders with a new onClose', () => {
    function Form() {
      const [a, setA] = useState('');
      return (
        <Overlay label="form" onClose={() => undefined}>
          <input aria-label="first" />
          <input aria-label="second" value={a} onChange={e => setA(e.target.value)} />
        </Overlay>
      );
    }
    render(<Form />);
    const second = screen.getByLabelText('second');
    second.focus();
    fireEvent.change(second, { target: { value: 'x' } });
    expect(second).toHaveFocus();
  });
});
