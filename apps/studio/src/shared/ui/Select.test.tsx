import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import Select from './Select';

const options = Array.from({ length: 12 }, (_, i) => ({ value: `s${i}`, label: `schema ${i}` }));

describe('Select', () => {
  // `scrollIntoView` scrolls every ancestor too, and the document and the shell
  // are `overflow: hidden`: the page slid away and only a reload brought it back.
  it('never scrolls anything but its own popover', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(<Select value="s11" onChange={() => {}} options={options} ariaLabel="Schema" />);
    const trigger = screen.getByRole('button', { name: 'Schema' });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });

    const listbox = screen.getByRole('listbox', { name: 'Schema' });
    expect(listbox.style.position).toBe('fixed');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
