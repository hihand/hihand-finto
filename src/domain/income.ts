import { base, now, type FintoDB } from '../db/schema';
import { writeRepay } from './debt';
import { assertDate, assertPayablesOk, creditOf } from './ledger';

export interface IncomeInput { date: string; categoryId: string; amount: number; title: string; personId: string | null }

async function check(db: FintoDB, input: IncomeInput) {
  if (!(input.amount > 0)) throw new Error('Số tiền phải lớn hơn 0');
  assertDate(input.date);
  const c = await db.categories.get(input.categoryId);
  if (!c || c.deletedAt || c.kind !== 'income') throw new Error('Cần chọn danh mục thu nhập');
}

/** UC-16: dùng một phần thu nhập để trả nợ một người. */
export interface IncomeRepay { personId: string; amount: number; mode?: 'hold' | 'transfer' }

const TABLES = (db: FintoDB) => [db.incomes, db.settlements, db.allocations, db.payables, db.repayments];

/** Tổng đã dùng để trả nợ từ một khoản thu nhập. */
async function repaidFrom(db: FintoDB, incomeId: string) {
  return (await db.repayments.where('incomeId').equals(incomeId).toArray()).filter((r) => !r.deletedAt).reduce((s, r) => s + r.amount, 0);
}

/** BR-20: ghi một khoản thu nhập (lương, thưởng, được cho…); có thể dùng luôn một phần để trả nợ (UC-16). */
export async function saveIncome(db: FintoDB, input: IncomeInput, repay?: IncomeRepay) {
  await check(db, input);
  const row = { ...base(), ...input, title: input.title.trim(), amount: Math.round(input.amount) };
  if (!repay || !(repay.amount > 0)) {
    await db.incomes.add(row);
    return row.id;
  }
  if (repay.amount > row.amount) throw new Error('Số trả nợ vượt khoản thu nhập');
  return db.transaction('rw', TABLES(db), async () => {
    await db.incomes.add(row);
    await writeRepay(db, { personId: repay.personId, date: row.date, amount: repay.amount, mode: repay.mode ?? 'hold', incomeId: row.id });
    return row.id;
  });
}

/** Thu nhập không có phần chia nên sửa được mọi trường. */
export async function updateIncome(db: FintoDB, id: string, input: IncomeInput) {
  await check(db, input);
  const cur = await db.incomes.get(id);
  if (!cur || cur.deletedAt) throw new Error('Khoản thu không còn');
  // Phần "cho luôn" gắn với lần nhận: tổng tiền vào phải giữ đúng số người đó chuyển.
  if (cur.settlementId && (Math.round(input.amount) !== cur.amount || input.personId !== cur.personId)) {
    throw new Error('Khoản này là phần cho luôn của một lần nhận tiền; muốn đổi số tiền hãy xóa lần nhận và ghi lại');
  }
  const used = await repaidFrom(db, id);
  if (used > Math.round(input.amount)) throw new Error(`Khoản này đã dùng ${used.toLocaleString('vi-VN')}đ để trả nợ; không giảm thấp hơn được`);
  await db.incomes.update(id, { ...input, title: input.title.trim(), amount: Math.round(input.amount), updatedAt: now() });
  // Lần trả nợ đi theo ngày của khoản thu.
  if (used > 0 && input.date !== cur.date) {
    for (const r of await db.repayments.where('incomeId').equals(id).toArray()) if (!r.deletedAt) await db.repayments.update(r.id, { date: input.date, updatedAt: now() });
  }
}

/**
 * Xóa khoản thu. Nếu là phần "cho luôn" gắn với lần nhận (UC-09) thì tiền đó vẫn đã vào tài khoản:
 * trả nó về lần nhận (thành tiền đang giữ của người đó), để số dư tài khoản không đổi.
 */
export async function deleteIncome(db: FintoDB, id: string) {
  return db.transaction('rw', TABLES(db), async () => {
    const r = await db.incomes.get(id);
    if (!r || r.deletedAt) throw new Error('Khoản thu không còn');
    const t = now();
    await db.incomes.update(id, { deletedAt: t, updatedAt: t });
    const st = r.settlementId ? await db.settlements.get(r.settlementId) : undefined;
    if (st && !st.deletedAt) await db.settlements.update(st.id, { amount: st.amount + r.amount, updatedAt: t });
    // Lần trả nợ từ khoản thu này bị xóa theo (khoản nợ quay lại).
    const reps = (await db.repayments.where('incomeId').equals(id).toArray()).filter((x) => !x.deletedAt);
    for (const x of reps) await db.repayments.update(x.id, { deletedAt: t, updatedAt: t });
    for (const pid of new Set(reps.map((x) => x.personId))) {
      if ((await creditOf(db, pid)) < 0) throw new Error('Tiền trả nợ giữ lại từ khoản thu này đã được dùng; hãy xóa các khoản chi hộ / trả lại trước');
    }
    return t;
  });
}

export async function restoreIncome(db: FintoDB, id: string, stamp: string) {
  return db.transaction('rw', TABLES(db), async () => {
    const r = await db.incomes.get(id);
    if (!r || r.deletedAt !== stamp) return;
    const st = r.settlementId ? await db.settlements.get(r.settlementId) : undefined;
    if (st && !st.deletedAt) {
      if ((await creditOf(db, st.personId)) < r.amount) throw new Error('Tiền đang giữ đã được dùng, không hoàn tác được');
      await db.settlements.update(st.id, { amount: st.amount - r.amount, updatedAt: now() });
    } else if (r.settlementId) return; // lần nhận đã bị xóa: không khôi phục phần cho luôn
    await db.incomes.update(id, { deletedAt: null, updatedAt: now() });
    const reps = (await db.repayments.where('incomeId').equals(id).toArray()).filter((x) => x.deletedAt === stamp);
    for (const x of reps) await db.repayments.update(x.id, { deletedAt: null, updatedAt: now() });
    for (const pid of new Set(reps.map((x) => x.personId))) await assertPayablesOk(db, pid);
  });
}

/** BR-23: số dư ban đầu tại một ngày; số dư = số này + dòng tiền từ ngày đó. */
export async function setOpeningBalance(db: FintoDB, amount: number, date: string) {
  if (!Number.isFinite(amount)) throw new Error('Số dư không hợp lệ');
  assertDate(date);
  await db.settings.update('settings', { openingBalance: Math.round(amount), openingDate: date });
}
