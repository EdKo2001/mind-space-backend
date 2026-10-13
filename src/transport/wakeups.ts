/** Wakeups contain no identifiers or content; subscribers always read verified state. */
export class SessionWakeups {
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  wake() { for (const listener of this.listeners) listener(); }
}
