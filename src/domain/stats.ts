import type {
  Allocation, Category, CategoryTag, Group, GroupMember, Income, MonthNote, Payable, Person, Repayment, Settings, Settlement, Share, ShareType, Tag, Transaction, TransactionTag,
} from '../db/schema';
import { inRange, periodRange, shiftMonth } from './period';

/** All data read once from IndexedDB; every number is computed from here (derived numbers are never stored). */
export interface Snapshot {
  people: Person[];
  categories: Category[];
  tags: Tag[];
  categoryTags: CategoryTag[];
  transactions: Transaction[];
  transactionTags: TransactionTag[];
  shares: Share[];
  settlements: Settlement[];
  allocations: Allocation[];
  groups?: Group[];
  groupMembers?: GroupMember[];
  monthNotes?: MonthNote[];
  incomes?: Income[];
  payables?: Payable[];
  repayments?: Repayment[];
  settings?: Settings;
}

const live = <T extends { deletedAt?: string | null }>(rows: T[]) => rows.filter((r) => !r.deletedAt);
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export type DebtStatus = 'paid' | 'partial' | 'open';

export interface Index {
  snap: Snapshot;
  /** Lookup including deleted records, so old transactions still show the right names (BR-14). */
  person: Map<string, Person>;
  category: Map<string, Category>;
  tag: Map<string, Tag>;
  /** Live records only. */
  people: Person[];
  /** Top-level expense categories. */
  roots: Category[];
  /** Top-level income categories. */
  incomeRoots: Category[];
  incomes: Income[];
  childrenOf: Map<string, Category[]>;
  tagsOfCategory: Map<string, Tag[]>;
  /** Real transactions (without opening amounts) — for stats, lists, balances. */
  txs: Transaction[];
  /** Including the opening "They owe me" transactions — for debts. */
  allTxs: Transaction[];
  tx: Map<string, Transaction>;
  sharesOfTx: Map<string, Share[]>;
  tagIdsOfTx: Map<string, string[]>;
  settlements: Settlement[];
  allocsOfSettlement: Map<string, Allocation[]>;
  /** Forgiven rows (UC-10), live, with their share and source transaction. */
  forgiven: { alloc: Allocation; share: Share; tx: Transaction; date: string }[];
  /** Incomes tied to a payment (gifted surplus, UC-09). */
  giftsOfSettlement: Map<string, Income[]>;
  paid: Map<string, number>;
  credit: Map<string, number>;
  /** Part of each Owed item paid with held money (on-behalf / auto-apply), not my own money. */
  heldCover: Map<string, number>;
  /** Part of each Owed item offset against what I owe that person. */
  offsetCover: Map<string, number>;
  /** What I owe (live), oldest first. */
  payables: Payable[];
  payableById: Map<string, Payable>;
  /** Repaid / waived / offset per payable. */
  payableUsed: Map<string, number>;
  repayments: Repayment[];
  /** Offset rows (live). */
  offsets: Allocation[];
  /** Fast lookups (avoid repeated .find with 10,000 transactions — NFR-01). */
  shareById: Map<string, Share>;
  settlementById: Map<string, Settlement>;
  forgivenByShare: Map<string, number>;
  groups: { group: Group; memberIds: string[] }[];
  /** Latest month-end surplus note per person. */
  lastNote: Map<string, MonthNote>;
  startDay: number;
}

export function makeIndex(snap: Snapshot): Index {
  const person = new Map(snap.people.map((p) => [p.id, p]));
  const category = new Map(snap.categories.map((c) => [c.id, c]));
  const tag = new Map(snap.tags.map((t) => [t.id, t]));
  const cats = live(snap.categories).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const roots = cats.filter((c) => c.parentId === null && c.kind !== 'income');
  const incomeRoots = cats.filter((c) => c.parentId === null && c.kind === 'income');
  const incomes = live(snap.incomes ?? []).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const childrenOf = new Map<string, Category[]>();
  for (const c of cats) if (c.parentId) push(childrenOf, c.parentId, c);

  const tagsOfCategory = new Map<string, Tag[]>();
  for (const l of live(snap.categoryTags).sort((a, b) => a.sortOrder - b.sortOrder)) {
    const t = tag.get(l.tagId);
    if (t && !t.deletedAt) push(tagsOfCategory, l.categoryId, t);
  }

  const allTxs = live(snap.transactions).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const txs = allTxs.filter((t) => !t.opening);
  const tx = new Map(allTxs.map((t) => [t.id, t]));
  const sharesOfTx = new Map<string, Share[]>();
  for (const s of live(snap.shares)) if (tx.has(s.transactionId)) push(sharesOfTx, s.transactionId, s);
  const ORDER = { mine: 0, owe: 1, give: 2 } as const;
  for (const arr of sharesOfTx.values()) arr.sort((a, b) => ORDER[a.type] - ORDER[b.type] || a.createdAt.localeCompare(b.createdAt));
  const tagIdsOfTx = new Map<string, string[]>();
  for (const l of live(snap.transactionTags)) push(tagIdsOfTx, l.transactionId, l.tagId);

  const settlements = live(snap.settlements).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const allocsOfSettlement = new Map<string, Allocation[]>();
  const paid = new Map<string, number>();
  const credit = new Map<string, number>();
  const shareById = new Map(live(snap.shares).map((x) => [x.id, x]));
  const stById = new Map(settlements.map((x) => [x.id, x]));
  const forgiven: Index['forgiven'] = [];
  const forgivenByShare = new Map<string, number>();
  const heldCover = new Map<string, number>();
  const offsetCover = new Map<string, number>();
  const offsets: Allocation[] = [];
  const payables = live(snap.payables ?? []).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const payableById = new Map(payables.map((p) => [p.id, p]));
  const repayments = live(snap.repayments ?? []).filter((r) => payableById.has(r.payableId))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const payableUsed = new Map<string, number>();
  const addCredit = (id: string, v: number) => credit.set(id, (credit.get(id) ?? 0) + v);
  for (const s of settlements) addCredit(s.personId, s.direction === 'out' ? -s.amount : s.amount);
  for (const r of repayments) {
    payableUsed.set(r.payableId, (payableUsed.get(r.payableId) ?? 0) + r.amount);
    if (r.mode === 'hold') addCredit(r.personId, r.amount);
  }
  for (const p of payables) if (p.origin === 'fromHeld') addCredit(p.personId, -p.amount);
  for (const a of live(snap.allocations)) {
    paid.set(a.shareId, (paid.get(a.shareId) ?? 0) + a.amount);
    if (a.kind === 'offset') {
      offsets.push(a);
      offsetCover.set(a.shareId, (offsetCover.get(a.shareId) ?? 0) + a.amount);
      if (a.payableId) payableUsed.set(a.payableId, (payableUsed.get(a.payableId) ?? 0) + a.amount);
      continue;
    }
    if (a.kind !== 'forgive') credit.set(a.personId, (credit.get(a.personId) ?? 0) - a.amount);
    if (!a.settlementId && a.kind !== 'forgive') heldCover.set(a.shareId, (heldCover.get(a.shareId) ?? 0) + a.amount);
    if (a.settlementId) push(allocsOfSettlement, a.settlementId, a);
    if (a.kind === 'forgive') {
      forgivenByShare.set(a.shareId, (forgivenByShare.get(a.shareId) ?? 0) + a.amount);
      const sh = shareById.get(a.shareId);
      const t = sh ? tx.get(sh.transactionId) : undefined;
      if (sh && t) forgiven.push({ alloc: a, share: sh, tx: t, date: a.date ?? (a.settlementId ? stById.get(a.settlementId)?.date : undefined) ?? a.createdAt.slice(0, 10) });
    }
  }

  const members = new Map<string, string[]>();
  for (const m of live(snap.groupMembers ?? [])) {
    const p = person.get(m.personId);
    if (p && !p.deletedAt) push(members, m.groupId, m.personId);
  }
  const groups = live(snap.groups ?? []).sort((a, b) => a.name.localeCompare(b.name, 'vi'))
    .map((group) => ({
      group,
      memberIds: (members.get(group.id) ?? []).sort((a, b) => person.get(a)!.name.localeCompare(person.get(b)!.name, 'vi')),
    }));
  const lastNote = new Map<string, MonthNote>();
  for (const n of live(snap.monthNotes ?? [])) {
    const cur = lastNote.get(n.personId);
    if (!cur || n.month > cur.month) lastNote.set(n.personId, n);
  }

  return {
    snap, person, category, tag, groups, lastNote,
    people: live(snap.people).sort((a, b) => a.name.localeCompare(b.name, 'vi')),
    forgiven, heldCover, offsetCover, payables, payableById, payableUsed, repayments, offsets, allTxs, shareById, settlementById: stById, forgivenByShare, giftsOfSettlement: (() => {
      const m = new Map<string, Income[]>();
      for (const r of incomes) if (r.settlementId) push(m, r.settlementId, r);
      return m;
    })(),
    roots, incomeRoots, incomes, childrenOf, tagsOfCategory, txs, tx, sharesOfTx, tagIdsOfTx, settlements, allocsOfSettlement, paid, credit,
    startDay: snap.settings?.monthStartDay ?? 1,
  };
}

export const rootOf = (ix: Index, categoryId: string): Category | undefined => {
  const c = ix.category.get(categoryId);
  return c?.parentId ? ix.category.get(c.parentId) : c;
};

/** Path like "Mỹ phẩm › Sữa rửa mặt". */
export function categoryPath(ix: Index, categoryId: string) {
  const c = ix.category.get(categoryId);
  if (!c) return '—';
  const p = c.parentId ? ix.category.get(c.parentId) : undefined;
  return p ? `${p.name} › ${c.name}` : c.name;
}

/** RULE-02: Mine only counts when the top-level category has "Counts as my spending" on. */
export const countsAsMine = (ix: Index, t: Transaction) => rootOf(ix, t.categoryId)?.countsAsMine ?? true;

/**
 * The real Owed part of an item: the part offset against what I owe that person is a REPAYMENT (I pay them),
 * not money they owe me, so it is not counted as Owed.
 */
export const oweAmount = (ix: Index, share: Share) => Math.max(0, share.amount - (ix.offsetCover.get(share.id) ?? 0));

export function statusOf(ix: Index, share: Share): DebtStatus {
  const p = ix.paid.get(share.id) ?? 0;
  return p >= share.amount ? 'paid' : p > 0 ? 'partial' : 'open';
}

export const creditOf = (ix: Index, personId: string) => Math.max(0, ix.credit.get(personId) ?? 0);

export interface TxTotals { mine: number; owe: number; give: number }
export function txTotals(ix: Index, t: Transaction): TxTotals {
  const out = { mine: 0, owe: 0, give: 0 };
  for (const s of ix.sharesOfTx.get(t.id) ?? []) out[s.type] += s.amount;
  return out;
}

export interface Line { tx: Transaction; amount: number }
export interface SubGroup { id: string; name: string; amount: number; items: Line[] }
export interface CatGroup { id: string; name: string; icon: string; amount: number; subs: SubGroup[] }
export interface PersonGroup { personId: string; amount: number; items: Line[] }

export interface PeriodStats {
  txs: Transaction[];
  total: number;
  mine: number;
  give: number;
  owe: number;
  byCategory: CatGroup[];
  byTag: { tag: Tag; amount: number }[];
  giveByPerson: PersonGroup[];
  oweByPerson: PersonGroup[];
  /** BR-20..22: income, money paid back, net cash flow = income + paid back − total money out (RULE-14). */
  income: number;
  received: number;
  /**
   * RULE-14: Left over = income − my real spending (spent).
   * Advances (to be paid back) and on-behalf payments from held money (other people's money) are not counted.
   */
  net: number;
  /** My real spending = all Mine + Given + forgiven: money really gone. */
  spent: number;
  /** Advances in the period = Owed not yet covered by held money (beyond held money, or nothing deposited yet). */
  advanced: number;
  /** Money returned to others from held money (UC-13). */
  returned: number;
  /** Forgiven in the period (UC-10) — counted as Given but not money out in the period. */
  forgiven: number;
  /** On-behalf payments in the period (UC-12) — part of Money out and Advances. */
  onBehalf: number;
  incomeByCategory: IncomeGroup[];
  /**
   * Repayments in the period (hold + transfer + offset). Only repayments of OPENING debts (repaidOld) reduce "Left over";
   * for debts created in the app the spending was already counted, so it is not deducted again.
   */
  repaid: number;
  repaidOld: number;
  /** Waived in the period; the in-app part (waivedNew) counts like a gift (added to "Left over"). */
  waived: number;
  waivedNew: number;
  /** Forgiving opening "They owe me" amounts: still Given, but not in the period's spending. */
  forgivenOld: number;
  /** New loans in the period (money in, not income). */
  borrowed: number;
}

export interface IncomeLine { income: Income; amount: number }
export interface IncomeGroup { id: string; name: string; icon: string; amount: number; subs: { id: string; name: string; amount: number; items: IncomeLine[] }[] }

function groupIncomes(ix: Index, list: Income[]): IncomeGroup[] {
  const m = new Map<string, IncomeGroup>();
  for (const r of list) {
    const root = rootOf(ix, r.categoryId);
    const rootId = root?.id ?? '?';
    let g = m.get(rootId);
    if (!g) m.set(rootId, (g = { id: rootId, name: root?.name ?? 'Không rõ', icon: root?.icon ?? 'dots', amount: 0, subs: [] }));
    g.amount += r.amount;
    const sub = ix.category.get(r.categoryId);
    const subId = sub && sub.parentId ? sub.id : rootId;
    let sg = g.subs.find((x) => x.id === subId);
    if (!sg) g.subs.push((sg = { id: subId, name: subId === rootId ? 'Chung' : sub!.name, amount: 0, items: [] }));
    sg.amount += r.amount;
    sg.items.push({ income: r, amount: r.amount });
  }
  const out = [...m.values()].sort((a, b) => b.amount - a.amount);
  for (const g of out) g.subs.sort((a, b) => b.amount - a.amount);
  return out;
}

/** Numbers for one period (BR-10, BR-12). Overview and Stats share this function, so they always agree. */
export function periodStats(ix: Index, range: { from: string; to: string }): PeriodStats {
  const txs = ix.txs.filter((t) => inRange(t.date, range));
  let total = 0, mine = 0, give = 0, owe = 0, mineAll = 0, advanced = 0;
  const forgivenOf = ix.forgivenByShare;
  const cats = new Map<string, CatGroup>();
  const tags = new Map<string, number>();
  const giveBy = new Map<string, PersonGroup>();
  const oweBy = new Map<string, PersonGroup>();

  for (const t of txs) {
    total += t.totalAmount;
    const counts = countsAsMine(ix, t);
    for (const s of ix.sharesOfTx.get(t.id) ?? []) {
      if (s.type === 'mine') {
        mineAll += s.amount;
        if (!counts) continue;
        mine += s.amount;
        const root = rootOf(ix, t.categoryId);
        const rootId = root?.id ?? '?';
        let g = cats.get(rootId);
        if (!g) cats.set(rootId, (g = { id: rootId, name: root?.name ?? 'Không rõ', icon: root?.icon ?? 'dots', amount: 0, subs: [] }));
        g.amount += s.amount;
        const sub = ix.category.get(t.categoryId);
        const subId = sub && sub.parentId ? sub.id : rootId;
        let sg = g.subs.find((x) => x.id === subId);
        if (!sg) g.subs.push((sg = { id: subId, name: subId === rootId ? 'Chung' : sub!.name, amount: 0, items: [] }));
        sg.amount += s.amount;
        sg.items.push({ tx: t, amount: s.amount });
        for (const tagId of ix.tagIdsOfTx.get(t.id) ?? []) tags.set(tagId, (tags.get(tagId) ?? 0) + s.amount);
      } else if (s.personId) {
        const m = s.type === 'give' ? giveBy : oweBy;
        if (s.type === 'give') give += s.amount;
        else {
          // The offset part is a repayment ("Trả nợ" row), not Owed.
          const real = oweAmount(ix, s);
          owe += real;
          if (real <= 0) continue;
          // parts paid with held money, offset (counted as repayment) or forgiven (counted as spending) are no longer advances
          advanced += Math.max(0, s.amount - (ix.heldCover.get(s.id) ?? 0) - (ix.offsetCover.get(s.id) ?? 0) - (forgivenOf.get(s.id) ?? 0));
        }
        const amt = s.type === 'owe' ? oweAmount(ix, s) : s.amount;
        let g = m.get(s.personId);
        if (!g) m.set(s.personId, (g = { personId: s.personId, amount: 0, items: [] }));
        g.amount += amt;
        g.items.push({ tx: t, amount: amt });
      }
    }
  }

  const byCategory = [...cats.values()].sort((a, b) => b.amount - a.amount);
  for (const g of byCategory) g.subs.sort((a, b) => b.amount - a.amount);
  const incomes = ix.incomes.filter((r) => inRange(r.date, range));
  const income = incomes.reduce((a, r) => a + r.amount, 0);
  const sts = ix.settlements.filter((st) => inRange(st.date, range));
  const received = sts.filter((st) => st.direction !== 'out' && !st.opening).reduce((a, st) => a + st.amount, 0);
  const returned = sts.filter((st) => st.direction === 'out').reduce((a, st) => a + st.amount, 0);
  let forgivenSum = 0, forgivenOld = 0;
  for (const f of ix.forgiven) {
    if (!inRange(f.date, range)) continue;
    if (f.tx.opening) { forgivenOld += f.alloc.amount; continue; }
    forgivenSum += f.alloc.amount;
    const pid = f.share.personId!;
    let g = giveBy.get(pid);
    if (!g) giveBy.set(pid, (g = { personId: pid, amount: 0, items: [] }));
    g.amount += f.alloc.amount;
    g.items.push({ tx: f.tx, amount: f.alloc.amount });
  }
  const onBehalf = txs.filter((t) => t.onBehalf).reduce((a, t) => a + t.totalAmount, 0);
  const d = debtFlows(ix, range);
  return {
    income, received, returned, forgiven: forgivenSum, onBehalf, forgivenOld, ...d,
    spent: mineAll + give + forgivenSum, advanced,
    net: income + d.waivedNew - (mineAll + give + forgivenSum) - d.repaidOld, incomeByCategory: groupIncomes(ix, incomes),
    txs, total, mine, give, owe, byCategory,
    byTag: [...tags.entries()].flatMap(([id, amount]) => {
      const tag = ix.tag.get(id);
      return tag ? [{ tag, amount }] : [];
    }).sort((a, b) => b.amount - a.amount),
    giveByPerson: [...giveBy.values()].sort((a, b) => b.amount - a.amount),
    oweByPerson: [...oweBy.values()].sort((a, b) => b.amount - a.amount),
  };
}

export interface MonthPoint { month: string; total: number; mine: number; give: number; owe: number; income: number; received: number; returned: number; spent: number; advanced: number; net: number; repaid: number }

/** Date of an offset row: its own date, otherwise the transaction date. */
const offsetDate = (ix: Index, a: Allocation) => a.date ?? (ix.tx.get(ix.shareById.get(a.shareId)?.transactionId ?? '')?.date) ?? a.createdAt.slice(0, 10);

/** Debt flows within a date range (see PeriodStats). */
function debtFlows(ix: Index, range: { from: string; to: string }) {
  let repaid = 0, repaidOld = 0, waived = 0, waivedNew = 0, borrowed = 0;
  const old = (payableId?: string) => ix.payableById.get(payableId ?? '')?.origin === 'opening';
  for (const r of ix.repayments) {
    if (!inRange(r.date, range)) continue;
    if (r.mode === 'waive') {
      waived += r.amount;
      if (!old(r.payableId)) waivedNew += r.amount;
    } else {
      repaid += r.amount;
      if (old(r.payableId)) repaidOld += r.amount;
    }
  }
  for (const a of ix.offsets) {
    if (!inRange(offsetDate(ix, a), range)) continue;
    repaid += a.amount;
    if (old(a.payableId)) repaidOld += a.amount;
  }
  for (const p of ix.payables) if (p.origin === 'borrow' && inRange(p.date, range)) borrowed += p.amount;
  return { repaid, repaidOld, waived, waivedNew, borrowed };
}

/** BR-17: the 12 periods of a year; average = Mine for the year ÷ months elapsed. */
export function yearStats(ix: Index, year: number, currentMonth: string) {
  const months: MonthPoint[] = [];
  for (let i = 0; i < 12; i++) {
    const month = `${year}-${String(i + 1).padStart(2, '0')}`;
    const st = periodStats(ix, periodRange(month, ix.startDay));
    months.push({ month, total: st.total, mine: st.mine, give: st.give, owe: st.owe, income: st.income, received: st.received, returned: st.returned, spent: st.spent, advanced: st.advanced, net: st.net, repaid: st.repaid });
  }
  const range = { from: periodRange(`${year}-01`, ix.startDay).from, to: periodRange(shiftMonth(`${year}-12`, 1), ix.startDay).from };
  const all = periodStats(ix, range);
  const cy = Number(currentMonth.slice(0, 4));
  const elapsed = year < cy ? 12 : year > cy ? 0 : Number(currentMonth.slice(5, 7));
  return { months, stats: all, elapsed, average: elapsed ? Math.round(all.mine / elapsed) : 0 };
}

export interface Debt { share: Share; tx: Transaction; paid: number; remaining: number }

/** A person's open Owed items, oldest first. */
export function openDebts(ix: Index, personId: string): Debt[] {
  const out: Debt[] = [];
  for (const t of ix.allTxs) {
    for (const s of ix.sharesOfTx.get(t.id) ?? []) {
      if (s.type !== 'owe' || s.personId !== personId) continue;
      const paid = ix.paid.get(s.id) ?? 0;
      if (paid < s.amount) out.push({ share: s, tx: t, paid, remaining: s.amount - paid });
    }
  }
  return out.sort((a, b) => a.tx.date.localeCompare(b.tx.date) || a.share.createdAt.localeCompare(b.share.createdAt));
}

export interface Outstanding { personId: string; amount: number; count: number; oldest: string }

/** Currently outstanding Owed, per person. */
export function outstanding(ix: Index): Outstanding[] {
  const m = new Map<string, Outstanding>();
  for (const t of ix.allTxs) {
    for (const s of ix.sharesOfTx.get(t.id) ?? []) {
      if (s.type !== 'owe' || !s.personId) continue;
      const rem = s.amount - (ix.paid.get(s.id) ?? 0);
      if (rem <= 0) continue;
      const o = m.get(s.personId) ?? { personId: s.personId, amount: 0, count: 0, oldest: t.date };
      o.amount += rem;
      o.count += 1;
      if (t.date < o.oldest) o.oldest = t.date;
      m.set(s.personId, o);
    }
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}

export interface PersonEntry {
  share: Share; tx: Transaction; status?: DebtStatus; paid: number;
  /** Amount of the row: the share, or the forgiven part in the Given tab. */
  amount: number;
  /** Part of this item that was forgiven (UC-10). */
  forgiven: number;
  /** A Given row that comes from forgiving an Owed item. */
  fromForgive?: boolean;
  /** Part offset (repayment) — already removed from the Owed row amount. */
  offset?: number;
}
export interface PersonSummary { personId: string; total: number; waiting: number; entries: PersonEntry[] }

/** BR-13: Given / Owed per person, all time. */
export function peopleSummary(ix: Index, type: Exclude<ShareType, 'mine'>): PersonSummary[] {
  const m = new Map<string, PersonSummary>();
  for (const t of ix.allTxs) {
    for (const s of ix.sharesOfTx.get(t.id) ?? []) {
      if (s.type !== type || !s.personId) continue;
      // Owed: drop the offset part (that is a repayment); fully offset items are no longer Owed.
      const off = type === 'owe' ? ix.offsetCover.get(s.id) ?? 0 : 0;
      const amount = s.amount - off;
      if (amount <= 0) continue;
      const g = m.get(s.personId) ?? { personId: s.personId, total: 0, waiting: 0, entries: [] };
      const paid = Math.max(0, (ix.paid.get(s.id) ?? 0) - off);
      g.total += amount;
      if (type === 'owe') g.waiting += Math.max(0, amount - paid);
      const fg = ix.forgivenByShare.get(s.id) ?? 0;
      const status = type === 'owe' ? (paid >= amount ? 'paid' : paid > 0 ? 'partial' : 'open') : undefined;
      g.entries.push({ share: s, tx: t, paid, amount, forgiven: fg, status, offset: off || undefined });
      m.set(s.personId, g);
    }
  }
  if (type === 'give') {
    for (const f of ix.forgiven) {
      const pid = f.share.personId!;
      const g = m.get(pid) ?? { personId: pid, total: 0, waiting: 0, entries: [] };
      g.total += f.alloc.amount;
      g.entries.push({ share: f.share, tx: f.tx, paid: 0, amount: f.alloc.amount, forgiven: f.alloc.amount, fromForgive: true });
      m.set(pid, g);
    }
    for (const g of m.values()) g.entries.sort((a, b) => b.tx.date.localeCompare(a.tx.date));
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

/** Search transactions by title, product, category, tag, person (accent-insensitive). */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();

export function txMatches(ix: Index, t: Transaction, q: string) {
  if (!q.trim()) return true;
  const hay = [
    t.title, t.productName ?? '', categoryPath(ix, t.categoryId),
    ...(ix.tagIdsOfTx.get(t.id) ?? []).map((id) => ix.tag.get(id)?.name ?? ''),
    ...(ix.sharesOfTx.get(t.id) ?? []).map((s) => (s.personId ? ix.person.get(s.personId)?.name ?? '' : '')),
  ].join(' ');
  return fold(hay).includes(fold(q.trim()));
}

export const totalOf = (xs: { amount: number }[]) => sum(xs.map((x) => x.amount));

/**
 * BR-23 / RULE-15: balance = opening balance + every cash flow dated from the start date up to before `before`.
 * Transactions before the start date are already in the opening balance, so they are not counted again. No opening balance → null.
 */
export function balanceAt(ix: Index, before?: string): number | null {
  const s = ix.snap.settings;
  if (s?.openingBalance === undefined || !s.openingDate) return null;
  const from = s.openingDate;
  const ok = (d: string) => d >= from && (!before || d < before);
  let b = s.openingBalance;
  for (const r of ix.incomes) if (ok(r.date)) b += r.amount;
  for (const st of ix.settlements) if (ok(st.date) && !st.opening) b += st.direction === 'out' ? -st.amount : st.amount;
  for (const t of ix.txs) if (ok(t.date)) b -= t.totalAmount;
  for (const p of ix.payables) if (p.origin === 'borrow' && ok(p.date)) b += p.amount;
  for (const r of ix.repayments) if (r.mode === 'transfer' && ok(r.date)) b -= r.amount;
  return b;
}

/** People who gave you money (incomes with a person), all time. */
export function giftsFromPeople(ix: Index) {
  const m = new Map<string, { personId: string; total: number; items: Income[] }>();
  for (const r of ix.incomes) {
    if (!r.personId) continue;
    const g = m.get(r.personId) ?? { personId: r.personId, total: 0, items: [] };
    g.total += r.amount;
    g.items.push(r);
    m.set(r.personId, g);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

/** When a real-money application happened: the payment date, or the transaction date for auto-applied held money. */
function allocDate(ix: Index, a: Allocation) {
  if (a.settlementId) return ix.settlementById.get(a.settlementId)?.date ?? a.createdAt.slice(0, 10);
  const sh = ix.shareById.get(a.shareId);
  return (sh && ix.tx.get(sh.transactionId)?.date) ?? a.createdAt.slice(0, 10);
}

/** Money held for others at a point in time (before `before`); omitted = now. */
export function heldAt(ix: Index, before?: string) {
  if (!before) return [...ix.credit.values()].reduce((a, v) => a + Math.max(0, v), 0);
  const per = new Map<string, number>();
  const add = (id: string, v: number) => per.set(id, (per.get(id) ?? 0) + v);
  for (const st of ix.settlements) if (st.date < before) add(st.personId, st.direction === 'out' ? -st.amount : st.amount);
  for (const a of ix.snap.allocations) {
    if (a.deletedAt || a.kind === 'forgive' || a.kind === 'offset') continue;
    if (allocDate(ix, a) < before) add(a.personId, -a.amount);
  }
  for (const r of ix.repayments) if (r.mode === 'hold' && r.date < before) add(r.personId, r.amount);
  for (const p of ix.payables) if (p.origin === 'fromHeld' && p.date < before) add(p.personId, -p.amount);
  return [...per.values()].reduce((a, v) => a + Math.max(0, v), 0);
}

/**
 * What I owe (before `before`; omitted = now), split into opening (off the books) and created in the app.
 */
export function owedAt(ix: Index, before?: string) {
  const left = new Map<string, number>();
  for (const p of ix.payables) if (!before || p.date < before) left.set(p.id, p.amount);
  for (const r of ix.repayments) if ((!before || r.date < before) && left.has(r.payableId)) left.set(r.payableId, left.get(r.payableId)! - r.amount);
  for (const a of ix.offsets) {
    if (!a.payableId || !left.has(a.payableId) || (before && offsetDate(ix, a) >= before)) continue;
    left.set(a.payableId, left.get(a.payableId)! - a.amount);
  }
  let opening = 0, inApp = 0;
  for (const [id, v] of left) {
    if (v <= 0) continue;
    if (ix.payableById.get(id)!.origin === 'opening') opening += v;
    else inApp += v;
  }
  return { total: opening + inApp, opening, inApp };
}

/** What I owe one person (now). */
export function owedTo(ix: Index, personId: string) {
  return ix.payables.filter((p) => p.personId === personId).reduce((s, p) => s + Math.max(0, p.amount - (ix.payableUsed.get(p.id) ?? 0)), 0);
}

export interface DebtRow { personId: string; iOwe: number; theyOwe: number }

/** Two-way debts per person (now), largest first. */
export function debtSummary(ix: Index): DebtRow[] {
  const m = new Map<string, DebtRow>();
  const get = (id: string) => m.get(id) ?? (m.set(id, { personId: id, iOwe: 0, theyOwe: 0 }), m.get(id)!);
  for (const o of outstanding(ix)) get(o.personId).theyOwe = o.amount;
  for (const p of ix.payables) {
    const rem = p.amount - (ix.payableUsed.get(p.id) ?? 0);
    if (rem > 0) get(p.personId).iOwe += rem;
  }
  return [...m.values()].filter((r) => r.iOwe > 0 || r.theyOwe > 0).sort((a, b) => b.iOwe + b.theyOwe - (a.iOwe + a.theyOwe));
}

export interface DebtEvent { date: string; label: string; delta: number; balance: number; kind: 'new' | 'repay' | 'offset' | 'waive'; ref: { type: 'payable' | 'repayment' | 'alloc'; id: string } }

const ORIGIN = { opening: 'Nợ đầu kỳ', borrow: 'Vay', fromHeld: 'Ứng tiền đang giữ' } as const;
const MODE = { hold: 'Trả nợ · giữ lại cho họ', transfer: 'Trả nợ · chuyển khoản', waive: 'Được xóa nợ' } as const;

/** One repayment with money (hold / transfer) — shown as one money-out transaction. */
export interface RepayTx { key: string; personId: string; date: string; createdAt: string; amount: number; mode: 'hold' | 'transfer'; incomeId?: string | null; note?: string; ids: string[] }

/** Group repayment rows of the same repayment (same batch) into one transaction, newest first. Waivers move no money, so they are not here. */
export function repayTxs(ix: Index): RepayTx[] {
  const m = new Map<string, RepayTx>();
  for (const r of ix.repayments) {
    if (r.mode === 'waive') continue;
    const key = r.batch ?? r.id;
    const g = m.get(key);
    if (g) { g.amount += r.amount; g.ids.push(r.id); continue; }
    m.set(key, { key, personId: r.personId, date: r.date, createdAt: r.createdAt, amount: r.amount, mode: r.mode, incomeId: r.incomeId, note: r.note, ids: [r.id] });
  }
  return [...m.values()].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

/** My debt book with one person: created (+), repaid / offset / waived (−), with the running balance. */
export function debtLedger(ix: Index, personId: string): DebtEvent[] {
  const ev: (Omit<DebtEvent, 'balance'> & { at: string })[] = [];
  for (const p of ix.payables) {
    if (p.personId !== personId) continue;
    ev.push({ date: p.date, at: p.createdAt, label: ORIGIN[p.origin] + (p.note && p.note !== 'Số đầu kỳ' ? ` · ${p.note}` : ''), delta: p.amount, kind: 'new', ref: { type: 'payable', id: p.id } });
  }
  for (const r of ix.repayments) {
    if (r.personId !== personId) continue;
    const label = MODE[r.mode] + (r.incomeId ? ' · từ thu nhập' : '') + (r.note ? ` · ${r.note}` : '');
    ev.push({ date: r.date, at: r.createdAt, label, delta: -r.amount, kind: r.mode === 'waive' ? 'waive' : 'repay', ref: { type: 'repayment', id: r.id } });
  }
  for (const a of ix.offsets) {
    if (a.personId !== personId) continue;
    const sh = ix.shareById.get(a.shareId);
    const t = sh ? ix.tx.get(sh.transactionId) : undefined;
    const name = t ? (t.opening ? 'Khoản họ nợ đầu kỳ' : t.title || t.productName || categoryPath(ix, t.categoryId)) : 'Khoản đã xóa';
    ev.push({ date: offsetDate(ix, a), at: a.createdAt, label: `Cấn trừ · ${name}`, delta: -a.amount, kind: 'offset', ref: { type: 'alloc', id: a.id } });
  }
  ev.sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at));
  let bal = 0;
  return ev.map(({ at: _at, ...e }) => ({ ...e, balance: (bal += e.delta) }));
}

/**
 * RULE-18: My balance = account balance − money held for others.
 * Gifts (income) are yours, so they are included; money others still owe you is not added.
 */
export function personalBalanceAt(ix: Index, before?: string): number | null {
  const bank = balanceAt(ix, before);
  // In-app debts (loans, spent held money) belong to others; opening debts are off the books, so not deducted.
  return bank === null ? null : bank - heldAt(ix, before) - owedAt(ix, before).inApp;
}

export interface HeldEvent { date: string; label: string; delta: number; balance: number; kind: 'in' | 'spend' | 'out' | 'gift' }

/** UC-11..13: a person's held-money book — received, spent on behalf / applied, returned, gifted — with the running balance. */
export function heldLedger(ix: Index, personId: string): HeldEvent[] {
  const ev: (Omit<HeldEvent, 'balance'> & { at: string })[] = [];
  for (const st of ix.settlements) {
    if (st.personId !== personId) continue;
    const gift = (ix.giftsOfSettlement.get(st.id) ?? []).reduce((a, r) => a + r.amount, 0);
    if (st.opening) ev.push({ date: st.date, at: st.createdAt, label: 'Số đầu kỳ', delta: st.amount, kind: 'in' });
    else if (st.direction === 'out') ev.push({ date: st.date, at: st.createdAt, label: st.note ? `Trả lại · ${st.note}` : 'Trả lại', delta: -st.amount, kind: 'out' });
    else ev.push({ date: st.date, at: st.createdAt, label: (st.note ? `Nhận · ${st.note}` : 'Nhận') + (gift ? ` (cho luôn ${gift.toLocaleString('vi-VN')}đ)` : ''), delta: st.amount, kind: 'in' });
  }
  for (const a of ix.snap.allocations) {
    if (a.deletedAt || a.kind === 'forgive' || a.kind === 'offset' || a.personId !== personId) continue;
    const sh = ix.shareById.get(a.shareId);
    const t = sh ? ix.tx.get(sh.transactionId) : undefined;
    const name = t ? (t.title || t.productName || categoryPath(ix, t.categoryId)) : 'Khoản đã xóa';
    ev.push({ date: allocDate(ix, a), at: a.createdAt, label: (t?.onBehalf ? 'Chi hộ · ' : 'Trừ khoản · ') + name, delta: -a.amount, kind: 'spend' });
  }
  for (const r of ix.repayments) {
    if (r.personId !== personId || r.mode !== 'hold') continue;
    ev.push({ date: r.date, at: r.createdAt, label: 'Trả nợ · giữ lại cho họ', delta: r.amount, kind: 'in' });
  }
  for (const p of ix.payables) {
    if (p.personId !== personId || p.origin !== 'fromHeld') continue;
    ev.push({ date: p.date, at: p.createdAt, label: 'Đã tiêu · chuyển thành khoản tôi nợ' + (p.note ? ` · ${p.note}` : ''), delta: -p.amount, kind: 'spend' });
  }
  // By date; same date by write order.
  ev.sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at));
  let bal = 0;
  return ev.map(({ at: _at, ...e }) => ({ ...e, balance: (bal += e.delta) }));
}

/** A person's opening amounts (UC-14), for editing. */
export function openingOf(ix: Index, personId: string) {
  const st = ix.settlements.find((s) => s.opening && s.personId === personId);
  const pay = ix.payables.find((p) => p.origin === 'opening' && p.personId === personId);
  const t = ix.allTxs.find((x) => x.opening && (ix.sharesOfTx.get(x.id) ?? []).some((s) => s.personId === personId));
  const sh = t ? (ix.sharesOfTx.get(t.id) ?? []).find((s) => s.personId === personId) : undefined;
  return { date: st?.date ?? pay?.date ?? t?.date, held: st?.amount ?? 0, owedByMe: pay?.amount ?? 0, owedToMe: sh?.amount ?? 0 };
}
