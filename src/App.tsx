import { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { useTheme } from './theme';
import { BrandMark, Icon, PrivacyToggle, Segmented, ToastProvider } from './ui/kit';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db/schema';
import { PrivacyCtx } from './ui/format';
import Overview from './pages/Overview';
import AddExpense from './pages/AddExpense';
import Transactions from './pages/Transactions';
import Settle from './pages/Settle';
import People from './pages/People';
import Stats from './pages/Stats';
import SettingsPage from './pages/Settings';

const NAV = [
  { to: '/', label: 'Tổng quan', icon: 'home' },
  { to: '/giao-dich', label: 'Giao dịch', icon: 'list' },
  { to: '/thong-ke', label: 'Thống kê', icon: 'chart' },
  { to: '/moi-nguoi', label: 'Mọi người', icon: 'users' },
  { to: '/cai-dat', label: 'Cài đặt', icon: 'settings' },
];

export default function App() {
  const { pref, setTheme } = useTheme();
  // Mặc định ẩn mỗi lần mở app (Cài đặt › "Ẩn khi mở app"); bấm con mắt chỉ đổi cho lần dùng này.
  const hideOnOpen = useLiveQuery(async () => (await db.settings.get('settings'))?.hideOnOpen ?? true) ?? true;
  const [override, setOverride] = useState<boolean | null>(null);
  const hidden = override ?? hideOnOpen;
  const privacy = { hidden, toggle: () => setOverride(!hidden) };
  return (
    <PrivacyCtx.Provider value={privacy}>
    <ToastProvider>
      <div className="app">
        <aside className="side">
          <div className="row between nowrap brand-row">
            <div className="brand"><BrandMark />Hihand Finto</div>
            <span className="row nowrap" style={{ gap: 2 }}>
              <PrivacyToggle />
              <NavLink to="/cai-dat" className="icon-btn only-sm" aria-label="Cài đặt"><Icon name="settings" /></NavLink>
            </span>
          </div>
          <nav className="nav" aria-label="Điều hướng chính">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'}><Icon name={n.icon} />{n.label}</NavLink>
            ))}
          </nav>
          <div className="theme">
            <Segmented label="Giao diện" value={pref === 'light' ? 'light' : 'dark'} onChange={setTheme}
              options={[['dark', 'Tối'], ['light', 'Sáng']]} />
          </div>
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/them" element={<AddExpense />} />
            <Route path="/giao-dich" element={<Transactions />} />
            <Route path="/thu-tien" element={<Settle />} />
            <Route path="/moi-nguoi" element={<People />} />
            <Route path="/thong-ke" element={<Stats />} />
            <Route path="/cai-dat" element={<SettingsPage />} />
            <Route path="*" element={<p className="muted">Không có trang này.</p>} />
          </Routes>
        </main>
        <nav className="bottom-nav" aria-label="Điều hướng nhanh">
          {NAV.slice(0, 2).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}><Icon name={n.icon} />{n.label}</NavLink>
          ))}
          <NavLink to="/them" className="fab" aria-label="Thêm chi tiêu"><Icon name="plus" size={26} stroke={2.6} /></NavLink>
          {NAV.slice(2, 4).map((n) => (
            <NavLink key={n.to} to={n.to}><Icon name={n.icon} />{n.label}</NavLink>
          ))}
        </nav>
      </div>
    </ToastProvider>
    </PrivacyCtx.Provider>
  );
}
