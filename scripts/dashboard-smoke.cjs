const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const endpoint = process.env.DASHBOARD_API_URL ?? 'http://127.0.0.1:3001/v1/dashboard';
  const origin = 'http://127.0.0.1:5173';
  const now = new Date().toISOString(), timezone = 'America/Chicago';
  let body, status, cors, cache, requestedUrl, parsed;
  const fetcher = async (url, options = {}) => {
    requestedUrl = String(url);
    const response = await fetch(url, { ...options, headers: { ...options.headers, Origin: origin }, signal: options.signal ?? AbortSignal.timeout(5000) });
    status = response.status; cors = response.headers.get('access-control-allow-origin'); cache = response.headers.get('cache-control');
    body = await response.clone().json();
    return response;
  };
  const client = process.argv.find(arg => arg.startsWith('--client='))?.slice('--client='.length);
  if (client) {
    // Optional compatibility check against the actual separate dashboard adapter; never edits it.
    const { requestDashboard } = await import(pathToFileURL(resolve(client)).href);
    parsed = await requestDashboard(endpoint, { period: 'today', timezone }, AbortSignal.timeout(5000), fetcher, now);
    assert.equal(parsed.source, 'api');
  } else {
    const url = new URL(endpoint);
    url.searchParams.set('start', new Date(Date.parse(now) - 86400_000).toISOString());
    url.searchParams.set('end', now); url.searchParams.set('timezone', timezone);
    await fetcher(url);
  }
  assert.equal(status, 200); assert.equal(cors, origin); assert.equal(cache, 'no-store');
  assert.equal(body.version, 1); assert.equal(body.profile, 'internal-test-v1'); assert.equal(body.scope, 'local-aggregate');
  const requested = new URL(requestedUrl);
  assert.equal(body.range.start, requested.searchParams.get('start')); assert.equal(body.range.end, requested.searchParams.get('end'));
  assert.equal(body.sessions, null); assert.equal(body.connected, null); assert.equal(body.voiceP95, null); assert.equal(body.spend, null);
  assert.equal(typeof body.completed, 'number');
  const invalid = await fetch(`${requestedUrl}&token=forbidden`, { signal: AbortSignal.timeout(5000) });
  assert.equal(invalid.status, 400);
  const denied = await fetch(requestedUrl, { headers: { Origin: 'https://untrusted.example' }, signal: AbortSignal.timeout(5000) });
  assert.equal(denied.status, 403);
  const ready = await fetch(new URL('/ready', endpoint), { signal: AbortSignal.timeout(5000) });
  assert.equal(ready.status, 503); const readiness = await ready.json();
  assert.equal(readiness.components.durableSessionStore, 'available');
  writeFileSync(resolve(__dirname, '../evidence/dashboard-smoke.json'), `${JSON.stringify({
    checkedAt: new Date().toISOString(), endpoint, origin, status, cors, cache,
    adapterCompatibility: client ? 'PASS: actual dashboard requestDashboard parsed the live HTTP response' : 'not run',
    invalidQueryStatus: invalid.status, deniedOriginStatus: denied.status, readiness, response: body,
  }, null, 2)}\n`);
  console.log(`Live dashboard HTTP PASS${client ? '; actual dashboard adapter compatibility PASS' : ''}; measured aggregates and explicit unavailable fields.`);
}
void main().catch(() => { console.error('Dashboard HTTP smoke failed'); process.exitCode = 1; });
