import { DashboardDemo } from './demo';
async function seed() {
  if (process.env.DASHBOARD_DEMO !== '1' || !process.env.DATABASE_URL) throw new Error('Explicit DASHBOARD_DEMO=1 and DATABASE_URL required');
  const demo = DashboardDemo.connect(process.env.DATABASE_URL);
  try { console.log(JSON.stringify(await demo.seed())); } finally { await demo.close(); }
}
void seed().catch(() => { console.error('Demo seed failed; check local configuration'); process.exitCode = 1; });
