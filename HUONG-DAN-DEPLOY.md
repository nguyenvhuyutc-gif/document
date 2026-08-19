# Hướng dẫn kết nối MongoDB & deploy Vercel

Tài liệu này ghi lại **toàn bộ cấu hình đã thiết lập** cho ứng dụng *Bảng theo dõi hạng mục* và hướng dẫn vận hành: kết nối database, deploy phiên bản mới, kiểm tra sau deploy và xử lý sự cố.

> Chạy local/LAN (không cần internet, không cần MongoDB) → xem [README.md](README.md).
> Tài liệu này dành cho bản chạy trên **Vercel + MongoDB Atlas**.
> Muốn hiểu **từng câu lệnh** (ý nghĩa, ví dụ, kết quả mong đợi) → xem [SO-TAY-CAU-LENH.md](SO-TAY-CAU-LENH.md).

---

## 1. Kiến trúc tổng quan

Ứng dụng có **2 chế độ chạy**, dùng chung một file giao diện `bang-hang-muc.html`:

| | Chạy local / LAN | Chạy trên Vercel |
|---|---|---|
| Máy chủ | `serve.cjs` (Node.js, cổng 8787) | Vercel CDN + Serverless Functions |
| Dữ liệu bảng | file `data.json` cùng thư mục | MongoDB Atlas — collection `bim_app` |
| File đính kèm | thư mục `data-files/` | MongoDB Atlas — collection `bim_files` |
| Giới hạn file upload | 25 MB / file | **~4,4 MB / file** (giới hạn body 4,5 MB của Vercel) |
| Ai truy cập được | máy trong cùng mạng LAN | bất kỳ ai có link (không có đăng nhập) |

Khi mở trang, frontend tự gọi `GET /api/data`:
- Trả về **200** → chế độ máy chủ, huy hiệu **🟢 Lưu chung** — mọi thao tác ghi vào MongoDB (hoặc `data.json` nếu chạy local), tự đồng bộ giữa các máy mỗi ~4 giây.
- Lỗi (404/500/mạng) → app **âm thầm rơi về localStorage**, huy hiệu **🟡 Lưu riêng trên máy này** — dữ liệu KHÔNG vào database.

> ⚠️ Vì vậy sau mỗi lần deploy hãy nhìn huy hiệu: nếu thấy **🟡** trên bản Vercel nghĩa là API đang lỗi — xem mục [Xử lý sự cố](#7-xử-lý-sự-cố).

## 2. Thông tin hiện trạng (đã thiết lập xong)

| Hạng mục | Giá trị |
|---|---|
| URL production | <https://bim-wheat.vercel.app> |
| Project Vercel | `bim` — team *ngothuytq98-2707's projects* |
| Liên kết project | có sẵn trong `.vercel/project.json` (`prj_bRV6EcO8Ug3zE4eVosStqWSmhVba`) |
| Cluster MongoDB Atlas | `cluster0.lafx8yo.mongodb.net` — user `ngothuytq98_db_user` |
| Database | `bim` |
| Collection dữ liệu bảng | `bim_app` (1 document duy nhất `_id: "data"`) |
| Collection file đính kèm | `bim_files` (mỗi file 1 document, nội dung lưu dạng Binary) |
| Biến môi trường trên Vercel | `MONGODB_URI`, `MONGODB_DB`, `MONGODB_COLLECTION` — đã set cho cả 3 môi trường (production / preview / development) |
| Node runtime | `22.x` (khai báo trong `package.json → engines`) |

Mật khẩu database **không ghi trong tài liệu này**. Giá trị thật nằm ở 2 nơi: file `.env` trên máy này (không được commit/deploy) và **Vercel Dashboard → Project `bim` → Settings → Environment Variables**.

## 3. Kết nối database (MongoDB Atlas)

### 3.1. Ba biến môi trường

Cả hai serverless function ([api/data.js](api/data.js), [api/files.js](api/files.js)) đọc cấu hình từ biến môi trường:

```
MONGODB_URI        = mongodb+srv://ngothuytq98_db_user:<mật_khẩu>@cluster0.lafx8yo.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB         = bim
MONGODB_COLLECTION = bim_app
```

Tuỳ chọn thêm (không bắt buộc): `MONGODB_FILES_COLLECTION` — tên collection lưu file đính kèm, mặc định `bim_files`.

- **Lấy chuỗi kết nối ở đâu:** Atlas → Database → nút **Connect** trên cluster → **Drivers** → copy chuỗi `mongodb+srv://…`, thay `<mật_khẩu>` bằng mật khẩu của user database.
- **Chạy local muốn test API Mongo:** copy `.env.example` thành `.env` rồi điền mật khẩu thật. Lưu ý `serve.cjs` **không dùng Mongo** (nó lưu `data.json`) — file `.env` chỉ cần khi chạy `vercel dev` hoặc script test gọi thẳng `api/*.js`.

### 3.2. Cho phép Vercel kết nối (Network Access)

Serverless của Vercel không có IP cố định, nên Atlas phải mở: **Atlas → Network Access → Add IP Address → `0.0.0.0/0`** (Allow access from anywhere). Bản deploy hiện tại đã kết nối thành công nên mục này đã được mở sẵn — chỉ cần kiểm tra lại nếu sau này API báo lỗi timeout.

### 3.3. Dữ liệu được lưu như thế nào

- `bim_app` — đúng **một** document:
  ```json
  { "_id": "data", "data": { "rows": [...], "people": [...], "statuses": [...] }, "updatedAt": 1752... }
  ```
  Mỗi lần sửa trên giao diện, frontend `POST /api/data` toàn bộ state (đã gộp/hoãn ~1s để tránh ghi dồn dập), backend `replaceOne` với `upsert: true`.
- `bim_files` — mỗi file đính kèm một document:
  ```json
  { "_id": "<24 ký tự hex>", "name": "tên gốc.pdf", "type": "application/pdf", "size": 12345, "data": Binary, "createdAt": ... }
  ```
  Upload qua `POST /api/files?name=…&type=…` (body là nội dung file), tải xuống qua `GET /api/files?id=…`, xoá qua `DELETE /api/files?id=…`.

### 3.4. Đổi / xoay mật khẩu database

1. Atlas → **Database Access** → sửa user `ngothuytq98_db_user` → Edit Password.
2. Cập nhật `MONGODB_URI` mới trong **Vercel → Settings → Environment Variables** (sửa cả 3 môi trường) và trong file `.env` local.
3. **Redeploy** (biến môi trường chỉ áp dụng cho lần deploy sau): `npm run deploy`.

### 3.5. Sao lưu

- Dữ liệu bảng: bấm **Xuất CSV** trong app, hoặc Atlas → Collections → `bim.bim_app` → export; kỹ hơn thì dùng `mongodump`.
- Deploy **không** đụng vào dữ liệu — dữ liệu nằm ở Atlas, deploy chỉ thay code.

## 4. Các file cấu hình deploy — vai trò từng file

| File | Vai trò |
|---|---|
| [vercel.json](vercel.json) | Rewrite `/` → `/bang-hang-muc.html` (trang chủ) + header CORS cho `/api/*`. **KHÔNG thêm `cleanUrls: true`** — chính nó từng gây lỗi 404 trang chủ (xung đột với rewrite). |
| [.vercelignore](.vercelignore) | Chặn upload lên Vercel: `.env` (mật khẩu!), `serve.cjs`, `data.json`, `start-server.bat`, `node_modules` — những thứ chỉ dùng local. |
| [package.json](package.json) | `engines.node = "22.x"` (Vercel không còn nhận Node 14/16); script `deploy`; dependency `mongodb` cho serverless functions. |
| [api/data.js](api/data.js) | Serverless function `GET/POST /api/data` — đọc/ghi document dữ liệu bảng trong Mongo. |
| [api/files.js](api/files.js) | Serverless function `POST/GET/DELETE /api/files` — upload / tải xuống / xoá file đính kèm. |
| `.vercel/project.json` | Ghi nhớ project đã link (`bim`). Xoá thư mục `.vercel` thì lần deploy sau CLI sẽ hỏi link lại. |

Mọi file `.js` nằm trong thư mục `api/` được Vercel **tự động** biến thành serverless function tại đường dẫn `/api/<tên-file>` — không cần khai báo gì thêm.

## 5. Quy trình deploy

### 5.1. Chuẩn bị một lần trên máy mới

```powershell
cd d:\bim
npm install          # cài vercel CLI (devDependency) + mongodb
npx vercel login     # in ra link https://vercel.com/oauth/device?user_code=XXXX-XXXX
```

Mở link, đăng nhập đúng tài khoản chứa project `bim` (team *ngothuytq98-2707's projects*) và bấm **Confirm**. Máy này đã đăng nhập sẵn — chỉ cần làm lại khi đổi máy hoặc hết hạn phiên.

**Nếu login bị kẹt** (chờ mãi không xong): tạo token tại Vercel Dashboard → Account Settings → **Tokens**, rồi khỏi cần login — gắn token trực tiếp vào lệnh deploy:

```powershell
npx vercel --prod --token DAN_TOKEN_VAO_DAY
```

### 5.2. Deploy phiên bản mới

Mỗi khi sửa `bang-hang-muc.html` hoặc `api/*.js`, thay đổi **chỉ có tác dụng local** cho đến khi deploy:

```powershell
cd d:\bim
npm run deploy       # = npx vercel --prod
```

CLI upload thẳng thư mục hiện tại (không cần Git), build ~30–60 giây, xong in ra URL production. Deploy hỏng có thể **rollback** ngay: Vercel Dashboard → Deployments → chọn bản cũ → ⋯ → *Promote to Production*.

### 5.3. Thêm / sửa biến môi trường bằng CLI (không cần vào Dashboard)

```powershell
npx vercel env ls                                  # xem danh sách
npx vercel env add MONGODB_URI production          # thêm (CLI sẽ hỏi giá trị)
npx vercel env rm MONGODB_URI production           # xoá
```

Sau khi đổi biến môi trường phải chạy lại `npm run deploy` thì function mới nhận giá trị mới.

### 5.4. Kiểm tra sau deploy

```powershell
# Trang chủ phải là 200 (không phải 404/308)
curl.exe -s -o NUL -w "HTTP %{http_code}" https://bim-wheat.vercel.app/

# API phải trả {"ok":true,...} kèm dữ liệu — nếu "error" thì xem mục 7
curl.exe -s https://bim-wheat.vercel.app/api/data
```

Rồi mở <https://bim-wheat.vercel.app> trên trình duyệt — huy hiệu góc trên phải là **🟢 Lưu chung**; thử gõ một ô, đợi 2 giây, bấm F5 — nội dung còn nguyên nghĩa là đã ghi vào MongoDB thật.

## 6. Chạy local / LAN (tóm tắt)

```powershell
cd d:\bim
node serve.cjs       # hoặc bấm đúp start-server.bat
```

- Dữ liệu ghi vào `data.json`, file đính kèm vào `data-files/` — **hoàn toàn tách biệt** với dữ liệu MongoDB trên Vercel; hai bên không tự đồng bộ với nhau.
- Đổi cổng: `$env:PORT=9000; node serve.cjs` (PowerShell) hoặc `set PORT=9000 && node serve.cjs` (cmd).
- Chi tiết các phương án chia sẻ trong LAN → [README.md](README.md).

## 7. Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách sửa |
|---|---|---|
| Trang chủ `/` trả 404 | Ai đó thêm lại `cleanUrls: true` vào `vercel.json` — nó phá rewrite `/` | Xoá dòng `cleanUrls`, deploy lại |
| `/api/data` trả 500: `MONGODB_URI is not configured` | Biến môi trường chưa set (hoặc set xong chưa redeploy) | `npx vercel env ls` kiểm tra → set thiếu → `npm run deploy` |
| `/api/data` trả 500: `bad auth` / `authentication failed` | Sai mật khẩu trong `MONGODB_URI` (thường sau khi đổi mật khẩu Atlas) | Cập nhật URI ở Vercel env (mục 3.4) → redeploy |
| `/api/data` trả 500: `Server selection timed out` | Atlas Network Access chưa mở `0.0.0.0/0` | Atlas → Network Access → Add IP `0.0.0.0/0` |
| Mở bản Vercel thấy huy hiệu **🟡** | API đang lỗi → app rơi về localStorage, dữ liệu không vào Mongo | Mở `https://…/api/data` xem thông báo lỗi, tra các dòng trên |
| Test Mongo trên **máy này** báo `querySrv ECONNREFUSED` | DNS của máy không phân giải được bản ghi SRV (`mongodb+srv`) — lỗi mạng local, **không phải** lỗi cấu hình | Kiểm tra trên bản deploy thay vì local; hoặc đổi DNS máy sang `8.8.8.8`; hoặc dùng chuỗi kết nối dạng thường (không SRV) do Atlas cung cấp |
| Upload file báo `File quá lớn` (413) | Vercel giới hạn body ~4,5 MB → app chặn ở 4,4 MB/file | Nén/chia nhỏ file; ảnh đã được app tự nén trước khi gửi; bản local cho phép tới 25 MB |
| `vercel login` treo / không mở được trình duyệt | Mạng chặn luồng device-login | Dùng token: mục 5.1 |
| Sửa code xong mà trang web không đổi | Quên deploy — sửa file chỉ có tác dụng local | `npm run deploy` |
| 2 người sửa cùng lúc bị "giật" nội dung | App đồng bộ toàn bộ state mỗi ~4s, người lưu sau thắng | Tránh 2 người sửa cùng một ô một lúc; dữ liệu vẫn an toàn trong Mongo |

## 8. Bảo mật — 3 điều phải nhớ

1. **Không bao giờ** commit hay deploy file `.env` — `.gitignore` và `.vercelignore` đã chặn sẵn, đừng gỡ các dòng đó.
2. Ứng dụng **không có đăng nhập**: ai có link `bim-wheat.vercel.app` đều xem/sửa được dữ liệu. Nếu cần hạn chế, bật **Vercel → Settings → Deployment Protection** (yêu cầu đăng nhập Vercel) hoặc đổi sang tên project khó đoán.
3. Nếu nghi ngờ lộ mật khẩu database → xoay mật khẩu ngay theo mục 3.4 (mất ~2 phút, không mất dữ liệu).
