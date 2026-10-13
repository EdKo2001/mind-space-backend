import { SessionError } from '../session/contracts';
import { headlineKeys } from './contracts';
import type { DashboardRange, DashboardReader, DashboardResponse } from './contracts';

/** The frontend supplies resolved UTC instants; do not resolve presets or DST again on the server. */
export function decodeDashboardRange(value: unknown, now = Date.now()): DashboardRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SessionError('invalid_input');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(',') !== 'end,start,timezone') throw new SessionError('invalid_input');
  const { start, end, timezone } = raw;
  const instant = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)
    && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
  if (!instant(start) || !instant(end) || typeof timezone !== 'string' || timezone.length > 100
    || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)) throw new SessionError('invalid_input');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); } catch { throw new SessionError('invalid_input'); }
  const duration = Date.parse(end) - Date.parse(start);
  // Includes up to 366 calendar days across DST; one minute of clock skew is tolerated, never projected.
  if (duration <= 0 || duration > 367 * 86400_000 || Date.parse(end) > now + 60_000) throw new SessionError('invalid_input');
  return { start, end, timezone };
}

export async function dashboardSnapshot(reader: DashboardReader, range: DashboardRange): Promise<DashboardResponse> {
  const totals = await reader.readDashboard(range);
  return {
    version: 1, profile: 'internal-test-v1', scope: 'local-aggregate', capturedAt: totals.capturedAt, range,
    comparisons: Object.fromEntries(headlineKeys.map(key => [key, { previous: null, label: 'Comparison measurement unavailable' }])) as DashboardResponse['comparisons'],
    connected: null, reconnecting: null, peak: null, peakAt: null, voiceP95: null, failedPercent: null, spend: null,
    capacity: null, completed: totals.completed, avgAnswers: null, avgDuration: totals.avgDuration,
    queueDepth: null, queueOldest: null, forecast: null, concurrency: null, sessions: null,
    health: [
      { name: 'API gateway', status: 'Operational' }, { name: 'PostgreSQL session store', status: 'Operational' },
      { name: 'Voice service', status: 'Unknown' }, { name: 'AI inference', status: 'Unknown' }, { name: 'Queue system', status: 'Unknown' },
    ],
    alerts: [{ title: 'Internal backend profile', detail: 'Totals cover persisted internal sessions. Identity, AI, voice and billing are not connected; their measurements are unavailable.' }],
    unavailable: {
      connected: 'Session lifecycle does not prove a connected client.', reconnecting: 'Connection presence instrumentation is not configured.',
      peak: 'Historical connection measurements are not configured.', peakAt: 'Historical connection measurements are not configured.',
      concurrency: 'Historical connection measurements are not configured; missing history is not zero.',
      voiceP95: 'No app-observed turn-end to first-audible-reply measurements.',
      failedPercent: 'Provider request outcomes and denominator are not configured.', spend: 'Provider usage/cost accounting is not configured.',
      capacity: 'Global capacity policy is not configured.', avgAnswers: 'Audible/delivered answer acknowledgments are not configured.',
      queueDepth: 'Inference queue is not configured; event outbox is a different queue.', queueOldest: 'Inference queue is not configured.',
      forecast: 'Cost data and forecast policy are not configured.', sessions: 'Local aggregate mode excludes session identifiers and private data; platform/latency are unavailable.',
      comparisons: 'Historical metric comparison measurements are not configured.',
    },
    diagnostics: { activeSessions: totals.activeSessions, preparingSessions: totals.preparingSessions, overdueSessions: totals.overdueSessions },
  };
}
