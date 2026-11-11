import { useEffect, useState } from 'react';
import { InstallGuide } from './AppBanners';
import { isIOS, requestPersist, storageInfo, useInstall, type StorageInfo } from './platform';

const mb = (n: number | null) => (n === null ? '?' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`);

/** Settings › General: is the app installed, is data kept persistently, how much storage is used. */
export default function AppStatus() {
  const inst = useInstall();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [guide, setGuide] = useState(false);
  const refresh = () => { void storageInfo().then(setInfo); };
  useEffect(refresh, []);

  return (
    <>
      <div className="setting">
        <div className="grow stack tight">
          <span className="strong">Ứng dụng</span>
          <span className="xs muted">
            {inst.installed ? 'Đang mở từ màn hình chính (đã cài).'
              : `Đang mở trong tab trình duyệt.${inst.ios ? ' Trên iPhone, app đã cài có dữ liệu riêng và không bị Safari tự xóa — nên cài rồi chuyển dữ liệu bằng Sao lưu → Khôi phục.' : ' Cài lên màn hình chính để mở như app.'}`}
          </span>
        </div>
        {!inst.installed && (inst.canPrompt || inst.ios) && (
          <button type="button" className="btn" onClick={() => (inst.canPrompt ? void inst.prompt() : setGuide(true))}>Cài app</button>
        )}
      </div>
      <div className="setting">
        <div className="grow stack tight">
          <span className="strong">Lưu trữ trên máy này</span>
          <span className="xs muted">
            {info?.persisted === true ? 'Đã được giữ lâu dài: trình duyệt không tự xóa khi máy thiếu dung lượng.'
              : info?.persisted === false ? 'Chưa được giữ lâu dài: khi máy thiếu dung lượng, trình duyệt có thể xóa dữ liệu. Hãy sao lưu thường xuyên.'
                : 'Trình duyệt không cho biết trạng thái lưu trữ.'}
            {info?.usage != null ? ` Đang dùng ${mb(info.usage)}.` : ''}
            {isIOS() ? ' iPhone: app nhắc sao lưu mỗi 3 ngày.' : ''}
          </span>
        </div>
        {info?.persisted === false && (
          <button type="button" className="btn" onClick={() => { void requestPersist().then(refresh); }}>Xin giữ lâu dài</button>
        )}
      </div>
      {guide && <InstallGuide onClose={() => setGuide(false)} />}
    </>
  );
}
