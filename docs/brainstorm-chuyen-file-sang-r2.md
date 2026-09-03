# Brainstorm — Chuyển file đính kèm từ MongoDB sang Cloudflare R2

- **Ngày:** 2026-09-03
- **Dự án:** Bảng theo dõi hạng mục (BIM) — `bim-ruddy.vercel.app`
- **Trạng thái:** Đã chốt thiết kế, chờ lập kế hoạch triển khai

---

## 1. Bối cảnh — hệ thống đang chạy thế nào

Quét codebase cho thấy **hai đường lưu trữ tách biệt**:

| | Bản web (Vercel) | Bản LAN (`serve.cjs`) |
|---|---|---|
| Dữ liệu bảng | MongoDB `bim_app`, 1 document/kế hoạch | `data.json` trên đĩa |
| File đính kèm | **MongoDB `bim_files`, dạng `Binary`** | Thư mục `data-files/` trên đĩa |
| Giới hạn 1 file | 50MB (cắt mảnh 4.4MB) | 50MB |

Hiểu lầm ban đầu cần đính chính: **bản web không lưu file ở local server**. Vercel
serverless không có đĩa ghi được — file nằm trong MongoDB. Local disk chỉ dùng ở chế độ LAN.

**Bản LAN đã ngừng sử dụng** → ra khỏi phạm vi thay đổi.

---

## 2. Vấn đề gốc (problem-first)

Yêu cầu đến dưới dạng giải pháp đã chọn: *"muốn đổi chỗ lưu file"*. Lật ngược lại,
vấn đề thật là: **kiến trúc hiện tại không kham nổi file Revit/IFC/CAD** — không phải
chậm, mà là không chạy được.

| Chỗ nghẽn | Bằng chứng | Hệ quả với file BIM |
|---|---|---|
| Chặn cứng 50MB | `bang-hang-muc.html:1297` | File Revit 100MB–1GB bị từ chối ngay |
| Upload xuyên Vercel function | `api/files.js:26` — body limit 4.4MB | File 300MB = 69 mảnh, **tải tuần tự**, mỗi mảnh 1 lần gọi function + 1 lần ghi MongoDB |
| Download gom hết vào RAM | `downloadChunked` nối toàn bộ mảnh thành Blob | File 500MB làm treo tab trình duyệt |
| MongoDB Atlas M0 | Trần 512MB | **Một** file Revit là hết sạch |
| Không có CDN | Mỗi lượt xem tính vào băng thông + thời gian chạy function | Chi phí và độ trễ tăng theo lượt tải |

**Kết luận then chốt:** đổi kho lưu trữ mà vẫn cho dữ liệu chạy xuyên qua Vercel
function thì không sửa được gì. Thay đổi kiến trúc thật là **client tải thẳng lên/xuống
kho bằng presigned URL**; chọn nhà cung cấp nào chỉ là chi tiết đứng sau quyết định đó.

---

## 3. Ràng buộc đã xác nhận

| Hạng mục | Giá trị |
|---|---|
| Loại file | Bản vẽ CAD, mô hình Revit/IFC |
| CDE hiện có | **Không có** — file đang nằm rải rác → app này thành nơi lưu chính |
| Quy mô | 10–100GB, 10–30 người dùng |
| Bản LAN | Không còn dùng → không đụng `serve.cjs` |
| Quyền tải xuống | Giữ tự do như hiện tại (không cần mật khẩu) |
| File cũ | Đường lai — không migrate |
| Giới hạn mới | **200MB/file** |

---

## 4. Các phương án đã cân nhắc

### A · Cloudflare R2 + presigned URL — **ĐÃ CHỌN**

- ✅ Egress **$0** ở mọi mức — quyết định tất cả với BIM, vì cùng một file bị cả nhóm tải đi tải lại
- ✅ Free 10GB, sau đó $0.015/GB/tháng
- ✅ S3-compatible → presigned PUT/GET; multipart sẵn sàng nếu sau này cần
- ❌ Phải mở tài khoản Cloudflare (cần thẻ tín dụng kể cả dùng free)
- ❌ Phải tự cấu hình CORS bucket

### B · Vercel Blob

- ✅ Dễ nhất: `@vercel/blob` có sẵn client upload, cùng tài khoản Vercel, không cần cấu hình CORS
- ❌ Hobby chỉ **1GB** storage, hạn mức dùng chung với chính trang web → một file Revit là vỡ
- ❌ Buộc lên Pro $20/tháng; egress $0.05/GB **không** nằm trong 1TB bandwidth của Pro

### C · Không chứa file gốc — chỉ trỏ link tới CDE

- ✅ Chi phí 0đ, không migration, không dependency mới
- ✅ Đúng cách làm của ngành: file gốc ở CDE, bảng theo dõi chỉ trỏ tới
- ❌ **Loại bỏ vì công ty chưa có CDE nào** — không có gì để trỏ tới

### So sánh chi phí ở quy mô 100GB / 200GB tải xuống mỗi tháng

| | Cloudflare R2 | Vercel Blob |
|---|---|---|
| Lưu trữ 100GB | (100−10 free) × $0.015 = **$1.35** | 100 × $0.023 = $2.30 |
| Tải xuống 200GB | **$0** | 200 × $0.05 = $10.00 |
| Phí nền tảng | $0 | Pro **$20** |
| **Tổng/tháng** | **~$1.35 (≈35.000đ)** | **~$32 (≈840.000đ)** |

Chênh **24 lần**, khoảng cách giãn ra theo lượt tải. Dưới 10GB thì R2 hoàn toàn miễn phí.

---

## 5. Thiết kế chốt

### Nguyên tắc

**Dữ liệu file không bao giờ đi qua Vercel function nữa.** Function chỉ ký URL và ghi metadata.

```
TẢI LÊN
  Client ──① xin URL──▶ /api/files?action=sign-upload   (kiểm EDIT_KEY)
         ◀─② presigned PUT URL (hết hạn 15 phút)
         ──③ PUT thẳng file ──────────────────────────▶ Cloudflare R2
         ──④ báo xong ──▶ /api/files?action=confirm  → ghi metadata vào MongoDB

TẢI XUỐNG
  Client ──① GET /api/files?id=xxx
         ◀─② 302 redirect tới presigned GET (hết hạn 5 phút)
         ──③ trình duyệt tải thẳng ───────────────────▶ Cloudflare R2
```

### Vai trò từng thành phần

| Thành phần | Sau khi đổi |
|---|---|
| Cloudflare R2 | Chứa toàn bộ file mới. Bucket riêng, không public. |
| MongoDB `bim_files` | Chỉ còn metadata `{_id, name, type, size, key, createdAt}`. File cũ giữ nguyên `data`/`chunks`. |
| MongoDB `bim_app` | Không đổi |
| `api/files.js` | Ký presigned URL + ghi metadata. Không cầm dữ liệu file. |
| `serve.cjs` | Ngoài phạm vi — không còn dùng |

### API sau khi đổi

```
POST ?action=sign-upload&name=&type=&size=
  → kiểm EDIT_KEY, kiểm size ≤ 200MB
  → sinh key: bim/<yyyy-mm>/<random>/<tên file>
  → trả { uploadUrl, id, key }        presigned PUT, hết hạn 15 phút

POST ?action=confirm&id=&key=&name=&type=&size=
  → kiểm EDIT_KEY, ghi metadata vào MongoDB
  → trả { ok, file: { id, name, size, type, url } }

GET ?id=<id>          (tự do, không cần mật khẩu)
  → doc có `key`      → 302 redirect tới presigned GET
  → doc có `data`     → đọc MongoDB, trả như cũ          ⟵ file cũ
  → doc có `chunks`   → nhánh ?part= như cũ              ⟵ file cũ

DELETE ?id=<id>       (cần ADMIN_KEY)
  → xóa object trên R2 nếu có `key`, xóa doc MongoDB
```

> **Đính chính sau red team (2026-09-03):** đoạn này ban đầu ghi *"presigned GET đính kèm
> `response-content-disposition` để giữ tên file tiếng Việt có dấu"*. **Cách đó không chạy được.**
> `aws4fetch` ký canonical query bằng `encodeRfc3986(encodeURIComponent(v))` (space → `%20`,
> `*` → `%2A`) còn URL gửi đi lấy từ `URL.toString()` (space → `+`, `*` → `*`); chuỗi
> `Content-Disposition` chứa **cả hai** ký tự đó nên chữ ký lệch → **R2 trả 403 với mọi file mới**.
>
> Cách đúng: client gửi `Content-Disposition` và `Content-Type` làm **header thật lúc PUT**.
> `signQuery` chỉ ký `host` nên header thừa không gây mismatch, mà R2 vẫn lưu chúng làm
> metadata của object. Presigned GET không cần tham số `response-*` nào.
>
> Xem [plan bản 2](../plans/260903-1205-chuyen-file-sang-r2/plan.md) để có thiết kế đầy đủ.

### Thư viện ký URL: `aws4fetch`, không dùng AWS SDK

Dự án theo phong cách tối giản. `@aws-sdk/client-s3` thêm ~10MB, làm chậm cold start.
`aws4fetch` chỉ ~6KB, ký SigV4 đủ dùng cho R2:

```js
new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" })
  .sign(url, { method: "PUT", aws: { signQuery: true } })
```

### Biến môi trường mới trên Vercel

`R2_ACCOUNT_ID` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_BUCKET`

### Thay đổi ở giao diện (`bang-hang-muc.html`)

- **Bỏ** `uploadChunked`, `dropChunks` (~90 dòng) → thay bằng: xin URL → `XMLHttpRequest.PUT` với `upload.onprogress` (**thanh % thật**) → gọi confirm
- **Giữ** `downloadChunked` — file cũ chia mảnh vẫn phải tải được (hệ quả của lựa chọn "đường lai")
- **Giữ** `maybeCompress` — nén ảnh trước khi tải vẫn đáng giá
- File mới tải xuống chỉ cần `window.location = url`
- `MAX_UPLOAD`: 50MB → **200MB** (`bang-hang-muc.html:1297`)

---

## 6. Rủi ro và cách chặn

| Rủi ro | Mức | Cách xử lý |
|---|---|---|
| Quên cấu hình CORS bucket → lỗi báo mơ hồ, tốn nhiều giờ mò | Cao | Làm CORS **trước tiên**, test bằng 1 file nhỏ trước khi viết giao diện |
| File mồ côi: PUT xong nhưng `confirm` hỏng | Trung bình | Script dọn thủ công đối chiếu object R2 với `key` trong MongoDB, xóa object mồ côi cũ hơn 7 ngày. **Không dùng lifecycle rule** — nó chỉ biết tuổi và prefix, không biết MongoDB có metadata hay không nên sẽ xóa cả file hợp lệ |
| Rò khóa R2 ra client | Cao nếu xảy ra | Khóa chỉ ở env Vercel; client chỉ thấy presigned URL hết hạn 15 phút |
| Tải đứt giữa chừng phải làm lại từ đầu | Thấp ở mức 200MB | Chấp nhận. Nếu sau này thành vấn đề → chuyển sang multipart upload |
| Site cũ `bim-wheat.vercel.app` chạy code cũ | Thấp | Chỉ đọc được file cũ, không thấy file mới. Không có quyền deploy site đó — chấp nhận |
| `CLAUDE.md` ghi "3 bản logic phân quyền giống nhau" thành lỗi thời | Thấp | Cập nhật `CLAUDE.md`: đánh dấu `serve.cjs` là code lỗi thời |

---

## 7. Tiêu chí nghiệm thu

1. Tải lên được file **200MB** qua giao diện web, có thanh tiến độ hiện % thật
2. Tải file đó xuống, tên file tiếng Việt có dấu giữ nguyên
3. File **cũ** đang nằm trong MongoDB (cả loại nguyên khối lẫn loại chia mảnh) vẫn tải xuống bình thường
4. Xóa file bằng quyền admin → object biến mất khỏi R2 **và** metadata biến mất khỏi MongoDB
5. Không có mật khẩu → không tải lên được; có `EDIT_KEY` → tải lên được; xóa cần `ADMIN_KEY`
6. Không còn document nào chứa `Binary` được tạo mới trong `bim_files`
7. Khóa R2 không xuất hiện ở bất kỳ đâu trong response gửi về client

---

## 8. Ngoài phạm vi lần này

- Migrate file cũ từ MongoDB sang R2 (đã chọn đường lai)
- `serve.cjs` / chế độ LAN
- Multipart / resume upload
- Bắt buộc mật khẩu khi tải xuống (đã chọn giữ tự do)
- Xem trước (preview) mô hình BIM trong trình duyệt
- Quản lý phiên bản file

---

## 9. Ước lượng công sức và chi phí

| Việc | Thời gian |
|---|---|
| Setup R2: bucket, CORS, API token, verify bằng curl | 30 phút |
| Viết lại `api/files.js` | 2–3 giờ |
| Sửa giao diện upload/download | 2–3 giờ |
| Test với file Revit thật | 1 giờ |
| **Tổng** | **~1 ngày công** |

> **Đính chính sau red team:** ước lượng này **thấp hơn thực tế**. Kế hoạch chi tiết bổ sung
> một giai đoạn 0 (deploy phòng vệ, chốt an toàn rollback), tách bucket + database riêng cho
> preview, làm `confirm` idempotent, thu hẹp phạm vi `filesBusy`, xoá bản LAN, và viết script
> dọn có đủ chốt an toàn. Ước lượng thực tế: **~2 ngày công**.

**Chi phí vận hành:** 0đ dưới 10GB · ~35.000đ/tháng ở 100GB · egress luôn 0đ.

---

## 10. Bước tiếp theo

1. Mở tài khoản Cloudflare, tạo bucket R2, lấy API token (**việc của người dùng — cần thẻ tín dụng**)
2. Cấu hình CORS bucket cho `https://bim-ruddy.vercel.app`
3. Đặt 4 biến môi trường trên Vercel
4. Lập kế hoạch triển khai chi tiết (`/ck:plan`)
5. Cập nhật `CLAUDE.md`: đánh dấu `serve.cjs` lỗi thời, ghi kiến trúc lưu file mới

---

## Nguồn tham khảo

- [Cloudflare R2 Pricing — developers.cloudflare.com](https://developers.cloudflare.com/r2/pricing)
- [Vercel Blob Pricing — vercel.com/docs](https://vercel.com/docs/vercel-blob/usage-and-pricing)
- [Cloudflare R2 free tier 2026 — Nubbo](https://nubbo.app/blog/cloudflare-r2-free-tier/)
- [Vercel Pricing 2026 breakdown — Flexprice](https://flexprice.io/blog/vercel-pricing-breakdown)
