# Dự án: Bảng theo dõi hạng mục (BIM)

Ứng dụng HTML tĩnh + serverless functions, chạy trên Vercel. Dữ liệu bảng ở
MongoDB Atlas; **file đính kèm ở Amazon S3** (từ 09/2026, tối đa 500MB/file).

- **Production:** https://bvtc.vcijsc.com
- **Vercel project:** `bim` thuộc tài khoản `nguyenvhuyutc-9517`

Site cũ `bim-wheat.vercel.app` thuộc tài khoản khác (`ngothuytq98`) — không có
quyền deploy, nhưng dùng chung MongoDB nên dữ liệu hai bên giống nhau.

## Cấu trúc

| Đường dẫn | Vai trò |
|---|---|
| `bang-hang-muc.html` | Toàn bộ giao diện — trang gốc `/` rewrite về đây |
| `api/data.js` | Serverless function đọc/ghi dữ liệu bảng vào MongoDB |
| `api/files.js` | Ký presigned URL cho S3 + ghi metadata file vào MongoDB |
| `scripts/kiem-tra-cau-hinh.mjs` | Kiểm `.env` + MongoDB + S3 ở máy — an toàn, chạy lúc nào cũng được |
| `scripts/don-file-mo-coi.mjs` | Dọn file mồ côi trên S3 — chạy tay, xoá được dữ liệu thật |
| `scripts/dong-bo-thu-muc.mjs` + `dong-bo/` | Đồng bộ thư mục NAS ↔ bảng — xem § Đồng bộ NAS |
| `scripts/thu-quyen-tvgs.mjs` | Kiểm phân quyền THẬT của cột mở tự do trên API — **chạy lại sau mỗi lần đụng `api/data.js` hoặc `api/files.js`** |
| `vercel.json` | Rewrite trang gốc + CORS + `functions.maxDuration` |
| `serve.cjs`, `start-server.bat`, `data.json` | **Tư liệu, KHÔNG chạy được nữa** — xem § Bản LAN |

**File đính kèm:** client PUT thẳng lên S3, function chỉ ký URL. MongoDB chỉ giữ
metadata (`{key, status, size}`). File tải lên **trước 09/2026** vẫn nằm trong
MongoDB dạng `data`/`chunks` và vẫn đọc được — hai đường chạy song song, không
migrate. Chi tiết + ba cái bẫy dễ sập: [docs/luu-file-s3.md](docs/luu-file-s3.md).

**Thùng rác:** xoá file (lẻ hoặc theo dòng) chỉ đổi `status` sang `"trashed"` —
object trên S3 không đụng tới, giữ 30 ngày rồi máy chủ tự dọn. Chỉ quản trị mở
được, và file trong đó không tải tự do được nữa. Khôi phục phải **ghi bảng trước,
gọi `?action=restore` sau** — đảo thứ tự là sinh file mồ côi kiểu mới. Xem
§ Thùng rác trong [docs/luu-file-s3.md](docs/luu-file-s3.md).

**Mọi action POST mới của `api/files.js` phải được thêm vào `ACTION_POST`** — cái
shim tương thích ở đó chặn mọi POST lạ bằng 426 "hãy tải lại trang", một lỗi
trông y hệt lỗi cache.

## Cột file

Một dòng có **năm** mảng file, hằng `FKEYS` giữ danh sách:

| Mảng | Cột trên bảng | Ghép cặp theo dòng |
|---|---|---|
| `files` | File đang trình — **PDF** | cột gốc, các cột khác bám theo nó |
| `filesCad` | File đang trình — **DWG + Excel** (và mọi đuôi khác) | có |
| `filesTvgs` | **Ý kiến TVGS** — mở cho mọi quyền, xem § Phân quyền | có |
| `filesDuyet` | File đã duyệt | không |
| `filesChapThuan` | Hồ sơ chấp thuận | không |

**Ghép cặp theo dòng (09/2026):** hằng `PAIRED` liệt kê các cột bám theo cột PDF
— hiện là `filesCad` và `filesTvgs`. Mỗi file trong một cột như vậy mang `pairUid`
= `uid` của file PDF nó đi kèm; chuỗi rỗng = chưa gán. Cột ghép cặp dựng **một ô
cho mỗi file PDF** — ô trống hiện nút `+` riêng của dòng đó — nên nhìn ngang là
biết file nào ứng với bản PDF nào. Ghép bằng **khoá chứ không bằng vị trí**: mảng
vẫn dày, mọi chỗ đếm file / xoá / thùng rác / CSV giữ nguyên cách duyệt cũ.
`capFile(row, fkey)` là chỗ **duy nhất** tính chuyện này, trả `{slots, roi}` với ô
đã ghép nằm ở `.kem`; `roi` gom file chưa gán **và** file trỏ vào PDF đã xoá — để
không file nào biến mất khỏi bảng.

**Thêm một cột ghép cặp nữa** chỉ cần: thêm tên vào `PAIRED` + `FKEYS` (ba nơi),
thêm mục trong `COLUMNS`, thêm `<th>`, thêm `appendChild` trong `render()`, thêm
cặp cột trong `HEADERS` và `lines.push([...])` của CSV, thêm `<option>` trong hộp
"Chọn chỗ khôi phục". Mọi chỗ còn lại đọc `PAIRED` chứ không ghi cứng tên cột.

Phần **file chưa gán** (`roi`) của mỗi cột xếp ngay dưới khối ô của chính cột đó,
nên khi hai cột có số file chưa gán khác nhau thì phần dưới ấy lệch nhau — cố ý:
file chưa gán vốn là ngoại lệ hiếm, đệm cho thẳng hàng chỉ tốn chỗ mà vẫn không nói
được ghi chú thuộc về file nào.

Kéo theo hai điều dễ quên: **ghi chú đi theo dòng** (lưu ở file PDF, không phải ở
file đi kèm — nên mọi chỗ chuyển một file vào ô đều phải dồn ghi chú của nó sang
file PDF), và `pairUid` phải **đi cùng file vào thùng rác** — `hoSoRac()` cùng hai
whitelist trong `api/files.js` đều chép nó, thiếu là khôi phục xong file nằm rời,
mất dòng. `node scratch/thu-ghep-cap-file.mjs` canh toàn bộ những điều trên.

`FKEYS` **được chép ở ba nơi** — `bang-hang-muc.html`, `api/files.js`,
`scripts/don-file-mo-coi.mjs` — và cả ba phải khớp. Thiếu một cột ở `api/files.js`
thì thùng rác coi file trong cột đó là rác; thiếu ở script dọn thì báo cáo gọi file
thật là mồ côi. `node scratch/thu-cau-truc-cot.mjs` kiểm đúng chuyện này.

`COLUMNS`, thứ tự `<th>` trong `thead`, và thứ tự `appendChild` trong `render()`
phải **khớp từng ô theo vị trí** — `initColGrips` ghép `th` thứ i với `COLUMNS[i]`
theo chỉ số chứ không theo tên. Cũng đừng thêm hàng `<th>` thứ hai vào `thead` vì
lý do đó.

Ba cột "Thời gian" đã bỏ (09/2026) — mốc tải lên xem ở tooltip của file. **CSV vẫn
giữ** các cột đó: file CSV không có tooltip.

## Bố cục bảng

Cột nào hiện mặc định là do cờ `off` trong `COLUMNS` quyết định — hiện `chiTiet`
và `nguoiLam` mang cờ đó nên **ẩn với mọi quyền**. Thêm cột ẩn mặc định chỉ cần
đặt cờ, `colHideMacDinh()` tự đọc ra.

Menu **"Hiển thị"** (ẩn/hiện cột, độ cao dòng, bề rộng cột, hiện lại dòng đã ẩn)
**chỉ quản trị mở được** — `canAdmin()`, không phải `canEdit()`. Nút, popup và tay
kéo cột đều ẩn với người khác, và ba handler đều kiểm quyền lại ở JS. Tuỳ chọn của
quản trị lưu ở `localStorage`, **riêng từng máy** — đổi cột không ảnh hưởng ai khác.

`applyView()` bỏ qua `view.colHide` khi không phải quản trị và dựng theo cờ `off`.
Đừng đổi thành "ẩn menu là đủ": tuỳ chọn cũ trong `localStorage` sẽ vẫn áp vào
người vừa mất quyền.

`node scratch/thu-cau-truc-cot.mjs` canh toàn bộ những điều trên.

## Đồng bộ NAS

Thư mục bản vẽ trên NAS ↔ bảng. Chạy trên **máy trạm**, trỏ vào đường dẫn UNC —
NAS chỉ là kho, không chạy được app.

```
dong-bo.bat                    bấm đúp → CHẠY KHÔ (có `pause`, đọc kết quả)
dong-bo.bat --thuc-hien        ghi thật
dong-bo-theo-lich.bat          bản cho Task Scheduler — KHÔNG `pause`, có ghi log
```

**Đừng cắm `dong-bo.bat` vào Task Scheduler.** `pause` khiến tác vụ treo chờ một
phím không ai bấm; Windows thấy "đang chạy" nên bỏ qua mọi lần sau. Hỏng im lặng,
ba tuần sau mới lộ. Dùng `dong-bo-theo-lich.bat`. Và **chỉ MỘT máy được cắm lịch**
— khoá `.bim-sync.lock` là lưới an toàn, không phải giấy phép.

Bốn module trong `scripts/dong-bo/`, mỗi cái do một phiên viết theo
[HOP-DONG.md](scripts/dong-bo/HOP-DONG.md). **Đọc § Bẫy đã biết ở đầu file đó trước
khi sửa bất cứ gì** — tám bẫy, mỗi cái đều đã cắn thật một lần.

Ba điều quan trọng nhất:

- **KHÔNG BAO GIỜ XOÁ**, ở cả hai bên. Sổ ghi `.bim-sync.json` phân biệt "chưa từng
  đồng bộ" với "đã bị xoá"; không có nó thì file xoá trên web sẽ sống lại từ thư mục
  ở mỗi lần chạy.
- **Chỉ đụng thư mục có `.bim-id`.** Cây thư mục cũ của công ty không bị chạm tới.
- **Chỉ cần `EDIT_KEY`**, không có `ADMIN_KEY` — script không xoá gì.

Cấu hình ở `scripts/.env.dong-bo` (bị `.gitignore` chặn; mẫu là `.env.dong-bo.example`).
Đường dẫn phải là **UNC**, không phải ổ map: ổ map thuộc phiên đăng nhập nên Task
Scheduler chạy tài khoản khác sẽ không thấy.

**`THU_MUC_GOC` trỏ vào một thư mục con riêng, không phải thư mục dự án.** Hiện tại:

```
…\<thu-muc-du-an>\04.WEB      ← THU_MUC_GOC
…\<thu-muc-du-an>\01.MANEGER  ┐
…\<thu-muc-du-an>\02.INPUT    ├ cây cũ của công ty, script không đụng
…\<thu-muc-du-an>\03.OUTPUT   ┘
```

Đường dẫn thật nằm ở `scripts/.env.dong-bo` — file đó bị `.gitignore` chặn, cố ý:
repo này công khai nên tên máy chủ và thư mục nội bộ không đi vào git.

Cây do script tạo gom hết vào `04.WEB` nên nhìn thư mục dự án là biết ngay phần nào
do người sắp, phần nào do máy sinh.

**Dời cả cây sang chỗ khác không làm hỏng gì** — script nhận diện bằng `.bim-id` chứ
không bằng đường dẫn (thiết kế của `docCayHienCo`). Đã kiểm bằng cách chuyển thật
rồi chạy lại: 0/0/0/0, 30 file và 45 dấu `.bim-id` nguyên vẹn. Dời xong chỉ cần sửa
`THU_MUC_GOC`.

Nhưng **chỉ tức thì khi dời trong CÙNG share**. Sang share khác hoặc ổ khác là chép
thật 588 MB — **chờ chép xong hẳn rồi mới chạy script**, chép dở mà chạy thì script
thấy thiếu file và xếp chúng vào mục "cần bạn quyết".

### Tên thư mục Quyển — dấu gạch và dấu phẩy KHÁC nghĩa

Tên thư mục bỏ tiền tố định danh cầu (`SD-CTP`, `CTP/T`, `SHP/SHT`) vì thư mục Tập
đã nói cầu nào rồi; giữ lại **dải trụ** — thứ người đi tìm bản vẽ thực sự cần.

| Nguồn trên web | Thư mục | |
|---|---|---|
| `TỪ SD-CTP-T51 ĐẾN SD-CTP-T55` | `I.1-4 CKN T51-T55` | **gạch** = dải liên tục |
| `CÁC TRỤ SD-CTP-T47, SD-CTT-T50` | `I.2-2 KCPD T47,T50` | **phẩy** = chỉ hai trụ đó |
| `TRỤ SHP/T-T43 ĐẾN MỐ SHP/SHT - M2` | `I.2-1 T43-M2` | mố cũng là mốc hợp lệ |

Đặt `T47-T50` cho quyển chỉ có T47 và T50 là **nói dối người dùng**: người tìm bản
vẽ trụ T49 sẽ mở đúng thư mục đó rồi không thấy gì. `daiTruMo()` trong
`cay-thu-muc.mjs` phân biệt bằng chữ "ĐẾN" trong nguồn.

Hai bẫy ở đó: dò từ khoá tiếng Việt **phải bỏ dấu trước** (`\bĐẾN\b` không bao giờ
khớp vì `Đ` ngoài ASCII — im lặng, không báo lỗi); và ranh giới từ `\b[TM]\d+\b` là
thứ giữ cho `KM29+877` không bị đọc thành trụ `M29`.

Đo được trên NAS công ty: `\\?\UNC\` **chạy**, trần đường dẫn **1039 ký tự** (Samba,
cao hơn Windows nhiều). Nên trần 260 chỉ còn là ràng buộc của Explorer/CAD, không
phải của việc ghi. Cây hiện tại dài nhất 217 → an toàn cả hai phía.
`node scripts/thu-nas.mjs <đường dẫn>` đo lại được bất cứ lúc nào, chỉ tạo một thư
mục tạm rồi xoá.

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
- `ADMIN_KEY` — quyền quản trị: như trên, thêm xoá kế hoạch, xoá file và **toàn bộ
  thùng rác** (liệt kê, khôi phục, xoá vĩnh viễn).
- Xem/tải file xuống (GET) tự do — **trừ file đang nằm trong thùng rác**, thứ chỉ
  quản trị tải được. **Không đặt cả hai biến → không khoá gì** (tương thích cũ).

**Ngoại lệ có chủ ý — cột "Ý kiến TVGS" (`filesTvgs`):** ai mở được trang cũng tải
file lên và bỏ vào thùng rác được ở **riêng cột đó**, không cần mật khẩu — bên tư
vấn giám sát không cầm mật khẩu của chủ đầu tư. Ba chốt giữ cho ngoại lệ này không
loang ra chỗ khác:

1. Họ **không POST được cả document**. Đường ghi thường vẫn đòi `EDIT_KEY`; cột này
   đi lối riêng `POST /api/data?action=tvgs&plan=&row=` chỉ thay đúng một mảng của
   đúng một dòng (dùng `arrayFilters`, không đọc-sửa-ghi cả bảng ở client).
2. Mọi mục gửi lên bị `locFileTvgs()` lọc về đúng các trường đã biết, và **id phải
   là file mang dấu `cot: "filesTvgs"`** — dấu này do `api/files.js` đóng lúc ký URL
   tải lên, không phải thứ client khai.
3. Thùng rác cho khách cũng kiểm bằng dấu `cot` đó, **không** tin `fkey` client gửi.
   Khôi phục, xoá vĩnh viễn và xem thùng rác vẫn chỉ quản trị.

Đổi lại: **ai có link cũng tải được file lên cột đó** (tới 500MB/file) và bỏ được ý
kiến của người khác vào thùng rác — quản trị khôi phục lại được trong 30 ngày. Muốn
siết thì thêm một mật khẩu riêng cho TVGS thay vì mở tự do.

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
- 4 biến S3 (`S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
  `S3_BUCKET`) đặt trên Vercel, tách riêng Production và Preview. Preview dùng
  bucket riêng và `MONGODB_DB=bim_preview` để kiểm thử không đụng dữ liệu thật.
  Access Key ID **có** nằm trong mọi URL đã ký — đó là bản chất SigV4, không
  phải rò rỉ; chỉ `S3_SECRET_ACCESS_KEY` mới phải giữ kín.
- URL S3 dùng **path-style** (`https://s3.<vùng>.amazonaws.com/<bucket>/<key>`),
  không phải virtual-hosted — tên bucket có dấu chấm nên chứng chỉ TLS
  `*.s3.<vùng>.amazonaws.com` không khớp. **Đừng "sửa" thành virtual-hosted.**
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
[docs/luu-file-s3.md](docs/luu-file-s3.md).

## Responses / Results / Questions / Suggests
Write all results, questions, and suggestions in Vietnamese with proper diacritics.