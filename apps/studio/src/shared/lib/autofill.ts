/**
 * Keeps browsers and password managers out of the console's own fields.
 *
 * A secret's Name/Value pair, a key field or an email search reads to a browser
 * like a login form, so it filled them with the operator's saved credentials.
 * The console has no shared input component to fix that in, so this runs once
 * over the whole document instead of on each of the ~70 inputs.
 *
 * A field that really is a credential opts back in by naming what it is:
 * `autoComplete="username"`, `"current-password"`, `"one-time-code"`... Only a
 * missing or `"off"` value is overridden.
 */

// One per password manager: 1Password, LastPass, Bitwarden, Dashlane.
const IGNORE_ATTRIBUTES: Record<string, string> = {
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
};

export function suppressAutofill(input: HTMLInputElement): void {
  const declared = input.getAttribute('autocomplete');
  if (declared && declared !== 'off') return;
  // Browsers ignore "off" on a password field, but never fill a saved password
  // into a "new-password" one.
  input.setAttribute('autocomplete', input.type === 'password' ? 'new-password' : 'off');
  for (const [name, value] of Object.entries(IGNORE_ATTRIBUTES)) input.setAttribute(name, value);
}

/** Applies suppressAutofill to every input under `root`, now and as they mount. Returns the teardown. */
export function guardAutofill(root: HTMLElement): () => void {
  const sweep = (node: ParentNode) => node.querySelectorAll('input').forEach(suppressAutofill);
  sweep(root);
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLInputElement) suppressAutofill(node);
        else if (node instanceof HTMLElement) sweep(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
