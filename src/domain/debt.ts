import { base, now, type FintoDB, type Payable, type RepayMode } from '../db/schema';
import { assertDate, assertPayablesOk, creditOf, openDebts, openPayables, owedOf, splitPayables } from './ledger';

/**
 * Two-way debts (UC-14..UC-19).
 * Rule: OPENING amounts are off the books (they happened before using the app); amounts CREATED IN THE APP are on the books.
 * Derived numbers live in stats.ts; this file only writes data, and every operation runs in one IndexedDB transaction.
 */

const T = (db: FintoDB) => [db.transactions, db.shares, db.settlements, db.allocations, db.payables, db.repayments, db.incomes];
const positive = (n: number, label = 'Số tiền') => {
  if (!Number.isFinite(n) || n < 0 || Math.round(n) !== n) throw new Error(`${label} không hợp lệ`);
};

export interface OpeningInput {
  personId: string;
  date: string;
  /** Held for that person (the money is still in the account). */
  held: number;
  /** I owe that person (already spent). */
  owedByMe: number;
  /** That person owes me. */
  owedToMe: number;
}

/** Current opening amounts of a person (0 if not entered). */
export async function getOpening(db: FintoDB, personId: string) {
  const st = (await db.settlements.where('personId').equals(personId).toArray()).find((s) => !s.deletedAt && s.opening);
  const pay = (await db.payables.where('personId').equals(personId).toArray()).find((p) => !p.deletedAt && p.origin === 'opening');
  const sh = await openingShare(db, personId);
  return {
    date: st?.date ?? pay?.date ?? sh?.tx.date,
    held: st?.amount ?? 0, owedByMe: pay?.amount ?? 0, owedToMe: sh?.share.amount ?? 0,
  };
}

async function openingShare(db: FintoDB, personId: string) {
  for (const share of await db.shares.where('personId').equals(personId).toArray()) {
    if (share.deletedAt || share.type !== 'owe') continue;
    const tx = await db.transactions.get(share.transactionId);
    if (tx && !tx.deletedAt && tx.opening) return { share, tx };
  }
  return undefined;
}

/**
 * UC-14: enter (or edit) a person's opening amounts. Not income, not money in/out,
 * not in period stats. 0 = remove that part. Cannot go below what was already used / repaid.
 */
export async function setOpening(db: FintoDB, input: OpeningInput) {
  assertDate(input.date);
  positive(input.held, 'Số đang giữ');
  positive(input.owedByMe, 'Số tôi đang nợ');
  positive(input.owedToMe, 'Số họ đang nợ');
  const { personId, date } = input;
  return db.transaction('rw', T(db), async () => {
    const t = now();
    // Opening held money: a settlement flagged as opening.
    const st = (await db.settlements.where('personId').equals(personId).toArray()).find((s) => !s.deletedAt && s.opening);
    if (st && input.held === 0) await db.settlements.update(st.id, { deletedAt: t, updatedAt: t });
    else if (st) await db.settlements.update(st.id, { amount: input.held, date, updatedAt: t });
    else if (input.held > 0) await db.settlements.add({ ...base(), personId, date, amount: input.held, direction: 'in', opening: true, note: 'Số đầu kỳ' });
    if ((await creditOf(db, personId)) < 0) throw new Error('Tiền đang giữ đầu kỳ đã được dùng nhiều hơn số mới');

    // Opening amount I owe.
    const pay = (await db.payables.where('personId').equals(personId).toArray()).find((p) => !p.deletedAt && p.origin === 'opening');
    if (pay && input.owedByMe === 0) await db.payables.update(pay.id, { deletedAt: t, updatedAt: t });
    else if (pay) await db.payables.update(pay.id, { amount: input.owedByMe, date, updatedAt: t });
    else if (input.owedByMe > 0) await db.payables.add({ ...base(), personId, date, amount: input.owedByMe, origin: 'opening', note: 'Số đầu kỳ' });
    if (pay && input.owedByMe === 0) {
      const touched = [
        ...(await db.repayments.where('payableId').equals(pay.id).toArray()).filter((r) => !r.deletedAt),
        ...(await db.allocations.where('personId').equals(personId).toArray()).filter((a) => !a.deletedAt && a.payableId === pay.id),
      ];
      if (touched.length) throw new Error('Khoản nợ đầu kỳ đã có lần trả / cấn trừ; hãy xóa các lần đó trước');
    }
    await assertPayablesOk(db, personId);

    // Opening amount they owe me: an opening transaction with one Owed share.
    const cur = await openingShare(db, personId);
    if (cur) {
      const paid = (await db.allocations.where('shareId').equals(cur.share.id).toArray()).filter((a) => !a.deletedAt).reduce((s, a) => s + a.amount, 0);
      if (input.owedToMe < paid) throw new Error(`Khoản họ nợ đầu kỳ đã trả / bỏ qua ${paid.toLocaleString('vi-VN')}đ`);
      if (input.owedToMe === 0) {
        await db.transactions.update(cur.tx.id, { deletedAt: t, updatedAt: t });
        await db.shares.update(cur.share.id, { deletedAt: t, updatedAt: t });
      } else {
        await db.transactions.update(cur.tx.id, { totalAmount: input.owedToMe, date, updatedAt: t });
        await db.shares.update(cur.share.id, { amount: input.owedToMe, updatedAt: t });
      }
    } else if (input.owedToMe > 0) {
      const tx = { ...base(), date, kind: 'transfer' as const, categoryId: '', title: 'Số đầu kỳ', totalAmount: input.owedToMe, splitMode: 'custom' as const, opening: true };
      await db.transactions.add(tx);
      await db.shares.add({ ...base(), transactionId: tx.id, personId, type: 'owe', amount: input.owedToMe });
    }
  });
}

/** UC-15a (new loan): that person sends me money, the account goes up, I owe them. Not income. */
export async function borrow(db: FintoDB, input: { personId: string; date: string; amount: number; note?: string }) {
  return addPayable(db, { ...input, origin: 'borrow' });
}

/** UC-15b: part of held money was spent → turn it into a debt (held goes down, what I owe goes up). */
export async function heldToDebt(db: FintoDB, input: { personId: string; date: string; amount: number; note?: string }) {
  return addPayable(db, { ...input, origin: 'fromHeld' });
}

async function addPayable(db: FintoDB, input: { personId: string; date: string; amount: number; note?: string; origin: Payable['origin'] }) {
  if (!(input.amount > 0)) throw new Error('Số tiền phải lớn hơn 0');
  assertDate(input.date);
  return db.transaction('rw', T(db), async () => {
    if (input.origin === 'fromHeld') {
      const credit = await creditOf(db, input.personId);
      if (input.amount > credit) throw new Error(`Chỉ đang giữ ${credit.toLocaleString('vi-VN')}đ`);
    }
    const row = { ...base(), personId: input.personId, date: input.date, amount: Math.round(input.amount), origin: input.origin, note: input.note?.trim() || undefined };
    await db.payables.add(row);
    return row.id;
  });
}

/** Delete a loan / held-money debt (undo). Not allowed once it has repayments / offsets. */
export async function deletePayable(db: FintoDB, id: string) {
  return db.transaction('rw', T(db), async () => {
    const p = await db.payables.get(id);
    if (!p || p.deletedAt) return;
    const used = (await openPayables(db, p.personId)).find((x) => x.payable.id === id)?.used ?? 0;
    if (used > 0) throw new Error('Khoản nợ này đã có lần trả / cấn trừ; hãy xóa các lần đó trước');
    await db.payables.update(id, { deletedAt: now(), updatedAt: now() });
  });
}

export interface RepayInput {
  personId: string;
  date: string;
  amount: number;
  /** 'hold' (default): keep the money in the account for that person. 'transfer': pay by bank transfer. */
  mode?: Exclude<RepayMode, 'waive'>;
  note?: string;
  incomeId?: string | null;
}

/** Write a repayment (call inside a transaction that includes all tables). */
export async function writeRepay(db: FintoDB, input: Omit<RepayInput, 'mode'> & { mode: RepayMode }) {
  if (!(input.amount > 0)) throw new Error('Số tiền phải lớn hơn 0');
  assertDate(input.date);
  const ids: string[] = [];
  const batch = crypto.randomUUID();
  for (const part of await splitPayables(db, input.personId, Math.round(input.amount))) {
    const row = {
      ...base(), personId: input.personId, payableId: part.payableId, date: input.date, amount: part.amount, mode: input.mode,
      incomeId: input.incomeId ?? null, note: input.note?.trim() || undefined, batch,
    };
    await db.repayments.add(row);
    ids.push(row.id);
  }
  return ids;
}

/** UC-16: repay (on its own, or tied to an income via saveIncome). Returns ids for undo. */
export async function repay(db: FintoDB, input: RepayInput) {
  return db.transaction('rw', T(db), async () => await writeRepay(db, { ...input, mode: input.mode ?? 'hold' }));
}

/** UC-18: that person forgives what I owe (partly or fully). No money moves. */
export async function waiveDebt(db: FintoDB, input: { personId: string; date: string; amount: number; note?: string }) {
  return db.transaction('rw', T(db), async () => await writeRepay(db, { ...input, mode: 'waive' }));
}

/** Delete (undo) repayments. A 'hold' repayment whose held money was already used cannot be deleted. */
export async function deleteRepayments(db: FintoDB, ids: string[]) {
  return db.transaction('rw', T(db), async () => {
    const people = new Set<string>();
    for (const id of ids) {
      const r = await db.repayments.get(id);
      if (!r || r.deletedAt) continue;
      await db.repayments.update(id, { deletedAt: now(), updatedAt: now() });
      people.add(r.personId);
    }
    for (const p of people) {
      if ((await creditOf(db, p)) < 0) throw new Error('Tiền giữ lại từ lần trả nợ này đã được dùng (chi hộ / trả lại); hãy xóa các khoản đó trước');
    }
  });
}

/** Undo deleting repayments: restore them unless the debt would be over-repaid (repaid another way meanwhile). */
export async function restoreRepayments(db: FintoDB, ids: string[]) {
  return db.transaction('rw', T(db), async () => {
    const people = new Set<string>();
    for (const id of ids) {
      const r = await db.repayments.get(id);
      if (!r || !r.deletedAt) continue;
      await db.repayments.update(id, { deletedAt: null, updatedAt: now() });
      people.add(r.personId);
    }
    for (const p of people) await assertPayablesOk(db, p);
  });
}

/**
 * UC-19: I forgive that person — reduce their Owed items, oldest first; this part becomes Given.
 * (Opening items: still Given, but not in the period's spending — see stats.)
 */
export async function forgiveAll(db: FintoDB, personId: string, amount: number, date: string) {
  if (!(amount > 0)) throw new Error('Số tiền phải lớn hơn 0');
  assertDate(date);
  return db.transaction('rw', T(db), async () => {
    let left = Math.round(amount);
    const ids: string[] = [];
    for (const d of await openDebts(db, personId)) {
      if (left <= 0) break;
      const take = Math.min(left, d.remaining);
      const row = { ...base(), settlementId: null, shareId: d.share.id, personId, amount: take, kind: 'forgive' as const, date };
      await db.allocations.add(row);
      ids.push(row.id);
      left -= take;
    }
    if (left > 0) throw new Error(`Chỉ đang nợ bạn ${(amount - left).toLocaleString('vi-VN')}đ`);
    return ids;
  });
}

/** UC-17 (manual): both sides owe each other → offset the smaller amount. Offsets everything by default; returns ids for undo. */
export async function offsetDebts(db: FintoDB, personId: string, date: string, amount?: number) {
  assertDate(date);
  return db.transaction('rw', T(db), async () => {
    const debts = await openDebts(db, personId);
    const theyOwe = debts.reduce((s, d) => s + d.remaining, 0);
    const iOwe = await owedOf(db, personId);
    const max = Math.min(theyOwe, iOwe);
    const want = amount ?? max;
    if (!(want > 0)) throw new Error('Không có gì để cấn trừ');
    if (want > max) throw new Error(`Chỉ cấn trừ được tối đa ${max.toLocaleString('vi-VN')}đ`);
    let left = want;
    const ids: string[] = [];
    for (const d of debts) {
      if (left <= 0) break;
      const take = Math.min(left, d.remaining);
      for (const part of await splitPayables(db, personId, take)) {
        const row = { ...base(), settlementId: null, shareId: d.share.id, personId, amount: part.amount, kind: 'offset' as const, payableId: part.payableId, date };
        await db.allocations.add(row);
        ids.push(row.id);
      }
      left -= take;
    }
    return ids;
  });
}

/** Delete (undo) offset / forgive rows that were just written. */
export async function deleteAllocations(db: FintoDB, ids: string[]) {
  return db.transaction('rw', T(db), async () => {
    for (const id of ids) {
      const a = await db.allocations.get(id);
      if (a && !a.deletedAt) await db.allocations.update(id, { deletedAt: now(), updatedAt: now() });
    }
  });
}
