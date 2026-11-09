import { afterEach, describe, expect, it } from 'vitest';
import { syncThemeColor } from '@/shared/lib/theme-provider';

const themeColors = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];

/** The browser chrome stayed on the OS scheme after the console's toggle flipped the page. */
describe('syncThemeColor', () => {
  afterEach(() => themeColors().forEach(meta => meta.remove()));

  it('creates one theme-color tag, then updates that same tag', () => {
    syncThemeColor('#f0ede4');
    syncThemeColor('#1f1f1f');

    expect(themeColors().map(meta => meta.content)).toEqual(['#1f1f1f']);
  });

  it('keeps the last colour when the canvas variable is not resolved yet', () => {
    syncThemeColor('#1f1f1f');
    syncThemeColor('');

    expect(themeColors().map(meta => meta.content)).toEqual(['#1f1f1f']);
  });
});
