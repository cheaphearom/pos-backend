import { logEvent } from './logger';

/**
 * Heartbeat for the ML detector: one `event=heartbeat` line every HEARTBEAT_INTERVAL_S seconds (30), even with
 * no customers. The detector raises "No logs from the API" when none arrives for a while: the API is down,
 * or its logs (Alloy → Loki) do not arrive. The detector keeps these lines out of the anomaly scores.
 * HEARTBEAT_INTERVAL_S=0 turns it off.
 */
export function startHeartbeat(intervalS = Number(process.env.HEARTBEAT_INTERVAL_S ?? 30), now: () => number = Date.now): () => void {
  if (!(intervalS > 0)) return () => undefined;
  const startedAt = now();
  const beat = () =>
    logEvent('info', 'heartbeat', 'Heartbeat', {
      uptimeS: Math.round((now() - startedAt) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    }, { logger: 'Heartbeat' });
  beat();
  const timer = setInterval(beat, intervalS * 1000);
  timer.unref(); // never keeps the process alive on shutdown
  return () => clearInterval(timer);
}
