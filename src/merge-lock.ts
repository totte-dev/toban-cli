/**
 * MergeLock — serializes git merge/push operations per repository.
 *
 * Multiple agents may complete tasks concurrently, but git merge
 * and push must happen one at a time per repo to avoid conflicts.
 */

export class MergeLock {
  private locks: Map<string, Promise<void>> = new Map();

  /**
   * Acquire the merge lock for a repository.
   * Returns a release function to call when done.
   */
  async acquire(repoDir: string): Promise<() => void> {
    // Wait for any existing lock on this repo
    while (this.locks.has(repoDir)) {
      await this.locks.get(repoDir);
    }

    // Create a new lock
    let releaseFn!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    this.locks.set(repoDir, lockPromise);

    return () => {
      this.locks.delete(repoDir);
      releaseFn();
    };
  }
}
