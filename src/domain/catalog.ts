import { base, now, type FintoDB, type Person } from '../db/schema';

/** BR-14: manage categories, tags, people. Deletes are soft, so old transactions keep their names. */

const clean = (s: string) => s.trim().replace(/\s+/g, ' ');

export async function addCategory(db: FintoDB, name: string, parentId: string | null, icon = 'dots', kind: 'expense' | 'income' = 'expense') {
  const n = clean(name);
  if (!n) throw new Error('Cần nhập tên danh mục');
  const parent = parentId ? await db.categories.get(parentId) : undefined;
  const k = parent ? parent.kind ?? 'expense' : kind;
  const siblings = (await db.categories.toArray()).filter((c) => !c.deletedAt && c.parentId === parentId && (c.kind ?? 'expense') === k);
  if (siblings.some((c) => c.name.toLowerCase() === n.toLowerCase())) throw new Error('Danh mục này đã có');
  const row = {
    ...base(), name: n, icon: parent?.icon ?? icon, parentId,
    countsAsMine: k === 'income' ? false : parent?.countsAsMine ?? true, sortOrder: siblings.length, kind: k,
  };
  await db.categories.add(row);
  return row.id;
}

export async function renameCategory(db: FintoDB, id: string, name: string) {
  const n = clean(name);
  if (!n) throw new Error('Cần nhập tên danh mục');
  await db.categories.update(id, { name: n, updatedAt: now() });
}

/** Toggle "Counts as my spending" for a top-level category and its subcategories. */
export async function setCountsAsMine(db: FintoDB, rootId: string, value: boolean) {
  const t = now();
  await db.transaction('rw', db.categories, async () => {
    await db.categories.update(rootId, { countsAsMine: value, updatedAt: t });
    await db.categories.where('parentId').equals(rootId).modify({ countsAsMine: value, updatedAt: t });
  });
}

export async function deleteCategory(db: FintoDB, id: string) {
  const t = now();
  await db.transaction('rw', db.categories, async () => {
    await db.categories.update(id, { deletedAt: t, updatedAt: t });
    await db.categories.where('parentId').equals(id).modify({ deletedAt: t, updatedAt: t });
  });
}

/** Add a tag to a category; reuses an existing tag with the same name (tags are shared). */
export async function addTagToCategory(db: FintoDB, categoryId: string, name: string) {
  const n = clean(name).replace(/^#/, '');
  if (!n) throw new Error('Cần nhập tên tag');
  return db.transaction('rw', [db.tags, db.categoryTags], async () => {
    let tag = (await db.tags.toArray()).find((t) => !t.deletedAt && t.name.toLowerCase() === n.toLowerCase());
    if (!tag) {
      tag = { ...base(), name: n };
      await db.tags.add(tag);
    }
    const links = (await db.categoryTags.where('categoryId').equals(categoryId).toArray()).filter((l) => !l.deletedAt);
    if (!links.some((l) => l.tagId === tag!.id)) {
      await db.categoryTags.add({ ...base(), categoryId, tagId: tag.id, sortOrder: links.length });
    }
    return tag.id;
  });
}

/** Remove a tag from a category (old transactions keep it). */
export async function removeTagFromCategory(db: FintoDB, categoryId: string, tagId: string) {
  const t = now();
  await db.categoryTags.where('categoryId').equals(categoryId).filter((l) => l.tagId === tagId && !l.deletedAt)
    .modify({ deletedAt: t, updatedAt: t });
}

export const PERSON_COLORS = ['#F7B27A', '#9DBCF5', '#C9C0FF', '#F49AC1', '#8FE0BE', '#F5D76E', '#7FD6E0'];

export async function addPerson(db: FintoDB, name: string, defaultType: Person['defaultType'] = 'owe') {
  const n = clean(name);
  if (!n) throw new Error('Cần nhập tên');
  const all = (await db.people.toArray()).filter((p) => !p.deletedAt);
  if (all.some((p) => p.name.toLowerCase() === n.toLowerCase())) throw new Error('Tên này đã có trong danh bạ');
  const row: Person = { ...base(), name: n, color: PERSON_COLORS[all.length % PERSON_COLORS.length], defaultType };
  await db.people.add(row);
  return row.id;
}

export async function updatePerson(db: FintoDB, id: string, patch: Partial<Pick<Person, 'name' | 'defaultType' | 'note' | 'archived'>>) {
  if (patch.name !== undefined) {
    patch.name = clean(patch.name);
    if (!patch.name) throw new Error('Cần nhập tên');
  }
  await db.people.update(id, { ...patch, updatedAt: now() });
}

/** BR-18: groups of people you often go out with. */
export async function saveGroup(db: FintoDB, input: { id?: string; name: string; memberIds: string[] }) {
  const n = clean(input.name);
  if (!n) throw new Error('Cần nhập tên nhóm');
  if (input.memberIds.length === 0) throw new Error('Nhóm cần ít nhất một người');
  return db.transaction('rw', [db.groups, db.groupMembers], async () => {
    const t = now();
    let id = input.id;
    if (id) await db.groups.update(id, { name: n, updatedAt: t });
    else {
      const g = { ...base(), name: n };
      await db.groups.add(g);
      id = g.id;
    }
    const cur = (await db.groupMembers.where('groupId').equals(id).toArray()).filter((m) => !m.deletedAt);
    const want = new Set(input.memberIds);
    for (const m of cur) if (!want.has(m.personId)) await db.groupMembers.update(m.id, { deletedAt: t, updatedAt: t });
    const have = new Set(cur.map((m) => m.personId));
    await db.groupMembers.bulkAdd(input.memberIds.filter((p) => !have.has(p)).map((personId) => ({ ...base(), groupId: id!, personId })));
    return id;
  });
}

export async function deleteGroup(db: FintoDB, id: string) {
  const t = now();
  await db.transaction('rw', [db.groups, db.groupMembers], async () => {
    await db.groups.update(id, { deletedAt: t, updatedAt: t });
    await db.groupMembers.where('groupId').equals(id).modify({ deletedAt: t, updatedAt: t });
  });
}
