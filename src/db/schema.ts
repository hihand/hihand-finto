import Dexie, { type EntityTable } from 'dexie';

/** Every table has id (UUID), createdAt, updatedAt, deletedAt so it can be synced later. */
export interface Base {
  id: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  deletedAt?: string | null;
}

export type ShareType = 'mine' | 'owe' | 'give';
export type TxKind = 'expense' | 'transfer';
export type SplitMode = 'equal' | 'custom';

export interface Person extends Base {
  name: string;
  color: string;
  defaultType: 'owe' | 'give';
  note?: string;
  archived?: boolean;
}

export interface Group extends Base {
  name: string;
}

export interface GroupMember extends Base {
  groupId: string;
  personId: string;
}

export interface Category extends Base {
  name: string;
  icon: string;
  parentId: string | null; // null = top-level category
  countsAsMine: boolean;
  sortOrder: number;
  /** 'income' = income category; missing = expense category (old data). */
  kind?: 'expense' | 'income';
}

export interface Tag extends Base {
  name: string;
}

export interface CategoryTag extends Base {
  categoryId: string;
  tagId: string;
  sortOrder: number;
}

export interface Transaction extends Base {
  date: string; // YYYY-MM-DD
  kind: TxKind;
  categoryId: string; // subcategory if any
  title: string;
  productName?: string;
  /** Paid on behalf of someone (UC-12): no "Mine" share, deducted from held money. */
  onBehalf?: boolean;
  totalAmount: number; // VND, integer
  splitMode: SplitMode;
  /** "They owe me" amount entered when starting to use the app: not money out, not in period stats. */
  opening?: boolean;
}

export interface TransactionTag extends Base {
  transactionId: string;
  tagId: string;
}

export interface Share extends Base {
  transactionId: string;
  personId: string | null; // null = me
  type: ShareType;
  amount: number;
}

export interface Settlement extends Base {
  personId: string;
  date: string;
  amount: number;
  note?: string;
  /** 'in' (default) = that person sent money to you; 'out' = you returned their held money (UC-13). */
  direction?: 'in' | 'out';
  /** Held amount entered when starting to use the app: already part of the opening balance, not money in. */
  opening?: boolean;
}

export interface Allocation extends Base {
  settlementId: string | null; // null = deducted from held money (or forgiven without a payment)
  shareId: string;
  personId: string;
  amount: number;
  /** 'pay' (default) = settled with real money; 'forgive' = you let it go, that part becomes Given (UC-10); 'offset' = netted against what I owe that person. The last two do not touch held money. */
  kind?: 'pay' | 'forgive' | 'offset';
  /** Date of the forgive / offset (for kind 'forgive' | 'offset'). */
  date?: string;
  /** Only for kind 'offset': the payable (what I owe) it is netted against. */
  payableId?: string;
}

/**
 * Money that I owe a person.
 * - 'opening': owed from before using the app (off the books: not deducted from My balance; repaying it counts as money out).
 * - 'borrow': a new loan, money came into the account (on the books).
 * - 'fromHeld': part of held money that was spent, turned into a debt (on the books).
 */
export type PayableOrigin = 'opening' | 'borrow' | 'fromHeld';
export interface Payable extends Base {
  personId: string;
  date: string;
  amount: number;
  origin: PayableOrigin;
  note?: string;
}

/**
 * One reduction of what I owe (tied to exactly one payable).
 * - 'hold': repaid by keeping the money in my account for that person (becomes held money).
 * - 'transfer': repaid by bank transfer.
 * - 'waive': that person forgave the debt (no money moves).
 */
export type RepayMode = 'hold' | 'transfer' | 'waive';
export interface Repayment extends Base {
  personId: string;
  payableId: string;
  date: string;
  amount: number;
  mode: RepayMode;
  /** Repayment made from an income: deleting the income deletes it too. */
  incomeId?: string | null;
  note?: string;
  /** Rows written by the same repayment (one repayment split across several payables) share a batch → shown as one transaction. */
  batch?: string;
}

/** One income: salary, bonus, gifts… (different from money others pay back = settlements). */
export interface Income extends Base {
  date: string; // YYYY-MM-DD
  categoryId: string; // income category (subcategory if any)
  amount: number;
  title: string;
  personId: string | null; // giver, e.g. Mom; null = no person
  /** Surplus the person gave away when paying (UC-09): tied to that payment; deleting the payment deletes it. */
  settlementId?: string | null;
}

export interface MonthNote extends Base {
  personId: string;
  month: string; // YYYY-MM
  creditAmount: number;
}

export interface Settings {
  id: 'settings';
  theme: 'dark' | 'light' | 'system';
  monthStartDay: number;
  monthEndNote: boolean;
  autoApplyCredit: boolean;
  seeded: boolean;
  /** Latest period for which the month-end note ran (YYYY-MM). */
  lastMonthEnd?: string;
  /** Last backup (ISO), to remind after 7 days (NFR-04). */
  lastBackupAt?: string;
  /** Opening balance: money on hand at openingDate (where the balance starts). */
  openingBalance?: number;
  openingDate?: string;
  /** Default income categories created (for upgraded old data). */
  incomeSeeded?: boolean;
  /** Default Bills category created (for old data). */
  billsSeeded?: boolean;
  /** "Chuyển tiền › Thanh toán hộ" created (for old data). */
  payForSeeded?: boolean;
  /** Hide sensitive amounts (income, balances, left over) on every app open; missing = true. */
  hideOnOpen?: boolean;
  /** Last change of the settings that are synced between browsers (SYNCED_SETTINGS). */
  syncUpdatedAt?: string;
}

/** Settings shared between browsers; the rest (theme, hide amounts, backups, seed flags) belongs to each browser. */
export const SYNCED_SETTINGS = ['monthStartDay', 'monthEndNote', 'autoApplyCredit', 'openingBalance', 'openingDate'] as const;

/** Synced tables (in write order: referenced tables first). */
export const SYNC_TABLES = ['people', 'groups', 'groupMembers', 'categories', 'tags', 'categoryTags', 'transactions', 'transactionTags',
  'shares', 'settlements', 'allocations', 'monthNotes', 'incomes', 'payables', 'repayments'] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

/** Data private to this browser (not backed up, not synced): device id, synced browsers, clock. */
export interface Meta { key: string; value: unknown }

export class FintoDB extends Dexie {
  people!: EntityTable<Person, 'id'>;
  groups!: EntityTable<Group, 'id'>;
  groupMembers!: EntityTable<GroupMember, 'id'>;
  categories!: EntityTable<Category, 'id'>;
  tags!: EntityTable<Tag, 'id'>;
  categoryTags!: EntityTable<CategoryTag, 'id'>;
  transactions!: EntityTable<Transaction, 'id'>;
  transactionTags!: EntityTable<TransactionTag, 'id'>;
  shares!: EntityTable<Share, 'id'>;
  settlements!: EntityTable<Settlement, 'id'>;
  allocations!: EntityTable<Allocation, 'id'>;
  monthNotes!: EntityTable<MonthNote, 'id'>;
  incomes!: EntityTable<Income, 'id'>;
  payables!: EntityTable<Payable, 'id'>;
  repayments!: EntityTable<Repayment, 'id'>;
  settings!: EntityTable<Settings, 'id'>;
  meta!: EntityTable<Meta, 'key'>;
  /** Local write sequence: every record carries the _seq of its last write, so sync packages only contain changes. */
  seq = 0;

  constructor(name = 'hihand-finto') {
    super(name);
    this.version(1).stores({
      people: 'id, name, updatedAt',
      groups: 'id, updatedAt',
      groupMembers: 'id, groupId, personId, updatedAt',
      categories: 'id, parentId, sortOrder, updatedAt',
      tags: 'id, name, updatedAt',
      categoryTags: 'id, categoryId, tagId, updatedAt',
      transactions: 'id, date, categoryId, kind, updatedAt',
      transactionTags: 'id, transactionId, tagId, updatedAt',
      shares: 'id, transactionId, personId, type, updatedAt',
      settlements: 'id, personId, date, updatedAt',
      allocations: 'id, settlementId, shareId, personId, updatedAt',
      monthNotes: 'id, [personId+month], updatedAt',
      settings: 'id',
    });
    // v2: incomes. Existing tables unchanged; income categories are created by seedIncomeCategories.
    this.version(2).stores({
      incomes: 'id, date, categoryId, personId, updatedAt',
    });
    // v3: two-way debts (payables + repayments / waivers).
    this.version(3).stores({
      payables: 'id, personId, date, updatedAt',
      repayments: 'id, personId, payableId, incomeId, date, updatedAt',
    });
    // v4: sync between browsers — _seq index on every synced table + a per-browser meta table.
    this.version(4).stores({
      ...Object.fromEntries(SYNC_TABLES.map((t) => [t, `${STORES[t]}, _seq`])),
      meta: 'key',
    }).upgrade(async (tx) => {
      let n = 0;
      for (const t of SYNC_TABLES) await tx.table(t).toCollection().modify((r: { _seq?: number }) => { r._seq = ++n; });
    });

    for (const t of SYNC_TABLES) {
      this.table(t).hook('creating', (_pk, obj: { _seq?: number }) => { obj._seq = ++this.seq; });
      this.table(t).hook('updating', () => ({ _seq: ++this.seq }));
    }
    // A shared setting changed → stamp the time for merging (newer wins).
    this.settings.hook('updating', (mods) => {
      const m = mods as Record<string, unknown>;
      if (SYNCED_SETTINGS.some((k) => k in m) && !('syncUpdatedAt' in m)) return { syncUpdatedAt: now() };
    });
    this.on('ready', async () => {
      for (const t of SYNC_TABLES) {
        const last = (await this.table(t).orderBy('_seq').last()) as { _seq?: number } | undefined;
        this.seq = Math.max(this.seq, last?._seq ?? 0);
      }
      const clock = (await this.meta.get('clock'))?.value;
      if (typeof clock === 'string') observeClock(clock);
    });
  }
}

/** Indexes of each table (unchanged from earlier versions; _seq added in v4). */
const STORES: Record<SyncTable, string> = {
  people: 'id, name, updatedAt',
  groups: 'id, updatedAt',
  groupMembers: 'id, groupId, personId, updatedAt',
  categories: 'id, parentId, sortOrder, updatedAt',
  tags: 'id, name, updatedAt',
  categoryTags: 'id, categoryId, tagId, updatedAt',
  transactions: 'id, date, categoryId, kind, updatedAt',
  transactionTags: 'id, transactionId, tagId, updatedAt',
  shares: 'id, transactionId, personId, type, updatedAt',
  settlements: 'id, personId, date, updatedAt',
  allocations: 'id, settlementId, shareId, personId, updatedAt',
  monthNotes: 'id, [personId+month], updatedAt',
  incomes: 'id, date, categoryId, personId, updatedAt',
  payables: 'id, personId, date, updatedAt',
  repayments: 'id, personId, payableId, incomeId, date, updatedAt',
};

export const db = new FintoDB();

/**
 * Monotonic clock: always later than any timestamp seen so far (including from other browsers when syncing),
 * so the next edit on this browser is always "newer" even if the two clocks disagree.
 */
let lastMs = 0;
export const observeClock = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isFinite(t) && t > lastMs) lastMs = t;
};
export const now = () => {
  lastMs = Math.max(Date.now(), lastMs + 1);
  return new Date(lastMs).toISOString();
};
export const uuid = () => crypto.randomUUID();
export const base = (): Base => {
  const t = now();
  return { id: uuid(), createdAt: t, updatedAt: t, deletedAt: null };
};
export const alive = <T extends Base>(r: T) => !r.deletedAt;
