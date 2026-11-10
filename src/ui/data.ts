import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import { makeIndex, type Index, type Snapshot } from '../domain/stats';

/** Đọc toàn bộ sổ (dữ liệu cá nhân nhỏ) và tự cập nhật khi IndexedDB đổi. */
export function useIndex(): Index | undefined {
  const snap = useLiveQuery<Snapshot>(async () => {
    const [people, categories, tags, categoryTags, transactions, transactionTags, shares, settlements, allocations, groups, groupMembers, monthNotes, incomes, payables, repayments, settings] = await Promise.all([
      db.people.toArray(), db.categories.toArray(), db.tags.toArray(), db.categoryTags.toArray(), db.transactions.toArray(),
      db.transactionTags.toArray(), db.shares.toArray(), db.settlements.toArray(), db.allocations.toArray(),
      db.groups.toArray(), db.groupMembers.toArray(), db.monthNotes.toArray(), db.incomes.toArray(), db.payables.toArray(), db.repayments.toArray(), db.settings.get('settings'),
    ]);
    return { people, categories, tags, categoryTags, transactions, transactionTags, shares, settlements, allocations, groups, groupMembers, monthNotes, incomes, payables, repayments, settings };
  });
  return useMemo(() => (snap ? makeIndex(snap) : undefined), [snap]);
}
