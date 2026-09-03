---
phase: 1
title: "Hạ tầng Cloudflare R2"
status: in-progress
priority: P1
dependencies: []
---

# Giai đoạn 1: Hạ tầng Cloudflare R2

## Tổng quan

Dựng **hai** bucket (production và preview), khóa API, CORS và biến môi trường tách theo
môi trường. Verify bằng `curl` **trước khi** viết một dòng code nào.

> **Phần lớn giai đoạn này là việc của người dùng.** Mở tài khoản Cloudflare cần thẻ tín dụng.

## Yêu cầu

**Chức năng:**
- Bucket riêng cho production và preview, cả hai private
- Khóa API chỉ có quyền đọc/ghi đúng hai bucket đó
- CORS cho phép `PUT`/`GET`/`HEAD` từ domain production và domain preview

**Phi chức năng:**
- Khóa không nằm trong bất kỳ file nào của repo (`scratch/` đã được `.gitignore` chặn)
- Verify được bằng `curl` **bao gồm tên file tiếng Việt** trước khi code

## Các bước

### 1.1 Tạo hai bucket

1. Cloudflare Dashboard → **R2 Object Storage** → bật R2 (cần thẻ tín dụng)
2. **Create bucket** → `bim-files` → Location: **Automatic** (hoặc APAC nếu có)
3. **Create bucket** → `bim-files-preview`
4. Cả hai giữ **private** — không bật Public Development URL

> Bucket preview riêng là bắt buộc, không phải cho sang. Không có nó thì 13 mục kiểm thử
> ở giai đoạn 4 sẽ ghi thẳng vào kho production khi người khác đang dùng.

### 1.2 Tạo khóa API

1. R2 → **Manage R2 API Tokens** → **Create API Token**
2. Permission: **Object Read & Write**
3. Specify buckets: chọn **cả hai** bucket (không cấp toàn tài khoản)
4. Lưu lại: `Access Key ID`, `Secret Access Key`, `Account ID`

> Secret chỉ hiện **một lần**. Mất là phải tạo khóa mới.
>
> Bật **billing alert** trên Cloudflare ngay lúc này. URL presigned PUT không ràng buộc
> kích thước body (chữ ký `signQuery` chỉ ký `host`), nên tham số `size` ở `sign-upload`
> chỉ có tính khai báo — ai giữ `EDIT_KEY` đều có thể xin URL rồi đẩy lên bao nhiêu tùy ý.
> `EDIT_KEY` là mật khẩu dùng chung nên đây là rủi ro có thật, và cảnh báo chi phí là
> hàng rào rẻ nhất.

### 1.3 Cấu hình CORS — cho **cả hai** bucket

`bim-files`:

```json
[
  {
    "AllowedOrigins": ["https://bim-ruddy.vercel.app"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`bim-files-preview`: giống trên, `AllowedOrigins` là domain preview.

> **`npm run deploy:preview` sinh hostname MỚI mỗi lần deploy**, và R2 khớp origin chính
> xác từng ký tự. Nghĩa là **mỗi lần** deploy preview đều phải thêm origin mới vào CORS
> của bucket preview, nếu không sẽ gặp lỗi CORS trông y hệt lỗi chữ ký. Đây là việc bắt
> buộc lặp lại, không phải ghi chú một lần.
>
> Bản 1 liệt kê `http://localhost:3000` — **sai**: máy chủ local chạy cổng **8787**
> (`serve.cjs:17`), mà bản LAN thì sẽ bị xoá ở giai đoạn 4. Không thêm origin localhost nào.

### 1.4 Biến môi trường — tách theo môi trường

**Production** (Vercel → Settings → Environment Variables → Production):

| Biến | Giá trị |
|---|---|
| `R2_ACCOUNT_ID` | Account ID |
| `R2_ACCESS_KEY_ID` | Access Key ID |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key |
| `R2_BUCKET` | `bim-files` |

**Preview + Development** — cùng 3 khóa trên, nhưng:

| Biến | Giá trị |
|---|---|
| `R2_BUCKET` | `bim-files-preview` |
| `MONGODB_DB` | `bim_preview` |

> `MONGODB_DB` riêng cho preview là thứ ngăn 13 mục kiểm thử ghi đè dữ liệu thật. Mất
> ~10 phút, và nó đồng thời loại bỏ luôn nguy cơ lệch database mà script dọn có thể hiểu
> nhầm thành "toàn bộ bucket là rác".

**Cảnh báo đã biết của repo này:** `deploy-bim/SKILL.md` ghi rõ `vercel env add` hay tạo
biến với **giá trị rỗng**, và **phải redeploy sau khi đổi biến**. Kiểm lại giá trị thật
trên Dashboard sau khi đặt.

**Local** — sửa `package.json` trước, vì lệnh hiện tại kéo nhầm môi trường:

```diff
- "vercel:env": "vercel env pull .env"
+ "vercel:env": "vercel env pull .env --environment production"
```

`vercel env pull` không có `--environment` thì CLI mặc định lấy **development**. Giai đoạn 4
có một script xoá được hàng loạt object R2; nó đọc `.env`. Kéo nhầm môi trường ở đây là một
mắt xích trong chuỗi dẫn tới xoá nhầm kho.

Cập nhật `.env.example` thêm 4 dòng R2 mẫu (giá trị rỗng, **không** ghi giá trị thật).

### 1.5 Verify bằng curl — BẮT BUỘC, không được bỏ mục nào

Viết `scratch/test-r2.mjs` (thư mục `scratch/` đã bị `.gitignore` và `.vercelignore` chặn).
Script phải đọc khóa từ `process.env`, **không hardcode**.

| # | Test | Kỳ vọng |
|---|---|---|
| 1 | Ký PUT cho key `test/hello.txt`, `curl -X PUT --upload-file` | HTTP **200** |
| 2 | Ký PUT kèm header `Content-Disposition` chứa **tên tiếng Việt có dấu và có dấu cách** — ví dụ `Bản vẽ kiến trúc (P1).dwg`, mã hoá RFC 5987 | HTTP **200** |
| 3 | Ký **GET** (không có tham số `response-*` nào), `curl -i` | **200**, và header `Content-Disposition` trả về **đúng tên tiếng Việt** đã gắn ở test 2 |
| 4 | Ký **HEAD** — `signR2(key, "HEAD", 300)`, `curl -I` | **200** kèm `Content-Length` đúng |
| 5 | DevTools trên `https://bim-ruddy.vercel.app`, chạy `fetch(uploadUrl, {method:'PUT', body:'x'})` | **Không** lỗi CORS |

**Test 2 và 3 là hai mục quan trọng nhất của cả giai đoạn.** Chúng chứng minh cách gắn tên
file thật sự chạy. Bản 1 định gắn tên qua query `response-content-disposition` trên
presigned GET — cách đó **hỏng**: `aws4fetch` ký canonical query bằng
`encodeRfc3986(encodeURIComponent(v))` (space → `%20`, `*` → `%2A`) trong khi URL gửi đi
lấy từ `URL.toString()` (space → `+`, `*` → `*`), mà `Content-Disposition` chứa cả hai ký
tự đó → R2 trả **403 cho mọi file**. Nếu chỉ test bằng `hello.txt` không dấu thì lỗi này
lọt qua toàn bộ giai đoạn 1–3 và chỉ lộ ra khi người dùng thật bấm tải file.

**Test 4** chứng minh `HEAD` phải được ký riêng: method là **dòng đầu tiên** của canonical
request trong SigV4 (`aws4fetch.cjs.js:201-209`), nên URL ký cho `GET` dùng làm `HEAD` sẽ
sai chữ ký. Giai đoạn 2 dựa vào HEAD để xác minh file — hỏng chỗ này thì **mọi `confirm`
đều fail** và báo nhầm là "chưa thấy file".

Xoá `test/hello.txt` khỏi bucket sau khi xong.

### 1.6 Cài dependency — ghim đúng phiên bản

```powershell
$env:PATH = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:PATH"
npm install --save-exact --ignore-scripts aws4fetch@1.0.20
```

Ghim tuyệt đối (không dùng `^`) vì giai đoạn 2 dựa vào hành vi cụ thể của `1.0.20`:
export `require` cho CommonJS, `signQuery` chỉ ký `host`, `X-Amz-Expires` đặt sẵn được tôn
trọng. `--ignore-scripts` vì gói này chạy trong cùng process với `MONGODB_URI`, `EDIT_KEY`,
`ADMIN_KEY` và `R2_SECRET_ACCESS_KEY`. Commit `package-lock.json`.

Chọn `aws4fetch` (~6KB) thay vì `@aws-sdk/client-s3` (~10MB) để không làm chậm cold start.

## File liên quan

- Sửa: `.env.example` — thêm 4 biến R2 mẫu
- Sửa: `package.json` — thêm `aws4fetch` ghim chính xác; `vercel:env` thêm `--environment production`
- Sửa: `package-lock.json`
- Tạm (đã bị chặn khỏi git và Vercel): `scratch/test-r2.mjs`

## Tiêu chí hoàn thành

- [ ] Hai bucket `bim-files` và `bim-files-preview` tồn tại, đều private
- [ ] Khóa API giới hạn đúng hai bucket đó, đã lưu an toàn
- [ ] Billing alert đã bật trên Cloudflare
- [ ] CORS đã áp cho cả hai bucket, không có origin localhost nào
- [ ] **Test 1 đạt** — PUT trả 200
- [ ] **Test 2 đạt** — PUT kèm `Content-Disposition` tiếng Việt trả 200
- [ ] **Test 3 đạt** — GET trả đúng tên tiếng Việt trong header, không dùng tham số `response-*`
- [ ] **Test 4 đạt** — HEAD ký riêng trả 200 kèm `Content-Length`
- [ ] **Test 5 đạt** — `fetch` PUT từ DevTools production không lỗi CORS
- [ ] Biến production đặt đủ 4, giá trị **không rỗng** (kiểm trên Dashboard)
- [ ] Biến preview/development có `R2_BUCKET=bim-files-preview` và `MONGODB_DB=bim_preview`
- [ ] `package.json` có `"aws4fetch": "1.0.20"` (không có `^`) và `vercel:env` có `--environment production`
- [ ] `git status` không thấy `scratch/` và không thấy `.env`
- [ ] Đã xoá `test/hello.txt` khỏi bucket

## Rủi ro

| Rủi ro | Cách xử lý |
|---|---|
| Không có thẻ tín dụng để bật R2 | Chặn cứng cả dự án. Giải quyết trước, hoặc quay lại cân nhắc Vercel Blob |
| Chỉ test bằng tên file ASCII → lỗi chữ ký lọt tới tay người dùng | Test 2 và 3 bắt buộc dùng tên tiếng Việt có dấu **và có dấu cách** |
| Quên thêm origin preview sau mỗi lần deploy preview | Lỗi CORS trông giống hệt lỗi chữ ký. Ghi vào checklist giai đoạn 4 như việc lặp lại |
| `vercel env add` tạo biến rỗng (bẫy đã biết của repo) | Kiểm giá trị trên Dashboard, redeploy sau khi đổi |
| Dán khóa vào `scratch/test-r2.mjs` rồi commit | `scratch/` đã có trong `.gitignore`. Script đọc `process.env`, không hardcode |
| Secret hiện một lần, ghi nhầm | Tạo khóa mới, không cố khôi phục |
