import Dexie, { type EntityTable } from 'dexie';

/** Mọi bảng có id (UUID), createdAt, updatedAt, deletedAt để sau này đồng bộ với app mobile. */
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
  parentId: string | null; // null = danh mục chính
  countsAsMine: boolean;
  sortOrder: number;
  /** 'income' = danh mục thu nhập; không có = danh mục chi (dữ liệu cũ). */
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
  categoryId: string; // danh mục con nếu có
  title: string;
  productName?: string;
  /** Chi hộ người khác (UC-12): không có phần Của tôi, trừ vào tiền đang giữ. */
  onBehalf?: boolean;
  totalAmount: number; // đồng, số nguyên
  splitMode: SplitMode;
  /** Số "Họ đang nợ tôi" nhập lúc bắt đầu dùng app: không phải tiền ra, không vào thống kê kỳ. */
  opening?: boolean;
}

export interface TransactionTag extends Base {
  transactionId: string;
  tagId: string;
}

export interface Share extends Base {
  transactionId: string;
  personId: string | null; // null = tôi
  type: ShareType;
  amount: number;
}

export interface Settlement extends Base {
  personId: string;
  date: string;
  amount: number;
  note?: string;
  /** 'in' (mặc định) = người đó chuyển cho bạn; 'out' = bạn trả lại tiền đang giữ của họ (UC-13). */
  direction?: 'in' | 'out';
  /** Số đang giữ nhập lúc bắt đầu dùng app: đã nằm trong số dư ban đầu, không phải tiền vào. */
  opening?: boolean;
}

export interface Allocation extends Base {
  settlementId: string | null; // null = trừ từ tiền đang giữ (hoặc bỏ qua không kèm lần nhận)
  shareId: string;
  personId: string;
  amount: number;
  /** 'pay' (mặc định) = trừ bằng tiền thật; 'forgive' = bạn bỏ qua, phần đó thành Cho đi (UC-10); 'offset' = cấn trừ với khoản tôi nợ người đó. Hai loại sau không đụng tiền đang giữ. */
  kind?: 'pay' | 'forgive' | 'offset';
  /** Ngày bỏ qua / cấn trừ (với kind 'forgive' | 'offset'). */
  date?: string;
  /** Chỉ với kind 'offset': khoản tôi nợ được cấn trừ. */
  payableId?: string;
}

/**
 * Khoản TÔI nợ một người.
 * - 'opening': nợ từ trước khi dùng app (ngoài sổ: không trừ vào Số dư của tôi; trả thì tính là tiền ra).
 * - 'borrow': vay mới, tiền vào tài khoản (trong sổ).
 * - 'fromHeld': chuyển một phần tiền đang giữ thành khoản nợ vì đã tiêu mất (trong sổ).
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
 * Một lần giảm khoản tôi nợ (gắn với đúng một khoản nợ).
 * - 'hold': trả bằng cách giữ lại trong tài khoản cho người đó (thành tiền đang giữ).
 * - 'transfer': chuyển khoản trả thẳng.
 * - 'waive': người đó xóa nợ cho tôi (không có tiền đi đâu).
 */
export type RepayMode = 'hold' | 'transfer' | 'waive';
export interface Repayment extends Base {
  personId: string;
  payableId: string;
  date: string;
  amount: number;
  mode: RepayMode;
  /** Trả nợ từ một khoản thu nhập: xóa thu nhập thì xóa theo. */
  incomeId?: string | null;
  note?: string;
  /** Các dòng ghi cùng một lần trả (một lần trả chia vào nhiều khoản nợ) có chung batch → hiện là 1 giao dịch. */
  batch?: string;
}

/** Một khoản thu nhập: lương, thưởng, được cho… (khác tiền người khác trả lại = settlements). */
export interface Income extends Base {
  date: string; // YYYY-MM-DD
  categoryId: string; // danh mục thu (con nếu có)
  amount: number;
  title: string;
  personId: string | null; // người cho, ví dụ Mẹ; null = không gắn người
  /** Phần dư người đó cho luôn khi trả tiền (UC-09): gắn với lần nhận, xóa lần nhận thì xóa theo. */
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
  /** Kỳ gần nhất đã chạy ghi chú cuối tháng (YYYY-MM). */
  lastMonthEnd?: string;
  /** Lần sao lưu gần nhất (ISO), để nhắc khi quá 7 ngày (NFR-04). */
  lastBackupAt?: string;
  /** Số dư ban đầu: số tiền đang có tại ngày openingDate (bắt đầu tính số dư). */
  openingBalance?: number;
  openingDate?: string;
  /** Đã tạo danh mục thu mặc định (cho dữ liệu cũ nâng cấp lên). */
  incomeSeeded?: boolean;
  /** Đã tạo danh mục Hóa đơn mặc định (cho dữ liệu cũ). */
  billsSeeded?: boolean;
  /** Đã tạo "Chuyển tiền › Thanh toán hộ" (cho dữ liệu cũ). */
  payForSeeded?: boolean;
  /** Ẩn số nhạy cảm (thu nhập, số dư, còn lại) mỗi lần mở app; không có = true. */
  hideOnOpen?: boolean;
  /** Lần đổi gần nhất của các cài đặt được đồng bộ giữa các trình duyệt (SYNCED_SETTINGS). */
  syncUpdatedAt?: string;
}

/** Cài đặt dùng chung giữa các trình duyệt; phần còn lại (giao diện, ẩn số, sao lưu, cờ tạo dữ liệu mặc định) là của riêng từng máy. */
export const SYNCED_SETTINGS = ['monthStartDay', 'monthEndNote', 'autoApplyCredit', 'openingBalance', 'openingDate'] as const;

/** Bảng được đồng bộ (theo thứ tự ghi: bảng được tham chiếu trước). */
export const SYNC_TABLES = ['people', 'groups', 'groupMembers', 'categories', 'tags', 'categoryTags', 'transactions', 'transactionTags',
  'shares', 'settlements', 'allocations', 'monthNotes', 'incomes', 'payables', 'repayments'] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

/** Dữ liệu riêng của trình duyệt này (không sao lưu, không đồng bộ): mã máy, các máy đã đồng bộ, đồng hồ. */
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
  /** Số thứ tự ghi trên máy này: mỗi bản ghi mang _seq của lần ghi cuối, để gói đồng bộ chỉ chứa phần thay đổi. */
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
    // v2: thu nhập. Bảng cũ giữ nguyên; danh mục thu được tạo bằng seedIncomeCategories.
    this.version(2).stores({
      incomes: 'id, date, categoryId, personId, updatedAt',
    });
    // v3: công nợ hai chiều (khoản tôi nợ + các lần trả / xóa nợ).
    this.version(3).stores({
      payables: 'id, personId, date, updatedAt',
      repayments: 'id, personId, payableId, incomeId, date, updatedAt',
    });
    // v4: đồng bộ giữa các trình duyệt — chỉ mục _seq cho mọi bảng đồng bộ + bảng meta riêng của máy.
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
    // Đổi cài đặt dùng chung → đánh dấu thời điểm để gộp (bản mới hơn thắng).
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

/** Chỉ mục của từng bảng (giữ nguyên như các bản trước, thêm _seq ở v4). */
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
 * Đồng hồ không lùi: luôn lớn hơn mọi mốc thời gian đã thấy (kể cả từ máy khác khi đồng bộ),
 * để lần sửa sau trên máy này luôn "mới hơn" dù đồng hồ hai máy lệch nhau.
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
