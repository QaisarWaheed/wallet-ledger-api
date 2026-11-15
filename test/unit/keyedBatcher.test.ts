import { describe, expect, it } from 'vitest';
import { KeyedBatcher } from '../../src/keyedBatcher.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Records every batch it receives and echoes items back as results. */
function recordingExecutor(work: () => Promise<void> = () => delay(5)) {
  const batches: Array<{ key: string; items: number[] }> = [];
  let running = 0;
  let maxRunningPerKey = 0;
  const runningKeys = new Map<string, number>();
  const execute = async (key: string, items: readonly number[]): Promise<number[]> => {
    batches.push({ key, items: [...items] });
    running += 1;
    runningKeys.set(key, (runningKeys.get(key) ?? 0) + 1);
    maxRunningPerKey = Math.max(maxRunningPerKey, runningKeys.get(key) ?? 0);
    await work();
    runningKeys.set(key, (runningKeys.get(key) ?? 1) - 1);
    running -= 1;
    return items.map((item) => item * 10);
  };
  return { execute, batches, peak: () => maxRunningPerKey, running: () => running };
}

describe('KeyedBatcher', () => {
  it('runs a lone item immediately as a batch of one', async () => {
    const { execute, batches } = recordingExecutor();
    const batcher = new KeyedBatcher(execute, 10);
    await expect(batcher.submit('a', 1)).resolves.toBe(10);
    expect(batches).toEqual([{ key: 'a', items: [1] }]);
  });

  it('groups items that queue up while a batch runs, keeping order and per-item results', async () => {
    const { execute, batches } = recordingExecutor();
    const batcher = new KeyedBatcher(execute, 100);

    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => batcher.submit('hot', i + 1)));

    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
    // The first item starts alone; everything that arrived meanwhile goes in the next batch.
    expect(batches).toEqual([
      { key: 'hot', items: [1] },
      { key: 'hot', items: [2, 3, 4, 5, 6] },
    ]);
  });

  it('never runs two batches for the same key at once', async () => {
    const { execute, peak } = recordingExecutor(() => delay(1));
    const batcher = new KeyedBatcher(execute, 3);
    await Promise.all(Array.from({ length: 30 }, (_, i) => batcher.submit('k', i)));
    expect(peak()).toBe(1);
  });

  it('respects maxBatchSize', async () => {
    const { execute, batches } = recordingExecutor();
    const batcher = new KeyedBatcher(execute, 2);
    await Promise.all(Array.from({ length: 5 }, (_, i) => batcher.submit('k', i)));
    expect(batches.map((b) => b.items)).toEqual([[0], [1, 2], [3, 4]]);
  });

  it('runs different keys in parallel', async () => {
    let running = 0;
    let peak = 0;
    const batcher = new KeyedBatcher(async (_key, items: readonly number[]) => {
      running += 1;
      peak = Math.max(peak, running);
      await delay(10);
      running -= 1;
      return [...items];
    }, 10);
    await Promise.all(['a', 'b', 'c', 'd'].map((key) => batcher.submit(key, 1)));
    expect(peak).toBe(4);
  });

  it('rejects every item of a failed batch, then keeps processing later batches', async () => {
    let call = 0;
    const batcher = new KeyedBatcher(async (_key, items: readonly number[]) => {
      call += 1;
      await delay(2);
      if (call === 2) throw new Error('batch failed');
      return [...items];
    }, 10);

    const first = batcher.submit('k', 1);
    const failedA = batcher.submit('k', 2);
    const failedB = batcher.submit('k', 3);
    await expect(first).resolves.toBe(1);
    await expect(failedA).rejects.toThrow('batch failed');
    await expect(failedB).rejects.toThrow('batch failed');
    await expect(batcher.submit('k', 4)).resolves.toBe(4);
  });

  it('rejects the batch if the executor returns the wrong number of results', async () => {
    const batcher = new KeyedBatcher(async () => [], 10);
    await expect(batcher.submit('k', 1)).rejects.toThrow(/returned 0 results for 1 items/);
  });

  it('forgets keys once they are idle', async () => {
    const { execute } = recordingExecutor();
    const batcher = new KeyedBatcher(execute, 10);
    await Promise.all([batcher.submit('a', 1), batcher.submit('b', 2), batcher.submit('a', 3)]);
    expect(batcher.activeKeys).toBe(0);
  });

  it('refuses an invalid batch size', () => {
    expect(() => new KeyedBatcher(async () => [], 0)).toThrow();
  });
});
