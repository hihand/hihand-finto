import { base, type FintoDB, type Category, type Tag, type CategoryTag } from './schema';

/** Subcategory of Chuyển tiền (transfers) for on-behalf payments that are transfers to someone else (UC-12). */
export const PAY_FOR = 'Thanh toán hộ';

/** Default categories, subcategories and tags (per the "Default data" section of the spec). */
const DEFAULTS: { name: string; icon: string; countsAsMine?: boolean; children: string[]; tags: string[] }[] = [
  { name: 'Ăn uống', icon: 'utensils', children: ['Bữa chính', 'Cà phê & trà sữa', 'Ăn vặt', 'Lẩu/nướng/nhà hàng'], tags: ['đi chơi', 'bạn bè', 'người yêu', 'gia đình', 'ăn hằng ngày'] },
  { name: 'Di chuyển', icon: 'bike', children: ['Xăng', 'Grab/taxi', 'Gửi xe', 'Sửa xe'], tags: ['đi chơi', 'đi làm'] },
  { name: 'Mỹ phẩm', icon: 'sparkles', children: ['Sữa rửa mặt', 'Kem chống nắng', 'Son', 'Dưỡng da'], tags: ['quà'] },
  { name: 'Mua sắm', icon: 'bag', children: ['Quần áo', 'Đồ gia dụng', 'Đồ điện tử', 'Mua online'], tags: ['người yêu', 'quà'] },
  { name: 'Giải trí', icon: 'film', children: ['Phim', 'Game', 'Du lịch'], tags: ['đi chơi', 'bạn bè', 'người yêu'] },
  { name: 'Quà tặng', icon: 'gift', children: ['Sinh nhật', 'Lễ tết'], tags: ['bạn bè', 'người yêu', 'gia đình'] },
  { name: 'Chuyển tiền', icon: 'send', countsAsMine: false, children: ['Gia đình', 'Cho mượn', PAY_FOR], tags: ['gia đình'] },
  { name: 'Khác', icon: 'dots', children: [], tags: [] },
];

export async function seedIfEmpty(db: FintoDB) {
  await seedExpense(db);
  await seedIncomeCategories(db);
  await seedBills(db);
  await seedPayFor(db);
}

/** Add "Chuyển tiền › Thanh toán hộ" once to old ledgers (new ledgers get it from DEFAULTS). */
export async function seedPayFor(db: FintoDB) {
  await db.transaction('rw', [db.settings, db.categories], async () => {
    const s = await db.settings.get('settings');
    if (!s || s.payForSeeded) return;
    const cats = (await db.categories.toArray()).filter((c) => !c.deletedAt && c.kind !== 'income');
    const root = cats.find((c) => c.parentId === null && c.name === 'Chuyển tiền');
    if (root && !cats.some((c) => c.parentId === root.id && c.name === PAY_FOR)) {
      const n = cats.filter((c) => c.parentId === root.id).length;
      await db.categories.add({ ...base(), name: PAY_FOR, icon: root.icon, parentId: root.id, countsAsMine: root.countsAsMine, sortOrder: n, kind: 'expense' });
    }
    await db.settings.update('settings', { payForSeeded: true });
  });
}

/** Bills category (UC-12: paying bills on behalf of others), added once, including to old ledgers. */
export async function seedBills(db: FintoDB) {
  await db.transaction('rw', [db.settings, db.categories], async () => {
    const s = await db.settings.get('settings');
    if (!s || s.billsSeeded) return;
    const all = (await db.categories.toArray()).filter((c) => !c.deletedAt && c.kind !== 'income' && c.parentId === null);
    if (!all.some((c) => c.name === 'Hóa đơn')) {
      const parent: Category = { ...base(), name: 'Hóa đơn', icon: 'receipt', parentId: null, countsAsMine: true, sortOrder: all.length, kind: 'expense' };
      const kids = ['Điện', 'Nước', 'Internet', 'Điện thoại', 'Học phí'].map((n, j): Category => (
        { ...base(), name: n, icon: 'receipt', parentId: parent.id, countsAsMine: true, sortOrder: j, kind: 'expense' }));
      await db.categories.bulkAdd([parent, ...kids]);
    }
    await db.settings.update('settings', { billsSeeded: true });
  });
}

async function seedExpense(db: FintoDB) {
  await db.transaction('rw', [db.settings, db.categories, db.tags, db.categoryTags], async () => {
    const s = await db.settings.get('settings');
    if (s?.seeded) return;

    const tagByName = new Map<string, Tag>();
    const cats: Category[] = [];
    const links: CategoryTag[] = [];

    DEFAULTS.forEach((d, i) => {
      const parent: Category = { ...base(), name: d.name, icon: d.icon, parentId: null, countsAsMine: d.countsAsMine ?? true, sortOrder: i };
      cats.push(parent);
      d.children.forEach((c, j) =>
        cats.push({ ...base(), name: c, icon: d.icon, parentId: parent.id, countsAsMine: parent.countsAsMine, sortOrder: j }),
      );
      d.tags.forEach((t, k) => {
        if (!tagByName.has(t)) tagByName.set(t, { ...base(), name: t });
        links.push({ ...base(), categoryId: parent.id, tagId: tagByName.get(t)!.id, sortOrder: k });
      });
    });

    await db.categories.bulkAdd(cats);
    await db.tags.bulkAdd([...tagByName.values()]);
    await db.categoryTags.bulkAdd(links);
    await db.settings.put({
      id: 'settings', theme: s?.theme ?? 'dark', monthStartDay: 1, monthEndNote: true, autoApplyCredit: true, seeded: true,
    });
  });
}

/** Default income categories. */
const INCOME_DEFAULTS: { name: string; icon: string; children: string[] }[] = [
  { name: 'Lương', icon: 'wallet', children: [] },
  { name: 'Thưởng', icon: 'sparkles', children: ['Tết', 'KPI', 'Tháng 13'] },
  { name: 'Được cho/tặng', icon: 'gift', children: ['Gia đình', 'Bạn bè'] },
  { name: 'Thu nhập phụ', icon: 'bag', children: ['Freelance', 'Bán đồ'] },
  { name: 'Lãi/đầu tư', icon: 'chart', children: [] },
  { name: 'Khác', icon: 'dots', children: [] },
];

/** Create the income categories once (for new ledgers and for old ones upgraded from a version without incomes). */
export async function seedIncomeCategories(db: FintoDB) {
  await db.transaction('rw', [db.settings, db.categories], async () => {
    const s = await db.settings.get('settings');
    if (!s || s.incomeSeeded) return;
    const cats: Category[] = [];
    INCOME_DEFAULTS.forEach((d, i) => {
      const parent: Category = { ...base(), name: d.name, icon: d.icon, parentId: null, countsAsMine: false, sortOrder: i, kind: 'income' };
      cats.push(parent);
      d.children.forEach((c, j) => cats.push({ ...base(), name: c, icon: d.icon, parentId: parent.id, countsAsMine: false, sortOrder: j, kind: 'income' }));
    });
    await db.categories.bulkAdd(cats);
    await db.settings.update('settings', { incomeSeeded: true });
  });
}
