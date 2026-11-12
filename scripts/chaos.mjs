#!/usr/bin/env node
// Switch a test fault on or off (development only: the API must run with CHAOS_ENABLED=true).
//
//   node scripts/chaos.mjs DB_TIMEOUT --duration 120          slow queries + 40 % database errors for 2 min
//   node scripts/chaos.mjs LATENCY --latency 2500 --duration 90
//   node scripts/chaos.mjs ERROR --rate 0.3
//   node scripts/chaos.mjs status
//   node scripts/chaos.mjs off
//
// Logs in as the super admin (--email, --password; default the demo admin). --api or API_URL as in load.mjs.
const [cmd = 'status', ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const API = (opt('api') ?? process.env.API_URL ?? 'http://localhost:3000/api/v1').replace(/\/$/, '');

const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: opt('email') ?? 'admin@pos.local', password: opt('password') ?? 'Password@123' }),
});
if (!login.ok) {
  console.error(`login failed: HTTP ${login.status}`);
  process.exit(1);
}
const { accessToken } = await login.json();
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` };

let res;
if (cmd === 'status') res = await fetch(`${API}/chaos`, { headers });
else if (cmd === 'off') res = await fetch(`${API}/chaos`, { method: 'DELETE', headers });
else if (['LATENCY', 'ERROR', 'DB_TIMEOUT'].includes(cmd.toUpperCase())) {
  const body = { type: cmd.toUpperCase() };
  if (opt('latency')) body.latencyMs = Number(opt('latency'));
  if (opt('rate')) body.errorRate = Number(opt('rate'));
  if (opt('duration')) body.durationSec = Number(opt('duration'));
  res = await fetch(`${API}/chaos`, { method: 'POST', headers, body: JSON.stringify(body) });
} else {
  console.error('usage: node scripts/chaos.mjs LATENCY|ERROR|DB_TIMEOUT [--latency ms] [--rate 0-1] [--duration s] | status | off');
  process.exit(2);
}
if (res.status === 404) {
  console.error('No fault injection on this API: start it with CHAOS_ENABLED=true (never in production).');
  process.exit(1);
}
console.log(JSON.stringify(await res.json(), null, 2));
process.exit(res.ok ? 0 : 1);
