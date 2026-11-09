import { beforeEach, describe, expect, it } from 'vitest';
import { loadDockState, saveDockState } from './dock-state';

beforeEach(() => localStorage.clear());

describe('dock state', () => {
  it('defaults to closed at a sensible width with no model pinned', () => {
    expect(loadDockState()).toEqual({ open: false, width: 420, model: '' });
  });

  it('round-trips through localStorage', () => {
    saveDockState({ open: true, width: 560, model: 'claude-haiku-4-5' });
    expect(loadDockState()).toEqual({ open: true, width: 560, model: 'claude-haiku-4-5' });
  });

  it('clamps a width that would swallow the page', () => {
    saveDockState({ open: true, width: 5000, model: '' });
    expect(loadDockState().width).toBe(720);
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('mb.assistant.dock', '{not json');
    expect(loadDockState()).toEqual({ open: false, width: 420, model: '' });
  });

  it('ignores a non-string model left by an older build', () => {
    localStorage.setItem('mb.assistant.dock', JSON.stringify({ open: true, width: 420, model: 7 }));
    expect(loadDockState().model).toBe('');
  });
});
