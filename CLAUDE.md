# Dự án: Bảng theo dõi hạng mục (BIM)

Ứng dụng HTML tĩnh + serverless functions, chạy trên Vercel, lưu dữ liệu ở MongoDB Atlas.

- **Production:** https://bim-ruddy.vercel.app
- **Vercel project:** `bim` thuộc tài khoản `nguyenvhuyutc-9517`

Site cũ `bim-wheat.vercel.app` thuộc tài khoản khác (`ngothuytq98`) — không có
quyền deploy, nhưng dùng chung MongoDB nên dữ liệu hai bên giống nhau.

## Cấu trúc

| Đường dẫn | Vai trò |
|---|---|
| `bang-hang-muc.html` | Toàn bộ giao diện — trang gốc `/` rewrite về đây |
| `api/data.js` | Serverless function đọc/ghi dữ liệu bảng vào MongoDB |
| `api/files.js` | Serverless function quản lý file đính kèm |
| `serve.cjs` | Server LAN chạy **local**, không deploy (loại trong `.vercelignore`) |
| `data.json` | Dữ liệu **local** dùng với `serve.cjs`, không deploy |
| `vercel.json` | Rewrite trang gốc + CORS header cho `/api/*` |

Trên Vercel dữ liệu nằm ở MongoDB; `serve.cjs` + `data.json` chỉ phục vụ chạy
máy trong mạng LAN. Đừng lẫn hai đường này.

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
| `npm start` | Chạy server LAN local (cổng 8787) |
| `npm run deploy` | Deploy production lên Vercel |
| `npm run deploy:preview` | Deploy bản thử, link riêng |
| `npm run vercel:env` | Kéo biến môi trường từ Vercel về `.env` |
| `npm run vercel:logs` | Xem log runtime của function |
| `npm run vercel:login` | Đăng nhập lại Vercel CLI |

## Deploy

Khi người dùng nói "deploy", "đẩy code lên", "cập nhật web" → dùng skill
`deploy-bim` (`.claude/skills/deploy-bim/SKILL.md`). Skill đó có đủ quy trình,
cách xác minh và bảng xử lý sự cố.

## Phân quyền

API dùng 2 mật khẩu đặt qua biến môi trường (trên Vercel cho bản web, hoặc env
khi chạy `serve.cjs` cho bản LAN):

- `EDIT_KEY` — quyền sửa: ghi dữ liệu bảng, tạo/đổi tên kế hoạch, tải file lên.
- `ADMIN_KEY` — quyền quản trị: như trên, thêm xoá kế hoạch và xoá file.
- Xem/tải file xuống (GET) luôn tự do. **Không đặt cả hai biến → không khoá gì**
  (tương thích cũ, và là mặc định của chế độ LAN).

Client gửi mật khẩu qua header `x-edit-key` (lưu localStorage, nhập ở nút đăng
nhập trên giao diện). Endpoint `GET /api/data?whoami=1` trả `{role, protected}`
để giao diện ẩn/hiện nút. Logic kiểm tra nằm ở `api/data.js`, `api/files.js`
và `serve.cjs` (3 bản giống nhau — sửa một chỗ thì sửa cả ba).

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
