/**
 * Per-key batching: at most one batch runs per key at a time, and each batch
 * takes every item that queued up for that key while the previous batch ran.
 * Different keys run fully in parallel.
 *
 * Used for per-user group commit. Writes to one user are serialized by the
 * database row lock anyway, and each write would otherwise pay for its own
 * durable commit (a disk flush). Running the queued writes of one user in a
 * single transaction lets one flush cover many writes, and a hot user holds
 * at most one database connection per process, leaving the rest of the pool
 * to other users.
 *
 * Items are passed to `execute` in submission order, and `execute` must
 * return one result per item, in the same order. If `execute` throws, every
 * item in that batch is rejected with the error; later batches still run.
 */
export type BatchExecutor<TItem, TResult> = (key: string, items: readonly TItem[]) => Promise<readonly TResult[]>;

interface Pending<TItem, TResult> {
  readonly item: TItem;
  readonly resolve: (result: TResult) => void;
  readonly reject: (error: unknown) => void;
}

export class KeyedBatcher<TItem, TResult> {
  /** Items waiting for each key that currently has a batch running. */
  private readonly queues = new Map<string, Pending<TItem, TResult>[]>();

  constructor(
    private readonly execute: BatchExecutor<TItem, TResult>,
    private readonly maxBatchSize: number,
  ) {
    if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) throw new Error('maxBatchSize must be a positive integer');
  }

  submit(key: string, item: TItem): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const queue = this.queues.get(key);
      if (queue !== undefined) {
        queue.push({ item, resolve, reject }); // a batch is running: wait for the next one
        return;
      }
      this.queues.set(key, [{ item, resolve, reject }]);
      void this.drain(key);
    });
  }

  /** Number of keys with queued or running work (for tests and diagnostics). */
  get activeKeys(): number {
    return this.queues.size;
  }

  private async drain(key: string): Promise<void> {
    const queue = this.queues.get(key);
    if (queue === undefined) return;

    while (queue.length > 0) {
      const batch = queue.splice(0, this.maxBatchSize);
      try {
        const results = await this.execute(
          key,
          batch.map((pending) => pending.item),
        );
        if (results.length !== batch.length) {
          throw new Error(`Batch executor returned ${results.length} results for ${batch.length} items`);
        }
        batch.forEach((pending, i) => pending.resolve(results[i] as TResult));
      } catch (error) {
        for (const pending of batch) pending.reject(error);
      }
    }
    // Nothing left: forget the key, so memory does not grow with the number of users.
    this.queues.delete(key);
  }
}
