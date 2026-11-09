import { describe, expect, it } from 'vitest';
import { guardAutofill } from '@/shared/lib/autofill';

function input(attrs: Record<string, string>): HTMLInputElement {
  const el = document.createElement('input');
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

/**
 * A secret's Name/Value pair read as a login form, and the browser filled it
 * with the operator's email and password.
 */
describe('guardAutofill', () => {
  it('marks fields present at start and fields mounted later, but leaves declared credentials alone', async () => {
    const root = document.createElement('div');
    const name = input({ type: 'text' });
    root.append(name);
    const stop = guardAutofill(root);

    const value = input({ type: 'password', autocomplete: 'off' });
    const login = input({ type: 'password', autocomplete: 'current-password' });
    const wrapper = document.createElement('div');
    wrapper.append(value);
    root.append(wrapper, login);
    await Promise.resolve(); // MutationObserver callbacks run as a microtask

    expect(name.getAttribute('autocomplete')).toBe('off');
    expect(name.getAttribute('data-1p-ignore')).toBe('true');
    expect(value.getAttribute('autocomplete')).toBe('new-password');
    expect(value.getAttribute('data-lpignore')).toBe('true');
    expect(login.getAttribute('autocomplete')).toBe('current-password');
    expect(login.hasAttribute('data-1p-ignore')).toBe(false);
    stop();
  });
});
