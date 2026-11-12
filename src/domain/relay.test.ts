import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FintoDB, SYNC_TABLES } from '../db/schema';
import { seedIfEmpty } from '../db/seed';
import { addPerson } from './catalog';
import { saveExpense } from './ledger';
import { inviteLink, newKey, parseInvite, roomOf, runSync, type RelayResult, type Transport } from './relay';
import { getDevice, pendingFor, setDeviceName } from './sync';

const open = async (name: string) => {
  const d = new FintoDB(`relay-${name}-${crypto.randomUUID()}`);
  await seedIfEmpty(d);
  await setDeviceName(d, name);
  return d;
};
const content = async (d: FintoDB) => {
  const out: Record<string, unknown[]> = {};
  for (const t of SYNC_TABLES) {
    out[t] = ((await d.table(t).toArray()) as Record<string, unknown>[])
      .map(({ _seq: _s, ...r }) => r).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return out;
};
const cat = async (d: FintoDB, n: string) => (await d.categories.filter((c) => c.name === n && !c.deletedAt && c.kind !== 'income').first())!.id;
const spend = async (d: FintoDB, amount: number, title = 'Ăn trưa') => saveExpense(d, {
  date: '2026-11-05', kind: 'expense', categoryId: await cat(d, 'Bữa chính'), title, totalAmount: amount, splitMode: 'equal', tagIds: [],
  shares: [{ personId: null, type: 'mine', amount }],
});
const liveTx = async (d: FintoDB) => (await d.transactions.toArray()).filter((t) => !t.deletedAt).length;

/**
 * Two connected in-memory transports, standing in for the relay. Frames are delivered asynchronously and in order.
 * `cutAfter`: drop the connection after that many frames went through (both sides see "left").
 */
function pair(opts: { cutAfter?: number; tamper?: (f: Uint8Array, from: 'host' | 'guest') => Uint8Array | null } = {}) {
  let frames = 0;
  let closed = false;
  const mk = (side: 'host' | 'guest') => {
    const queue: Uint8Array[] = [];
    let onFrame: ((f: Uint8Array) => void) | null = null;
    let onClose: ((c: string) => void) | null = null;
    let pendingClose: string | null = null;
    return {
      side,
      deliver(f: Uint8Array) { if (onFrame) onFrame(f); else queue.push(f); },
      closeWith(code: string) { if (onClose) onClose(code); else pendingClose = code; },
      t: {
        send(f: Uint8Array) {
          if (closed) return;
          if (opts.cutAfter !== undefined && ++frames > opts.cutAfter) { cut('left'); return; }
          const g = opts.tamper ? opts.tamper(f, side) : f;
          if (g) setTimeout(() => !closed && other(side).deliver(g.slice()), 0);
        },
        listen(f: (x: Uint8Array) => void, c: (code: string) => void) {
          onFrame = f;
          onClose = c;
          queue.splice(0).forEach(f);
          if (pendingClose) c(pendingClose);
        },
        close() { if (!closed) setTimeout(() => cut('left'), 5); },
      } satisfies Transport,
    };
  };
  const host = mk('host');
  const guest = mk('guest');
  const other = (s: 'host' | 'guest') => (s === 'host' ? guest : host);
  const cut = (code: string) => {
    if (closed) return;
    closed = true;
    host.closeWith(code);
    guest.closeWith(code);
  };
  return { host: host.t, guest: guest.t };
}

/** One live session: `h` shows the QR, `g` scans it. */
async function session(h: FintoDB, g: FintoDB, opts: Parameters<typeof pair>[0] & { chunk?: number; guestKey?: Uint8Array; guestSchema?: number } = {}) {
  const key = newKey();
  const p = pair(opts);
  return Promise.allSettled([
    runSync(h, p.host, key, 'host', { chunk: opts.chunk }),
    runSync(g, p.guest, opts.guestKey ?? key, 'guest', { chunk: opts.chunk, schema: opts.guestSchema }),
  ]);
}
const ok = (r: PromiseSettledResult<RelayResult>) => {
  if (r.status === 'rejected') throw r.reason;
  return r.value;
};
const id = async (d: FintoDB) => (await getDevice(d)).id;

let PC1: FintoDB, PC2: FintoDB, M: FintoDB;
beforeEach(async () => {
  PC1 = await open('PC1');
  PC2 = await open('PC2');
  M = await open('iPhone');
});

describe('invite links', () => {
  it('round-trips the key; the room id is derived and does not reveal the key', async () => {
    const key = newKey();
    const link = inviteLink('https://finto.hihandlabs.online/', key);
    expect(link).toMatch(/^https:\/\/finto\.hihandlabs\.online\/#sync=[A-Za-z0-9_-]{43}$/);
    expect(parseInvite(link)).toEqual(key);
    expect(parseInvite(`  ${link.split('#')[1]} `)).toEqual(key);
    expect(parseInvite('https://finto.hihandlabs.online/#sync=abc')).toBeNull();
    const room = await roomOf(key);
    expect(room).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(link).not.toContain(room);
    expect(await roomOf(key)).toBe(room);
  });
});

describe('live sync through the relay', () => {
  it('first session: both ledgers end identical, both sides know the other has everything', async () => {
    await spend(PC1, 100_000);
    await spend(M, 50_000);
    await addPerson(M, 'Mẹ');
    const [h, g] = (await session(PC1, M)).map(ok);
    expect(h.peer.name).toBe('iPhone');
    expect(g.peer.name).toBe('PC1');
    expect(h.full && g.full).toBe(true);
    expect(await content(PC1)).toEqual(await content(M));
    expect(await liveTx(PC1)).toBe(2);
    expect(await pendingFor(PC1, await id(M))).toBe(0);
    expect(await pendingFor(M, await id(PC1))).toBe(0);
  });

  it('next session only sends the changes', async () => {
    await spend(PC1, 100_000);
    ok((await session(PC1, M))[0]);
    await spend(M, 20_000, 'Cà phê');
    const [h, g] = (await session(PC1, M)).map(ok);
    expect(h.sent).toBe(0);
    expect(h.full).toBe(false);
    expect(g.sent).toBe(2); // 1 transaction + 1 share
    expect(h.report.added).toBe(2);
    expect(await content(PC1)).toEqual(await content(M));
  });

  it('three devices through a phone as hub: M↔PC1, M↔PC2, M↔PC1 → all identical', async () => {
    await spend(PC1, 100_000, 'PC1');
    await spend(PC2, 200_000, 'PC2');
    await spend(M, 300_000, 'M');
    (await session(PC1, M)).map(ok); // phone scans PC1
    (await session(PC2, M)).map(ok); // phone scans PC2
    (await session(PC1, M)).map(ok); // phone scans PC1 again
    const c = await content(M);
    expect(await content(PC1)).toEqual(c);
    expect(await content(PC2)).toEqual(c);
    expect(await liveTx(PC2)).toBe(3);
    // the phone can also be the host
    await spend(PC2, 1_000, 'later');
    (await session(M, PC2)).map(ok);
    expect(await liveTx(M)).toBe(4);
  });

  it('large package split into many chunks', async () => {
    for (let i = 0; i < 40; i++) await spend(PC1, 1_000 + i, `Món ${i}`);
    const [h] = (await session(PC1, M, { chunk: 512 })).map(ok);
    expect(h.sent).toBeGreaterThan(80);
    expect(await liveTx(M)).toBe(40);
    expect(await content(PC1)).toEqual(await content(M));
  });

  it('wrong key: both sides stop, nothing merged', async () => {
    await spend(PC1, 100_000);
    const [h, g] = await session(PC1, M, { guestKey: newKey() });
    expect(h.status).toBe('rejected');
    expect(g.status).toBe('rejected');
    expect((h as PromiseRejectedResult).reason.code).toBe('key');
    expect(await liveTx(M)).toBe(0);
  });

  it('different app versions are refused', async () => {
    const [h, g] = await session(PC1, M, { guestSchema: M.verno - 1 });
    expect((h as PromiseRejectedResult).reason.code).toBe('version');
    expect((g as PromiseRejectedResult).reason.code).toMatch(/version|peer/);
  });

  it('connection lost halfway: nothing partial is merged, the next session completes', async () => {
    for (let i = 0; i < 20; i++) await spend(PC1, 1_000 + i, `Món ${i}`);
    const r = await session(PC1, M, { chunk: 256, cutAfter: 6 });
    expect(r.every((x) => x.status === 'rejected')).toBe(true);
    expect((r[1] as PromiseRejectedResult).reason.code).toBe('left');
    expect(await liveTx(M)).toBe(0);
    (await session(PC1, M, { chunk: 256 })).map(ok);
    expect(await content(PC1)).toEqual(await content(M));
  });

  it('a relay that reflects or replays frames is detected', async () => {
    let first: Uint8Array | null = null;
    const r = await session(PC1, M, {
      // replay the host's first frame instead of its second one
      tamper: (f, from) => {
        if (from !== 'host') return f;
        if (!first) { first = f; return f; }
        return first;
      },
    });
    expect((r[1] as PromiseRejectedResult).reason.code).toBe('key');
  });
});
