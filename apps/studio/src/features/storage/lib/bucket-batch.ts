export interface BucketTarget { slug: string; name: string }

/** Settle every write before refetching: a failed request must not hide later successes. */
export async function runBucketBatch<T>(targets: BucketTarget[], action: (slug: string) => Promise<T>) {
  const results = await Promise.allSettled(targets.map(target => action(target.slug)));
  const succeeded: { bucket: BucketTarget; value: T }[] = [];
  const failed: { bucket: BucketTarget; error: unknown }[] = [];
  results.forEach((result, index) => {
    const bucket = targets[index];
    if (result.status === 'fulfilled') succeeded.push({ bucket, value: result.value });
    else failed.push({ bucket, error: result.reason });
  });
  return { succeeded, failed };
}
