const MAX_RECONNECT_DELAY_MS = 30_000;

export function reconnectDelay(attempt: number, random: () => number): number {
  const exponent = Math.min(Math.max(0, attempt), 30);
  const ceiling = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** exponent);
  const value = random();
  const jitter = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return jitter * ceiling;
}
