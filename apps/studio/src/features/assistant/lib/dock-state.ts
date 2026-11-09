export interface DockState {
  open: boolean;
  width: number;
  /** Model chosen from the dock's switcher. Empty ⇒ whatever the settings
   *  group has configured, resolved server side per message. */
  model: string;
}

const KEY = 'mb.assistant.dock';
const DEFAULT: DockState = { open: false, width: 420, model: '' };
const MIN = 320;
const MAX = 720;

// Exposed so the resize handle can clamp a live drag/keyboard adjustment to
// the same bounds this module already enforces on load/save.
export const DOCK_MIN_WIDTH = MIN;
export const DOCK_MAX_WIDTH = MAX;

export function clampWidth(width: number): number {
  return Math.min(MAX, Math.max(MIN, width));
}

export function loadDockState(): DockState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<DockState>;
    return {
      open: Boolean(parsed.open),
      width: clampWidth(Number(parsed.width) || DEFAULT.width),
      model: typeof parsed.model === 'string' ? parsed.model : '',
    };
  } catch {
    return DEFAULT;
  }
}

export function saveDockState(state: DockState): void {
  const clamped = { open: state.open, width: clampWidth(state.width), model: state.model };
  try {
    localStorage.setItem(KEY, JSON.stringify(clamped));
  } catch {
    /* private browsing: the dock still works, it just forgets its width */
  }
}
