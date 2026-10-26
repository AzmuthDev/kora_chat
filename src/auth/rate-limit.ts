/**
 * Limite de tentativas de login em memória (por processo): N falhas por chave numa janela.
 * Suficiente para um servidor; com vários servidores, mover para o banco ou Redis.
 */
export class LoginRateLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Segundos até poder tentar de novo; 0 = liberado. */
  retryAfter(keys: string[], now = Date.now()): number {
    let wait = 0;
    for (const key of keys) {
      const list = this.recent(key, now);
      if (list.length >= this.maxFailures) wait = Math.max(wait, Math.ceil((list[0]! + this.windowMs - now) / 1000));
    }
    return wait;
  }

  fail(keys: string[], now = Date.now()): void {
    for (const key of keys) this.failures.set(key, [...this.recent(key, now), now]);
  }

  succeed(keys: string[]): void {
    for (const key of keys) this.failures.delete(key);
  }
}
