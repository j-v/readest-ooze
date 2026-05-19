export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<Array<{ item: T; result: R } | { item: T; error: unknown }>> {
  const results: Array<{ item: T; result: R } | { item: T; error: unknown }> = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      if (signal?.aborted) return;
      const currentIndex = index++;
      const item = items[currentIndex]!;
      try {
        const result = await fn(item);
        results[currentIndex] = { item, result };
      } catch (error) {
        results[currentIndex] = { item, error };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
