const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
async function main() {
  const client = process.argv.find(arg => arg.startsWith('--client='))?.slice('--client='.length);
  if (!client) throw new Error('Supply --client=/absolute/path/to/dashboard/src/data/client.ts');
  const { requestDashboard } = await import(pathToFileURL(resolve(client)).href);
  const endpoint = 'http://127.0.0.1:3001/v1/dashboard/demo', origin = 'http://127.0.0.1:5175';
  const fetcher = async (url, options) => {
    const response = await fetch(url, { ...options, headers: { ...options.headers, Origin: origin } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response;
  };
  const snapshots = [];
  for (const period of ['today','week','30days']) {
    const snapshot = await requestDashboard(endpoint, { period, timezone: 'America/Chicago' }, AbortSignal.timeout(5000), fetcher);
    assert.equal(snapshot.source,'db-demo'); assert.equal(snapshot.connected,4); assert.equal(snapshot.reconnecting,2);
    assert.equal(snapshot.sessions.length,6); assert(snapshot.sessions.every(row => row.id.startsWith('DEMO-')));
    assert(Array.isArray(snapshot.concurrency)); assert.equal(snapshot.forecast,null);
    assert(Number.isInteger(snapshot.completed) && snapshot.completed >= 0);
    assert(snapshot.concurrency.every(point => Date.parse(point.at) >= Date.parse(snapshot.range.start)
      && Date.parse(point.at) < Date.parse(snapshot.range.end)));
    if (snapshot.granularity === 'daily') {
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
      assert.equal(new Set(snapshot.concurrency.map(point => date.format(new Date(point.at)))).size,snapshot.concurrency.length);
      assert(snapshot.concurrency.length <= snapshot.range.calendarDays);
    }
    assert.equal(snapshot.health.find(row => row.name === 'Voice service').status,'Unknown');
    snapshots.push(snapshot);
  }
  writeFileSync(resolve(__dirname,'../evidence/dashboard-db-demo.json'), `${JSON.stringify({
    checkedAt: new Date().toISOString(), endpoint, origin, status: 'PASS',
    adapterCompatibility: 'Actual dashboard HTTP adapter parsed PostgreSQL-backed responses',
    snapshots,
  },null,2)}\n`);
  console.log('PostgreSQL → HTTP → dashboard adapter PASS; today/week/30days; explicitly synthetic.');
}
void main().catch(error => { console.error(error.message); process.exitCode=1; });
