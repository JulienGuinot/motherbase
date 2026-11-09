// Bucket timestamped items into `n` equal slots over the last `windowMs`,
// returning per-slot counts (oldest → newest). Used by log sparklines.
export function bucketCounts(items: { at: string }[], n: number, windowMs: number): number[] {
  const now = Date.now();
  const start = now - windowMs;
  const slot = windowMs / n;
  const arr = new Array(n).fill(0);
  for (const it of items) {
    const t = Date.parse(it.at);
    if (Number.isNaN(t) || t < start) continue;
    const idx = Math.min(n - 1, Math.floor((t - start) / slot));
    arr[idx] += 1;
  }
  return arr;
}
