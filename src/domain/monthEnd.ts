import { base, type FintoDB } from '../db/schema';
import { creditOf } from './ledger';
import { periodOf, shiftMonth } from './period';

/**
 * Month end: on the first app open in a new period, record each person's held money (> 0) for the period that just ended.
 * The web app has no background server, so this runs on app open (spec: "Main flows › Month end").
 * Returns the number of notes written.
 */
export async function runMonthEnd(db: FintoDB, todayIso: string) {
  return db.transaction('rw', [db.settings, db.people, db.settlements, db.allocations, db.payables, db.repayments, db.monthNotes], async () => {
    const s = await db.settings.get('settings');
    if (!s) return 0;
    const current = periodOf(todayIso, s.monthStartDay);
    if (s.lastMonthEnd === current) return 0;
    await db.settings.update('settings', { lastMonthEnd: current });
    // The first run only marks the period, no notes for the past.
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

/** NFR-04: remind to back up when there is data and more than `every` days (default 7; iPhone 3) have passed since the last backup (or the first transaction). */
export function backupOverdueDays(lastBackupAt: string | undefined, firstDataAt: string | undefined, now = new Date(), every = 7) {
  const ref = lastBackupAt ?? firstDataAt;
  if (!ref) return 0;
  const days = Math.floor((now.getTime() - new Date(ref).getTime()) / 86_400_000);
  return days >= every ? days : 0;
}
