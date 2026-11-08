import { useState } from 'react';
import { exportSheets } from '../domain/export';
import { fmtDate, monthLabel, periodOf, periodRange, shiftMonth, today } from '../domain/period';
import type { Index } from '../domain/stats';
import { buildXlsx } from '../lib/xlsx';
import { saveBlob } from './download';
import { useToast } from './format';
import { Modal } from './kit';

type Pick = 'month' | 'prev' | 'year' | 'all' | 'custom';

/** BR-19: xuất Excel giao dịch theo kỳ, mỗi dòng một phần chia. */
export default function ExportDialog({ ix, onClose }: { ix: Index; onClose: () => void }) {
  const toast = useToast();
  const cur = periodOf(today(), ix.startDay);
  const [pick, setPick] = useState<Pick>('month');
  const [from, setFrom] = useState(periodRange(cur, ix.startDay).from);
  const [to, setTo] = useState(today());
  const year = cur.slice(0, 4);

  const plan = (): { range: { from: string; to: string } | null; label: string; file: string } => {
    switch (pick) {
      case 'month': return { range: periodRange(cur, ix.startDay), label: monthLabel(cur), file: cur };
      case 'prev': { const m = shiftMonth(cur, -1); return { range: periodRange(m, ix.startDay), label: monthLabel(m), file: m }; }
      case 'year': return { range: { from: periodRange(`${year}-01`, ix.startDay).from, to: periodRange(`${+year + 1}-01`, ix.startDay).from }, label: `Năm ${year}`, file: year };
      case 'all': return { range: null, label: 'Tất cả', file: 'tat-ca' };
      default: {
        const end = new Date(to + 'T00:00:00');
        end.setDate(end.getDate() + 1);
        return { range: { from, to: today(end) }, label: `${fmtDate(from)} – ${fmtDate(to)}`, file: `${from}_${to}` };
      }
    }
  };
  const p = plan();
  const sheets = exportSheets(ix, p.range);
  const n = sheets.reduce((a, sh) => a + sh.rows.length, 0);

  const go = () => {
    const bytes = buildXlsx(sheets);
    saveBlob(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `hihand-finto-${p.file}.xlsx`);
    toast({ text: `Đã xuất ${sheets[0].rows.length} dòng phần chia` });
    onClose();
  };

  const OPTS: [Pick, string][] = [['month', monthLabel(cur)], ['prev', monthLabel(shiftMonth(cur, -1))], ['year', `Năm ${year}`], ['all', 'Tất cả'], ['custom', 'Tùy chọn']];
  return (
    <Modal title="Xuất Excel" onClose={onClose}>
      <span className="small muted">Trang “Phần chia”: mỗi dòng một phần chia, có người, loại và trạng thái. Trang “Thu tiền”: các lần được trả lại. Trang “Thu nhập”: lương, thưởng, được cho…</span>
      <div className="chips" role="group" aria-label="Kỳ xuất">
        {OPTS.map(([k, l]) => <button type="button" key={k} className="chip" aria-pressed={pick === k} onClick={() => setPick(k)}>{l}</button>)}
      </div>
      {pick === 'custom' && (
        <div className="row">
          <div className="field grow"><label htmlFor="x-from">Từ ngày</label><input id="x-from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field grow"><label htmlFor="x-to">Đến ngày</label><input id="x-to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
      )}
      <div className="summary">
        <div className="row"><span>Kỳ</span><span className="strong">{p.label}</span></div>
        <div className="row"><span>Phần chia</span><span className="num">{sheets[0].rows.length} dòng</span></div>
        <div className="row"><span>Lần thu tiền</span><span className="num">{sheets[1].rows.length} dòng</span></div>
        <div className="row"><span>Thu nhập</span><span className="num">{sheets[2].rows.length} dòng</span></div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>Hủy</button>
        <button type="button" className="btn primary" disabled={n === 0} onClick={go}>Tải file .xlsx</button>
      </div>
    </Modal>
  );
}
