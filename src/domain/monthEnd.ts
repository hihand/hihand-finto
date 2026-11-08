import { base, type FintoDB } from '../db/schema';
import { creditOf } from './ledger';
import { periodOf, shiftMonth } from './period';

/**
 * Cuối tháng: lần đầu mở app trong kỳ mới, ghi lại tiền đang giữ (> 0) của từng người cho kỳ vừa qua.
 * Bản web không có máy chủ chạy nền nên việc này chạy khi mở app (tài liệu: "Luồng xử lý chính › Cuối tháng").
 * Trả về số ghi chú đã ghi.
 */
export async function runMonthEnd(db: FintoDB, todayIso: string) {
  return db.transaction('rw', [db.settings, db.people, db.settlements, db.allocations, db.monthNotes], async () => {
    const s = await db.settings.get('settings');
    if (!s) return 0;
    const current = periodOf(todayIso, s.monthStartDay);
    if (s.lastMonthEnd === current) return 0;
    await db.settings.update('settings', { lastMonthEnd: current });
    // Lần chạy đầu tiên chỉ đánh dấu kỳ, không ghi chú cho quá khứ.
    if (!s.lastMonthEnd || !s.monthEndNote) return 0;
    const prev = shiftMonth(current, -1);
    let n = 0;
    for (const p of await db.people.toArray()) {
      if (p.deletedAt) continue;
      const credit = await creditOf(db, p.id);
      if (credit <= 0) continue;
      const exists = await db.monthNotes.where('[personId+month]').equals([p.id, prev]).first();
      if (exists && !exists.deletedAt) continue;
      await db.monthNotes.add({ ...base(), personId: p.id, month: prev, creditAmount: credit });
      n++;
    }
    return n;
  });
}

/** NFR-04: nhắc sao lưu khi có dữ liệu và đã quá 7 ngày kể từ lần sao lưu (hoặc giao dịch đầu tiên). */
export function backupOverdueDays(lastBackupAt: string | undefined, firstDataAt: string | undefined, now = new Date()) {
  const ref = lastBackupAt ?? firstDataAt;
  if (!ref) return 0;
  const days = Math.floor((now.getTime() - new Date(ref).getTime()) / 86_400_000);
  return days >= 7 ? days : 0;
}
