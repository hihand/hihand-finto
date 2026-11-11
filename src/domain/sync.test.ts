import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FintoDB, SYNC_TABLES, now } from '../db/schema';
import { seedIfEmpty } from '../db/seed';
import { addPerson } from '../domain/catalog';
import { setOpening } from './debt';
import { saveIncome, setOpeningBalance } from './income';
import { creditOf, deleteTransaction, returnCredit, saveExpense, settle } from './ledger';
import { periodRange } from './period';
import { balanceAt, makeIndex, periodStats, personalBalanceAt, type Snapshot } from './stats';
import { buildPackage, getPeers, importPackage, packageSize, packageToText, pendingFor, readPackage, setDeviceName, type SyncPackage } from './sync';

const NOV = periodRange('2026-11');
const open = async (name: string) => {
  const d = new FintoDB(`sync-${name}-${crypto.randomUUID()}`);
  await seedIfEmpty(d);
  await setDeviceName(d, name);
  return d;
};
const snap = async (d: FintoDB): Promise<Snapshot> => ({
  people: await d.people.toArray(), categories: await d.categories.toArray(), tags: await d.tags.toArray(),
  categoryTags: await d.categoryTags.toArray(), transactions: await d.transactions.toArray(), transactionTags: await d.transactionTags.toArray(),
  shares: await d.shares.toArray(), settlements: await d.settlements.toArray(), allocations: await d.allocations.toArray(),
  incomes: await d.incomes.toArray(), payables: await d.payables.toArray(), repayments: await d.repayments.toArray(), settings: await d.settings.get('settings'),
});
const ix = async (d: FintoDB) => makeIndex(await snap(d));
/** Nội dung các bảng đồng bộ (bỏ _seq — số thứ tự riêng của từng máy). */
const content = async (d: FintoDB) => {
  const out: Record<string, unknown[]> = {};
  for (const t of SYNC_TABLES) {
    out[t] = ((await d.table(t).toArray()) as Record<string, unknown>[])
      .map(({ _seq: _s, ...r }) => r).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return out;
};
/** Gửi gói từ `a` sang `b` (qua file JSON, như thật). */
const send = async (a: FintoDB, b: FintoDB, password?: string) => {
  const bId = ((await b.meta.get('device'))!.value as { id: string }).id;
  const peers = await getPeers(a);
  const pkg = await buildPackage(a, peers[bId] ? bId : null);
  const text = await packageToText(pkg, password);
  const read = await readPackage(text, password);
  if (!('pkg' in read)) throw new Error('cần mật khẩu');
  return { pkg, report: await importPackage(b, read.pkg) };
};
const cat = async (d: FintoDB, n: string) => (await d.categories.filter((c) => c.name === n && !c.deletedAt && c.kind !== 'income').first())!.id;
const person = async (d: FintoDB, n: string) => (await d.people.filter((p) => p.name === n && !p.deletedAt).first())!.id;
const lunch = async (d: FintoDB, amount: number, date = '2026-11-05') => saveExpense(d, {
  date, kind: 'expense', categoryId: await cat(d, 'Bữa chính'), title: 'Ăn trưa', totalAmount: amount, splitMode: 'equal', tagIds: [],
  shares: [{ personId: null, type: 'mine', amount }],
});

let A: FintoDB, B: FintoDB;
beforeEach(async () => {
  A = await open('PC1');
  B = await open('PC2');
});

describe('đồng bộ hai trình duyệt bằng gói JSON', () => {
  it('lần đầu: gộp hai sổ, danh mục mặc định không bị nhân đôi; hai bên giống hệt nhau', async () => {
    await lunch(A, 100_000);
    await lunch(B, 50_000);
    const catsBefore = (await A.categories.toArray()).length;
    const first = await send(A, B);
    expect(first.report.fixes.join(' ')).toMatch(/danh mục trùng/);
    await send(B, A);
    expect(await content(A)).toEqual(await content(B));
    // Danh mục còn sống đúng bằng một bộ mặc định; khoản chi của B đã chuyển sang danh mục giữ lại.
    expect((await A.categories.toArray()).filter((c) => !c.deletedAt)).toHaveLength(catsBefore);
    const x = await ix(A);
    expect(periodStats(x, NOV).mine).toBe(150_000);
    expect(periodStats(x, NOV).byCategory).toHaveLength(1);
  });

  it('chỉ gửi phần thay đổi; nhận rồi thì không gửi lại; gói thứ hai gọn', async () => {
    await lunch(A, 100_000);
    await send(A, B);
    await send(B, A); // B xác nhận đã nhận của A
    await lunch(A, 20_000, '2026-11-06');
    const { pkg } = await send(A, B);
    // Chỉ 1 giao dịch + 1 phần chia mới (không gửi lại cả sổ, không gửi lại những gì vừa nhận từ B).
    expect(packageSize(pkg)).toBe(2);
    const bId = ((await B.meta.get('device'))!.value as { id: string }).id;
    expect(await pendingFor(A, bId)).toBe(2); // B chưa xác nhận gói vừa rồi
    await send(B, A);
    expect(await pendingFor(A, bId)).toBe(0);
    expect(await content(A)).toEqual(await content(B));
  });

  it('cùng sửa một bản ghi ở hai máy: bản sửa sau thắng; xóa ở một máy thì máy kia cũng xóa', async () => {
    const txId = await lunch(A, 100_000);
    await send(A, B);
    await send(B, A);
    await A.transactions.update(txId, { title: 'Sửa ở PC1', updatedAt: now() });
    await B.transactions.update(txId, { title: 'Sửa ở PC2', updatedAt: now() }); // sau
    await send(A, B);
    await send(B, A);
    expect((await A.transactions.get(txId))!.title).toBe('Sửa ở PC2');
    expect(await content(A)).toEqual(await content(B));

    await deleteTransaction(A, txId);
    await send(A, B);
    expect((await B.transactions.get(txId))!.deletedAt).toBeTruthy();
    expect(periodStats(await ix(B), NOV).mine).toBe(0);
  });

  it('người, tag thêm riêng ở hai máy với cùng tên được gộp; khoản nợ và tiền giữ đi theo', async () => {
    await addPerson(A, 'Mẹ');
    await addPerson(B, 'Mẹ');
    await setOpening(A, { personId: await person(A, 'Mẹ'), date: '2026-11-01', held: 0, owedByMe: 12_000_000, owedToMe: 0 });
    await settle(B, { personId: await person(B, 'Mẹ'), date: '2026-11-02', amount: 2_000_000, picks: [] });
    await send(A, B);
    await send(B, A);
    for (const d of [A, B]) {
      const x = await ix(d);
      expect(x.people).toHaveLength(1);
      const mom = x.people[0].id;
      expect(await creditOf(d, mom)).toBe(2_000_000);
      expect(x.payables.filter((p) => p.personId === mom)).toHaveLength(1);
    }
    expect(await content(A)).toEqual(await content(B));
  });

  it('ba trình duyệt: thay đổi đi vòng A → B → C', async () => {
    const C = await open('Laptop');
    await lunch(A, 100_000);
    await send(A, B);
    await send(B, C);
    expect(periodStats(await ix(C), NOV).mine).toBe(100_000);
    await lunch(C, 30_000);
    await send(C, B);
    await send(B, A);
    expect(periodStats(await ix(A), NOV).mine).toBe(130_000);
    await send(A, C);
    await send(C, A);
    await send(A, B);
    await send(B, C);
    expect(await content(A)).toEqual(await content(B));
    expect(await content(B)).toEqual(await content(C));
  });

  it('cài đặt dùng chung (số dư ban đầu) đồng bộ; giao diện thì không', async () => {
    await setOpeningBalance(A, 5_000_000, '2026-11-01');
    await B.settings.update('settings', { theme: 'light' });
    await send(A, B);
    const s = await B.settings.get('settings');
    expect(s).toMatchObject({ openingBalance: 5_000_000, openingDate: '2026-11-01', theme: 'light' });
    await saveIncome(B, { date: '2026-11-03', categoryId: (await B.categories.filter((c) => c.name === 'Lương').first())!.id, amount: 1_000_000, title: '', personId: null });
    await send(B, A);
    expect(balanceAt(await ix(A))).toBe(6_000_000);
    expect((await A.settings.get('settings'))!.theme).toBe('dark');
  });

  it('gộp làm tiền giữ âm (hai máy cùng dùng tiền giữ): tự gỡ khoản tự trừ và báo lại', async () => {
    await addPerson(A, 'Mẹ');
    const mom = await person(A, 'Mẹ');
    await settle(A, { personId: mom, date: '2026-11-01', amount: 1_000_000, picks: [] });
    await send(A, B);
    await send(B, A);
    // PC1 trả lại 1tr cho mẹ; PC2 (chưa biết) chi hộ 1tr trừ vào tiền giữ.
    await returnCredit(A, mom, 1_000_000, '2026-11-05');
    await saveExpense(B, {
      date: '2026-11-05', kind: 'expense', categoryId: await cat(B, 'Điện'), title: 'Điện nhà mẹ', totalAmount: 1_000_000, splitMode: 'custom', tagIds: [],
      shares: [{ personId: mom, type: 'owe', amount: 1_000_000 }], onBehalf: true,
    });
    const { report } = await send(B, A);
    expect(report.fixes.join(' ')).toMatch(/tiền giữ bị âm/);
    expect(await creditOf(A, mom)).toBe(0);
    await send(A, B);
    expect(await content(A)).toEqual(await content(B));
    expect(personalBalanceAt(await ix(A))).toBe(personalBalanceAt(await ix(B)));
  });
});

describe('gói đồng bộ', () => {
  it('mã hóa bằng mật khẩu; sai mật khẩu thì báo lỗi; không nhập gói của chính mình; không nhận file sao lưu', async () => {
    await lunch(A, 100_000);
    const text = await packageToText(await buildPackage(A, null), 'bí mật');
    expect(text).not.toContain('Ăn trưa');
    expect(await readPackage(text)).toMatchObject({ needPassword: true, fromName: 'PC1' });
    await expect(readPackage(text, 'sai')).rejects.toThrow(/Sai mật khẩu/);
    const ok = await readPackage(text, 'bí mật');
    expect('pkg' in ok && packageSize(ok.pkg)).toBeGreaterThan(0);
    await expect(importPackage(A, (ok as { pkg: SyncPackage }).pkg)).rejects.toThrow(/chính trình duyệt này/);
    await expect(readPackage(JSON.stringify({ app: 'hihand-finto', version: 1, tables: {} }))).rejects.toThrow(/file sao lưu/);
    await expect(readPackage(JSON.stringify({ app: 'hihand-finto', kind: 'sync', v: 1, from: { id: 'x', name: 'x' }, tables: { evil: [] } }))).rejects.toThrow();
  });

  it('nhập lại cùng một gói hai lần không đổi gì', async () => {
    await lunch(A, 100_000);
    const pkg = await buildPackage(A, null);
    await importPackage(B, pkg);
    const before = await content(B);
    const again = await importPackage(B, pkg);
    expect(again.added + again.updated).toBe(0);
    expect(await content(B)).toEqual(before);
  });

  it('bỏ lỡ một gói: không xác nhận nhầm, gói sau tự gửi lại phần thiếu', async () => {
    await lunch(A, 100_000);
    await send(A, B);
    await send(B, A);
    const bId = ((await B.meta.get('device'))!.value as { id: string }).id;
    await lunch(A, 10_000, '2026-11-07');
    await buildPackage(A, bId); // gói này bị thất lạc
    await lunch(A, 20_000, '2026-11-08');
    await send(A, B); // gói mới vẫn chứa cả hai khoản vì B chưa xác nhận
    expect(periodStats(await ix(B), NOV).mine).toBe(130_000);
  });
});
