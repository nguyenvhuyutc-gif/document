# Sổ tay câu lệnh — Bảng theo dõi hạng mục

Tập hợp **tất cả câu lệnh** dùng cho dự án này. Mỗi lệnh có: **ý nghĩa từng phần → khi nào dùng → ví dụ kèm kết quả thật**.

**Gõ lệnh ở đâu:** mở VS Code → menu **Terminal ▸ New Terminal** (mặc định là PowerShell), đảm bảo đang đứng ở thư mục `D:\bim`. Trong ví dụ, phần `PS D:\bim>` là dấu nhắc của máy — **không gõ phần đó**, chỉ gõ phần phía sau.

---

## 0. Bảng tra nhanh

| Việc cần làm | Câu lệnh |
|---|---|
| Chạy máy chủ local/LAN | `node serve.cjs` |
| Chạy máy chủ ở cổng khác | `$env:PORT=9000; node serve.cjs` |
| Cài thư viện (máy mới, làm 1 lần) | `npm install` |
| Đăng nhập Vercel (làm 1 lần) | `npx vercel login` |
| Xem đang đăng nhập tài khoản nào | `npx vercel whoami` |
| Deploy bản **thử** (link riêng để xem trước) | `npx vercel` |
| Deploy bản **chính thức** | `npm run deploy` |
| Xem lịch sử các bản đã deploy | `npx vercel ls` |
| Xem danh sách biến môi trường | `npx vercel env ls` |
| Xem log lỗi của API trên Vercel | `npx vercel logs https://bim-wheat.vercel.app` |
| Kiểm tra trang chủ sống chưa | `curl.exe -s -o NUL -w "HTTP %{http_code}" https://bim-wheat.vercel.app/` |
| Xem API trả dữ liệu gì | `curl.exe -s https://bim-wheat.vercel.app/api/data` |

---

## 1. Nhóm chạy local / LAN

### 1.1. `node serve.cjs` — bật máy chủ

```
node serve.cjs
│    └─ file máy chủ của dự án (nằm trong D:\bim)
└─ chương trình Node.js: "hãy chạy file JavaScript này"
```

- **Khi nào dùng:** muốn dùng app trong văn phòng/LAN, dữ liệu lưu vào `data.json`, file đính kèm vào `data-files\`. Không cần internet, không đụng gì tới MongoDB/Vercel.
- **Ví dụ:**

```powershell
PS D:\bim> node serve.cjs
=================================================
  BẢNG THEO DÕI HẠNG MỤC — máy chủ đã chạy
-------------------------------------------------
  Trên máy này :  http://localhost:8787/
  Máy cùng LAN :  http://192.168.1.50:8787/
  Dữ liệu chung:  D:\bim\data.json
-------------------------------------------------
  Dừng máy chủ : đóng cửa sổ này (hoặc Ctrl+C)
=================================================
```

Mở địa chỉ in ra bằng trình duyệt là dùng được. **Giữ cửa sổ terminal mở** — đóng nó là tắt máy chủ. Hai lệnh `npm run dev` và `npm start` cho kết quả **y hệt** (chúng chỉ là tên gọi tắt khai báo trong `package.json`, bên trong đều gọi `node serve.cjs`).

### 1.2. Đổi cổng khi 8787 bị bận

```powershell
PS D:\bim> $env:PORT=9000; node serve.cjs
```

- **Ý nghĩa:** `$env:PORT=9000` = đặt biến môi trường `PORT` thành 9000 **cho riêng cửa sổ terminal này**; dấu `;` = "rồi chạy tiếp lệnh sau". `serve.cjs` đọc biến `PORT`, không thấy thì mặc định 8787.
- Nếu dùng cửa sổ **cmd** (màn hình đen, không phải PowerShell), cú pháp khác: `set PORT=9000 && node serve.cjs`.
- Tương tự, chỉ cho máy mình vào (không mở ra LAN): `$env:HOST="127.0.0.1"; node serve.cjs`

---

## 2. Nhóm cài đặt — chỉ làm 1 lần trên máy mới

### 2.1. `node --version` — kiểm tra đã cài Node.js chưa

```powershell
PS D:\bim> node --version
v22.14.0
```

Ra số phiên bản (v18 trở lên là ổn) nghĩa là dùng được. Báo *"không nhận ra lệnh node"* → cài Node.js bản LTS từ <https://nodejs.org> rồi mở lại terminal.

### 2.2. `npm install` — tải thư viện của dự án

```
npm install
│   └─ hành động: đọc danh sách trong package.json rồi tải về thư mục node_modules
└─ trình quản lý gói đi kèm Node.js
```

- **Khi nào dùng:** máy mới lần đầu làm việc với dự án, hoặc sau khi lỡ xoá thư mục `node_modules`. Nó tải 2 thứ: `mongodb` (cho API) và `vercel` (công cụ deploy). **Chạy local thuần thì không cần** — `serve.cjs` không dùng gói ngoài.
- **Ví dụ:**

```powershell
PS D:\bim> npm install
added 120 packages in 15s
```

---

## 3. Nhóm Vercel — đăng nhập & deploy

### 3.1. `npx vercel login` — đăng nhập (1 lần / máy)

```
npx vercel login
│   │      └─ hành động: đăng nhập
│   └─ tên công cụ: Vercel CLI
└─ "chạy công cụ trong node_modules (hoặc tự tải nếu chưa có) mà không cần cài toàn máy"
```

- **Ví dụ:**

```powershell
PS D:\bim> npx vercel login
Vercel CLI 55.x
> Visit https://vercel.com/oauth/device?user_code=ABCD-EFGH to log in.
```

Mở link đó bằng trình duyệt, đăng nhập đúng tài khoản chứa project `bim`, bấm **Confirm** — quay lại terminal sẽ thấy `Congratulations!`. Kiểm tra lại bằng:

```powershell
PS D:\bim> npx vercel whoami
ngothuytq98-2707
```

### 3.2. `npm run deploy` — deploy bản chính thức ⭐ (lệnh dùng nhiều nhất)

```
npm run deploy         →  thực chất chạy:  npx vercel --prod
                                           │          └─ đưa thẳng lên địa chỉ CHÍNH THỨC
                                           └─ công cụ deploy của Vercel
```

- **Khi nào dùng:** **mỗi khi sửa** `bang-hang-muc.html` hoặc `api/*.js` — sửa xong file chỉ nằm trên máy, phải deploy thì trang web mới đổi.
- **Ví dụ:**

```powershell
PS D:\bim> npm run deploy
Vercel CLI 55.x
🔍 Inspect: https://vercel.com/ngothuytq98-2707s-projects/bim/4Zk...  [2s]
✅ Production: https://bim-wheat.vercel.app [35s]
```

Dòng `✅ Production:` là xong. Con số thời gian mỗi lần mỗi khác — bình thường.

### 3.3. `npx vercel` (không có `--prod`) — deploy bản THỬ

- **Ý nghĩa:** tạo một bản chạy ở **link tạm riêng** (vd `https://bim-abc123-….vercel.app`), **không đụng** tới địa chỉ chính thức. Dữ liệu vẫn dùng chung MongoDB.
- **Khi nào dùng:** muốn xem trước thay đổi lớn trước khi cho cả nhóm dùng. Ưng ý rồi thì chạy `npm run deploy` để lên chính thức.

### 3.4. `npx vercel ls` — xem lịch sử deploy

```powershell
PS D:\bim> npx vercel ls
  Age     Deployment                                    Status      Duration
  5m      https://bim-4zk9x-ngothuytq98-2707s.vercel.app  ● Ready     35s
  2h      https://bim-8ab2c-ngothuytq98-2707s.vercel.app  ● Ready     40s
```

- **Khi nào dùng:** xem bản mới nhất deploy lúc nào, có thành công không (`Ready` = ok, `Error` = hỏng). Muốn **quay lại bản cũ** khi bản mới bị lỗi: vào Vercel Dashboard → Deployments → chọn bản cũ đang `Ready` → nút ⋯ → **Promote to Production** (an toàn nhất), hoặc gõ `npx vercel rollback`.

### 3.5. `npx vercel env …` — quản lý biến môi trường (mật khẩu DB)

```
npx vercel env add MONGODB_URI production
│   │      │   │   │           └─ áp dụng cho môi trường nào: production / preview / development
│   │      │   │   └─ tên biến cần thêm
│   │      │   └─ hành động: add = thêm, ls = xem, rm = xoá
│   │      └─ nhóm lệnh về biến môi trường (environment variables)
│   └─ Vercel CLI
└─ chạy không cần cài toàn máy
```

- **Khi nào dùng:** đổi mật khẩu MongoDB (xoá biến cũ → thêm biến mới → deploy lại), hoặc kiểm tra biến đã set chưa khi API lỗi `MONGODB_URI is not configured`.
- **Ví dụ — xem danh sách:**

```powershell
PS D:\bim> npx vercel env ls
  name                  value               environments                        created
  MONGODB_URI           Encrypted           Production, Preview, Development    3h ago
  MONGODB_DB            Encrypted           Production, Preview, Development    3h ago
  MONGODB_COLLECTION    Encrypted           Production, Preview, Development    3h ago
```

- **Ví dụ — thêm biến** (CLI sẽ hỏi giá trị, dán vào rồi Enter):

```powershell
PS D:\bim> npx vercel env add MONGODB_URI production
? What's the value of MONGODB_URI? [dán chuỗi mongodb+srv://... vào đây]
✅ Added Environment Variable MONGODB_URI to Project bim
```

> ⚠️ Đổi biến xong **phải chạy `npm run deploy`** thì API mới nhận giá trị mới.

### 3.6. `npx vercel logs` — xem lỗi của API trên Vercel

```powershell
PS D:\bim> npx vercel logs https://bim-wheat.vercel.app
```

- **Ý nghĩa:** in ra nhật ký chạy của các serverless function (`/api/data`, `/api/files`) — thấy được thông báo lỗi MongoDB thật sự thay vì đoán mò.
- **Mẹo:** lệnh này chỉ hiện log **đang phát sinh** — cứ để nó chạy, rồi mở trang web thao tác vài cái cho lỗi xuất hiện. Dừng xem: `Ctrl+C`.

### 3.7. Deploy bằng token — khi `vercel login` bị kẹt

1. Vào Vercel Dashboard → avatar → **Account Settings → Tokens** → Create → copy chuỗi token.
2. Deploy kèm token, không cần login:

```powershell
PS D:\bim> npx vercel --prod --token vRa1B2c3D4...
```

- **Ý nghĩa:** `--token` = "đây là chìa khoá chứng minh tôi là chủ tài khoản". Token là **bí mật** như mật khẩu — không gửi cho ai, không dán vào file trong dự án.

---

## 4. Nhóm kiểm tra sau deploy

> **Lưu ý Windows:** trong PowerShell phải gõ **`curl.exe`** (có `.exe`). Gõ `curl` trần sẽ chạy nhầm sang lệnh khác của PowerShell và cho kết quả khó đọc.

### 4.1. Kiểm tra trang chủ sống chưa

```
curl.exe -s -o NUL -w "HTTP %{http_code}" https://bim-wheat.vercel.app/
│        │  │      │                      └─ địa chỉ cần kiểm tra
│        │  │      └─ -w = in ra đúng thứ mình cần: mã trạng thái HTTP
│        │  └─ -o NUL = vứt bỏ nội dung trang (không cần xem HTML)
│        └─ -s = im lặng, không in thanh tiến trình
└─ công cụ gửi yêu cầu web từ terminal
```

```powershell
PS D:\bim> curl.exe -s -o NUL -w "HTTP %{http_code}" https://bim-wheat.vercel.app/
HTTP 200
```

- **Đọc kết quả:** `200` = tốt ✅ · `404` = hỏng rewrite (kiểm tra `vercel.json` có bị thêm `cleanUrls` không) · `500` = code lỗi.

### 4.2. Kiểm tra API + MongoDB

```powershell
PS D:\bim> curl.exe -s https://bim-wheat.vercel.app/api/data
{"ok":true,"mtime":1752212345678,"data":{"rows":[{"id":"...","hangMuc":"Phần ngầm",...}]}}
```

- **Đọc kết quả:** thấy `"ok":true` và dữ liệu hạng mục quen thuộc = **MongoDB đang hoạt động** ✅. Thấy `"ok":false,"error":"..."` → đọc chữ trong `error` rồi tra bảng sự cố trong [HUONG-DAN-DEPLOY.md mục 7](HUONG-DAN-DEPLOY.md#7-xử-lý-sự-cố).
- Kiểm tra bản local cũng hệt vậy, chỉ đổi địa chỉ: `curl.exe -s http://localhost:8787/api/data`

### 4.3. (Nâng cao) Test upload file bằng lệnh

```powershell
PS D:\bim> "noi dung thu" | Out-File test.txt -Encoding utf8
PS D:\bim> curl.exe -s -X POST "http://localhost:8787/api/files?name=test.txt&type=text/plain" --data-binary "@test.txt"
{"ok":true,"file":{"id":"a1b2c3...","name":"test.txt","size":14,"type":"text/plain","url":"api/files?id=a1b2c3..."}}
```

- **Ý nghĩa:** `-X POST` = gửi kiểu POST (tải lên); `--data-binary "@test.txt"` = lấy nội dung file `test.txt` làm thân gói tin (dấu `@` = "đọc từ file"). Trả về `"ok":true` kèm `id` = backend file hoạt động.

---

## 5. Câu prompt mẫu khi nhờ Claude Code làm việc

Nếu không muốn tự gõ lệnh, bạn có thể ra lệnh cho Claude bằng tiếng Việt thường. Prompt tốt cần **3 phần: việc cần làm + phạm vi + thế nào là xong**. Các mẫu dùng ngay:

| Câu prompt (copy nguyên) | Claude sẽ làm gì |
|---|---|
| *"Deploy bản mới nhất lên Vercel, xong kiểm tra trang chủ và /api/data đều trả 200 rồi báo kết quả."* | Chạy `npm run deploy`, tự curl kiểm tra 2 địa chỉ, báo ✅/❌ kèm nguyên nhân |
| *"Trang bim-wheat.vercel.app đang hiện huy hiệu vàng 🟡. Tìm nguyên nhân và sửa, xong xác nhận huy hiệu xanh."* | Curl API đọc thông báo lỗi → đối chiếu bảng sự cố → sửa đúng chỗ → deploy → kiểm tra lại |
| *"Test tính năng upload file trên local trước, chạy ổn thì mới deploy lên production."* | Bật `serve.cjs`, test upload/tải xuống/xoá, đạt thì deploy, không đạt thì sửa và báo |
| *"Tôi vừa đổi mật khẩu MongoDB trên Atlas. Cập nhật cấu hình theo mục 3.4 của HUONG-DAN-DEPLOY.md giúp tôi."* | Hỏi bạn mật khẩu mới → cập nhật `.env` + biến môi trường Vercel → redeploy → kiểm tra API |
| *"Sao lưu toàn bộ dữ liệu từ MongoDB ra file backup-2026-07-11.json trong thư mục backup."* | Gọi API đọc dữ liệu, lưu thành file JSON có ngày tháng trên máy |
| *"Thêm cột 'Ghi chú' vào bảng, lưu chung như các cột khác, đừng deploy vội để tôi xem local trước."* | Sửa HTML đủ các lớp (render, lưu, CSV…), chạy local cho bạn duyệt, chờ lệnh mới deploy |

**Mẹo viết prompt hiệu quả:**
- Nêu **điều kiện hoàn thành** ("xong kiểm tra X trả 200") — Claude sẽ tự kiểm chứng thay vì chỉ làm rồi đoán là xong.
- Nói rõ **giới hạn** khi cần ("đừng deploy vội", "chỉ sửa file X") — tránh làm quá tay.
- Việc dài nhiều bước cứ gộp trong 1 câu — Claude tự chia bước, không cần ra lệnh từng dòng.

---

## 6. Ghi chú chung

- Mọi lệnh trong tài liệu này chạy tại thư mục `D:\bim` (terminal của VS Code mở sẵn đúng chỗ).
- **PowerShell vs cmd:** ví dụ ở đây viết cho PowerShell (terminal mặc định của VS Code). Khác biệt duy nhất hay gặp: đặt biến môi trường — PowerShell dùng `$env:TEN=giá_trị;` còn cmd dùng `set TEN=giá_trị &&`.
- Dừng lệnh đang chạy (máy chủ, xem log): bấm **Ctrl+C** trong terminal.
- Lệnh `npx …` lần đầu chạy có thể hỏi `Ok to proceed? (y)` — gõ `y` rồi Enter (nó xin phép tải công cụ về).
