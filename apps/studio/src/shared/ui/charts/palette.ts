// Categorical series colours for every chart in the studio.
//
// The eight hues are fixed and assigned in this order, never cycled: a ninth
// series folds into "Other" rather than reusing slot 1, so a colour always
// means one entity. Both columns are validated as a set against their own
// surface (lightness band, chroma floor, colourblind separation, normal-vision
// separation, contrast). The order is what makes them pass, so do not reshuffle
// them: the previous order put orange next to red at a normal-vision ΔE of 7.1,
// and orange next to green at ΔE 3.2 for a protanope.
//
// Slots: blue · orange · aqua · yellow · magenta · green · violet · red
const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

export function categoricalPalette(theme: 'light' | 'dark') {
  return theme === 'dark' ? DARK : LIGHT;
}

export interface Series {
  label: string;
  value: number;
}

/**
 * Turn any number of series into at most eight coloured slices, largest first.
 * Beyond the eighth the tail is summed into a single neutral "Other" slice,
 * which is the honest answer for a donut: nine indistinguishable slivers say
 * less than one labelled remainder.
 */
export function toSlices<T extends Series>(series: T[], theme: 'light' | 'dark') {
  const palette = categoricalPalette(theme);
  const ranked = [...series].filter(s => s.value > 0).sort((a, b) => b.value - a.value);
  if (ranked.length <= palette.length) {
    return ranked.map((s, i) => ({ label: s.label, value: s.value, color: palette[i] }));
  }
  const head = ranked.slice(0, palette.length - 1);
  const tail = ranked.slice(palette.length - 1);
  return [
    ...head.map((s, i) => ({ label: s.label, value: s.value, color: palette[i] })),
    {
      label: `Other (${tail.length})`,
      value: tail.reduce((sum, s) => sum + s.value, 0),
      color: 'var(--text-mute)',
    },
  ];
}
