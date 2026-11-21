# Đọc sách

App đọc sách PDF cá nhân (PWA). Sách lấy từ Google Drive, đọc được offline, chạy trên Samsung Fold, tablet và laptop.

## Giai đoạn P1 (bản này)
- Đăng nhập Google, quét thư mục `Đọc sách/<Thể loại>/` trên Drive.
- Hai chế độ đọc: **Sách chữ** (vừa chiều rộng) và **Truyện tranh** (lật phải → trái, 2 trang khi mở Fold).
- Tải offline: Wi-Fi thì tự tải tập đang đọc và tập kế tiếp; 4G thì hỏi trước. Mở sách chưa tải bằng 4G chỉ lấy những trang đang đọc.
- Tập đọc xong tự xoá khỏi máy (file trên Drive giữ nguyên).
- Đồng bộ trang đang đọc giữa các máy qua file ẩn trong Google Drive (appDataFolder).
- Ghi phiên đọc và streak (thống kê chi tiết ở P2).

## Cấu trúc
- `index.html`, `css/app.css`: giao diện.
- `js/app.js`: thư viện, quy tắc tải theo mạng, phiên đọc, cài đặt.
- `js/reader.js`: trình đọc (pdf.js, đọc từng phần qua range request).
- `js/storage.js`: lưu offline (OPFS) và hàng đợi tải.
- `js/drive.js`, `js/auth.js`, `js/sync.js`: Google Drive, đăng nhập, đồng bộ.
- `sw.js`: service worker để app mở được khi offline.
- `vendor/pdfjs`: pdf.js 6.5.438 (Apache-2.0, xem `vendor/pdfjs/LICENSE`).

Không cần build: đây là các file tĩnh, đăng bằng GitHub Pages.
