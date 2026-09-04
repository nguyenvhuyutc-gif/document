# Lưu file đính kèm trên Amazon S3

Từ 09/2026 file đính kèm không còn nằm trong MongoDB. Client tải thẳng lên
Amazon S3 qua **presigned URL**; serverless function chỉ ký URL và ghi metadata.
Giới hạn 1 file: **500MB**.

> Bản đầu thiết kế cho Cloudflare R2 rồi đổi sang S3 vì công ty đã dùng AWS sẵn.
> Đổi được rẻ vì `aws4fetch` vốn là bộ ký SigV4 **của S3** — R2 chỉ là endpoint
> tương thích. Toàn bộ `signS3`, `makeKey`, `confirm`+HEAD, nhánh 302, DELETE và
> `ListObjectsV2` giữ nguyên; chỉ `getS3()` đổi.

---

## Luồng

```text
TẢI LÊN
  Client ──① POST /api/files?action=sign-upload   (cần EDIT_KEY, size ≤ 500MB)
         │                                         → ghi doc {status:"pending", key}
         ◀─② { uploadUrl, id, key }                presigned PUT, hạn 1 giờ
         ──③ XHR PUT + header Content-Disposition & Content-Type ──▶ S3
         ──④ POST /api/files?action=confirm        → HEAD lấy size thật
                                                   → updateOne pending → ready

TẢI XUỐNG
  <a href="api/files?id=xxx">
         ──① GET /api/files?id=xxx
         ◀─② 302 + Cache-Control: private, no-store
         ──③ trình duyệt tải thẳng ───────────────────────────────▶ S3
              tên file & MIME lấy từ metadata ĐÃ LƯU TRÊN OBJECT

XOÁ (qua thùng rác)
  Client ──① POST /api/files?action=trash   (cần ADMIN_KEY, cả mẻ 1 request)
         │      → $set {status:"trashed", trashedAt, origin:{planId,rowId,fkey,rowName}}
         │      → object trên S3 KHÔNG đụng tới
         ──② GET /api/files?trash=1&plan=…  → liệt kê + dọn bản quá hạn 30 ngày
         ──③a POST ?action=restore&id=…     → bỏ cờ, file quay lại bảng
         ──③b DELETE ?id=…                  → xoá hẳn: object S3 + doc
```

## Thùng rác

Xoá file khỏi bảng **không** xoá gì trên S3 — chỉ đổi `status` sang `"trashed"`,
đóng dấu `trashedAt` và ghi `origin` để còn biết đường khôi phục. Object nằm
nguyên chỗ cũ: copy một object 500MB sang prefix khác trong hàm 15 giây là rủi ro
không đổi lấy gì.

`origin` phải mang theo **cả những thứ chỉ tồn tại trong document kế hoạch**, vì
mục đó vừa bị gỡ khỏi đúng nơi duy nhất giữ chúng:

| Trường | Vì sao cần |
|---|---|
| `planId`, `rowId`, `fkey` | Chỗ file từng nằm |
| `rowName` | Để thùng rác nói được "từ dòng: Móng M1" kể cả khi dòng đã mất |
| `uploadedAt` | **Nội dung cột "Thời gian trình/duyệt/chấp thuận"**. `bim_files` không lưu nó |
| `note` | Ghi chú riêng của file — cũng chỉ sống trong document kế hoạch |
| `viTri` | Chỗ đứng trong mảng, dùng khi file không có `uploadedAt` |

**Khôi phục chèn lại đúng vị trí, không nối vào cuối.** Mảng file của một ô vốn
xếp theo thứ tự tải lên (mỗi lần tải xong đều đẩy vào cuối), nên `chenLaiFile()`
chèn theo `uploadedAt` — file về đúng chỗ cũ kể cả khi trong lúc nó nằm thùng rác
có người thêm hoặc xoá file khác trong cùng ô. File tải lên trước 09/2026 không
có `uploadedAt` nên lùi về `viTri`.

Đừng dùng `trashedAt` làm `uploadedAt` khi khôi phục: đó là lúc **vứt đi**, không
phải lúc **tải lên**, và cột thời gian sẽ hiện sai ngày.

| Vào thùng rác từ | Khôi phục |
|---|---|
| Xoá 1 file ở ô đính kèm | Về đúng dòng và cột cũ |
| Xoá dòng (`doDeleteRows`) | Dòng gốc đã mất → giao diện hỏi dòng + cột đích |

Ba điều đáng biết:

- **Toàn bộ endpoint thùng rác đòi `ADMIN_KEY`**, kể cả `GET ?trash=1`. `canAdmin()`
  ở giao diện chỉ ẩn nút; hàng rào thật nằm ở `api/files.js`.
- **File đang trong thùng rác không tải tự do được nữa** — `GET ?id=` trả 404 cho
  người không phải quản trị. Nó đã bị gỡ khỏi bảng; ai biết id vẫn tải được thì
  việc xoá chẳng có nghĩa gì.
- **Dọn quá hạn chạy lười**, ngay trong request liệt kê, tối đa 10 file mỗi lần để
  không chạm trần `maxDuration` 15 giây. Không dùng S3 Lifecycle: nó xoá object mà
  không biết gì về MongoDB, để lại doc trỏ vào hư không.

Máy chủ còn tự loại khỏi danh sách thùng rác những file **đang được bảng tham
chiếu**. Đó là lớp tự chữa lành: nếu `save()` xong mà bước `restore` hỏng giữa
chừng, file tự biến khỏi thùng rác ở lần mở sau thay vì nằm lại gây hoang mang.

Thứ tự khi khôi phục là **bắt buộc**: ghi bảng (`save()`, có bảo vệ xung đột 409)
trước, gọi `?action=restore` sau. Làm ngược lại thì lúc ghi bảng hỏng, file đã bỏ
cờ `trashed` mà không dòng nào trỏ tới — không nằm trong bảng, cũng không còn
trong thùng rác.

### `?signed=1` — vì sao cần

`GET /api/files?id=…&signed=1` trả URL đã ký dạng JSON thay vì 302. Thẻ `<a>` và
`window.open` không gửi được header, mà file trong thùng rác lại đòi `x-edit-key`.
Giao diện xin URL kèm header (cùng origin) rồi mở thẳng URL đó. Cách này cũng
tránh CORS của bucket: điều hướng của trình duyệt không bị CORS chặn, `fetch` thì có.

Khi tải cả thùng rác vào một thư mục (File System Access API), giao diện **fetch
thẳng tới URL đã ký, không kèm header** — gửi header quyền qua chuyển hướng
cross-origin sẽ kích hoạt preflight và vướng CORS.

## Ba điều dễ làm sai — đọc trước khi sửa `api/files.js`

### 1. Không bao giờ dùng `response-content-disposition` trên presigned GET

Cách "đúng sách" để đặt tên file khi tải xuống là thêm tham số
`response-content-disposition` vào presigned GET. **Với `aws4fetch` thì cách đó
hỏng.**

Thư viện dựng canonical query bằng `encodeRfc3986(encodeURIComponent(v))`
(space → `%20`, `*` → `%2A`) nhưng URL gửi đi lấy từ `URL.toString()`
(space → `+`, `*` giữ nguyên). Chuỗi `Content-Disposition` chứa cả space lẫn `*`
(trong `filename*=UTF-8''`) → hai bên tính ra chuỗi khác nhau → chữ ký lệch →
**S3 trả 403 với mọi file mới**, trong khi mọi thứ khác trông vẫn bình thường.

**Cách đang dùng:** client gửi `Content-Disposition` và `Content-Type` làm
**header thật khi PUT**. Với `signQuery: true`, aws4fetch chỉ ký đúng header
`host` (`X-Amz-SignedHeaders=host`) nên header thừa không tham gia chữ ký —
nhưng S3 **vẫn lưu chúng làm metadata của object**. Presigned GET sau đó không
cần tham số `response-*` nào.

Hệ quả: **bỏ hai header lúc PUT thì không còn đường cứu ở phía client.** File sẽ
tải xuống với tên key ngẫu nhiên (`a1b2c3d4e5f6.dwg`) vì key cố ý chỉ chứa ASCII,
không mang tên thật. Thuộc tính `download` của thẻ `<a>` **bị trình duyệt bỏ qua
khi tài nguyên cuối khác origin**, nên sau 302 nó vô hiệu.

### 2. Mỗi HTTP method phải ký riêng

Method là **dòng đầu tiên** của canonical request trong SigV4. URL ký cho `GET`
dùng làm `HEAD` sẽ sai chữ ký và S3 trả 403. `confirm` dựa vào HEAD để xác minh
file, nên nhầm chỗ này làm **mọi lần confirm đều fail** và báo nhầm là "chưa thấy
file trên kho lưu trữ".

### 2b. URL là path-style, không phải virtual-hosted

`base` dựng thành `https://s3.<vùng>.amazonaws.com/<bucket>` — bucket nằm trong
**path**. AWS khuyến nghị virtual-hosted (`<bucket>.s3.<vùng>.amazonaws.com`),
nhưng tên bucket ở đây **có dấu chấm**, mà chứng chỉ TLS `*.s3.<vùng>.amazonaws.com`
chỉ khớp **một** nhãn — `com.vcijsc.bvtc.s3.…` sẽ lỗi TLS ở mọi request. Path-style
chạy với mọi tên bucket nên không cần rẽ nhánh.

Hệ quả cho script dọn: `ListObjectsV2` là `GET /<bucket>?list-type=2`, **không có**
dấu `/` sau tên bucket — thêm slash biến nó thành một key rỗng.

### 3. Nhánh 302 bắt buộc có `Cache-Control: no-store`

Code đọc file cũ bên dưới đặt `public, max-age=31536000, immutable`. Để header
đó rơi vào nhánh 302 là **nhét một credential 5 phút vào cache 1 năm**: 5 phút
sau, mọi lần bấm đều nhận `AccessDenied` từ S3 và không xoá được nếu không xoá
dữ liệu site. Người dùng sẽ báo "file hỏng" trong khi file hoàn toàn nguyên vẹn.

---

## Biến môi trường

| Biến | Production | Preview / Development |
|---|---|---|
| `S3_ACCESS_KEY_ID` | Access Key ID của IAM user | như production |
| `S3_SECRET_ACCESS_KEY` | Secret Access Key | như production |
| `S3_REGION` | vùng của bucket, vd `ap-southeast-1` | như production |
| `S3_BUCKET` | bucket thật | bucket thử nghiệm riêng |
| `MONGODB_DB` | `bim` | `bim_preview` |

**Dùng IAM user + access key dài hạn**, không dùng role/STS: presigned URL ký
bằng credential tạm sẽ chết theo token. Policy giới hạn đúng bucket:

```json
[
  { "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": "arn:aws:s3:::<bucket>/*" },
  { "Effect": "Allow",
    "Action": ["s3:ListBucket"],
    "Resource": "arn:aws:s3:::<bucket>" }
]
```

`s3:ListBucket` là bắt buộc cho script dọn. Giữ "Block all public access" **bật** —
presigned URL là request đã xác thực nên không bị chặn.

Đặt trên Vercel → Settings → Environment Variables, **chọn đúng môi trường**.

> **Bẫy đã biết:** `vercel env add` hay tạo biến với giá trị **rỗng**. Kiểm lại
> giá trị thật trên Dashboard sau khi đặt, và **phải redeploy** thì biến mới có
> hiệu lực.

Thiếu biến S3 **không** làm hỏng việc đọc file cũ: `getS3()` khởi tạo lười, chỉ
chạy khi có ai tải lên hoặc tải file S3 xuống. Nhánh đọc file cũ trong MongoDB
không bao giờ chạm tới nó.

### Access Key ID nằm trong URL là bình thường

Mọi URL đã ký đều chứa `X-Amz-Credential=<AccessKeyID>/...`. **Đó là bản chất
của SigV4, không phải rò rỉ.** Thứ duy nhất phải giữ kín là `S3_SECRET_ACCESS_KEY`
— nó không bao giờ rời khỏi function.

## CORS

Cả hai bucket cần rule cho phép `PUT`/`GET`/`HEAD` từ đúng origin. Đặt ở
AWS Console → S3 → bucket → Permissions → Cross-origin resource sharing:

```json
[
  {
    "AllowedOrigins": ["https://bvtc.vcijsc.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`AllowedHeaders: ["*"]` là bắt buộc: `Content-Disposition` không nằm trong danh
sách header an toàn của CORS, nên trình duyệt sẽ gửi preflight `OPTIONS` trước
mỗi lần PUT.

### Cách kiểm CORS thật sự đang cho phép gì

`kiem-tra-cau-hinh.mjs` có mục 4 làm việc này. Nó **không** đọc cấu hình bằng
`GetBucketCORS` — khoá API thường không có quyền đó — mà gửi đúng cái preflight
trình duyệt gửi. **200 là được phép, 403 là không.** Kiểm tay:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS \
  -H "Origin: https://bvtc.vcijsc.com" \
  -H "Access-Control-Request-Method: PUT" \
  "https://s3.ap-southeast-1.amazonaws.com/com.vcijsc.bvtc/bim/probe"
```

Phép kiểm này quan trọng hơn vẻ ngoài của nó: **mọi thứ khác trong script đều
chạy bằng Node nên không bị CORS chặn**. Bucket có thể qua sạch 11 phép thử ở mục
3 trong khi trình duyệt hoàn toàn không gọi nổi S3. Thiếu origin biểu hiện thành
`xhr.onerror` ở client, mà giao diện dịch thành "mất kết nối khi tải lên" — không
một chữ nào nhắc tới CORS.

Muốn chạy thử ở máy bằng `vercel dev` thì thêm `http://localhost:3000` vào
`AllowedOrigins`. Rủi ro thấp: vẫn phải có presigned URL hợp lệ, mà URL đó chỉ
`/api/files` cấp và nó đòi `EDIT_KEY`.

> **Đổi domain là phải sửa CORS.** Ngày 04/09/2026 trang đổi từ
> `bim-ruddy.vercel.app` sang `bvtc.vcijsc.com`; bucket đã được cập nhật theo, và
> `bim-ruddy.vercel.app` **không còn** trong `AllowedOrigins` — ai vào bằng link
> cũ vẫn xem và tải file xuống bình thường nhưng **không tải lên được**, với thông
> báo "mất kết nối khi tải lên". Danh sách origin cần kiểm nằm ở biến
> `ORIGIN_CAN` trong `kiem-tra-cau-hinh.mjs` — sửa domain thì sửa cả chỗ đó.
>
> Khoá `bim-dev` không có quyền `GetBucketCORS`/`PutBucketCORS`, nên chỉ đọc được
> CORS bằng preflight và chỉ sửa được ở AWS Console.

> **`npm run deploy:preview` sinh hostname MỚI mỗi lần**, và S3 khớp origin chính
> xác từng ký tự. **Mỗi lần** deploy preview đều phải thêm hostname mới vào CORS
> của `bucket thử nghiệm`, nếu không sẽ gặp lỗi CORS **trông y hệt lỗi chữ ký**.
> Đây là việc lặp lại, không phải ghi chú một lần.

## Xoay khoá S3

1. AWS → IAM → user đang dùng → Security credentials → **Create access key**
   (một IAM user giữ được tối đa 2 access key cùng lúc — đó là cách xoay không
   gián đoạn).
2. Cập nhật `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` trên Vercel cho **cả**
   Production và Preview/Development.
3. **Redeploy** — biến môi trường chỉ có hiệu lực sau khi deploy lại.
4. Xác minh tải lên + tải xuống chạy được, rồi mới **Deactivate** khoá cũ. Đợi
   thêm một hai ngày rồi mới Delete, để còn đường lùi.

URL đã ký bằng khoá cũ hết hiệu lực ngay khi khoá bị vô hiệu hoá. Hạn dài nhất
là 1 giờ (presigned PUT), nên chọn lúc vắng người dùng.

Bật **AWS Budgets** kèm cảnh báo. URL presigned PUT không ràng buộc kích thước
body — tham số `size` ở `sign-upload` chỉ có tính khai báo. Ai giữ `EDIT_KEY`
đều có thể xin URL rồi đẩy lên bao nhiêu tuỳ ý, mà `EDIT_KEY` là mật khẩu dùng
chung. Với S3 thì việc này tốn tiền theo cả dung lượng lẫn số request, khác S3.

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

Doc `pending` được ghi ngay ở `sign-upload` để ràng `id ↔ key ↔ người ký` một
cách nguyên tử. Nhờ đó: `confirm` không thể ghi metadata trỏ vào key của người
khác (key **không phải bí mật** — nó nằm trong path của mọi URL đã ký), `confirm`
gọi lại lần hai không vỡ, và script dọn có **danh sách pending có thẩm quyền**
thay vì đoán theo tuổi file.

## Script dọn file mồ côi

```bash
node scripts/don-file-mo-coi.mjs          # chạy khô, chỉ in ra
node scripts/don-file-mo-coi.mjs --xoa    # xoá thật
```

Script đọc `.env` ở thư mục gốc. **Kéo đúng môi trường trước khi chạy:**

```bash
npm run vercel:env      # đã có sẵn --environment production
```

Nó kiểm tra hai chiều:

- **Chiều A** — object trên S3 mà không doc nào trỏ tới → xoá được với `--xoa`.
- **Chiều B** — doc trong `bim_files` mà không dòng nào trong `bim_app` trỏ tới
  → **chỉ báo cáo**, không tự xoá.

Chiều B tồn tại vì có **bốn** đường sinh file mồ côi: `confirm` xong nhưng
`save()` hỏng; `doDeleteRows()` xoá dòng mà không bao giờ gọi `DELETE api/files`;
`removeFile` bắn-rồi-quên; và xoá từ site cũ `bim-wheat.vercel.app`. Ba đường sau
sinh ra doc *có* metadata mà *không dòng nào trỏ tới* — quét một chiều sẽ mù hoàn
toàn với chúng.

### Vì sao script có nhiều chốt an toàn đến vậy

Mọi cách hỏng của nó đều biểu hiện **y hệt nhau**: tập key rỗng. Lệch
`MONGODB_DB`, lệch `MONGODB_FILES_COLLECTION`, `.env` kéo nhầm môi trường, hay
con trỏ Mongo lỗi giữa chừng — tất cả đều làm script đọc thành "toàn bộ kho là
rác". Ngưỡng theo tuổi file **không** cứu được, vì nó chỉ giữ lại file mới nhất.

Vì vậy script dừng ngay khi: tập key rỗng · số mồ côi > 20% tổng số object · lỗi
con trỏ MongoDB · lỗi phân trang `ListObjectsV2`. Object của doc `status:"pending"`
**không bao giờ** bị coi là mồ côi — phiên tải lên có thể đang chạy dở. Với `--xoa`
còn phải **gõ lại đúng tên bucket**, và mỗi lần chạy xoá tối đa 100 object.

## Rollback

`api/files.js` có một guard: doc không có `key`, cũng không có `data`/`chunks` thì
trả **410** thay vì rơi xuống `docBuffer()`.

Guard này quan trọng khi rollback về bản code trước S3. Không có nó, `docBuffer()`
làm `Buffer.from(doc.data || "")` trên doc kiểu S3 → **buffer rỗng, không ném
lỗi** → handler trả `200` kèm đúng tên file, `Content-Length: 0` và
`Cache-Control: immutable`. Người dùng nhận file `.rvt` **0 byte**, Revit báo
hỏng, không có log ở đâu cả, và header `immutable` ghim kết quả rỗng đó **một
năm** — sống lâu hơn cả lần rollback sinh ra nó.

Quy trình rollback:

1. `vercel rollback` về bản trước khi chuyển S3
2. File S3 trả **410** kèm thông báo tiếng Việt — hỏng ồn ào, không phải 0 byte
3. File cũ trong MongoDB hoạt động bình thường
4. Object S3 và doc metadata **không bị xoá** — sửa xuôi rồi deploy lại là dùng
   được ngay
5. **Không chạy script dọn trong lúc đang rollback** — mọi doc S3 lúc đó vẫn hợp lệ

## Muốn dựng lại bản LAN (`serve.cjs`)

Cần cài thêm 3 route vào `serve.cjs`, hoặc quay lại lưu file trong `data-files/`:

- `POST ?action=sign-upload` — trả một URL mà client PUT được (có thể là route
  cục bộ của chính `serve.cjs`, không cần S3)
- `POST ?action=confirm` — ghi metadata
- `GET ?id=` — trả file

Đơn giản hơn: tách một bản `bang-hang-muc.html` riêng cho LAN. Nhưng lúc đó lại
có hai file giao diện phải giữ đồng bộ — chính là lý do bản LAN bị ngừng.

## Chi phí

Ước tính cho `ap-southeast-1` (Singapore) — **kiểm lại bảng giá hiện hành trước
khi trích dẫn con số này ra ngoài**:

| Khoản | Mức |
|---|---|
| Lưu trữ S3 Standard | ~$0,025/GB/tháng → 100GB ≈ **$2,5/tháng** |
| Egress ra internet | **100GB đầu mỗi tháng miễn phí**, sau đó ~$0,09/GB |
| Request PUT | ~$0,005/1000 |
| Request GET | ~$0,0004/1000 |

Với 10–30 người và file ~500MB, 100GB egress miễn phí tương đương khoảng **200
lượt tải/tháng** — đội này khó chạm tới, nên thực tế chỉ trả tiền lưu trữ.

*(So sánh: Cloudflare R2 rẻ hơn ở lưu trữ (~$0,015/GB) và egress luôn 0đ. Ở quy
mô hiện tại chênh lệch chỉ cỡ 1 đô/tháng, nên lý do chọn S3 là gộp một nhà cung
cấp chứ không phải giá. Nếu sau này có nhiều người ngoài tải file thường xuyên
thì egress mới thành khoản đáng kể và đáng tính lại.)*

Cân nhắc thêm **S3 Lifecycle rule** chuyển object cũ hơn 90 ngày sang
Standard-IA (~$0,0138/GB) nếu file cũ ít được mở lại. Chưa cần lúc này.
