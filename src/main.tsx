import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/nunito/latin-400.css';
import '@fontsource/nunito/latin-600.css';
import '@fontsource/nunito/latin-700.css';
import '@fontsource/nunito/latin-800.css';
import '@fontsource/nunito/vietnamese-400.css';
import '@fontsource/nunito/vietnamese-600.css';
import '@fontsource/nunito/vietnamese-700.css';
import '@fontsource/nunito/vietnamese-800.css';
import './index.css';
import App from './App';
import { db } from './db/schema';
import { seedIfEmpty } from './db/seed';
import { runMonthEnd } from './domain/monthEnd';
import { today } from './domain/period';

// Xin trình duyệt giữ dữ liệu lâu dài (giảm rủi ro bị xóa), rồi tạo dữ liệu mặc định lần đầu.
navigator.storage?.persist?.();
await seedIfEmpty(db);
// Ghi chú tiền dư cuối tháng chạy khi mở app lần đầu trong kỳ mới (không có máy chủ chạy nền).
await runMonthEnd(db, today()).catch(() => 0);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
