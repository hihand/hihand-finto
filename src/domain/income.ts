import { base, now, type FintoDB } from '../db/schema';
import { assertDate, creditOf } from './ledger';

export interface IncomeInput { date: string; categoryId: string; amount: number; title: string; personId: string | null }

async function check(db: FintoDB, input: IncomeInput) {
  if (!(input.amount > 0)) throw new Error('Số tiền phải lớn hơn 0');
  assertDate(input.date);
  const c = await db.categories.get(input.categoryId);
  if (!c || c.deletedAt || c.kind !== 'income') throw new Error('Cần chọn danh mục thu nhập');
}

/** BR-20: ghi một khoản thu nhập (lương, thưởng, được cho…). */
export async function saveIncome(db: FintoDB, input: IncomeInput) {
  await check(db, input);
  const row = { ...base(), ...input, title: input.title.trim(), amount: Math.round(input.amount) };
  await db.incomes.add(row);
  return row.id;
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
  await db.incomes.update(id, { ...input, title: input.title.trim(), amount: Math.round(input.amount), updatedAt: now() });
}

/**
 * Xóa khoản thu. Nếu là phần "cho luôn" gắn với lần nhận (UC-09) thì tiền đó vẫn đã vào tài khoản:
 * trả nó về lần nhận (thành tiền đang giữ của người đó), để số dư tài khoản không đổi.
 */
export async function deleteIncome(db: FintoDB, id: string) {
  return db.transaction('rw', [db.incomes, db.settlements], async () => {
    const r = await db.incomes.get(id);
    if (!r || r.deletedAt) throw new Error('Khoản thu không còn');
    const t = now();
    await db.incomes.update(id, { deletedAt: t, updatedAt: t });
    const st = r.settlementId ? await db.settlements.get(r.settlementId) : undefined;
    if (st && !st.deletedAt) await db.settlements.update(st.id, { amount: st.amount + r.amount, updatedAt: t });
    return t;
  });
}

export async function restoreIncome(db: FintoDB, id: string, stamp: string) {
  return db.transaction('rw', [db.incomes, db.settlements, db.allocations], async () => {
    const r = await db.incomes.get(id);
    if (!r || r.deletedAt !== stamp) return;
    const st = r.settlementId ? await db.settlements.get(r.settlementId) : undefined;
    if (st && !st.deletedAt) {
      if ((await creditOf(db, st.personId)) < r.amount) throw new Error('Tiền đang giữ đã được dùng, không hoàn tác được');
      await db.settlements.update(st.id, { amount: st.amount - r.amount, updatedAt: now() });
    } else if (r.settlementId) return; // lần nhận đã bị xóa: không khôi phục phần cho luôn
    await db.incomes.update(id, { deletedAt: null, updatedAt: now() });
  });
}

/** BR-23: số dư ban đầu tại một ngày; số dư = số này + dòng tiền từ ngày đó. */
export async function setOpeningBalance(db: FintoDB, amount: number, date: string) {
  if (!Number.isFinite(amount)) throw new Error('Số dư không hợp lệ');
  assertDate(date);
  await db.settings.update('settings', { openingBalance: Math.round(amount), openingDate: date });
}
