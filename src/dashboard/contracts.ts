/** Matches the operations dashboard's version-1 HTTP adapter. Units are documented in docs/dashboard-api.md. */
export type DashboardRange = { start: string; end: string; timezone: string };
export type DashboardTotals = {
  capturedAt: string; completed: number; avgDuration: number | null;
  activeSessions: number; preparingSessions: number; overdueSessions: number;
};
export interface DashboardReader { readDashboard(range: DashboardRange): Promise<DashboardTotals> }
export const headlineKeys = ['connected', 'reconnecting', 'peak', 'voiceP95', 'failedPercent', 'spend'] as const;
export type HeadlineKey = typeof headlineKeys[number];
export type DashboardResponse = {
  version: 1; profile: 'internal-test-v1'; scope: 'local-aggregate'; capturedAt: string; range: DashboardRange;
  comparisons: Record<HeadlineKey, { previous: number | null; label: string }>;
  connected: number | null; reconnecting: number | null; peak: number | null; peakAt: string | null;
  voiceP95: number | null; failedPercent: number | null; spend: number | null; capacity: number | null;
  completed: number; avgAnswers: number | null; avgDuration: number | null;
  queueDepth: number | null; queueOldest: number | null; forecast: number | null;
  concurrency: { at: string; count: number | null }[] | null; sessions: null;
  health: { name: string; status: 'Operational' | 'Unknown' }[];
  alerts: { title: string; detail: string }[];
  unavailable: Record<string, string>;
  diagnostics: { activeSessions: number; preparingSessions: number; overdueSessions: number };
};
