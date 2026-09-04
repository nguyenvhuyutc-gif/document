---
name: deploy-bim
description: Deploy dự án BIM (bảng theo dõi hạng mục) lên Vercel — production hoặc preview — bằng Vercel CLI đã link sẵn. Dùng khi người dùng nói "deploy", "đẩy code lên", "cập nhật web", "lên production", "deploy bản mới", "up code".
---

# Deploy BIM lên Vercel

Thực hiện tuần tự các bước dưới. Không bỏ bước, không hỏi lại nếu người dùng
chỉ nói "deploy" — mặc định là **production**.

## Thông tin project

| Mục | Giá trị |
|---|---|
| URL production | https://bvtc.vcijsc.com |
| Tài khoản Vercel | `nguyenvhuyutc-9517` (nguyenvhuyutc@gmail.com), gói Hobby |
| Scope / team | `team_ZxR5LGq3wCByGjtulrdlZZkE` |
| Project ID | `prj_2wdCGn7lLL6ROSYdMGFW1yHrhowk` |
| Kiểu app | HTML tĩnh + serverless functions trong `api/` |
| Build step | Không có — `vercel-build` chỉ `echo` |
| Dữ liệu | MongoDB Atlas qua biến môi trường |
| Trang gốc | `/` rewrite sang `/bang-hang-muc.html` |

Site cũ `bim-wheat.vercel.app` thuộc tài khoản khác (`ngothuytq98`), **không có
quyền deploy**. Nó vẫn chạy và dùng chung MongoDB. Đừng cố deploy vào đó.

## Bước 0 — Mở đầu mọi lệnh (bắt buộc)

Shell của Claude Code **thiếu Node trong PATH** và không tự nạp `VERCEL_TOKEN`.
Luôn mở đầu lệnh PowerShell bằng hai dòng này:

```powershell
$env:PATH = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:PATH"
$env:VERCEL_TOKEN = [Environment]::GetEnvironmentVariable("VERCEL_TOKEN","User")
```

Bash tool hoàn toàn không có `node`/`npm`/`npx` — **dùng PowerShell cho mọi
lệnh liên quan Vercel**.

## Bước 1 — Kiểm tra đăng nhập

Xác thực bằng **Access Token** lưu ở biến môi trường User của Windows
(`VERCEL_TOKEN`), không dùng OAuth tương tác.

```powershell
node node_modules\vercel\dist\index.js whoami
```

Kỳ vọng: `nguyenvhuyutc-9517`.

- Lỗi `Not authorized` → kiểm tra `.vercel/project.json` có đúng org
  `team_ZxR5LGq3wCByGjtulrdlZZkE` không. Token bị scope theo project đang link,
  nên link sai team làm cả `whoami` fail.
- Token hết hạn → người dùng tạo token mới tại
  https://vercel.com/account/tokens rồi:
  ```powershell
  [Environment]::SetEnvironmentVariable("VERCEL_TOKEN","<token>","User")
  ```
- **KHÔNG** chạy `vercel login` ở background: mã thiết bị hết hạn trước khi kịp
  xác nhận.
- **KHÔNG** ghi token vào `.env`, `package.json` hay file nào trong repo.

## Bước 2 — Kiểm tra link

`.vercel/project.json` phải có đúng `projectId` và `orgId` ở bảng trên.
Nếu mất file → `npm run vercel:link -- --project bim`.

## Bước 3 — Deploy

```powershell
npm run deploy            # production — mặc định
npm run deploy:preview    # bản thử, link riêng, không đụng production
```

Deploy mất khoảng 30–90 giây. Đặt timeout tối thiểu 300000ms.

## Bước 4 — Xác minh (bắt buộc, đừng bỏ)

```powershell
foreach ($u in @("https://bvtc.vcijsc.com/","https://bvtc.vcijsc.com/api/data")) {
  try { $r = Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 45 -ErrorAction Stop
        "$u -> OK $($r.StatusCode), $($r.Content.Length) bytes" }
  catch { "$u -> LOI $($_.Exception.Response.StatusCode.value__)" }
}
```

Kỳ vọng cả hai trả `200`. `/api/data` khoảng 2.4KB.
`/api/files` trả `400 "Thiếu id"` khi gọi trần — **đó là bình thường**, không
phải lỗi.

Báo người dùng URL + kết quả. Nếu lỗi thì nói thẳng là lỗi, đừng làm nhẹ đi.

## Biến môi trường

| Biến | Bắt buộc | Mặc định |
|---|---|---|
| `MONGODB_URI` | **Có** | — thiếu là API trả 500 |
| `MONGODB_DB` | Không | `bim` |
| `MONGODB_COLLECTION` | Không | `bim_app` |
| `MONGODB_FILES_COLLECTION` | Không | `bim_files` |

Cả 3 biến đầu đã set cho production/preview/development, giá trị lấy từ `.env`.

**BẪY QUAN TRỌNG:** `vercel env add <KEY> <env>` nhận giá trị qua stdin, nhưng
trong môi trường này pipe **không tới nơi** — biến được tạo với giá trị **rỗng**
và API sẽ lỗi 500 với `MongoParseError: Invalid scheme`. Dùng REST API thay thế:

```powershell
$h = @{ Authorization = "Bearer $env:VERCEL_TOKEN"; "Content-Type" = "application/json" }
$proj = "prj_2wdCGn7lLL6ROSYdMGFW1yHrhowk"; $team = "team_ZxR5LGq3wCByGjtulrdlZZkE"
$body = ConvertTo-Json @(@{ key="TEN_BIEN"; value="gia_tri"; type="encrypted"
                            target=@("production","preview","development") }) -Depth 5
Invoke-RestMethod -Method Post -Uri "https://api.vercel.com/v10/projects/$proj/env?teamId=$team" -Headers $h -Body $body
```

**`--force` KHÔNG cứu được.** `"gia_tri" | vercel env add KEY production --force`
in ra `Removed trailing newline from stdin input` rồi `✓ Overrode` — trông y như
thành công, nhưng giá trị lưu vẫn **rỗng**. Đã dính lại lần nữa ngày 04/09/2026.
Đừng tin dòng `✓` của CLI; chỉ tin phép thử ở dưới.

Biến **đã tồn tại** thì POST ở trên sẽ lỗi trùng key. Lấy id rồi PATCH:

```powershell
$all = Invoke-RestMethod -Uri "https://api.vercel.com/v9/projects/$proj/env?teamId=$team" -Headers $h -Method Get
foreach ($e in $all.envs | Where-Object { $_.key -eq "MONGODB_URI" }) {
  Invoke-RestMethod -Method Patch -Headers $h -Body (@{ value = $uri } | ConvertTo-Json) `
    -Uri "https://api.vercel.com/v9/projects/$proj/env/$($e.id)?teamId=$team" | Out-Null
}
```

Sau khi đổi biến môi trường **phải deploy lại** thì function mới nạp giá trị mới.

**Cách kiểm chắc chắn nhất là gọi API thật**, không phải đọc file:

```powershell
curl.exe -s --max-time 45 "https://bvtc.vcijsc.com/api/data?list=1"
```

`MongoParseError: Invalid scheme` = biến rỗng. `vercel env pull` **không dùng
được** để kiểm nữa: biến tạo qua `env add` bị đánh dấu *Sensitive* và pull không
tải giá trị về, nên file trông như thiếu biến kể cả khi nó có giá trị đúng.

## Quy tắc an toàn

- **KHÔNG** commit hoặc deploy `.env` / `.env.local` — chứa mật khẩu MongoDB và
  OIDC token. `.gitignore` có `.env*` kèm `!.env.example`; đừng bỏ dòng phủ định
  đó, nếu không `.env.example` sẽ biến mất khỏi repo.
- **KHÔNG** sửa `.vercelignore` để bỏ `serve.cjs`, `data.json`, `.env` khỏi danh
  sách loại trừ. `serve.cjs` là server LAN chạy local; `data.json` là dữ liệu
  local, deploy lên sẽ gây nhầm lẫn với dữ liệu MongoDB.
- **KHÔNG** tự commit/push git khi người dùng chỉ bảo deploy. Deploy bằng CLI
  đẩy thẳng file trên đĩa lên Vercel, độc lập với git.
- Project có kết nối GitHub repo `nguyenvhuyutc-gif/document`, nên **push lên
  repo đó cũng kích hoạt deploy tự động**. Nhắc người dùng nếu điều này ngoài ý.

## Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `Not authorized` | Link sai team, hoặc token sai/hết hạn | Xem Bước 1 |
| `node not recognized` | PATH thiếu Node | Prefix ở Bước 0 |
| `npx: command not found` | Đang dùng Bash tool | Chuyển sang PowerShell |
| API 500 `Invalid scheme` | `MONGODB_URI` rỗng trên Vercel | Set lại qua REST API, xem phần biến môi trường |
| API 500 khác | Lỗi kết nối MongoDB | `npm run vercel:logs` xem log thật |
| `Could not retrieve Project Settings` | Token không có quyền với project đang link | Kiểm tra `orgId` trong `.vercel/project.json` |
| Trang trắng ở `/` | Sai rewrite trong `vercel.json` | Kiểm tra rewrite `/` → `/bang-hang-muc.html` |

Xem log runtime: `npm run vercel:logs https://bvtc.vcijsc.com`
