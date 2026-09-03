---
title: "Chuyển file đính kèm từ MongoDB sang Cloudflare R2"
status: in-progress
created: 2026-09-03
revised: 2026-09-03
source: docs/brainstorm-chuyen-file-sang-r2.md
blockedBy: []
blocks: []
---

# Chuyển file đính kèm từ MongoDB sang Cloudflare R2

> **Bản 2** — viết lại sau red team. 15 finding được áp. Xem [§ Red Team Review](#red-team-review)
> ở cuối file. Bản 1 sai ở chỗ nghiêm trọng: cách gắn tên file qua presigned GET
> **không chạy được**, và giả định "tải xuống không cần sửa client" thiếu một dòng then chốt.

## Mục tiêu

Đưa file đính kèm (bản vẽ CAD, mô hình Revit/IFC) ra khỏi MongoDB, chuyển sang
Cloudflare R2 với **presigned URL** — client tải thẳng lên/xuống R2, Vercel function
chỉ ký URL và ghi metadata.

Nâng giới hạn 1 file từ **50MB lên 200MB**. Thoát trần 512MB của MongoDB Atlas M0.

Thiết kế gốc tại [docs/brainstorm-chuyen-file-sang-r2.md](../../docs/brainstorm-chuyen-file-sang-r2.md).

## Phạm vi

**Trong phạm vi:**
- `api/files.js` — viết lại theo mô hình ký URL
- `api/data.js` — thêm điều kiện `ifMtime` chống ghi đè *(validate đưa vào)*
- `bang-hang-muc.html` — sửa luồng **tải lên**; nâng `MAX_UPLOAD`; sửa phạm vi `filesBusy`; dải cảnh báo xung đột
- Hạ tầng R2 + biến môi trường Vercel (tách riêng preview và production)
- Ngừng bản LAN: **giữ file**, chỉ gỡ script npm và thêm chú thích *(validate quyết định)*
- Cập nhật `CLAUDE.md`, `README.md`

**Ngoài phạm vi:**
- Migrate file cũ (đường lai — file cũ vẫn đọc từ MongoDB). **Nhưng giai đoạn 0 phải đo
  dung lượng chúng đang chiếm**; > 350MB thì dừng lại xem xét lại quyết định này
- Multipart / resume upload
- Bắt buộc mật khẩu khi tải xuống (giữ tự do)
- Sửa `global.__mongoClient` không kiểm tra sức khoẻ (lỗi sẵn có, xem finding bị bác)
- `doDeleteRows()` không xoá file đính kèm của dòng bị xoá (rò rỉ sẵn có)

## Kiến trúc

```
TẢI LÊN
  Client ──① POST /api/files?action=sign-upload   (EDIT_KEY, size ≤ 200MB)
         │                                         → ghi doc {status:"pending", key}
         ◀─② { uploadUrl, id, key }                presigned PUT, hết hạn 15 phút
         ──③ XHR PUT + header Content-Disposition & Content-Type ──▶ R2
         ──④ POST /api/files?action=confirm        → updateOne pending → ready

TẢI XUỐNG
  <a href="api/files?id=xxx" download="...">
         ──① GET /api/files?id=xxx
         ◀─② 302 + Cache-Control: private, no-store
         ──③ trình duyệt tải thẳng ───────────────────────────────▶ R2
              tên file & MIME lấy từ metadata ĐÃ LƯU TRÊN OBJECT
```

### Quyết định then chốt: gắn `Content-Disposition` lúc PUT, không qua presigned GET

Bản 1 định gắn tên file bằng query `response-content-disposition` trên presigned GET.
**Cách đó hỏng.** `aws4fetch` dựng canonical query bằng `encodeRfc3986(encodeURIComponent(v))`
(space → `%20`, `*` → `%2A`) còn URL gửi đi lấy từ `URL.toString()` (space → `+`, `*` → `*`).
Chuỗi `Content-Disposition` chứa cả space lẫn `*` → R2 tính ra chữ ký khác → **403 với mọi
file mới**, trong khi mọi ô checklist khác vẫn xanh.

Thay bằng: **client gửi `Content-Disposition` + `Content-Type` làm header thật khi PUT.**
Với `signQuery: true`, aws4fetch chỉ ký `host` — header thừa không tham gia chữ ký nên
không thể gây mismatch, nhưng R2 **vẫn lưu chúng làm metadata của object**. Presigned GET
sau đó không cần tham số `response-*` nào.

Giá trị header phải mã hoá RFC 5987 (`asciiName` + `filename*=UTF-8''…` — đúng cách
`api/files.js:141,144-145` đang làm) để chỉ còn ASCII, vì header HTTP không nhận UTF-8 thô.

### Vì sao tải xuống vẫn không cần sửa client — và chỗ bản 1 nói sai

`bang-hang-muc.html:1384-1389` dựng thẻ `<a>`:

```js
a.href = f.url || f.dataUrl || "#";
a.setAttribute("download", f.name || "file");          // ← BẢN 1 BỎ SÓT DÒNG NÀY
if (f.chunks) { a.setAttribute("data-chunks", …); }    // chỉ file mảnh mới cần JS
```

Thuộc tính `download` **bị trình duyệt bỏ qua khi tài nguyên cuối khác origin** — sau 302
sang R2 nó vô hiệu. Bản 1 trích dòng 1386 rồi nhảy sang 1389, bỏ đúng dòng có ý nghĩa thay đổi.

Kết luận vẫn đúng nhưng **vì lý do khác**: giữ nguyên thuộc tính `download` (file **cũ**
vẫn cùng origin và vẫn cần nó), còn file mới thì tên đến từ `Content-Disposition: attachment`
đã lưu sẵn trên object R2. Trình duyệt vẫn tải xuống đúng tên. **Không sửa dòng nào ở phía
tải xuống** — nhưng nếu ai bỏ header lúc PUT thì file sẽ lưu thành `a1b2c3d4e5f6.dwg`.

## Các giai đoạn

| # | Giai đoạn | Trạng thái | Ưu tiên | Phụ thuộc |
|---|---|---|---|---|
| 0 | [Deploy phòng vệ (chốt an toàn rollback)](phase-00-deploy-phong-ve.md) | mã xong · chờ deploy + đo MongoDB | P1 | — |
| 1 | [Hạ tầng Cloudflare R2](phase-01-ha-tang-r2.md) | mã xong · chờ đặt biến Vercel + verify curl | P1 | — |
| 2 | [Viết lại api/files.js](phase-02-api-files.md) | mã xong · chờ kiểm thử thật | P1 | 0, 1 |
| 3 | [Sửa luồng tải lên ở giao diện](phase-03-giao-dien-tai-len.md) | mã xong · chờ kiểm thử thật | P1 | 2 |
| 4 | [Chống ghi đè ở api/data.js](phase-04-chong-ghi-de.md) | mã xong · chờ kiểm thử thật | P1 | 3 |
| 5 | [Kiểm thử, deploy, dọn dẹp](phase-05-kiem-thu-deploy.md) | mã xong · **toàn bộ kiểm thử còn lại** | P1 | 4 |

**Giai đoạn 0 phải deploy riêng, trước mọi thứ khác.** Nó là thứ duy nhất làm cho
rollback an toàn — xem § Rollback.

**Giai đoạn 1 có phần việc của người dùng** — mở tài khoản Cloudflare cần thẻ tín dụng.

## Hình dạng document trong `bim_files`

```js
// MỚI — sau sign-upload, trước confirm
{ _id, name, type, key, status: "pending", createdAt }

// MỚI — sau confirm
{ _id, name, type, key, status: "ready", size, createdAt, confirmedAt }

// CŨ nguyên khối (chỉ đọc, giữ nguyên)
{ _id, name, type, size, data: Binary, createdAt }

// CŨ chia mảnh (chỉ đọc, giữ nguyên)
{ _id, name, type, size, chunks: ["c…"], createdAt }
```

Doc `pending` được ghi ngay ở `sign-upload` để ràng `id ↔ key ↔ người ký` một cách nguyên
tử. Nhờ đó: `confirm` không thể ghi metadata trỏ vào key người khác, `confirm` gọi lại lần
hai không vỡ, và script dọn có **danh sách pending có thẩm quyền** thay vì đoán theo tuổi.

## Rollback

Bản 1 **không có mục này** — đó là thiếu sót nghiêm trọng.

**Vấn đề:** `docBuffer()` tại `api/files.js:76-78` làm `Buffer.from(doc.data || "")`. Doc
kiểu R2 không có `data` → buffer rỗng, **không ném lỗi** → handler trả `200` kèm đúng tên
file, `Content-Length: 0`, và `Cache-Control: max-age=31536000, immutable`
(`api/files.js:146`). Người dùng nhận file `.rvt` 0 byte; Revit báo hỏng; không log gì.
Header `immutable` ghim kết quả rỗng đó **một năm**, sống lâu hơn cả lần rollback.

**Chốt an toàn:** giai đoạn 0 deploy riêng một bản vá vào code **hiện tại**: doc không có
`data`, không có `chunks` → trả **410** kèm thông báo rõ ràng, thay vì rơi xuống `docBuffer`.
Với dữ liệu hôm nay đây là no-op tuyệt đối. Sau đó `vercel rollback` mới an toàn.

**Quy trình rollback:**
1. `vercel rollback` về bản ngay trước giai đoạn 2
2. File R2 trả 410 (nhờ giai đoạn 0) — lỗi ồn ào, không phải file 0 byte
3. File cũ trong MongoDB hoạt động bình thường
4. Object R2 và doc metadata **không bị xoá** — sửa xuôi rồi deploy lại là dùng được ngay
5. **Không chạy script dọn file mồ côi trong lúc đang rollback** — mọi doc R2 lúc đó vẫn hợp lệ

## Rủi ro toàn cục

| Rủi ro | Mức | Cách chặn |
|---|---|---|
| Chữ ký sai vì `response-*` trong query | **Cao** | Không dùng `response-*`. Gắn metadata lúc PUT. Giai đoạn 1 phải test bằng tên file tiếng Việt thật |
| Ghi đè mất dữ liệu do `filesBusy` đóng băng đồng bộ | **Cao** | Giai đoạn 3 thu cửa sổ từ hàng chục phút xuống vài trăm ms (không giữ `filesBusy` lúc PUT, tra lại `findRow()`); **giai đoạn 4 đóng hẳn** bằng điều kiện `ifMtime` + dải cảnh báo xung đột |
| Script dọn xoá nhầm cả kho | **Cao** | Đọc env như API, in ra db/collection/bucket đã phân giải, bắt gõ tên bucket, chặn khi key set rỗng hoặc orphan > 20% |
| Thiếu biến R2 làm sập cả `/api/files` | **Cao** | `getR2()` khởi tạo lười, đúng nếp `connectMongo()`. Đường đọc file cũ không bao giờ chạm tới nó |
| `site cũ bim-wheat.vercel.app` — người dùng **đã chấp nhận rủi ro này** | **Cao** *(bản 1 ghi "Thấp" — sai)* | Code cũ trả file R2 thành 200/0 byte, và `DELETE` ở đó **không cần mật khẩu** (`api/files.js:223-232`). Sau khi chuyển R2, xoá doc = mất dấu `key` = mất file. Cách chặn triệt để duy nhất là đổi mật khẩu Atlas — chủ dự án đã quyết định chấp nhận |
| Preview ghi đè dữ liệu production | Cao | Preview dùng `MONGODB_DB=bim_preview` và `R2_BUCKET=bim-files-preview` riêng |
| HTML cũ trong cache gọi endpoint đã gỡ | Trung bình | Endpoint đã gỡ trả 426 kèm câu tiếng Việt bảo tải lại trang |
| File mồ côi | Thấp | Doc `pending` cho script danh sách chính xác thay vì đoán theo tuổi |

## Tiêu chí nghiệm thu toàn dự án

1. Tải lên file **200MB** qua web, thanh tiến độ hiện % thật
2. Tải file đó xuống, **tên tiếng Việt có dấu giữ nguyên**, mở được bằng phần mềm gốc
3. File cũ (cả nguyên khối lẫn chia mảnh) vẫn tải xuống bình thường
4. Xoá bằng quyền admin → object mất khỏi R2 **và** doc mất khỏi MongoDB
5. Không mật khẩu → không tải lên được; `EDIT_KEY` → được; xoá cần `ADMIN_KEY`
6. Không còn doc chứa `Binary` **được tạo mới** trong `bim_files` — kiểm bằng mốc **epoch dạng số**, kèm một đối chứng dương
7. **`R2_SECRET_ACCESS_KEY` không xuất hiện trong bất kỳ response nào.** *(Access Key ID và Account ID **có** nằm trong `X-Amz-Credential` và hostname của mọi URL đã ký — đó là bản chất SigV4, không phải lỗi. Bản 1 ghi tiêu chí này sai thành "không có khóa nào".)*
8. Gọi `confirm` hai lần cùng `id` → cả hai lần trả 200, tạo đúng **một** document
9. Với biến R2 chưa đặt: `GET ?id=` file cũ **vẫn chạy**, `sign-upload` trả 500 nêu đúng tên biến thiếu
10. Rollback về bản trước giai đoạn 2 → file R2 trả **410**, không phải 200/0 byte

## Chi phí

0đ dưới 10GB · ~$1.35/tháng (≈35.000đ) ở 100GB · egress luôn 0đ.

---

## Red Team Review

### Session — 2026-09-03
**Findings:** 28 thô → 16 sau khi gộp trùng (**15 nhận, 1 bác**)
**Severity:** 4 Critical, 9 High, 2 Medium
**Reviewers:** Security Adversary · Assumption Destroyer · Failure Mode Analyst
**Báo cáo đầy đủ:** [reports/](reports/)

| # | Finding | Mức | Xử lý | Áp vào |
|---|---|---|---|---|
| 1 | Chữ ký `response-content-disposition` không khớp (`%20` vs `+`, `%2A` vs `*`) — mọi file mới 403 | Critical | Accept | plan.md, Phase 2, 3 |
| 2 | Bỏ sót `a.setAttribute("download")` ở `:1387`; cross-origin 302 làm nó vô hiệu | Critical | Accept | plan.md, Phase 3 |
| 3 | Code cũ + rollback trả doc R2 thành 200/0 byte, cache `immutable` 1 năm | Critical | Accept | **Phase 0 (mới)**, plan.md § Rollback |
| 4 | Script dọn có thể xoá sạch bucket (lệch env, `vercel env pull` mặc định development) | Critical | Accept | Phase 4 |
| 5 | Bảng "Gỡ bỏ" thiếu nhánh `POST ?name=&type=` và `MAX_FILE` → `ReferenceError` | High | Accept | Phase 2 |
| 6 | `HEAD` lên URL ký cho `GET` — method nằm trong canonical request | High | Accept | Phase 1, 2 |
| 7 | `confirm` không idempotent (E11000) + chỉ kiểm hình dạng key, không kiểm nguồn gốc | High | Accept | Phase 2 |
| 8 | `filesBusy` đóng băng đồng bộ + `$set` cả document không kiểm version → mất sửa của người khác | High | Accept | Phase 3 |
| 9 | Header `immutable` áp nhầm lên nhánh 302 | High | Accept | Phase 2 |
| 10 | `AwsClient` khởi tạo ở tầng module → thiếu env làm sập cả `/api/files` | High | Accept | Phase 2 |
| 11 | LAN không được cô lập — dùng chung `bang-hang-muc.html` | High | Accept | Phase 4 (xoá `serve.cjs`) |
| 12 | Preview ghi vào MongoDB + bucket của production | High | Accept | Phase 1, 4 |
| 13 | `retryUp` khai là "vẫn dùng" nhưng code mẫu không gọi → 0 caller | High | Accept | Phase 3 |
| 14 | Tiêu chí #7 bất khả thi; handler 500 trả nguyên `error.message` | Medium | Accept | plan.md, Phase 2 |
| 15 | Truy vấn chứng minh so Number với ISODate → luôn đúng vô nghĩa | Medium | Accept | Phase 4 |
| 16 | `global.__mongoClient` không kiểm tra sức khoẻ | High | **Reject** | — |

**Lý do bác #16:** có thật, nhưng là lỗi sẵn có ở `api/files.js:47-54` và `api/data.js:45-53`,
không do plan này sinh ra, và ảnh hưởng cả `api/data.js` nằm ngoài phạm vi. Gộp vào đây sẽ
làm phình một plan vốn đã lớn. Ghi nhận thành việc riêng.

**Nhóm nhỏ đã áp kèm:** xoá `localhost:3000` khỏi CORS (cổng thật 8787, mà LAN thì bị xoá
hẳn) · bắt buộc thêm origin preview mỗi lần deploy preview · ghim `aws4fetch` đúng `1.0.20` ·
`vercel:env` thêm `--environment production` · sửa lại lý do "không ký Content-Type" cho
đúng (XHR **luôn** tự gắn header đó; nó vô hại vì `signQuery` chỉ ký `host` — bản 1 ghi sai
lý do, dễ hại người sửa sau) · thêm `*.md`, `docs`, `plans`, `scripts`, `scratch` vào
`.vercelignore` và `scratch/` vào `.gitignore` **(đã thực hiện)**.

### Whole-Plan Consistency Sweep
- Files reread: `plan.md`, `phase-00`, `phase-01`, `phase-02`, `phase-03`, `phase-04`, `phase-05`
- Decision deltas checked: 15
- Reconciled stale references: xem § Sweep ở cuối `phase-05`
- Unresolved contradictions: **0**

---

## Validation Log

### Session 1 — 2026-09-03
**Câu hỏi:** 4 · **Quyết định chốt:** 4 · **Giai đoạn thêm mới:** 1

Bước verify không lặp lại: `## Red Team Review` đã có sẵn bằng chứng xác minh, và không
còn tag `[UNVERIFIED]` nào trong plan.

#### Mâu thuẫn validate tự tìm ra

**`bim_preview` là database rỗng, nhưng 4 mục kiểm thử đòi phải có file cũ ở đó.**
Giai đoạn 1.4 đặt `MONGODB_DB=bim_preview` để cách ly dữ liệu (đúng), nhưng giai đoạn kiểm
thử lại có mục 6, 7, 15, R3 và truy vấn đối chứng dương — tất cả đều cần doc `data`/`chunks`
sẵn có. Trên một database mới tinh thì không mục nào chạy được. Đây là lỗi do chính bản 2
tạo ra khi sửa finding #12 của red team.

#### Quyết định

| # | Câu hỏi | Chọn | Áp vào |
|---|---|---|---|
| 1 | Database preview rỗng, làm sao kiểm thử file cũ? | **Sao chép vài doc cũ sang `bim_preview`** — 1 nguyên khối, 1 chia mảnh kèm đủ mảnh, 1 kế hoạch trỏ tới chúng | phase-05 § Gieo dữ liệu |
| 2 | Có xoá hẳn `serve.cjs` và bản LAN không? | **Giữ file, chỉ gỡ script npm** + thêm chú thích ở đầu `serve.cjs` | phase-05 § Ngừng bản LAN · plan.md § Phạm vi |
| 3 | Lỗi ghi đè của `api/data.js` — làm luôn hay để sau? | **Làm luôn lần này** — thêm điều kiện `ifMtime` | **phase-04 (mới)** · plan.md § Phạm vi, § Rủi ro |
| 4 | File cũ chiếm bao nhiêu trong 512MB? | **Đo ở giai đoạn 0 trước khi làm tiếp**; > 350MB thì dừng xem xét lại | phase-00 bước 3 · plan.md § Phạm vi |

**Ghi chú quyết định 2:** giữ `serve.cjs` để lại một máy chủ chạy được nhưng hỏng phần tải
file — ai chạy `node serve.cjs` mà không đọc chú thích sẽ gặp `400 "File rỗng"` khó hiểu.
Khối chú thích ở đầu file là biện pháp giảm nhẹ, không phải loại bỏ. Chủ dự án đã cân nhắc
và chấp nhận đánh đổi này.

**Ghi chú quyết định 3:** đây là mở rộng phạm vi thật, không phải sửa vặt — chạm vào đường
lưu dữ liệu của **toàn bộ** ứng dụng chứ không riêng phần file. Đổi lại nó đóng hẳn một lỗi
mất dữ liệu đã tồn tại từ trước. Ước lượng công sức tăng từ ~2 lên **~2,5 ngày**.

### Whole-Plan Consistency Sweep
- Files reread: `plan.md`, `phase-00`, `phase-01`, `phase-02`, `phase-03`, `phase-04`, `phase-05`
- Decision deltas checked: 4
- Reconciled stale references: 6 — đánh số giai đoạn `4→5` · bảng giai đoạn trong `plan.md` ·
  "xoá bản LAN" → "ngừng bản LAN" (`plan.md` § Phạm vi, `phase-05` § Ngừng, § File liên quan,
  § Tiêu chí) · rủi ro `filesBusy` nay trỏ tới giai đoạn 4 · ma trận kiểm thử 18 → 22 mục ·
  bảng cập nhật `CLAUDE.md` thêm dòng `ifMtime`
- **Unresolved contradictions: 0**

---

## Tiến độ thực hiện

### Phiên 1 — 2026-09-03 (`/cook --auto`)

**Đã xong: toàn bộ phần mã.** 8 commit trên nhánh `anhnt/new-storage`, tách theo
giai đoạn để deploy giai đoạn 0 riêng được (nhánh `backup-r2` giữ lịch sử trước
khi gộp `.gitignore`/`.vercelignore` vào commit giai đoạn 0).

| Commit | Nội dung |
|---|---|
| `7b5d55d` | Giai đoạn 0 — guard 410 + `.gitignore`/`.vercelignore` |
| `2070074` | Giai đoạn 1 (mã) — `aws4fetch@1.0.20` ghim, `vercel:env --environment production` |
| `4107d3f` | Giai đoạn 2 — viết lại `api/files.js` + `vercel.json` |
| `532639c` | Giai đoạn 3 — luồng tải lên PUT thẳng lên R2 |
| `e0431a2` | Giai đoạn 4 — `ifMtime` chống ghi đè |
| `44b4579` | Giai đoạn 5 (mã) — script dọn, ngừng bản LAN, tài liệu |
| `3247bf7` | Sửa: `mtime` phải tăng thật sự |
| `2cf4755` | Sửa 6 lỗi code review |

**Bốn giả định then chốt đã xác minh bằng thực nghiệm** (không phải đọc code suy ra):
`X-Amz-SignedHeaders=host` (header thừa lúc PUT không làm lệch chữ ký) ·
`X-Amz-Expires` đặt sẵn được tôn trọng · GET và HEAD sinh chữ ký **khác nhau** ·
`response-content-disposition` thật sự bị mã hoá lệch (`+` vs `%20`, `*` thô vs `%2A`).
Nghĩa là finding Critical #1 và #6 của red team đều đúng, và cách thay thế chạy được.

**Kiểm thử tự động: 113 mục, 0 sai** (MongoDB và R2 giả, chạy được không cần hạ tầng):

| Bộ | Số mục | Phủ |
|---|---|---|
| `api/data.js` | 25 | `ifMtime`, 409, tương thích ngược, lưu 20 lần liên tiếp, rename/delete |
| `api/files.js` | 63 | phân quyền, sign-upload, confirm idempotent, 302 + `no-store`, file cũ, guard 410, shim 426, DELETE, thiếu biến R2 |
| script dọn | 25 | mọi chốt an toàn, gồm mục "sai collection → DỪNG vì tập key rỗng" |

**Hai lỗi thật do kiểm thử/review tìm ra, đã vá:**

1. `updatedAt` không tăng khi hai lần ghi rơi cùng một mili-giây → `ifMtime` của
   người lưu kế tiếp khớp nhầm → ghi đè im lặng, đúng lỗi giai đoạn 4 sinh ra để chặn.
2. `pushToServer` không có khoá "đang gửi" → người dùng gõ liên tục trên mạng chậm
   nhận **dải cảnh báo xung đột giả với chính thay đổi của mình**. Mục kiểm thử
   "lưu 20 lần liên tiếp" không bắt được vì nó chờ từng phản hồi.

Bốn lỗi review còn lại: shim 426 bỏ sót `POST ?name=&type=` (đường tải file nhỏ
của bản cũ) · dải cảnh báo hiện đè lên màn hình danh sách khi bấm quay lại ·
409 với `mtime: 0` làm sống lại kế hoạch đã xoá · `fetch` xoá object R2 thiếu
timeout nên bị `maxDuration` giết trước khi xoá metadata · `insertOne` chạy trước
`signR2` để lại doc `pending` mồ côi mà script dọn cố ý không đụng tới.

### Phiên 2 — 2026-09-03 (đổi sang S3 + đo MongoDB)

**Đổi kho lưu trữ: Cloudflare R2 → Amazon S3.** Lý do: công ty đã dùng AWS sẵn.
Đổi lúc này tốn bằng không (bucket R2 còn rỗng, chưa deploy, chưa đặt biến Vercel).
Rẻ vì `aws4fetch` vốn là bộ ký SigV4 **của S3**; chỉ `getS3()` đổi. Commit `398eaf3`.

Một chi tiết bắt buộc, đừng "sửa lại cho đúng chuẩn AWS": URL dùng **path-style**
`https://s3.<vùng>.amazonaws.com/<bucket>/<key>`. Tên bucket `com.vcijsc.bvtc`
**có dấu chấm**, mà chứng chỉ TLS `*.s3.<vùng>.amazonaws.com` chỉ khớp một nhãn —
virtual-hosted sẽ lỗi TLS ở **mọi** request. Đã có 3 mục kiểm thử chặn việc này.

**Đã kiểm thật với AWS S3 — 13/13 đạt.** Lần đầu xác minh được trên hạ tầng thật
thay vì suy từ mã nguồn. Cả hai finding Critical của red team nay có bằng chứng:
PUT kèm `Content-Disposition` tiếng Việt **không** làm lệch chữ ký và S3 **trả lại
đúng tên đó**; URL ký cho GET dùng làm HEAD bị từ chối 403.

#### ►► Đo MongoDB (giai đoạn 0 bước 3) — CHẠM NGƯỠNG DỪNG

Bước 2 đạt: `countDocuments({data:{$exists:false}, chunks:{$exists:false}})` = **0**,
nên guard 410 là no-op tuyệt đối, deploy được an toàn.

Bước 3 **vượt ngưỡng**:

| Database `bim` | |
|---|---|
| `dataSize` | **352,8 MB** / 512 MB — **69% trần gói M0** |
| mảnh rời (109 doc) | 342,1 MB |
| file chia mảnh (23 file) | 342,1 MB *(cùng số bytes, đếm ở doc cha)* |
| file nguyên khối (5 file) | 10,7 MB |
| còn trống | ~160 MB |

Bytes thật của file đính kèm ≈ 342,1 + 10,7 = **353 MB**, khớp gần khít `dataSize`
352,8 MB. Nghĩa là **gần như toàn bộ database là file đính kèm**; phần dữ liệu bảng
(3 kế hoạch) không đáng kể.

**Ngưỡng plan đặt ra là > 350MB → dừng lại xem xét.** Đã chạm.

Kết luận: **đường lai không giải quyết được vấn đề gốc.** Chuyển file *mới* sang S3
giữ cho database khỏi phình thêm, nhưng 353 MB đang chiếm chỗ vẫn nằm đó vĩnh viễn
và M0 vẫn ở mức 69%. **Script migrate file cũ (đã thiết kế ở § Việc tiếp theo) không
còn là việc tuỳ chọn làm sau — nó là điều kiện để dự án này đạt mục đích ban đầu.**

Tin tốt: sau lượt 1 + lượt 2 của script migrate, `bim` xuống còn ~11 MB. Từ 69%
về ~2%. Kiến trúc đúng, chỉ là thứ tự ưu tiên đổi.

Rủi ro trước mắt: chỉ còn ~160 MB trống, mà site cũ `bim-wheat.vercel.app` vẫn
chạy mã cũ ghi thẳng file vào MongoDB. Ai tải file lên từ đó vẫn ăn vào 160 MB này.

### Còn lại — cần hạ tầng thật, không làm từ máy được

| # | Việc | Chặn bởi |
|---|---|---|
| ~~1~~ | ~~Đo dung lượng file cũ~~ **XONG** — 352,8 MB, **chạm ngưỡng dừng**, xem § Phiên 2 | — |
| 2 | Đặt 4 biến **S3** lên Vercel (Production + Preview) và `MONGODB_DB=bim_preview` | Đã có bucket + khoá và đã kiểm chạy được ở máy; còn đặt lên Vercel |
| 3 | Cấu hình CORS cho bucket (thêm `http://localhost:3000` cho bucket thử nghiệm nếu dùng `vercel dev`) | AWS Console |
| ~~4~~ | ~~5 test `curl` giai đoạn 1~~ **XONG** — 13/13 đạt với S3 thật, gồm cả tên tiếng Việt | — |
| 5 | Gieo dữ liệu `bim_preview` (1 doc `data`, 1 doc `chunks` + đủ mảnh, 1 kế hoạch trỏ tới) | Cần truy cập Atlas |
| 6 | 22 mục ma trận kiểm thử + 4 mục rollback R1–R4 trên preview | Cần deploy preview |
| 7 | Deploy giai đoạn 0 **riêng** trước, xác minh, rồi mới deploy phần còn lại | Cần đăng nhập Vercel |

**Chưa kiểm thử được ở đây:** toàn bộ phần giao diện chạy trong trình duyệt —
thanh tiến độ %, hai tab tranh nhau, dải cảnh báo xung đột, tải file 200MB thật.
Mục 12, 19, 20, 21 của ma trận kiểm thử phủ đúng những chỗ đó.
