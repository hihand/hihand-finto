import { base, now, type FintoDB, type Share, type Allocation, type TxKind, type SplitMode } from '../db/schema';
import { assertBalanced, type ShareDraft } from './split';

/** Ngày phải là YYYY-MM-DD có thật; ngày trống làm giao dịch biến mất khỏi mọi thống kê. */
export function assertDate(date: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Error('Ngày không hợp lệ');
}

/** Danh mục phải còn và đúng loại (chi / thu). */
async function assertCategory(db: FintoDB, id: string, kind: 'expense' | 'income') {
  const c = id ? await db.categories.get(id) : undefined;
  if (!c || c.deletedAt || (c.kind ?? 'expense') !== kind) throw new Error(kind === 'income' ? 'Cần chọn danh mục thu nhập' : 'Cần chọn danh mục chi');
}

/** Số đã trừ của một share owe. */
async function paidOf(db: FintoDB, shareId: string) {
  const rows = await db.allocations.where('shareId').equals(shareId).toArray();
  return rows.filter((a) => !a.deletedAt).reduce((s, a) => s + a.amount, 0);
}

/**
 * RULE-06: tiền đang giữ = tiền họ đã chuyển − tiền đã trả lại họ − tổng đã trừ bằng tiền thật.
 * Phần bỏ qua (forgive) không đụng tiền đang giữ.
 */
export async function creditOf(db: FintoDB, personId: string) {
  const sets = (await db.settlements.where('personId').equals(personId).toArray()).filter((s) => !s.deletedAt);
  const allocs = (await db.allocations.where('personId').equals(personId).toArray()).filter((a) => !a.deletedAt && a.kind !== 'forgive');
  return sets.reduce((s, x) => s + (x.direction === 'out' ? -x.amount : x.amount), 0) - allocs.reduce((s, x) => s + x.amount, 0);
}

/** Các khoản Đòi lại còn thiếu của một người, cũ nhất trước. */
export async function openDebts(db: FintoDB, personId: string) {
  const shares = (await db.shares.where('personId').equals(personId).toArray()).filter((s) => !s.deletedAt && s.type === 'owe');
  const out: { share: Share; date: string; remaining: number; paid: number }[] = [];
  for (const share of shares) {
    const tx = await db.transactions.get(share.transactionId);
    if (!tx || tx.deletedAt) continue;
    const paid = await paidOf(db, share.id);
    if (paid < share.amount) out.push({ share, date: tx.date, remaining: share.amount - paid, paid });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.share.createdAt.localeCompare(b.share.createdAt));
}

export async function debtOf(db: FintoDB, personId: string) {
  return (await openDebts(db, personId)).reduce((s, d) => s + d.remaining, 0);
}

export interface ExpenseInput {
  date: string;
  kind: TxKind;
  categoryId: string;
  title: string;
  productName?: string;
  totalAmount: number;
  splitMode: SplitMode;
  tagIds: string[];
  shares: ShareDraft[];
  applyCredit?: boolean; // RULE-07, mặc định theo cài đặt
  onBehalf?: boolean; // UC-12: chi hộ, luôn trừ vào tiền đang giữ
}

/** Lưu một khoản chi trong một giao dịch IndexedDB. */
export async function saveExpense(db: FintoDB, input: ExpenseInput) {
  if (input.totalAmount <= 0) throw new Error('Số tiền phải lớn hơn 0');
  if (!input.categoryId) throw new Error('Cần chọn danh mục');
  assertDate(input.date);
  await assertCategory(db, input.categoryId, 'expense');
  if (input.shares.length === 0) throw new Error('Cần chọn ít nhất một người');
  if (input.shares.some((s) => (s.type === 'mine') !== (s.personId === null))) throw new Error('Phần Của tôi phải là của bạn');
  if (input.onBehalf && input.shares.some((s) => s.type !== 'owe')) throw new Error('Chi hộ chỉ gồm phần Đòi lại của người được chi hộ');
  if (input.kind === 'transfer' && input.shares.some((s) => s.type === 'mine')) throw new Error('Chuyển tiền không có phần Của tôi');
  assertBalanced(input.totalAmount, input.shares);

  return db.transaction('rw', [db.transactions, db.transactionTags, db.shares, db.settlements, db.allocations, db.settings], async () => {
    const settings = await db.settings.get('settings');
    const applyCredit = input.onBehalf ? true : input.applyCredit ?? settings?.autoApplyCredit ?? true;
    const tx = { ...base(), date: input.date, kind: input.kind, categoryId: input.categoryId, title: input.title, productName: input.productName, totalAmount: input.totalAmount, splitMode: input.splitMode, ...(input.onBehalf ? { onBehalf: true } : {}) };
    await db.transactions.add(tx);
    await db.transactionTags.bulkAdd(input.tagIds.map((tagId) => ({ ...base(), transactionId: tx.id, tagId })));
    const shares: Share[] = input.shares.map((s) => ({ ...base(), transactionId: tx.id, personId: s.personId, type: s.type, amount: s.amount }));
    await db.shares.bulkAdd(shares);

    if (applyCredit) {
      for (const sh of shares) {
        if (sh.type !== 'owe' || !sh.personId) continue;
        const credit = await creditOf(db, sh.personId);
        const take = Math.min(credit, sh.amount);
        if (take > 0) await db.allocations.add({ ...base(), settlementId: null, shareId: sh.id, personId: sh.personId, amount: take });
      }
    }
    return tx.id;
  });
}

export interface SettleInput {
  personId: string;
  date: string;
  amount: number;
  note?: string;
  picks: { shareId: string; amount: number }[];
  /** UC-09: phần dư của tiền vừa nhận — 'keep' giữ lại cho họ (mặc định), 'gift' họ cho luôn (ghi thu nhập). */
  surplus?: 'keep' | 'gift';
  /** UC-10: phần thiếu so với khoản đã chọn — 'owe' để họ nợ tiếp (mặc định), 'forgive' bạn cho luôn. */
  shortfall?: 'owe' | 'forgive';
  giftCategoryId?: string;
}

/** Danh mục thu cho phần "cho luôn": Được cho/tặng › Bạn bè, nếu không có thì danh mục thu đầu tiên. */
async function giftCategory(db: FintoDB, preferred?: string) {
  if (preferred) return preferred;
  const cats = (await db.categories.toArray()).filter((c) => !c.deletedAt && c.kind === 'income');
  const root = cats.find((c) => c.parentId === null && c.name === 'Được cho/tặng');
  return (root && cats.find((c) => c.parentId === root.id && c.name === 'Bạn bè'))?.id ?? root?.id
    ?? cats.find((c) => c.parentId === null)?.id ?? (() => { throw new Error('Chưa có danh mục thu nhập'); })();
}

/**
 * Nhận tiền từ một người (BR-06/07/08, UC-09, UC-10): trừ vào các khoản đã chọn (cũ trước, được trừ một phần).
 * Dư: giữ lại (tiền đang giữ) hoặc họ cho luôn (thu nhập gắn với lần nhận). Thiếu: để nợ tiếp hoặc bạn bỏ qua (Cho đi).
 * Tổng tiền vào luôn đúng số họ chuyển: lần nhận (amount − phần cho) + thu nhập (phần cho).
 */
export async function settle(db: FintoDB, input: SettleInput) {
  if (!(input.amount > 0)) throw new Error('Số tiền phải lớn hơn 0');
  assertDate(input.date);
  return db.transaction('rw', [db.settlements, db.allocations, db.shares, db.transactions, db.incomes, db.categories], async () => {
    const credit = Math.max(0, await creditOf(db, input.personId));
    const picks: { shareId: string; amount: number; date: string }[] = [];
    for (const p of input.picks) {
      const sh = await db.shares.get(p.shareId);
      if (!sh || sh.deletedAt || sh.personId !== input.personId || sh.type !== 'owe') throw new Error('Khoản không hợp lệ');
      if (p.amount <= 0 || p.amount > sh.amount - (await paidOf(db, sh.id))) throw new Error('Số trừ vượt số còn thiếu');
      const tx = await db.transactions.get(sh.transactionId);
      picks.push({ ...p, date: tx?.date ?? '' });
    }
    picks.sort((a, b) => a.date.localeCompare(b.date));
    const picked = picks.reduce((s, p) => s + p.amount, 0);
    const available = input.amount + credit;
    if (picked > available && !input.shortfall) throw new Error('Tổng khoản trừ vượt tiền nhận + tiền đang giữ');
    const gift = input.surplus === 'gift' ? Math.max(0, input.amount - picked) : 0;

    // Tiền thật trừ lần lượt từ khoản cũ nhất; phần không đủ: bỏ qua hoặc để nợ tiếp.
    let left = Math.min(picked, available);
    const pay: { shareId: string; amount: number }[] = [];
    const forgive: { shareId: string; amount: number }[] = [];
    for (const p of picks) {
      const take = Math.min(left, p.amount);
      if (take > 0) pay.push({ shareId: p.shareId, amount: take });
      left -= take;
      if (p.amount > take && input.shortfall === 'forgive') forgive.push({ shareId: p.shareId, amount: p.amount - take });
    }

    const stAmount = input.amount - gift;
    let stId: string | null = null;
    if (stAmount > 0) {
      const st = { ...base(), personId: input.personId, date: input.date, amount: stAmount, note: input.note, direction: 'in' as const };
      await db.settlements.add(st);
      stId = st.id;
    }
    await db.allocations.bulkAdd([
      ...pay.map((p) => ({ ...base(), settlementId: stId, shareId: p.shareId, personId: input.personId, amount: p.amount, kind: 'pay' as const })),
      ...forgive.map((p) => ({ ...base(), settlementId: stId, shareId: p.shareId, personId: input.personId, amount: p.amount, kind: 'forgive' as const, date: input.date })),
    ]);
    if (gift > 0) {
      await db.incomes.add({
        ...base(), date: input.date, categoryId: await giftCategory(db, input.giftCategoryId), amount: gift,
        title: picked > 0 ? 'Cho luôn phần dư khi trả tiền' : (input.note?.trim() || 'Được cho'), personId: input.personId, settlementId: stId,
      });
    }
    return stId;
  });
}

/** Giữ tương thích: nhận tiền, phần dư giữ lại. */
export const receivePayment = (db: FintoDB, input: Omit<SettleInput, 'surplus' | 'shortfall'>) => settle(db, input) as Promise<string>;

/**
 * UC-11: nhận tiền nhờ giữ (gửi trước / nạp thêm). Nếu người đó đang có khoản Đòi lại
 * (ví dụ chi hộ vượt tiền giữ) và `coverDebts` bật thì trừ luôn các khoản đó, cũ nhất trước.
 */
export async function depositCredit(db: FintoDB, input: { personId: string; date: string; amount: number; note?: string; coverDebts?: boolean }) {
  const picks = input.coverDebts ? await pickOldest(db, input.personId, input.amount) : [];
  return settle(db, { personId: input.personId, date: input.date, amount: input.amount, note: input.note || 'Gửi giữ', picks }) as Promise<string>;
}

/** UC-10 (không kèm lần nhận): bạn bỏ qua một phần hoặc cả khoản Đòi lại; phần đó thành Cho đi. */
export async function forgiveShare(db: FintoDB, shareId: string, amount: number, date: string) {
  assertDate(date);
  return db.transaction('rw', [db.shares, db.allocations], async () => {
    const sh = await db.shares.get(shareId);
    if (!sh || sh.deletedAt || sh.type !== 'owe' || !sh.personId) throw new Error('Khoản không hợp lệ');
    if (amount <= 0 || amount > sh.amount - (await paidOf(db, sh.id))) throw new Error('Số bỏ qua vượt số còn thiếu');
    await db.allocations.add({ ...base(), settlementId: null, shareId, personId: sh.personId, amount, kind: 'forgive', date });
  });
}

/** UC-13: trả lại cho người đó một phần / toàn bộ tiền đang giữ. Không phải Cho đi. */
export async function returnCredit(db: FintoDB, personId: string, amount: number, date: string, note?: string) {
  if (!(amount > 0)) throw new Error('Số tiền phải lớn hơn 0');
  assertDate(date);
  return db.transaction('rw', [db.settlements, db.allocations], async () => {
    const credit = await creditOf(db, personId);
    if (amount > credit) throw new Error(`Chỉ đang giữ ${credit.toLocaleString('vi-VN')}đ`);
    const st = { ...base(), personId, date, amount, note, direction: 'out' as const };
    await db.settlements.add(st);
    return st.id;
  });
}

/**
 * Đổi tiền đang giữ thành quà (UC-09, khi lỡ chọn "giữ lại"): tách các lần nhận gần nhất thành
 * phần được trả lại + thu nhập gắn với lần nhận. Tiền vào không đổi; tiền đang giữ giảm; Số dư của tôi tăng.
 */
export async function giftFromCredit(db: FintoDB, personId: string, amount: number, categoryId?: string) {
  if (amount <= 0) throw new Error('Số tiền phải lớn hơn 0');
  return db.transaction('rw', [db.settlements, db.allocations, db.incomes, db.categories], async () => {
    const credit = await creditOf(db, personId);
    if (amount > credit) throw new Error(`Chỉ đang giữ ${credit.toLocaleString('vi-VN')}đ`);
    const cat = await giftCategory(db, categoryId);
    const sets = (await db.settlements.where('personId').equals(personId).toArray())
      .filter((s) => !s.deletedAt && s.direction !== 'out')
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    let left = amount;
    for (const st of sets) {
      if (left <= 0) break;
      const used = (await db.allocations.where('settlementId').equals(st.id).toArray())
        .filter((a) => !a.deletedAt && a.kind !== 'forgive').reduce((s, a) => s + a.amount, 0);
      const take = Math.min(left, st.amount - used);
      if (take <= 0) continue;
      await db.settlements.update(st.id, { amount: st.amount - take, updatedAt: now() });
      await db.incomes.add({ ...base(), date: st.date, categoryId: cat, amount: take, title: 'Cho luôn tiền đang giữ', personId, settlementId: st.id });
      left -= take;
    }
    if (left > 0) throw new Error('Không tách được tiền đang giữ');
  });
}

/** Trừ các khoản Đòi lại cũ vào tiền đang giữ (không có tiền mới chuyển tới). */
export async function applyCreditTo(db: FintoDB, personId: string, picks: { shareId: string; amount: number }[]) {
  if (picks.length === 0) throw new Error('Chưa chọn khoản nào');
  return db.transaction('rw', [db.settlements, db.allocations, db.shares, db.transactions], async () => {
    const credit = await creditOf(db, personId);
    const total = picks.reduce((s, p) => s + p.amount, 0);
    if (total > credit) throw new Error('Tổng khoản trừ vượt tiền đang giữ');
    for (const p of picks) {
      const sh = await db.shares.get(p.shareId);
      if (!sh || sh.deletedAt || sh.personId !== personId || sh.type !== 'owe') throw new Error('Khoản không hợp lệ');
      if (p.amount <= 0 || p.amount > sh.amount - (await paidOf(db, sh.id))) throw new Error('Số trừ vượt số còn thiếu');
    }
    await db.allocations.bulkAdd(picks.map((p) => ({ ...base(), settlementId: null, shareId: p.shareId, personId, amount: p.amount })));
  });
}

/** "Tự chọn khoản cũ nhất": trừ lần lượt, khoản cuối có thể chỉ trừ một phần. */
export async function pickOldest(db: FintoDB, personId: string, amount: number) {
  let left = amount + Math.max(0, await creditOf(db, personId));
  const picks: { shareId: string; amount: number }[] = [];
  for (const d of await openDebts(db, personId)) {
    if (left <= 0) break;
    const take = Math.min(left, d.remaining);
    picks.push({ shareId: d.share.id, amount: take });
    left -= take;
  }
  return picks;
}

/** Gỡ khoản tự trừ (mới nhất trước) cho đến khi tiền đang giữ không âm — RULE-13. */
async function fixNegativeCredit(db: FintoDB, personId: string) {
  let credit = await creditOf(db, personId);
  if (credit >= 0) return;
  const autos = (await db.allocations.where('personId').equals(personId).toArray())
    .filter((a) => !a.deletedAt && a.settlementId === null && a.kind !== 'forgive')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const a of autos) {
    if (credit >= 0) break;
    await db.allocations.update(a.id, { deletedAt: now(), updatedAt: now() });
    credit += a.amount;
  }
}

/** RULE-13: xóa một lần nhận (kèm phần cho luôn, phần bỏ qua của nó) hoặc một lần trả lại tiền giữ. */
export async function deleteSettlement(db: FintoDB, settlementId: string) {
  return db.transaction('rw', [db.settlements, db.allocations, db.incomes], async () => {
    const st = await db.settlements.get(settlementId);
    if (!st || st.deletedAt) return;
    const t = now();
    await db.settlements.update(st.id, { deletedAt: t, updatedAt: t });
    const own = await db.allocations.where('settlementId').equals(st.id).toArray();
    for (const a of own) if (!a.deletedAt) await db.allocations.update(a.id, { deletedAt: t, updatedAt: t });
    const gifts = (await db.incomes.toArray()).filter((r) => r.settlementId === st.id && !r.deletedAt);
    for (const r of gifts) await db.incomes.update(r.id, { deletedAt: t, updatedAt: t });
    await fixNegativeCredit(db, st.personId);
    if ((await creditOf(db, st.personId)) < 0) {
      throw new Error('Đã trả lại một phần tiền giữ từ lần nhận này. Hãy xóa lần trả lại trước.');
    }
  });
}

/**
 * Xóa mềm giao dịch; khoản trừ trên các phần chia của nó cũng bị gỡ (tiền quay lại tiền đang giữ).
 * Trả về dấu thời gian xóa để hoàn tác (BR-11).
 */
export async function deleteTransaction(db: FintoDB, txId: string) {
  return db.transaction('rw', [db.transactions, db.shares, db.allocations], async () => {
    const t = now();
    await db.transactions.update(txId, { deletedAt: t, updatedAt: t });
    const shares = await db.shares.where('transactionId').equals(txId).toArray();
    for (const s of shares) {
      if (s.deletedAt) continue;
      await db.shares.update(s.id, { deletedAt: t, updatedAt: t });
      const allocs: Allocation[] = await db.allocations.where('shareId').equals(s.id).toArray();
      for (const a of allocs) if (!a.deletedAt) await db.allocations.update(a.id, { deletedAt: t, updatedAt: t });
    }
    return t;
  });
}

/** Hoàn tác xóa: khôi phục đúng các bản ghi bị xóa cùng lúc; tiền đang giữ vẫn không âm (RULE-06). */
export async function restoreTransaction(db: FintoDB, txId: string, stamp: string) {
  return db.transaction('rw', [db.transactions, db.shares, db.allocations, db.settlements], async () => {
    const tx = await db.transactions.get(txId);
    if (!tx || tx.deletedAt !== stamp) return;
    const t = now();
    await db.transactions.update(txId, { deletedAt: null, updatedAt: t });
    const persons = new Set<string>();
    for (const s of await db.shares.where('transactionId').equals(txId).toArray()) {
      if (s.deletedAt !== stamp) continue;
      await db.shares.update(s.id, { deletedAt: null, updatedAt: t });
      for (const a of await db.allocations.where('shareId').equals(s.id).toArray()) {
        if (a.deletedAt !== stamp) continue;
        // Lần nhận tiền của khoản trừ này đã bị xóa trong lúc chờ hoàn tác → không khôi phục khoản trừ.
        if (a.settlementId && (await db.settlements.get(a.settlementId))?.deletedAt) continue;
        await db.allocations.update(a.id, { deletedAt: null, updatedAt: t });
        persons.add(a.personId);
      }
    }
    for (const p of persons) await fixNegativeCredit(db, p);
  });
}

/** RULE-09: chỉ sửa ngày, danh mục, tag, ghi chú, tên sản phẩm. */
export async function updateTransactionMeta(
  db: FintoDB,
  txId: string,
  patch: { date: string; categoryId: string; title: string; productName?: string; tagIds: string[] },
) {
  if (!patch.categoryId) throw new Error('Cần chọn danh mục');
  assertDate(patch.date);
  await assertCategory(db, patch.categoryId, 'expense');
  return db.transaction('rw', [db.transactions, db.transactionTags], async () => {
    const tx = await db.transactions.get(txId);
    if (!tx || tx.deletedAt) throw new Error('Giao dịch không còn');
    const t = now();
    await db.transactions.update(txId, {
      date: patch.date, categoryId: patch.categoryId, title: patch.title.trim(), productName: patch.productName?.trim() || undefined, updatedAt: t,
    });
    const links = (await db.transactionTags.where('transactionId').equals(txId).toArray()).filter((l) => !l.deletedAt);
    const want = new Set(patch.tagIds);
    for (const l of links) if (!want.has(l.tagId)) await db.transactionTags.update(l.id, { deletedAt: t, updatedAt: t });
    const have = new Set(links.map((l) => l.tagId));
    const add = patch.tagIds.filter((id) => !have.has(id));
    await db.transactionTags.bulkAdd(add.map((tagId) => ({ ...base(), transactionId: txId, tagId })));
  });
}

/** Trạng thái một khoản Đòi lại. */
export async function shareStatus(db: FintoDB, share: Share): Promise<'paid' | 'partial' | 'open'> {
  const paid = await paidOf(db, share.id);
  return paid >= share.amount ? 'paid' : paid > 0 ? 'partial' : 'open';
}
