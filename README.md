# Đọc sách

App đọc sách PDF cá nhân (PWA). Sách lấy từ Google Drive, đọc được offline, chạy trên Samsung Fold, tablet và laptop.

## Giai đoạn P1 (bản này)
- Đăng nhập Google, quét thư mục `Đọc sách/<Thể loại>/` trên Drive.
- Hai chế độ đọc: **Sách chữ** (vừa chiều rộng) và **Truyện tranh** (lật phải → trái, 2 trang khi mở Fold).
- Tải offline: Wi-Fi thì tự tải tập đang đọc và tập kế tiếp; 4G thì hỏi trước. Mở sách chưa tải bằng 4G chỉ lấy những trang đang đọc.
- Tập đọc xong tự xoá khỏi máy (file trên Drive giữ nguyên).
- Đồng bộ trang đang đọc giữa các máy qua file ẩn trong Google Drive (appDataFolder).
- Ghi phiên đọc và streak (thống kê chi tiết ở P2).

## Highlight & tìm kiếm (v1.7.0)
- Sách chữ có lớp chữ bên trong: giữ tay lên một từ, kéo để chọn cụm → thanh **Highlight · Ghi chú · Tìm Google · Sao chép**.
- Highlight lưu trang, đoạn chữ, vị trí, ghi chú, tag; xem lại ở tab **Ghi chép → Highlight**, bấm để mở đúng trang. Chạm vào highlight trên trang để sửa/xoá.
- PDF dạng ảnh scan chưa hỗ trợ (để sau: khoanh vùng → Gemini đọc chữ).

## Đánh giá khi đọc xong (v1.10.0)
- Đọc xong một cuốn (PDF hoặc sách giấy), app hỏi chấm **điểm nguyên 1–10** (bắt buộc) và **nhận xét** (không bắt buộc).
- Bộ nhiều tập chấm cho **cả bộ**: đọc xong một tập mà thư viện chưa có tập sau thì app hỏi “Đây có phải tập cuối của bộ?”. Nếu thư viện còn tập sau thì app không hỏi.
- PDF: app hỏi khi lật quá trang cuối hoặc khi về thư viện. Sách giấy: app hỏi ngay sau khi ghi lần đọc tới trang cuối, hoặc khi đổi trạng thái sang “Đã đọc xong”.
- “Để sau” → thẻ sách mang nhãn **Chưa đánh giá**, app không nhắc lại. Điểm hiện trên thẻ sách/bộ (vd **8/10**), bấm vào để sửa. Mỗi cuốn/bộ chỉ giữ điểm mới nhất.
- Đánh giá tay: nút “Đánh giá” trên thẻ sách đã đọc xong, “Đánh giá bộ” khi mở rộng thẻ bộ, hoặc trong trang chi tiết sách giấy.
- Lưu ở `js/ratings.js`, đồng bộ chung file ẩn trên Drive.

## Cấu trúc
- `index.html`, `css/app.css`: giao diện.
- `js/app.js`: thư viện, quy tắc tải theo mạng, phiên đọc, cài đặt.
- `js/reader.js`: trình đọc (pdf.js, đọc từng phần qua range request, lớp chữ để chọn chữ, vẽ highlight).
- `js/highlights.js`: lưu highlight (đồng bộ chung file ẩn trên Drive).
- `js/ratings.js`: điểm và nhận xét khi đọc xong (đồng bộ chung file ẩn trên Drive).
- `js/storage.js`: lưu offline (OPFS) và hàng đợi tải.
- `js/drive.js`, `js/auth.js`, `js/sync.js`: Google Drive, đăng nhập, đồng bộ.
- `sw.js`: service worker để app mở được khi offline.
- `vendor/pdfjs`: pdf.js 6.5.438 (Apache-2.0, xem `vendor/pdfjs/LICENSE`).

Không cần build: đây là các file tĩnh, đăng bằng GitHub Pages.
