import { Pool } from 'pg';
import type { DashboardRange } from './contracts';
import { headlineKeys } from './contracts';

/** Isolated, synthetic reporting fixtures. Never writes to the session/account store. */
export class DashboardDemo {
  private readonly schema: string;
  constructor(private readonly pool: Pool, schema = 'mindspace_dashboard_demo') {
    if (schema !== 'mindspace_dashboard_demo' && !/^ms_demo_test_[a-f0-9]+$/.test(schema)) throw new Error('Invalid demo schema');
    this.schema = `"${schema}"`;
  }
  static connect(url: string) {
    const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
    pool.on('error', () => {});
    return new DashboardDemo(pool);
  }
  async close() { await this.pool.end(); }
  async seed(now = new Date()) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [this.schema]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema};
        CREATE TABLE IF NOT EXISTS ${this.schema}.sessions (
          id text PRIMARY KEY CHECK(id LIKE 'DEMO-%'), kind text NOT NULL CHECK(kind IN ('paid','trial')),
          status text NOT NULL CHECK(status IN ('Connected','Reconnecting','Completed')),
          platform text NOT NULL CHECK(platform IN ('iOS','Android','Web')),
          started_at timestamptz NOT NULL, ended_at timestamptz,
          remaining double precision NOT NULL, answers integer NOT NULL,
          latency double precision NOT NULL, requests integer NOT NULL, failures integer NOT NULL,
          spend double precision NOT NULL);
        CREATE TABLE IF NOT EXISTS ${this.schema}.samples (id integer PRIMARY KEY, at timestamptz NOT NULL, count integer NOT NULL);`);
      // Fixed IDs + UPSERT make reruns replace this fixture, without duplicates or deleting other data.
      for (let i = 0; i < 66; i++) {
        const active = i >= 60, trial = i % 3 === 2;
        const minutes = active ? (trial ? 7 : 22) : (trial ? 10 : 45);
        const ended = active ? null : new Date(now.getTime() - (i * 12 + 1) * 3600_000);
        const started = new Date((ended?.getTime() ?? now.getTime()) - minutes * 60_000);
        await client.query(`INSERT INTO ${this.schema}.sessions VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,status=EXCLUDED.status,platform=EXCLUDED.platform,
          started_at=EXCLUDED.started_at,ended_at=EXCLUDED.ended_at,remaining=EXCLUDED.remaining,answers=EXCLUDED.answers,
          latency=EXCLUDED.latency,requests=EXCLUDED.requests,failures=EXCLUDED.failures,spend=EXCLUDED.spend`,
        [`DEMO-${String(i+1).padStart(3,'0')}`, trial ? 'trial' : 'paid', active ? (i % 3 === 1 ? 'Reconnecting' : 'Connected') : 'Completed',
          ['iOS','Android','Web'][i % 3], started, ended, active ? (trial ? 3 : 23) : 0,
          12+i%29, 1.8+(i%7)*0.3, 100+i%11, i%4 === 0 ? 2 : 0, 0.12+(i%9)*0.04]);
      }
      for (let i = 0; i <= 720; i++) {
        await client.query(`INSERT INTO ${this.schema}.samples VALUES($1,$2,$3)
          ON CONFLICT(id) DO UPDATE SET at=EXCLUDED.at,count=EXCLUDED.count`,
        [i, new Date(now.getTime() - (720-i)*3600_000), i === 720 ? 4 : 4+(i*7)%23]);
      }
      await client.query('COMMIT');
      return { synthetic: true, sessions: 66, samples: 721, seededAt: now.toISOString() };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async readDemo(range: DashboardRange) {
    // One read transaction gives a consistent snapshot even while the explicit seed command reruns.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const totals = await client.query(`SELECT COUNT(*)::int AS completed,
        AVG(EXTRACT(EPOCH FROM ended_at-started_at)/60)::float8 AS duration,
        AVG(answers)::float8 AS answers, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency) AS latency,
        SUM(spend)::float8 AS spend, SUM(failures)::float8/NULLIF(SUM(requests),0)*100 AS failed
        FROM ${this.schema}.sessions WHERE ended_at >= $1 AND ended_at < $2`, [range.start, range.end]);
      const live = await client.query(`SELECT * FROM ${this.schema}.sessions WHERE ended_at IS NULL ORDER BY id`);
      const samples = await client.query(`SELECT at,count FROM ${this.schema}.samples WHERE at >= $1 AND at <= $2 ORDER BY at`, [range.start, range.end]);
      const captured = await client.query('SELECT NOW() AS at');
      await client.query('COMMIT');
      const value = totals.rows[0];
      const concurrency = samples.rows.map(row => ({ at: row.at.toISOString() as string, count: row.count as number }));
      const peak = concurrency.reduce<{at: string; count: number} | null>((a,b) => !a || b.count > a.count ? b : a, null);
      return {
        version: 1, profile: 'db-demo-v1', scope: 'synthetic-demo', synthetic: true,
        capturedAt: captured.rows[0].at.toISOString(), range,
        comparisons: Object.fromEntries(headlineKeys.map(key => [key, { previous: null, label: 'Comparison not seeded' }])),
        connected: live.rows.filter(row => row.status === 'Connected').length,
        reconnecting: live.rows.filter(row => row.status === 'Reconnecting').length,
        peak: peak?.count ?? null, peakAt: peak?.at ?? null, voiceP95: value.latency,
        failedPercent: value.failed, spend: value.spend, capacity: null,
        completed: value.completed, avgAnswers: value.answers, avgDuration: value.duration,
        queueDepth: null, queueOldest: null, forecast: null, concurrency,
        sessions: live.rows.map(row => ({ id: row.id, type: row.kind, status: row.status, platform: row.platform,
          startedAt: row.started_at.toISOString(), remaining: row.remaining, answers: row.answers, latency: row.latency })),
        health: [{ name: 'API gateway', status: 'Operational' }, { name: 'PostgreSQL demo store', status: 'Operational' },
          { name: 'Voice service', status: 'Unknown' }, { name: 'AI inference', status: 'Unknown' }],
        alerts: [{ title: 'PostgreSQL demo · synthetic data', detail: 'Sessions, history, latency, failures and spend are seeded test values. Provider services are not connected. Current demo session rows are frozen fixtures; Refresh rereads PostgreSQL.' }],
        unavailable: { capacity: 'Capacity policy is not configured.', queueDepth: 'No inference queue connected.',
          queueOldest: 'No inference queue connected.', forecast: 'No cost forecast policy configured.' },
      };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
