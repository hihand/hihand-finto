// Integration test for the relay. Run `npm run dev:test` (rooms expire after 3 s) in another shell, then `npm test`.
// Uses Node 22's built-in WebSocket (undici), which accepts custom headers for the Origin check.
import assert from 'node:assert/strict';

const BASE = process.env.RELAY ?? 'ws://127.0.0.1:8787';
const ORIGIN = 'http://localhost:5173';
const rid = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');

/** Open a socket and collect what arrives. */
function open(room, role, origin = ORIGIN) {
  const ws = new WebSocket(`${BASE}/room/${room}?role=${role}`, { headers: { Origin: origin } });
  ws.binaryType = 'arraybuffer';
  const got = { text: [], bin: [], close: null, error: false };
  ws.addEventListener('message', (e) => (typeof e.data === 'string' ? got.text : got.bin).push(e.data));
  ws.addEventListener('close', (e) => { got.close = e.code; });
  ws.addEventListener('error', () => { got.error = true; });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ready.catch(() => {});
  return { ws, got, ready };
}
const until = async (f, ms = 3000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
};
const tests = [];
const test = (n, f) => tests.push([n, f]);

test('health endpoint', async () => {
  const r = await fetch(BASE.replace('ws', 'http') + '/');
  assert.equal(r.status, 200);
});

test('pairs host and guest and forwards binary frames both ways', async () => {
  const room = rid();
  const h = open(room, 'host'); await h.ready;
  const g = open(room, 'guest'); await g.ready;
  await until(() => h.got.text.length && g.got.text.length);
  assert.deepEqual(JSON.parse(h.got.text[0]), { relay: 'paired' });
  assert.deepEqual(JSON.parse(g.got.text[0]), { relay: 'paired' });
  h.ws.send(new Uint8Array([1, 2, 3]));
  g.ws.send(new Uint8Array(300 * 1024).fill(7));
  await until(() => g.got.bin.length && h.got.bin.length);
  assert.deepEqual([...new Uint8Array(g.got.bin[0])], [1, 2, 3]);
  assert.equal(h.got.bin[0].byteLength, 300 * 1024);
  // ping is answered by the relay, not forwarded
  h.ws.send('ping');
  await until(() => h.got.text.includes('pong'));
  assert.equal(g.got.text.includes('ping'), false);
  // guest leaves → host is told and closed
  g.ws.close(1000);
  await until(() => h.got.close !== null);
  assert.equal(h.got.close, 4001);
});

test('refuses a third device and a guest without host', async () => {
  const room = rid();
  const h = open(room, 'host'); await h.ready;
  const g = open(room, 'guest'); await g.ready;
  const x = open(room, 'guest'); await x.ready;
  await until(() => x.got.close !== null);
  assert.equal(x.got.close, 4002);
  const y = open(room, 'host'); await y.ready;
  await until(() => y.got.close !== null);
  assert.equal(y.got.close, 4002);
  // the pair still works
  h.ws.send(new Uint8Array([9]));
  await until(() => g.got.bin.length);
  h.ws.close(); g.ws.close();
  const lone = open(rid(), 'guest'); await lone.ready;
  await until(() => lone.got.close !== null);
  assert.equal(lone.got.close, 4004);
});

test('rejects other origins and bad room ids', async () => {
  const bad = open(rid(), 'host', 'https://evil.example');
  await until(() => bad.got.error || bad.got.close !== null);
  const short = open('short', 'host');
  await until(() => short.got.error || short.got.close !== null);
  assert.equal(short.got.bin.length + short.got.text.length, 0);
});

test('a waiting room expires (WAIT_SECONDS=3)', async () => {
  const room = rid();
  const h = open(room, 'host'); await h.ready;
  setInterval(() => {}, 1000).unref();
  // The relay announces the expiry and closes with 4008. (Under `wrangler dev` the close frame sent from an alarm
  // does not always reach the client, so clients treat a {"relay":"error"} message as final and close themselves.)
  await until(() => h.got.text.some((t) => t.includes('expired')), 8000);
  h.ws.close();
  // the expired room can not be joined
  const g = open(room, 'guest'); await g.ready;
  await until(() => g.got.close !== null);
  assert.equal(g.got.close, 4004);
});

let fail = 0;
for (const [n, f] of tests) {
  try { await f(); console.log('✓', n); } catch (e) { fail++; console.log('✗', n, '\n ', e); }
}
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
