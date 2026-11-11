import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { db, type ShareType, type SplitMode, type TxKind } from '../db/schema';
import { addPerson } from '../domain/catalog';
import { saveExpense, type PersonSettle } from '../domain/ledger';
import { today } from '../domain/period';
import { parseAmount, splitEqual, splitRemaining, type Participant, type ShareDraft } from '../domain/split';
import { creditOf, owedTo, rootOf, type Index } from '../domain/stats';
import { useIndex } from '../ui/data';
import { AmountKeys, Avatar, Icon, Segmented } from '../ui/kit';
import { money, short, useMask, useRun, useToast } from '../ui/format';
import { CategoryPicker, TagPicker } from '../ui/pickers';
import { PAY_FOR } from '../db/seed';
import IncomeForm from '../ui/IncomeForm';
import HeldModal from '../ui/HeldModal';

interface Part { personId: string; type: Exclude<ShareType, 'mine'>; amountText: string }

const toText = (n: number) => (n ? n.toLocaleString('vi-VN') : '');

/** Initial form values: empty, or copied from a transaction when duplicating (BR-11). */
function initial(ix: Index, copyId: string | null, proxyFor: string | null) {
  const src = copyId ? ix.tx.get(copyId) : undefined;
  if (!src && proxyFor !== null) {
    // UC-12: pay on behalf — Bills category by default, no share of mine.
    const bills = ix.roots.find((c) => c.name === 'Hóa đơn');
    return {
      amountText: '', kind: 'expense' as TxKind, rootId: bills?.id ?? ix.roots[0]?.id ?? '', subId: '', tags: [] as string[], title: '', product: '',
      me: false, myText: '', parts: (proxyFor && ix.person.get(proxyFor) ? [{ personId: proxyFor, type: 'owe' as const, amountText: '' }] : []) as Part[],
      mode: 'equal' as SplitMode, proxy: true,
    };
  }
  if (!src) return {
    amountText: '', kind: 'expense' as TxKind, rootId: ix.roots[0]?.id ?? '', subId: '', tags: [] as string[], title: '', product: '',
    me: true, myText: '', parts: [] as Part[], mode: 'equal' as SplitMode, proxy: false,
  };
  const cat = ix.category.get(src.categoryId);
  const shares = ix.sharesOfTx.get(src.id) ?? [];
  const mine = shares.find((s) => s.type === 'mine');
  return {
    amountText: toText(src.totalAmount), kind: src.kind, rootId: rootOf(ix, src.categoryId)?.id ?? '', subId: cat?.parentId ? cat.id : '',
    tags: ix.tagIdsOfTx.get(src.id) ?? [], title: src.title, product: src.productName ?? '', me: !!mine, myText: toText(mine?.amount ?? 0),
    parts: shares.filter((s) => s.personId).map((s) => ({ personId: s.personId!, type: s.type as Part['type'], amountText: toText(s.amount) })),
    mode: src.splitMode, proxy: !!src.onBehalf,
  };
}

export default function AddExpense() {
  const ix = useIndex();
  const [params] = useSearchParams();
  const nav = useNavigate();
  if (!ix) return <p className="muted">Đang tải…</p>;
  const copyId = params.get('copy');
  if (params.get('loai') === 'thu') {
    const src = copyId ? ix.incomes.find((r) => r.id === copyId) : undefined;
    return (
      <div className="stack" style={{ gap: 20 }}>
        <div className="stack tight">
          <Link to="/" className="back">‹ Tổng quan</Link>
          <h1>{src ? 'Nhân bản thu nhập' : 'Thêm thu nhập'}</h1>
        </div>
        <section className="card" style={{ maxWidth: 860 }} aria-label="Thông tin thu nhập">
          <IncomeForm key={copyId ?? 'new'} ix={ix} src={src} onDone={() => nav('/')}
            header={<KindSwitch value="income" />} />
        </section>
      </div>
    );
  }
  const proxyFor = params.get('loai') === 'ho' ? params.get('p') ?? '' : null;
  return <ExpenseForm key={`${copyId ?? 'new'}-${proxyFor ?? ''}`} ix={ix} copyId={copyId} proxyFor={proxyFor} />;
}

type AddKind = TxKind | 'proxy' | 'income';

/** Expense / Transfer / Pay on behalf / Income. Income is a separate form, so switching uses the URL. */
function KindSwitch({ value, onChange }: { value: AddKind; onChange?: (k: TxKind | 'proxy') => void }) {
  const nav = useNavigate();
  return (
    <Segmented label="Loại" value={value}
      onChange={(k: AddKind) => (k === 'income' ? nav('/them?loai=thu') : onChange ? onChange(k) : nav(k === 'proxy' ? '/them?loai=ho' : '/them'))}
      options={[['expense', 'Khoản chi'], ['transfer', 'Chuyển tiền'], ['proxy', 'Chi hộ'], ['income', 'Thu nhập']]} />
  );
}

function ExpenseForm({ ix, copyId, proxyFor }: { ix: Index; copyId: string | null; proxyFor: string | null }) {
  const nav = useNavigate();
  const run = useRun();
  const mask = useMask();
  const toast = useToast();
  const [init] = useState(() => initial(ix, copyId, proxyFor));
  const [proxy, setProxy] = useState(init.proxy);
  const [amountText, setAmountText] = useState(init.amountText);
  const [date, setDate] = useState(today());
  const [kind, setKind] = useState<TxKind>(init.kind);
  const [rootId, setRootId] = useState(init.rootId);
  const [subId, setSubId] = useState(init.subId);
  const [tags, setTags] = useState<string[]>(init.tags);
  const [title, setTitle] = useState(init.title);
  const [product, setProduct] = useState(init.product);
  const [me, setMe] = useState(init.me);
  const [myText, setMyText] = useState(init.myText);
  const [parts, setParts] = useState<Part[]>(init.parts);
  const [mode, setMode] = useState<SplitMode>(init.mode);
  /** How each person's Owed share is handled: held money → offset what I owe → the rest stays owed / is given. */
  const [opts, setOpts] = useState<Record<string, PersonSettle>>({});
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [heldFor, setHeldFor] = useState<{ id: string | null } | null>(null);

  const total = parseAmount(amountText);
  const isTransfer = kind === 'transfer';
  const withMe = me && !isTransfer && !proxy;
  const participants: Participant[] = useMemo(() => [
    ...(withMe ? [{ personId: null, type: 'mine' as const, amount: parseAmount(myText) }] : []),
    ...parts.map((p) => ({ personId: p.personId, type: p.type, amount: parseAmount(p.amountText) })),
  ], [withMe, myText, parts]);

  const shares: ShareDraft[] = useMemo(() => {
    if (participants.length === 0) return [];
    if (mode === 'equal') return total > 0 ? splitEqual(total, participants) : participants.map((p) => ({ personId: p.personId, type: p.type, amount: 0 }));
    return participants.map((p) => ({ personId: p.personId, type: p.personId === null ? 'mine' : p.type, amount: p.amount ?? 0 }));
  }, [participants, mode, total]);

  const sums = { mine: 0, owe: 0, give: 0 };
  for (const s of shares) sums[s.type] += s.amount;
  const assigned = sums.mine + sums.owe + sums.give;
  const diff = total - assigned;

  const amountOf = (personId: string | null) => shares.find((s) => s.personId === personId)?.amount ?? 0;
  const active = ix.people.filter((p) => !p.archived || parts.some((x) => x.personId === p.id));
  const defaultApply = ix.snap.settings?.autoApplyCredit ?? true;
  const optOf = (id: string): Required<PersonSettle> => ({ credit: opts[id]?.credit ?? (proxy || defaultApply), offset: opts[id]?.offset ?? true, rest: opts[id]?.rest ?? 'owe' });
  const setOpt = (id: string, patch: PersonSettle) => setOpts((o) => ({ ...o, [id]: { ...o[id], ...patch } }));

  // Pay on behalf: two common categories — paying a bill for them, or a transfer paying someone on their behalf.
  const bills = ix.roots.find((c) => c.name === 'Hóa đơn');
  const transfer = ix.roots.find((c) => c.name === 'Chuyển tiền');
  const payFor = transfer ? (ix.childrenOf.get(transfer.id) ?? []).find((c) => c.name === PAY_FOR) : undefined;
  const proxyQuick = [
    ...(bills ? [{ label: 'Trả hóa đơn giúp', rootId: bills.id, subId: '', icon: bills.icon }] : []),
    ...(transfer && payFor ? [{ label: `Chuyển tiền › ${PAY_FOR}`, rootId: transfer.id, subId: payFor.id, icon: transfer.icon }] : []),
  ];

  const pickRoot = (id: string) => {
    setRootId(id);
    setSubId('');
    setTags([]);
    const root = ix.category.get(id);
    // Categories that do not count as my spending (Chuyển tiền) → default to a transfer (RULE-04).
    // While paying on behalf, stay in that mode (e.g. Chuyển tiền › Thanh toán hộ).
    if (proxy) return;
    if (root && !root.countsAsMine) switchKind('transfer');
    else if (isTransfer) switchKind('expense');
  };

  const switchKind = (k: TxKind | 'proxy') => {
    if (k === 'proxy') {
      // UC-12: pay on behalf — drop my share, everyone is Owed (from held money).
      setProxy(true);
      setKind('expense');
      setMe(false);
      const bills = ix.roots.find((c) => c.name === 'Hóa đơn');
      if (bills && rootId !== bills.id) { setRootId(bills.id); setSubId(''); setTags([]); }
      setParts((ps) => ps.map((p) => ({ ...p, type: 'owe' })));
      return;
    }
    setProxy(false);
    if (!proxy || k !== 'expense') setKind(k);
    if (proxy) setMe(true);
    if (k === 'transfer') setParts((ps) => ps.map((p) => ({ ...p, type: 'give' })));
    else setParts((ps) => ps.map((p) => ({ ...p, type: ix.person.get(p.personId)?.defaultType ?? 'owe' })));
  };

  const togglePerson = (id: string) => {
    setParts((ps) => ps.some((p) => p.personId === id)
      ? ps.filter((p) => p.personId !== id)
      : [...ps, { personId: id, type: proxy ? 'owe' : isTransfer ? 'give' : ix.person.get(id)?.defaultType ?? 'owe', amountText: '' }]);
  };
  /** BR-18: picking a group ticks the whole group; tap again to remove it. */
  const pickGroup = (memberIds: string[], all: boolean) => setParts((ps) => all
    ? ps.filter((p) => !memberIds.includes(p.personId))
    : [...ps, ...memberIds.filter((id) => !ps.some((p) => p.personId === id))
      .map((id) => ({ personId: id, type: proxy ? 'owe' as const : isTransfer ? 'give' as const : ix.person.get(id)?.defaultType ?? 'owe', amountText: '' }))]);
  const setPart = (id: string, patch: Partial<Part>) => setParts((ps) => ps.map((p) => (p.personId === id ? { ...p, ...patch } : p)));

  const fillRest = () => {
    try {
      const r = splitRemaining(total, participants);
      if (withMe) setMyText(toText(r[0].amount));
      setParts((ps) => ps.map((p) => ({ ...p, amountText: toText(r.find((s) => s.personId === p.personId)?.amount ?? 0) })));
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };

  const addNew = async () => {
    const id = await run(() => addPerson(db, newName));
    if (id) {
      setNewName('');
      setParts((ps) => [...ps, { personId: id, type: isTransfer ? 'give' : 'owe', amountText: '' }]);
    }
  };

  const canSave = total > 0 && !!rootId && shares.length > 0 && diff === 0 && !saving;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    const nonZero = shares.filter((s) => s.amount > 0);
    const ok = await run(() => saveExpense(db, {
      date, kind, categoryId: subId || rootId, title: title.trim(), productName: product.trim() || undefined,
      totalAmount: total, splitMode: mode, tagIds: tags, shares: nonZero.length ? nonZero : shares,
      applyCredit: defaultApply, onBehalf: proxy,
      perPerson: Object.fromEntries(settlePlan.map((x) => [x.id, optOf(x.id)])),
    }), proxy ? 'Đã ghi chi hộ' : 'Đã lưu giao dịch');
    setSaving(false);
    if (ok) nav('/');
  };

  const splitTitle = proxy ? 'Chi hộ cho ai?' : isTransfer ? 'Chuyển cho ai?' : `Đi cùng ai? · ${participants.length} người`;
  /** Preview each person's Owed share: held money → offset what I owe → the rest. */
  const settlePlan = shares.filter((s) => s.type === 'owe' && s.personId && s.amount > 0).map((s) => {
    const id = s.personId!;
    const o = optOf(id);
    const held = creditOf(ix, id);
    const owed = owedTo(ix, id);
    const fromHeld = o.credit ? Math.min(held, s.amount) : 0;
    const offset = o.offset ? Math.min(owed, s.amount - fromHeld) : 0;
    return { id, name: ix.person.get(id)?.name ?? '', amount: s.amount, held, owed, fromHeld, offset, rest: s.amount - fromHeld - offset, o };
  }).filter((x) => proxy || x.held > 0 || x.owed > 0);
  const offsetPlanned = settlePlan.reduce((a, x) => a + x.offset, 0);

  return (
    <>
    <form className="stack" style={{ gap: 20 }} onSubmit={submit}>
      <div className="stack tight">
        <Link to="/" className="back">‹ Tổng quan</Link>
        <h1>{copyId ? 'Nhân bản giao dịch' : proxy ? 'Chi hộ' : 'Thêm chi tiêu'}</h1>
      </div>

      <div className="cols">
        <section className="card stack col-main" aria-label="Thông tin khoản chi">
          <div className="row" style={{ alignItems: 'flex-end', gap: 16 }}>
            <div className="field" style={{ flex: '2 1 240px' }}>
              <label htmlFor="amt">{isTransfer ? 'Số tiền chuyển' : proxy ? 'Số tiền bạn trả hộ' : 'Tổng tiền bạn đã trả'}</label>
              <input id="amt" className="input big" inputMode="decimal" autoComplete="off" autoFocus placeholder="360k"
                value={amountText} onChange={(e) => setAmountText(e.target.value)}
                onBlur={() => total > 0 && setAmountText(toText(total))} aria-describedby="amt-hint" />
              <span id="amt-hint" className="xs muted">{total > 0 ? `= ${money(total)}` : 'Gõ tắt: 360k, 1,5tr'}</span>
              <AmountKeys onAdd={(k) => setAmountText((t) => t + k)} />
            </div>
            <div className="field" style={{ flex: '1 1 160px' }}>
              <label htmlFor="day">Ngày</label>
              <input id="day" className="input" type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
              <span className="xs muted">&nbsp;</span>
            </div>
          </div>

          <KindSwitch value={proxy ? 'proxy' : kind} onChange={switchKind} />
          {proxy && proxyQuick.length > 0 && (
            <div className="field">
              <span className="label" id="proxy-quick">Chọn nhanh</span>
              <div className="chips" role="group" aria-labelledby="proxy-quick">
                {proxyQuick.map((q) => (
                  <button type="button" key={q.label} className="chip sm" aria-pressed={rootId === q.rootId && subId === q.subId}
                    onClick={() => { setRootId(q.rootId); setSubId(q.subId); setTags([]); }}>
                    <Icon name={q.icon} size={14} />{q.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <CategoryPicker ix={ix} rootId={rootId} subId={subId} onRoot={pickRoot} onSub={setSubId} />
          <TagPicker ix={ix} rootId={rootId} value={tags} onChange={setTags} />

          <div className="row" style={{ gap: 16 }}>
            <div className="field grow" style={{ flex: '1 1 220px' }}>
              <label htmlFor="note">Ghi chú</label>
              <input id="note" className="input" placeholder={proxy ? 'Tiền điện tháng 11' : 'Lẩu nướng cuối tuần'} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="field grow" style={{ flex: '1 1 220px' }}>
              <label htmlFor="prod">Tên sản phẩm (nếu có)</label>
              <input id="prod" className="input" placeholder="Sữa rửa mặt Cetaphil" value={product} onChange={(e) => setProduct(e.target.value)} />
            </div>
          </div>
        </section>

        <section className="card stack col-side" aria-label="Chia tiền" style={{ flexBasis: 380 }}>
          <div className="row between">
            <h2>{splitTitle}</h2>
            <Segmented label="Cách chia" value={mode} onChange={setMode} options={[['equal', 'Chia đều'], ['custom', 'Tùy chỉnh']]} />
          </div>
          <span className="xs muted">{proxy
            ? 'Không có phần của tôi. Tiền trừ vào tiền đang giữ của người đó; phần vượt thành Đòi lại.'
            : 'Bấm tên để chọn người; Đòi lại / Cho lấy mặc định theo người, đổi được.'}</span>
          {proxy && (
            <div className="row between small" style={{ gap: 8 }}>
              <span className="muted">Người đó gửi tiền nhờ giữ (gửi trước / nạp thêm)?</span>
              <button type="button" className="btn sm" onClick={() => setHeldFor({ id: parts[0]?.personId ?? null })}>+ Nhận tiền giữ</button>
            </div>
          )}
          {ix.groups.length > 0 && (
            <div className="chips" role="group" aria-label="Chọn nhanh theo nhóm">
              {ix.groups.map(({ group, memberIds }) => {
                const all = memberIds.length > 0 && memberIds.every((id) => parts.some((p) => p.personId === id));
                return (
                  <button type="button" key={group.id} className="chip sm" aria-pressed={all} onClick={() => pickGroup(memberIds, all)}>
                    <Icon name="users" size={14} />{group.name}
                  </button>
                );
              })}
            </div>
          )}

          <div className="stack" style={{ gap: 8 }}>
            {!isTransfer && !proxy && (
              <div className={`person-line ${withMe ? 'mine' : ''}`}>
                <button type="button" className="pick" style={{ flex: 1, padding: 0, minHeight: 44 }} aria-pressed={withMe} onClick={() => setMe(!me)}>
                  <span className={`check ${withMe ? 'on' : ''}`}>{withMe && <Icon name="check" size={14} stroke={3.5} />}</span>
                  <Avatar size={34} />
                  <span className="grow strong">Phần của tôi</span>
                </button>
                {withMe && (mode === 'custom'
                  ? <input aria-label="Phần của tôi" className="input amount" inputMode="decimal" value={myText} onChange={(e) => setMyText(e.target.value)} />
                  : <span className="num">{money(amountOf(null))}</span>)}
              </div>
            )}
            {active.map((p) => {
              const part = parts.find((x) => x.personId === p.id);
              return (
                <div key={p.id} className={`person-line ${part ? part.type : ''}`}>
                  <button type="button" className="pick" style={{ flex: 1, padding: 0, minHeight: 44, background: 'transparent' }} aria-pressed={!!part} onClick={() => togglePerson(p.id)}>
                    <span className={`check ${part ? 'on' : ''}`}>{part && <Icon name="check" size={14} stroke={3.5} />}</span>
                    <Avatar person={p} size={34} />
                    <span className="grow strong">{p.name}</span>
                  </button>
                  {part && (
                    <>
                      {mode === 'custom'
                        ? <input aria-label={`Phần của ${p.name}`} className="input amount" inputMode="decimal" value={part.amountText} onChange={(e) => setPart(p.id, { amountText: e.target.value })} />
                        : <span className="num">{money(amountOf(p.id))}</span>}
                      {!proxy && <span className="mini-seg" role="group" aria-label={`Loại cho ${p.name}`}>
                        <button type="button" className="owe" aria-pressed={part.type === 'owe'} onClick={() => setPart(p.id, { type: 'owe' })}>Đòi lại</button>
                        <button type="button" className="give" aria-pressed={part.type === 'give'} onClick={() => setPart(p.id, { type: 'give' })}>Cho</button>
                      </span>}
                      {proxy && (
                        <button type="button" className="btn sm" title={`${p.name} gửi thêm tiền nhờ giữ`} aria-label={`Nhận thêm tiền giữ của ${p.name}`}
                          onClick={() => setHeldFor({ id: p.id })}>giữ {short(creditOf(ix, p.id))} · +</button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
            <div className="row nowrap" style={{ gap: 8 }}>
              <label className="sr-only" htmlFor="new-person">Thêm người mới</label>
              <input id="new-person" className="input" placeholder="+ Thêm người mới" value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNew(); } }} />
              <button type="button" className="btn" onClick={addNew} disabled={!newName.trim()}>Thêm</button>
            </div>
          </div>

          {mode === 'custom' && (
            <div className="row between">
              <span className={`small strong ${diff === 0 ? 'c-income' : 'c-owe'}`}>
                {diff === 0 ? 'Đã chia đủ' : diff > 0 ? `Còn ${money(diff)} chưa chia` : `Vượt ${money(-diff)}`}
              </span>
              <button type="button" className="btn sm" onClick={fillRest} disabled={total <= 0}>Chia phần còn lại</button>
            </div>
          )}

          {settlePlan.map((x) => (
            <div className="summary ok stack tight" key={x.id} aria-live="polite">
              <div className="row"><span className="strong">{x.name} · {money(x.amount)}</span><span className="xs muted">Khoản này xử lý thế nào?</span></div>
              {x.held > 0 && (
                <label className="row nowrap small" style={{ gap: 8 }}>
                  <input type="checkbox" checked={x.o.credit} onChange={(e) => setOpt(x.id, { credit: e.target.checked })} />
                  <span className="grow">Trừ vào tiền đang giữ của {x.name} (đang giữ {money(x.held)})</span>
                </label>
              )}
              {x.owed > 0 && (
                <label className="row nowrap small" style={{ gap: 8 }}>
                  <input type="checkbox" checked={x.o.offset} onChange={(e) => setOpt(x.id, { offset: e.target.checked })} />
                  <span className="grow">Cấn trừ vào khoản tôi đang nợ {x.name} (đang nợ {mask(money(x.owed))})</span>
                </label>
              )}
              {x.rest > 0 && <span className="xs muted">Phần còn lại {money(x.rest)}:</span>}
              {x.rest > 0 && (
                <Segmented label={`Phần còn lại ${money(x.rest)}`} value={x.o.rest} onChange={(v) => setOpt(x.id, { rest: v })}
                  options={[['owe', `${x.name} nợ lại tôi`], ['give', `Cho ${x.name} luôn`]]} />
              )}
              <span className="small">
                → {[
                  x.fromHeld > 0 && `Trừ tiền giữ ${short(x.fromHeld)} (còn giữ ${short(x.held - x.fromHeld)})`,
                  x.offset > 0 && `Cấn trừ ${short(x.offset)} (còn nợ ${x.name} ${mask(short(x.owed - x.offset))})`,
                  x.rest > 0 && (x.o.rest === 'give' ? `Cho ${x.name} ${short(x.rest)}` : `${x.name} nợ lại ${short(x.rest)}`),
                ].filter(Boolean).join(' · ')}
              </span>
            </div>
          ))}
          {!proxy && <div className="summary" aria-live="polite">
            <div className="row"><span className="c-mine strong">Của tôi</span><span className="num">{money(sums.mine)}</span></div>
            <div className="row"><span className="c-owe strong">Đòi lại</span><span className="num">{money(sums.owe - offsetPlanned)}</span></div>
            {offsetPlanned > 0 && <div className="row"><span className="c-give strong">Trả nợ (cấn trừ)</span><span className="num">{mask(money(offsetPlanned))}</span></div>}
            <div className="row"><span className="c-give strong">Cho đi</span><span className="num">{money(sums.give)}</span></div>
          </div>}
          <div className="row nowrap save-bar">
            <Link to="/" className="btn">Hủy</Link>
            <button type="submit" className="btn primary grow" disabled={!canSave}>{proxy ? 'Lưu chi hộ' : 'Lưu giao dịch'}</button>
          </div>
          {!canSave && !saving && (
            <span className="xs muted">
              {total <= 0 ? 'Nhập số tiền.' : shares.length === 0 ? 'Chọn ít nhất một người.' : diff !== 0 ? 'Tổng các phần phải bằng tổng bill.' : ''}
            </span>
          )}
        </section>
      </div>
    </form>
    {/* Outside <form> so Enter inside the dialog does not save the expense. */}
    {heldFor && <HeldModal ix={ix} personId={heldFor.id} initial="in" onClose={() => setHeldFor(null)} />}
    </>
  );
}
