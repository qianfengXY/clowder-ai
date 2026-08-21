export interface WorkMutationIdentity {
  readonly projectId: string;
  readonly workId: string;
}

/**
 * Serializes mutations that belong to the same managed work across services.
 *
 * The coordinator is deliberately process-local: the stores still enforce their
 * durable optimistic-concurrency checks, while this closes read-check-dispatch
 * gaps between the Desktop loop and Review coordinator in one API process.
 */
export class WorkMutationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(identity: WorkMutationIdentity, operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([identity.projectId, identity.workId]);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(
      () => current,
      () => current,
    );
    this.tails.set(key, next);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}
