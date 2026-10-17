import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

function runSmoke(t: TestContext, scenario: string) {
  const root = mkdtempSync(join(tmpdir(),'ms-dashboard-smoke-'));
  t.after(() => rmSync(root,{ recursive: true, force: true }));
  mkdirSync(join(root,'scripts')); mkdirSync(join(root,'evidence'));
  const script = join(root,'scripts/dashboard-demo-smoke.cjs'), client = join(root,'client.mjs');
  copyFileSync(resolve(__dirname,'../../scripts/dashboard-demo-smoke.cjs'),script);
  // Only the adapter result is synthetic here. Execute the actual smoke script in a child,
  // keeping its evidence output out of the checkout. Live adapter/SQL tests remain separate.
  writeFileSync(client, `
    export async function requestDashboard(_endpoint, query) {
      const scenario = process.env.MINDSPACE_SMOKE_SCENARIO;
      const calendarDays = { today:1, week:7, '30days':30 }[query.period];
      const start = new Date(Date.parse('2026-10-17T05:00:00.000Z')-(calendarDays-1)*86400000).toISOString();
      const empty = scenario === 'empty' || (scenario === 'partial' && query.period === 'today');
      return {
        source:'db-demo', connected:4, reconnecting:2,
        sessions:Array.from({length:6},(_,i)=>({id:'DEMO-'+i})),
        concurrency:scenario === 'missing-history' ? null : empty ? [] : [{at:start,count:4}],
        completed:scenario === 'invalid-count' ? -1 : empty ? 0 : 3,
        forecast:null, range:{start,end:'2026-10-17T17:00:00.000Z',calendarDays},
        granularity:calendarDays === 1 ? 'intraday' : 'daily',
        health:[{name:'Voice service',status:'Unknown'}],
      };
    }
  `);
  const result = spawnSync(process.execPath,[script,`--client=${client}`],{
    encoding:'utf8', timeout:5000, env:{ ...process.env, MINDSPACE_SMOKE_SCENARIO:scenario },
  });
  return { result, evidence:join(root,'evidence/dashboard-db-demo.json') };
}

test('demo smoke accepts persisted fixtures with empty Today/week/month ranges', t => {
  const { result, evidence } = runSmoke(t,'empty');
  assert.equal(result.status,0,result.stderr);
  const value = JSON.parse(readFileSync(evidence,'utf8'));
  assert.deepEqual(value.snapshots.map((s: { completed: number }) => s.completed),[0,0,0]);
  assert(value.snapshots.every((s: { concurrency: unknown[] }) => s.concurrency.length === 0));
});
test('demo smoke accepts partial history and equal completion totals across ranges', t => {
  for (const scenario of ['partial','equal']) {
    const { result, evidence } = runSmoke(t,scenario);
    assert.equal(result.status,0,result.stderr);
    const value = JSON.parse(readFileSync(evidence,'utf8'));
    assert.deepEqual(value.snapshots.map((s: { completed: number }) => s.completed),scenario === 'partial' ? [0,3,3] : [3,3,3]);
    assert.deepEqual(value.snapshots.map((s: { concurrency: unknown[] }) => s.concurrency.length),scenario === 'partial' ? [0,1,1] : [1,1,1]);
  }
});
test('demo smoke still rejects missing history and invalid completion counts', t => {
  for (const scenario of ['missing-history','invalid-count']) {
    const { result } = runSmoke(t,scenario);
    assert.equal(result.status,1);
    assert.match(result.stderr,scenario === 'missing-history' ? /Array.isArray/ : /Number.isInteger/);
  }
});
