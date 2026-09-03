# Dự án: Bảng theo dõi hạng mục (BIM)

Ứng dụng HTML tĩnh + serverless functions, chạy trên Vercel. Dữ liệu bảng ở
MongoDB Atlas; **file đính kèm ở Cloudflare R2** (từ 09/2026, tối đa 200MB/file).

- **Production:** https://bim-ruddy.vercel.app
- **Vercel project:** `bim` thuộc tài khoản `nguyenvhuyutc-9517`

Site cũ `bim-wheat.vercel.app` thuộc tài khoản khác (`ngothuytq98`) — không có
quyền deploy, nhưng dùng chung MongoDB nên dữ liệu hai bên giống nhau.

## Cấu trúc

| Đường dẫn | Vai trò |
|---|---|
| `bang-hang-muc.html` | Toàn bộ giao diện — trang gốc `/` rewrite về đây |
| `api/data.js` | Serverless function đọc/ghi dữ liệu bảng vào MongoDB |
| `api/files.js` | Ký presigned URL cho R2 + ghi metadata file vào MongoDB |
| `scripts/don-file-mo-coi.mjs` | Dọn file mồ côi trên R2 — chạy tay, xoá được dữ liệu thật |
| `vercel.json` | Rewrite trang gốc + CORS + `functions.maxDuration` |
| `serve.cjs`, `start-server.bat`, `data.json` | **Tư liệu, KHÔNG chạy được nữa** — xem § Bản LAN |

**File đính kèm:** client PUT thẳng lên R2, function chỉ ký URL. MongoDB chỉ giữ
metadata (`{key, status, size}`). File tải lên **trước 09/2026** vẫn nằm trong
MongoDB dạng `data`/`chunks` và vẫn đọc được — hai đường chạy song song, không
migrate. Chi tiết + ba cái bẫy dễ sập: [docs/luu-file-r2.md](docs/luu-file-r2.md).

## Môi trường

Shell của Claude Code **thiếu Node trong PATH** và không tự nạp `VERCEL_TOKEN`.
Với mọi lệnh `node`/`npm`/`vercel`, dùng **PowerShell** và mở đầu bằng:

```powershell
$env:PATH = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:PATH"
$env:VERCEL_TOKEN = [Environment]::GetEnvironmentVariable("VERCEL_TOKEN","User")
```

Bash tool không có `node`/`npm`/`npx` — đừng dùng Bash cho các lệnh này.

## Lệnh

| Lệnh | Tác dụng |
|---|---|
| `npm run deploy` | Deploy production lên Vercel |
| `npm run deploy:preview` | Deploy bản thử, link riêng |
| `npm run vercel:env` | Kéo biến môi trường **production** từ Vercel về `.env` |
| `npm run vercel:logs` | Xem log runtime của function |
| `npm run vercel:login` | Đăng nhập lại Vercel CLI |

## Deploy

Khi người dùng nói "deploy", "đẩy code lên", "cập nhật web" → dùng skill
`deploy-bim` (`.claude/skills/deploy-bim/SKILL.md`). Skill đó có đủ quy trình,
cách xác minh và bảng xử lý sự cố.

## Phân quyền

API dùng 2 mật khẩu đặt qua biến môi trường trên Vercel:

- `EDIT_KEY` — quyền sửa: ghi dữ liệu bảng, tạo/đổi tên kế hoạch, tải file lên.
- `ADMIN_KEY` — quyền quản trị: như trên, thêm xoá kế hoạch và xoá file.
- Xem/tải file xuống (GET) luôn tự do. **Không đặt cả hai biến → không khoá gì**
  (tương thích cũ).

Client gửi mật khẩu qua header `x-edit-key` (lưu localStorage, nhập ở nút đăng
nhập trên giao diện). Endpoint `GET /api/data?whoami=1` trả `{role, protected}`
để giao diện ẩn/hiện nút. Logic kiểm tra nằm ở `api/data.js` và `api/files.js`
— **hai bản giống nhau, sửa một chỗ thì sửa cả hai**. `serve.cjs` đứng ngoài, đã
ngừng dùng.

Lưu ý: site cũ `bim-wheat.vercel.app` chạy code cũ trên cùng MongoDB nên không
bị khoá theo — muốn chặn triệt để phải đổi mật khẩu MongoDB Atlas.

## Bảo mật

- `.env` chứa connection string MongoDB, `.env.local` chứa OIDC token — cả hai
  bị `.gitignore` chặn qua `.env*`. **Không bao giờ** commit hoặc deploy chúng.
- Dòng `!.env.example` trong `.gitignore` là cố ý — đừng xoá, nếu không file mẫu
  sẽ biến mất khỏi repo.
- Biến môi trường production đặt trên Vercel, không đọc từ `.env` khi chạy thật.
- Token Vercel lưu ở biến môi trường User của Windows (`VERCEL_TOKEN`), nằm
  ngoài repo. Không ghi token vào bất kỳ file nào trong project.
- Project có kết nối GitHub repo `nguyenvhuyutc-gif/document` → push lên repo đó
  cũng kích hoạt deploy tự động.
- 4 biến R2 (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET`) đặt trên Vercel, tách riêng Production và Preview. Preview dùng
  bucket `bim-files-preview` và `MONGODB_DB=bim_preview` để kiểm thử không đụng
  dữ liệu thật. Access Key ID **có** nằm trong mọi URL đã ký — đó là bản chất
  SigV4, không phải rò rỉ; chỉ `R2_SECRET_ACCESS_KEY` mới phải giữ kín.
- `.vercelignore` chặn `*.md`, `docs`, `plans`, `scripts`, `scratch` — **đừng gỡ**.
  Vercel phục vụ mọi file tĩnh, nên bỏ ra là `https://…/CLAUDE.md` mở được công khai.

## Đồng bộ dữ liệu bảng

`POST /api/data?plan=<id>&ifMtime=<mtime>` chỉ ghi khi document trên máy chủ vẫn
đúng bản client đã đọc. Không khớp → **409 kèm `conflict: true`, `mtime` và `data`
của bản trên máy chủ**. 409 ở đây nghĩa là *xung đột*, không phải lỗi — giao diện
hiện dải cảnh báo cho người dùng chọn "Xem bản mới" hay "Ghi đè bằng bản của tôi",
và dừng vòng đồng bộ (`syncPaused`) trong lúc đó.

`ifMtime = 0` hoặc thiếu → giữ hành vi cũ (upsert, last-write-wins). Cần cho kế
hoạch mới chưa có document, và cho tab đang mở bản HTML cũ trong cache.

## Bản LAN (`serve.cjs`) — đã ngừng

Giữ file làm tư liệu, đã gỡ script `npm start` / `dev` / `serve`. Chỉ có **một**
`bang-hang-muc.html` dùng chung, mà giao diện nay gọi `?action=sign-upload` —
`serve.cjs` không có route đó nên **mọi lần tải file lên sẽ báo "File rỗng"**.
Đừng "sửa lỗi" đó bằng cách đổi giao diện; đọc § Muốn dựng lại bản LAN trong
[docs/luu-file-r2.md](docs/luu-file-r2.md).

## Responses / Results / Questions / Suggests
Write all results, questions, and suggestions in Vietnamese with proper diacritics.