/**
 * Generation-counter single-flight sync coordinator.
 * Injects drainFn and runFn. Guarantees that any requestSync() caller
 * only resolves after a sync cycle that started AT OR AFTER the request has completed.
 */
export class SyncCoordinator {
  private requestedGen = 0;
  private completedGen = 0;
  private runningPromise: Promise<void> | null = null;
  private readonly drainFn: () => Promise<void>;
  private readonly runFn: () => Promise<void>;

  constructor(drainFn: () => Promise<void>, runFn: () => Promise<void>) {
    this.drainFn = drainFn;
    this.runFn = runFn;
  }

  async requestSync(): Promise<void> {
    const targetGen = ++this.requestedGen;
    while (this.completedGen < targetGen) {
      if (!this.runningPromise) {
        this.runningPromise = this.runLoop();
      }
      await this.runningPromise;
    }
  }

  private async runLoop(): Promise<void> {
    try {
      while (this.completedGen < this.requestedGen) {
        const genToRun = this.requestedGen;
        await this.drainFn();
        await this.runFn();
        this.completedGen = genToRun;
      }
    } finally {
      this.runningPromise = null;
    }
  }

  getCompletedGen(): number {
    return this.completedGen;
  }

  getRequestedGen(): number {
    return this.requestedGen;
  }
}
