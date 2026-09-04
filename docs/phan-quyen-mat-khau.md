# Phân quyền bằng mật khẩu — Bảng theo dõi hạng mục

Tài liệu này ghi lại cơ chế phân quyền 2 cấp (triển khai ngày 21/08/2026) và
hướng dẫn tự đặt mật khẩu trên Vercel.

## Tóm tắt cơ chế

| Quyền | Mật khẩu | Được làm gì |
|---|---|---|
| **Xem** (mặc định) | Không cần | Xem bảng, tìm kiếm, lọc, xuất CSV, tải file xuống |
| **Sửa** | `EDIT_KEY` | Như trên + sửa ô, thêm/xoá dòng, tạo/đổi tên kế hoạch, tải file lên |
| **Quản trị** | `ADMIN_KEY` | Như trên + **xoá kế hoạch**, **xoá file** đính kèm |

- Mật khẩu đặt qua **biến môi trường** (trên Vercel cho bản web; qua env khi
  chạy `serve.cjs` cho bản LAN).
- **Không đặt cả hai biến → web không khoá gì** (mọi người toàn quyền như trước
  đây). Đây là mặc định của chế độ LAN.
- Người dùng nhập mật khẩu một lần trên giao diện; trình duyệt lưu lại
  (localStorage), lần sau mở không phải nhập nữa. Muốn thu hồi quyền của tất cả
  mọi người: đổi giá trị biến trên Vercel rồi Redeploy.

---

## 1. Những thay đổi trong code

### Phía server (nơi chặn thật sự)

Client gửi mật khẩu qua header HTTP `x-edit-key` trong mỗi request ghi.
Server so sánh với biến môi trường (so sánh chống dò thời gian bằng
`crypto.timingSafeEqual` trên hash SHA-256) và suy ra vai trò:
`admin` / `edit` / `view`.

| File | Thay đổi |
|---|---|
| `api/data.js` | Thêm endpoint `GET /api/data?whoami=1` trả `{role, protected}` để giao diện biết quyền. Chặn: mọi POST (lưu bảng, tạo, đổi tên kế hoạch) cần quyền **sửa**; `action=delete` (xoá kế hoạch) cần **quản trị**. GET đọc dữ liệu vẫn tự do. |
| `api/files.js` | Chặn: POST (tải file lên — cả file nhỏ lẫn tải theo mảnh) cần quyền **sửa**; DELETE (xoá file) cần **quản trị**. GET tải file xuống vẫn tự do. |
| `serve.cjs` | Bản server LAN có cùng logic (whoami + chặn ghi/xoá). Mặc định không đặt khoá → mọi người là quản trị như trước. Muốn khoá cả LAN: `set EDIT_KEY=... && set ADMIN_KEY=... && node serve.cjs` |
| `vercel.json` | CORS cho phép thêm header `x-edit-key` và method `DELETE`. |

Request không đủ quyền bị trả **HTTP 401** kèm
`{"ok":false,"needKey":true,"error":"..."}`.

> Lưu ý bảo trì: logic kiểm tra quyền nằm ở **3 nơi giống nhau**
> (`api/data.js`, `api/files.js`, `serve.cjs`) — sửa một chỗ thì sửa cả ba.

### Phía giao diện (`bang-hang-muc.html`)

Chỉ là lớp ẩn/hiện cho gọn mắt — kể cả ai vượt qua được giao diện thì server
vẫn chặn.

- Khi mở trang, giao diện gọi `?whoami=1` (kèm mật khẩu đã lưu nếu có) để biết
  quyền hiện tại.
- **Chế độ chỉ xem**: các ô không sửa được; ẩn toàn bộ nút Thêm dòng, Xóa,
  Nhập CSV, tăng/giảm cấp WBS, Tạo kế hoạch, đổi tên/xoá kế hoạch, nút tải
  file lên, nút xoá file, ô tick chọn dòng. Vẫn dùng được: tìm kiếm, lọc cột,
  thu gọn/mở rộng nhánh, Xuất CSV, tải file xuống.
- Nút đăng nhập ở cả 2 màn hình (danh sách kế hoạch và bảng):
  - Chưa đăng nhập: **"🔒 Chỉ xem — đăng nhập để sửa"** → bấm, nhập mật khẩu.
  - Đã có quyền sửa: **"✎ Quyền sửa · thoát"**.
  - Đã có quyền quản trị: **"★ Quản trị · thoát"**.
  - Bấm khi đang đăng nhập → thoát về chế độ chỉ xem (xoá mật khẩu khỏi máy).
- Người có quyền **sửa** không nhìn thấy nút xoá file / xoá kế hoạch (chỉ
  quản trị thấy).
- Nếu server không đặt mật khẩu (`protected:false`) → nút đăng nhập tự ẩn,
  web hoạt động y như trước khi có tính năng này.

---

## 2. Tự đặt mật khẩu trên Vercel (Settings → Environment Variables)

### Bước 1 — Vào phần cài đặt

1. Đăng nhập https://vercel.com bằng tài khoản `nguyenvhuyutc-9517`.
2. Chọn project **`bim`**.
3. Vào tab **Settings** → mục **Environment Variables** (cột trái).

### Bước 2 — Thêm / sửa 2 biến

| Key | Value | Environment |
|---|---|---|
| `EDIT_KEY` | mật khẩu cho người được sửa | tick **Production** |
| `ADMIN_KEY` | mật khẩu quản trị (chỉ mình bạn biết) | tick **Production** |

Quy tắc chọn mật khẩu:

- Hai mật khẩu **phải khác nhau** — trùng nhau thì ai cũng thành quản trị.
- Dùng chữ không dấu + số, **không khoảng trắng**, ví dụ: `giabinh-sua-2026`,
  `giabinh-qt-Xz89`. Người dùng sẽ phải gõ lại chính xác từng ký tự.
- Nên chọn kiểu **Sensitive** khi tạo biến (Vercel sẽ không cho đọc ngược giá
  trị — an toàn hơn, nhưng chính bạn cũng không xem lại được, chỉ sửa đè).
- Muốn khoá cả bản deploy thử thì tick thêm **Preview** (không bắt buộc).

Muốn **đổi mật khẩu / thu hồi quyền**: bấm vào biến → **Edit** → nhập giá trị
mới → Save. Muốn **bỏ khoá hoàn toàn**: xoá cả 2 biến.

### Bước 3 — Redeploy (bắt buộc sau mọi thay đổi biến)

Biến môi trường **chỉ có hiệu lực từ lần deploy kế tiếp**, bản đang chạy
không tự đổi. Cách redeploy nhanh trên web Vercel:

1. Vào tab **Deployments** của project `bim`.
2. Ở bản deploy mới nhất (Production), bấm nút **⋯** → **Redeploy** → xác nhận.

(Hoặc chạy `npm run deploy` trong thư mục dự án, hoặc nhờ Claude "deploy".)

### Bước 4 — Kiểm tra

1. Mở https://bvtc.vcijsc.com trong **cửa sổ ẩn danh** (Ctrl+Shift+N) —
   phải thấy chế độ chỉ xem, có nút "🔒 Chỉ xem — đăng nhập để sửa".
2. Đăng nhập bằng `EDIT_KEY` → sửa được, tải file lên được, **không** thấy nút
   xoá file/kế hoạch.
3. Thoát, đăng nhập bằng `ADMIN_KEY` → thấy đủ nút xoá.

Kiểm tra nhanh bằng URL: mở
`https://bvtc.vcijsc.com/api/data?whoami=1` — thấy `"protected":true`
nghĩa là khoá đang bật.

---

## Sự cố thường gặp

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| Nhập đúng mật khẩu vẫn báo "Mật khẩu không đúng" | Giá trị trên Vercel gõ nhầm / dính khoảng trắng, hoặc chưa Redeploy sau khi đặt | Sửa lại giá trị biến rồi Redeploy |
| Không thấy nút đăng nhập, ai cũng sửa được | Chưa đặt biến, hoặc đặt xong chưa Redeploy | Làm lại Bước 2–3 |
| Đăng nhập rồi nhưng máy khác vẫn phải nhập | Đúng thiết kế — mật khẩu lưu theo từng trình duyệt/máy | Nhập một lần trên máy đó |
| Muốn đuổi một người đã biết mật khẩu | Mật khẩu là dùng chung, không theo cá nhân | Đổi giá trị `EDIT_KEY` (hoặc `ADMIN_KEY`) rồi Redeploy, báo mật khẩu mới cho những người còn lại |
| Site cũ `bim-wheat.vercel.app` vẫn sửa được dữ liệu | Site đó chạy code cũ (không có khoá) nhưng dùng chung MongoDB | Chặn triệt để: đổi mật khẩu MongoDB Atlas → site cũ mất kết nối hoàn toàn |
