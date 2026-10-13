import type { DatabaseState, SessionStore } from './contracts';

/** Synthetic local tests only. No disk, database, authentication or production durability. */
export class MemorySessionStore implements SessionStore {
  private state: DatabaseState = { accounts: new Map(), sessions: new Map(), commands: new Map(), ledger: [] };
  private tail: Promise<void> = Promise.resolve();
  async transaction<T>(operation: (state: DatabaseState) => T): Promise<T> {
    const preceding = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await preceding;
    try {
      const draft = structuredClone(this.state);
      const result = operation(draft);
      if (result instanceof Promise) throw new Error('Session transactions cannot wait on asynchronous work');
      const detached = structuredClone(result);
      this.state = structuredClone(draft);
      return detached;
    } finally { release(); }
  }
}
