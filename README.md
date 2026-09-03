# Bảng theo dõi hạng mục (WBS)

Ứng dụng theo dõi hạng mục công trình: một trang HTML tĩnh cộng vài serverless
function, chạy trên Vercel.

- **Địa chỉ dùng thật:** <https://bim-ruddy.vercel.app>
- **Dữ liệu bảng:** MongoDB Atlas
- **File đính kèm:** Amazon S3 (tối đa **200MB/file**)

---

## Cấu trúc

```text
document/
├─ bang-hang-muc.html   ← toàn bộ giao diện; trang gốc "/" rewrite về đây
├─ api/
│  ├─ data.js           ← đọc/ghi dữ liệu bảng vào MongoDB
│  └─ files.js          ← ký presigned URL cho S3 + ghi metadata file
├─ scripts/
│  └─ don-file-mo-coi.mjs  ← dọn file mồ côi trên S3 (chạy tay, không tự động)
├─ vercel.json          ← rewrite trang gốc, CORS, giới hạn thời gian function
├─ .env.example         ← mẫu biến môi trường (copy thành .env để chạy script)
├─ docs/                ← tài liệu kỹ thuật
├─ serve.cjs            ← (tư liệu) máy chủ LAN cũ — ĐÃ NGỪNG, xem bên dưới
├─ start-server.bat     ← (tư liệu) đi kèm serve.cjs
└─ data.json            ← (tư liệu) dữ liệu của bản LAN cũ
```

## Cách file đính kèm hoạt động

Client tải file **thẳng lên Amazon S3**, không đi qua Vercel. Function chỉ ký
URL có hạn và ghi metadata:

```text
TẢI LÊN   client → POST /api/files?action=sign-upload   → { uploadUrl, id, key }
          client → PUT thẳng lên S3 (kèm Content-Disposition + Content-Type)
          client → POST /api/files?action=confirm       → ghi metadata

TẢI XUỐNG client → GET /api/files?id=…  → 302 sang S3 (URL ký, hạn 5 phút)
```

Nhờ vậy không còn vướng giới hạn body ~4.5MB của Vercel lẫn giới hạn
16MB/document của MongoDB. Chi tiết ở **[docs/luu-file-s3.md](docs/luu-file-s3.md)**.

File tải lên **trước 09/2026** vẫn nằm trong MongoDB và vẫn tải xuống bình thường —
không migrate. Hai đường đọc chạy song song.

## Lệnh

```bash
npm run deploy           # deploy production
npm run deploy:preview   # deploy bản thử, link riêng
npm run vercel:env       # kéo biến môi trường production về .env
npm run vercel:logs      # xem log runtime của function
```

Dọn file mồ côi trên S3 (mặc định chỉ chạy khô, in ra):

```bash
node scripts/don-file-mo-coi.mjs
```

## Tài liệu

| File | Nội dung |
|---|---|
| [docs/luu-file-s3.md](docs/luu-file-s3.md) | Kiến trúc lưu file, biến môi trường S3, xoay khoá, script dọn |
| [docs/phan-quyen-mat-khau.md](docs/phan-quyen-mat-khau.md) | Hai mật khẩu `EDIT_KEY` / `ADMIN_KEY` |
| [HUONG-DAN-DEPLOY.md](HUONG-DAN-DEPLOY.md) | Thiết lập MongoDB Atlas + deploy Vercel |
| [SO-TAY-CAU-LENH.md](SO-TAY-CAU-LENH.md) | Sổ tay câu lệnh, giải thích từng lệnh |
| [CLAUDE.md](CLAUDE.md) | Ghi chú cho người/máy sửa mã nguồn |

Bảo mật: `.env` chứa connection string MongoDB và khoá S3 — **không bao giờ**
commit hay deploy. `.vercelignore` chặn `*.md`, `docs`, `plans`, `scripts`,
`scratch` để chúng không mở được công khai qua `https://…/CLAUDE.md`.

---

## Bản LAN (`serve.cjs`) — đã ngừng

Trước đây có một máy chủ Node chạy trong mạng LAN, lưu dữ liệu vào `data.json`.
**Bản đó đã ngừng dùng từ 09/2026.**

Các file `serve.cjs`, `start-server.bat`, `data.json` vẫn còn trong repo **làm tư
liệu**, nhưng script `npm start` / `npm run dev` / `npm run serve` đã bị gỡ.

Lý do: chỉ có **một** file `bang-hang-muc.html` dùng chung cho cả hai bản. Giao
diện nay gọi `?action=sign-upload`, mà `serve.cjs` không có route đó — chạy
`node serve.cjs` thì phần bảng biểu vẫn hoạt động nhưng **mọi lần tải file lên
đều báo "File rỗng"**. Khối chú thích ở đầu `serve.cjs` nói rõ điều này.

Muốn dùng lại bản LAN thì phải cài thêm 3 route `sign-upload` / `confirm` / GET
302 vào `serve.cjs` — xem [docs/luu-file-s3.md](docs/luu-file-s3.md).

Mở thẳng `bang-hang-muc.html` bằng `file://` vẫn chạy được ở chế độ lưu riêng
(localStorage, huy hiệu 🟡), không gọi API nào. Chế độ đó giới hạn 8MB/file.
