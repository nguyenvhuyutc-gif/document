---
phase: 2
title: "Viết lại api/files.js"
status: in-progress
priority: P1
dependencies: [0, 1]
---

# Giai đoạn 2: Viết lại `api/files.js`

## Tổng quan

Chuyển `api/files.js` từ "cầm dữ liệu file" sang "chỉ ký URL và ghi metadata".
Giữ nguyên toàn bộ nhánh đọc file cũ để không mất dữ liệu.

## Yêu cầu

**Chức năng:**
- `POST ?action=sign-upload` → ghi doc `pending`, trả presigned PUT (cần `EDIT_KEY`)
- `POST ?action=confirm` → xác minh trên R2 bằng HEAD, chuyển `pending` → `ready` (cần `EDIT_KEY`)
- `GET ?id=` → doc có `key` thì **302 + `no-store`**; có `data`/`chunks` thì đọc MongoDB như cũ
- `DELETE ?id=` → xoá object R2 (nếu có) + xoá doc (cần `ADMIN_KEY`)
- Endpoint đã gỡ trả **426** kèm câu tiếng Việt bảo tải lại trang

**Phi chức năng:**
- `R2_SECRET_ACCESS_KEY` không bao giờ xuất hiện trong response
- Thiếu biến R2 **không được** làm hỏng đường đọc file cũ
- Giữ nguyên `getRole` / `safeEqual`

## Kiến trúc

### Khởi tạo lười — bắt buộc

`aws4fetch@1.0.20` có export `require` → dùng thẳng trong CommonJS.

```js
const { AwsClient } = require("aws4fetch");

// KHỞI TẠO LƯỜI, đúng nếp connectMongo() ở api/files.js:46.
// KHÔNG dựng AwsClient ở tầng module: nếu 4 biến R2 thiếu hoặc RỖNG (bẫy đã biết
// của `vercel env add`, xem deploy-bim/SKILL.md) thì hoặc là module không nạp được
// và TOÀN BỘ /api/files trả 500 — kể cả GET file cũ trong MongoDB, thứ mà đường lai
// sinh ra để bảo vệ — hoặc là R2_BASE thành "https://undefined.r2.…/undefined" và
// sign-upload trả 200 với URL trông hợp lệ, đẩy lỗi xuống tận xhr.onerror ở client
// dưới dạng "mất kết nối khi tải lên".
let _r2 = null;
function getR2() {
  if (_r2) return _r2;
  const miss = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
    .filter((k) => !process.env[k]);
  if (miss.length) throw new Error("Thiếu biến môi trường R2: " + miss.join(", "));
  _r2 = {
    client: new AwsClient({
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
    }),
    base: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}`,
  };
  return _r2;
}

// Ký URL có hạn. signQuery: true → chữ ký nằm trong query string.
// LƯU Ý: method là DÒNG ĐẦU TIÊN của canonical request trong SigV4
// (aws4fetch.cjs.js:201-209) — URL ký cho "GET" KHÔNG dùng được cho "HEAD".
async function signR2(key, method, expires) {
  const { client, base } = getR2();
  const u = new URL(`${base}/${key}`);
  u.searchParams.set("X-Amz-Expires", String(expires));
  const signed = await client.sign(u.toString(), { method, aws: { signQuery: true } });
  return signed.url;
}
```

### Tên file và MIME gắn lúc PUT, KHÔNG qua query của presigned GET

Đây là thay đổi quan trọng nhất so với bản 1. **Không** thêm `response-content-disposition`
hay `response-content-type` vào URL ký.

Lý do: `aws4fetch` dựng canonical query bằng `encodeRfc3986(encodeURIComponent(v))`
(space → `%20`, `*` → `%2A`) còn URL gửi đi lấy từ `URL.toString()` (space → `+`, `*` → `*`).
Chuỗi `Content-Disposition` chứa cả space lẫn `*` → chữ ký lệch → **403 với mọi file mới**.

Thay vào đó client gửi `Content-Disposition` và `Content-Type` làm **header thật** khi PUT
(giai đoạn 3). Với `signQuery` thì aws4fetch chỉ ký `host`, nên header thừa không tham gia
chữ ký và không thể gây mismatch — nhưng R2 **vẫn lưu chúng làm metadata của object**.

### Quy tắc đặt key — chỉ ASCII

```js
// bim/2026-09/a1b2c3d4e5f6.dwg
function makeKey(name) {
  const ym = new Date().toISOString().slice(0, 7);
  const rand = crypto.randomBytes(6).toString("hex");
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ""));
  return `bim/${ym}/${rand}${m ? "." + m[1].toLowerCase() : ""}`;
}
const KEY_RE = /^bim\/\d{4}-\d{2}\/[0-9a-f]{12}(\.[a-z0-9]{1,8})?$/;
```

Tên thật (có dấu) lưu ở MongoDB, không nhét vào key — tránh một lớp lỗi mã hoá trong chữ ký.

## Bốn nhánh xử lý

### `POST ?action=sign-upload&name=&type=&size=`

```
getRole(req) ∈ {admin, edit}          → không thì 401 { needKey: true }
size là số, 0 < size ≤ 200MB          → không thì 413
key = makeKey(name)
id  = crypto.randomBytes(12).toString("hex")
insertOne { _id: id, name, type, key, status: "pending", createdAt: Date.now() }
uploadUrl = await signR2(key, "PUT", 900)          // 15 phút
→ 200 { ok: true, id, key, uploadUrl }
```

**Ghi doc `pending` ngay tại đây** là điểm khác cốt lõi so với bản 1. Nó ràng
`id ↔ key ↔ người ký` một cách nguyên tử, và giải quyết cùng lúc ba vấn đề:

1. `confirm` không thể ghi metadata trỏ vào key của người khác. Key **không phải bí mật** —
   nó nằm trong path của mọi URL ký, tức là đi qua lịch sử trình duyệt và mọi proxy trung
   gian. Nếu `confirm` chỉ kiểm *hình dạng* key như bản 1, ai giữ `EDIT_KEY` có thể trỏ hai
   document vào cùng một object; xoá document mồi sẽ phá mất file thật, mà nhánh DELETE lại
   cố tình nuốt lỗi xoá R2 nên không có tín hiệu nào.
2. `confirm` gọi lại lần hai không vỡ (xem dưới).
3. Script dọn ở giai đoạn 4 có **danh sách pending có thẩm quyền** thay vì đoán theo tuổi.

### `POST ?action=confirm&id=&key=&name=&type=`

```
getRole(req) ∈ {admin, edit}          → không thì 401
KEY_RE.test(key)                      → không thì 400

// Ký RIÊNG cho HEAD. Ký cho GET rồi gọi HEAD sẽ sai chữ ký.
// AbortController 5s: confirm giờ có lời gọi ra ngoài trong một serverless
// invocation. HEAD treo sẽ ăn hết budget và Vercel trả HTML lỗi, mà apiJson ở
// client biến nó thành "máy chủ trả lỗi HTTP 504" — sau khi 200MB đã truyền xong.
headUrl = await signR2(key, "HEAD", 300)
r = await fetch(headUrl, { method: "HEAD", signal: AbortSignal.timeout(5000) })
  r.status === 404          → 400 "Chưa thấy file trên kho lưu trữ"
  r.status === 403          → 500 "Lỗi chữ ký khi kiểm tra file"     ⟵ TÁCH RIÊNG khỏi 404
  timeout / lỗi mạng        → 503 "Kho lưu trữ không phản hồi, hãy thử lại"
size = Number(r.headers.get("content-length"))
  size > 200MB              → xoá object, 413

// Idempotent: cùng id gọi hai lần đều trả 200 và chỉ tạo MỘT document.
res = updateOne({ _id: id, key, status: "pending" },
                { $set: { status: "ready", size, confirmedAt: Date.now() } })
nếu res.matchedCount === 1 → 200 ok
ngược lại:
  doc = findOne({ _id: id })
  nếu doc && doc.key === key && doc.status === "ready" → 200 ok    ⟵ retry sau khi đã thành công
  ngược lại                                            → 400 "Phiên tải lên không hợp lệ"
→ 200 { ok: true, file: { id, name, size, type, url: "api/files?id=" + id } }
```

**Lấy `size` từ HEAD chứ không tin client.** Vừa chính xác, vừa chặn ghi metadata cho file
chưa hề tải lên.

**Vì sao phải idempotent:** bản 1 dùng `insertOne` với `_id` do client cấp. `confirm` được
bọc `retryUp` (giai đoạn 3), nên khi lần gọi đầu insert xong mà response mất (cold start,
Wi-Fi đổi sang 4G), lần retry sẽ ném `E11000` → 500 → client thấy `j.ok === false` →
`okCount` giữ nguyên 0 → **`save()` không bao giờ chạy**. File 200MB nằm trong R2 và trong
`bim_files` nhưng **không dòng nào trỏ tới**, còn người dùng thì được báo là thất bại và
tải lại thêm 200MB nữa.

### `GET ?id=<id>` — tự do, không cần mật khẩu

```
doc = findOne({_id: id})               → không có thì 404

nếu doc.key:                                                    ⟵ FILE MỚI
    nếu doc.status !== "ready" → 404 (doc pending chưa phải file)
    url = await signR2(doc.key, "GET", 300)                     // KHÔNG có response-*
    res.setHeader("Cache-Control", "private, no-store")         // ⟵ BẮT BUỘC
    → 302 Location: url

nếu doc.chunks và có ?part=i:          → giữ nguyên code hiện tại   ⟵ FILE CŨ
nếu doc.chunks:                        → giữ nguyên code hiện tại   ⟵ FILE CŨ
nếu doc.data:                          → giữ nguyên code hiện tại   ⟵ FILE CŨ
ngược lại:                             → 410 (guard của giai đoạn 0, giữ nguyên)
```

**`no-store` là bắt buộc, không phải tuỳ chọn.** Code cũ bên dưới đặt
`Cache-Control: public, max-age=31536000, immutable` (`api/files.js:121,146`). Bản 1 dặn
"chỉ thêm `if (doc.key)` ở đầu, không sửa code dưới" — làm đúng vậy mà quên header thì sẽ
**nhét một credential 5 phút vào cache 1 năm**: 5 phút sau, mọi lần bấm đều nhận
`AccessDenied` từ R2, không xoá được nếu không xoá dữ liệu site. Người dùng báo "file
hỏng", trong khi file hoàn toàn nguyên vẹn.

### `DELETE ?id=<id>` — cần `ADMIN_KEY`

```
getRole(req) === "admin"               → không thì 401
doc = findOne({_id: id}, {projection: {key: 1, chunks: 1}})
nếu !doc                               → 200 { ok: true }        ⟵ GIỮ guard này
nếu doc.key:   fetch(await signR2(doc.key, "DELETE", 300), { method: "DELETE" })
nếu doc.chunks: deleteMany({_id: {$in: doc.chunks}})
deleteOne({_id: id})
→ 200 { ok: true }
```

Guard `if (!doc)` phải giữ — code hiện tại có nó (`api/files.js:226`). `removeFile` ở client
gọi DELETE kiểu bắn-rồi-quên (`bang-hang-muc.html:1646-1647`), nên xoá cùng một file hai lần
là chuyện bình thường (hai tab, hoặc hai người trên một dòng đang đồng bộ). Bỏ guard đi thì
lần thứ hai ném TypeError → 500 thay vì 200 êm ả như hiện nay.

Xoá object R2 hỏng thì **vẫn xoá metadata** và trả `ok` — metadata trỏ vào hư không tệ hơn
một file mồ côi. Ghi `console.error` để còn dấu vết.

## Sửa handler lỗi

```js
// KHÔNG trả nguyên error.message về client. Chuỗi đó có thể chứa cả URL đã ký
// (kèm X-Amz-Credential và chữ ký còn hiệu lực), hoặc E11000 kèm tên database
// và tên index — một kênh dò _id có sẵn.
} catch (error) {
  console.error(error);
  res.status(500).json({ ok: false, error: "Lỗi máy chủ" });
}
```

Thay `api/files.js:236-238` hiện tại (`String(error && error.message || error)`).

## Shim cho HTML cũ trong cache

`bang-hang-muc.html` là file tĩnh, `vercel.json:5-13` chỉ đặt header cho `/api/(.*)` — không
có gì ép trình duyệt tải lại HTML. Tab đang mở sẽ tiếp tục gọi endpoint đã gỡ.

```js
if (["chunk", "finish"].includes(action) || (req.method === "DELETE" && q.get("chunks"))) {
  res.status(426).json({ ok: false, error: "Bản web đã cập nhật — hãy tải lại trang (Ctrl+F5)" });
  return;
}
```

Không có shim này thì request rơi xuống `api/files.js:234` và client hiện chuỗi tiếng Anh
`"Method Not Allowed"` cho người dùng Việt, sau khi `retryUp(..., 3)` đã thử lại 3 lần mỗi
mảnh — file 40MB sẽ treo ô nhiều phút trước khi báo lỗi khó hiểu.

## Gỡ bỏ — danh sách ĐẦY ĐỦ

| Gỡ | Vị trí | Ghi chú |
|---|---|---|
| `POST ?name=&type=` (nhánh 1 request) | `api/files.js:186-209` | **Bản 1 bỏ sót.** Đây là đường upload phổ biến nhất hiện nay (mọi file < 3.5MB) |
| `POST ?action=chunk` | `:152` | thay bằng shim 426 |
| `POST ?action=finish` | `:167` | thay bằng shim 426 |
| `DELETE ?chunks=` | `:213` | thay bằng shim 426 |
| `readRawBody()` | `:58` | 2 caller: `:154`, `:191` |
| `MAX_BYTES` | `:26` | 2 chỗ dùng: `:68`, `:197` |
| `MAX_FILE` | `:27` | **Bản 1 bỏ sót.** 1 chỗ dùng: `:175` |
| `Binary` trong import | `:19` | 2 chỗ dùng: `:161`, `:205` |

Bản 1 liệt kê `readRawBody`/`MAX_BYTES`/`Binary` để xoá nhưng **không** liệt kê nhánh
`POST ?name=&type=` vốn là caller của cả ba. Làm theo bảng cũ sẽ xoá phụ thuộc mà giữ lại
người gọi → `ReferenceError` → 500 cho mọi upload file nhỏ.

**Giữ lại:** `docBuffer()`, nhánh GET `data`/`chunks`/`?part=`, guard 410 của giai đoạn 0,
`getRole`, `safeEqual`, `connectMongo`.

## Thêm giới hạn thời gian cho function

`vercel.json` hiện **không có** khối `functions`. `confirm` giờ gọi ra ngoài (HEAD tới R2)
nên cần chặn trên rõ ràng:

```json
"functions": { "api/*.js": { "maxDuration": 15 } }
```

## File liên quan

- Sửa: `api/files.js` — toàn bộ
- Sửa: `vercel.json` — thêm khối `functions`
- Không đụng: `api/data.js`, `bang-hang-muc.html` (giai đoạn 3)

## Tiêu chí hoàn thành

- [ ] `sign-upload` không mật khẩu → 401 `{needKey: true}`
- [ ] `sign-upload` có `EDIT_KEY` → trả URL, và tạo doc `status:"pending"` trong MongoDB
- [ ] `sign-upload` với `size` > 200MB → 413, **không** tạo doc
- [ ] `confirm` với `key` sai `KEY_RE` → 400
- [ ] `confirm` với key hợp lệ nhưng **không phải** key của `id` đó → 400 "Phiên tải lên không hợp lệ"
- [ ] `confirm` khi chưa PUT → 400 "Chưa thấy file trên kho lưu trữ" (404 từ R2, **không** lẫn với 403)
- [ ] **`confirm` gọi hai lần cùng `id` → cả hai trả 200, `countDocuments({_id: id})` === 1**
- [ ] `confirm` hợp lệ → doc chuyển `pending` → `ready`, `size` khớp file thật
- [ ] `GET ?id=` file mới → **302**, header `Cache-Control` chứa `no-store`
- [ ] `curl -L` file mới → tải đúng nội dung **và đúng tên tiếng Việt có dấu**
- [ ] `GET ?id=` doc còn `pending` → 404
- [ ] `GET ?id=` file cũ nguyên khối → như trước
- [ ] `GET ?id=&part=0` file cũ chia mảnh → như trước
- [ ] `DELETE` không `ADMIN_KEY` → 401
- [ ] `DELETE` hai lần cùng một id → cả hai lần **200**, không 500
- [ ] `DELETE` có `ADMIN_KEY` → object mất khỏi R2, doc mất khỏi MongoDB
- [ ] Gọi `?action=chunk` → **426** kèm câu tiếng Việt
- [ ] **Xoá hết 4 biến R2 → `GET ?id=` file cũ VẪN chạy; `sign-upload` trả 500 và log nêu đúng tên biến thiếu**
- [ ] Ép một lỗi bất kỳ → response chỉ có `"Lỗi máy chủ"`, không có chi tiết driver
- [ ] `grep -n "R2_SECRET_ACCESS_KEY" api/files.js` → chỉ trong `getR2()`, không nằm trong response nào
- [ ] Không còn `action=chunk`/`finish` xử lý thật, không còn `Binary`, không còn `MAX_FILE`

## Rủi ro

| Rủi ro | Cách xử lý |
|---|---|
| Vẫn dùng `response-*` trong query vì thấy tiện | Chữ ký lệch → 403 mọi file. Giai đoạn 1 test 2&3 đã chứng minh đường đúng — bám theo |
| Quên `no-store` trên nhánh 302 | Tiêu chí có mục riêng. Cache 1 năm cho URL 5 phút là lỗi rất khó chẩn đoán |
| Sửa nhầm nhánh đọc file cũ | Chỉ **thêm** `if (doc.key)` ở đầu; không sửa code cũ bên dưới trừ header |
| Dựng `AwsClient` ở tầng module cho gọn | Thiếu env sẽ hạ cả `/api/files`, kể cả file cũ. Tiêu chí có mục kiểm riêng |
| Ký `GET` rồi gọi `HEAD` | Giai đoạn 1 test 4 đã chứng minh phải ký riêng |
| Nhầm 403 thành 404 ở `confirm` | Tách hai mã trả về; báo "chưa thấy file" khi thật ra sai chữ ký sẽ dẫn debug đi sai hướng cả buổi |
