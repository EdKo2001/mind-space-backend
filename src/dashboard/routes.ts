import type { FastifyInstance } from 'fastify';
import { SessionError } from '../session/contracts';
import type { DashboardRange, DashboardReader } from './contracts';
import { dashboardSnapshot, decodeDashboardRange } from './service';

export type DashboardOptions = { reader: DashboardReader; localAggregates: true; allowedOrigins: readonly string[]; demo?: { readDemo(range: DashboardRange): Promise<unknown> } };
/** Explicit development-only, redacted aggregate endpoint. Default server has no dashboard access. */
export function registerDashboard(app: FastifyInstance, options?: DashboardOptions) {
  for (const origin of options?.allowedOrigins ?? []) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Dashboard development origin must be loopback HTTP');
  }
  for (const path of ['/v1/dashboard', '/v1/dashboard/demo']) app.get(path, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Vary', 'Origin');
    if (!options) return reply.code(503).send({ ok: false, error: 'dashboard_access_unconfigured' });
    const origin = request.headers.origin;
    if (origin) {
      if (!options.allowedOrigins.includes(origin)) throw new SessionError('forbidden');
      reply.header('Access-Control-Allow-Origin', origin);
    }
    if (path.endsWith('/demo') && !options.demo) return reply.code(503).send({ ok: false, error: 'dashboard_demo_unconfigured' });
    const range = decodeDashboardRange(request.query);
    try { return path.endsWith('/demo') ? await options.demo!.readDemo(range) : await dashboardSnapshot(options.reader, range); }
    catch { return reply.code(503).send({ ok: false, error: 'dashboard_storage_unavailable' }); }
  });
}
