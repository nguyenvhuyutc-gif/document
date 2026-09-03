---
phase: 5
title: "Kiểm thử, deploy, dọn dẹp"
status: in-progress
priority: P1
dependencies: [4]
---

# Giai đoạn 5: Kiểm thử, deploy, dọn dẹp

<!-- Updated: Validation Session 1 — đánh số lại 4→5 (thêm giai đoạn 4 chống ghi đè);
     gieo dữ liệu cho bim_preview; bản LAN giữ file, chỉ gỡ script npm -->

## Tổng quan

Kiểm thử đầu-cuối trên preview **có database và bucket riêng**, deploy production, ngừng
bản LAN, và viết script dọn file mồ côi có đủ chốt an toàn.

## Gieo dữ liệu cho `bim_preview`

`MONGODB_DB=bim_preview` là một database **rỗng hoàn toàn**. Nhưng các mục 6, 7, 15, R3 và
truy vấn đối chứng dương đều đòi **file cũ phải tồn tại ở đó**. Không gieo thì chúng không
chạy được — và đây chính là mâu thuẫn mà bước validate bắt được trong bản 2.

Trước khi kiểm thử, sao chép sang `bim_preview`:

| Cần | Vì sao |
|---|---|
| 1 doc `bim_files` loại **nguyên khối** (có `data`) | Mục 6, 15, R3, đối chứng dương |
| 1 doc `bim_files` loại **chia mảnh** (có `chunks`) + đủ các doc mảnh của nó | Mục 7 — nhánh `?part=` |
| 1 doc `bim_app` chứa dòng trỏ tới hai file trên | Để bấm được từ giao diện |

```js
// Chạy trong mongosh. Đây là thao tác CHỈ ĐỌC ở phía bim, chỉ ghi sang bim_preview.
var src = db.getSiblingDB("bim"), dst = db.getSiblingDB("bim_preview");
var whole = src.bim_files.findOne({ data: { $exists: true } });
var split = src.bim_files.findOne({ chunks: { $exists: true } });
if (whole) dst.bim_files.insertOne(whole);
if (split) {
  dst.bim_files.insertOne(split);
  src.bim_files.find({ _id: { $in: split.chunks } }).forEach(function (c) { dst.bim_files.insertOne(c); });
}
// Rồi tạo thủ công 1 kế hoạch trong bim_app có dòng trỏ tới _id của whole và split.
```

Chọn file **nhỏ** để sao chép cho nhanh — mục đích là kiểm nhánh code, không phải kiểm dung lượng.

## Kiểm thử trên preview

```powershell
$env:PATH = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:PATH"
$env:VERCEL_TOKEN = [Environment]::GetEnvironmentVariable("VERCEL_TOKEN","User")
npm run deploy:preview
```

> **Mỗi lần** `deploy:preview` sinh hostname mới, và R2 khớp origin chính xác từng ký tự.
> **Phải thêm hostname mới vào CORS của `bim-files-preview` trước khi test**, nếu không sẽ
> gặp lỗi CORS trông y hệt lỗi chữ ký. Đây là việc lặp lại mỗi lần deploy preview.

Preview dùng `MONGODB_DB=bim_preview` và `R2_BUCKET=bim-files-preview` (giai đoạn 1.4), nên
13 mục dưới đây **không** chạm vào dữ liệu thật. Bản 1 để preview dùng chung env với
production — nghĩa là mọi mục kiểm thử sẽ ghi thẳng vào bảng người khác đang dùng, hiện ra
sau 4 giây, và không có bước dọn nào.

### Ma trận kiểm thử

| # | Việc | Kỳ vọng |
|---|---|---|
| 1 | Tải lên `.rvt`/`.ifc` **~200MB** thật | Thành công, thanh % chạy đủ |
| 2 | Tải file đó xuống | Đúng dung lượng, **đúng tên tiếng Việt có dấu**, mở được bằng phần mềm gốc |
| 3 | Tải lên file tên `Bản vẽ kiến trúc (P1).dwg` | Tải xuống ra **nguyên tên đó**, không phải tên key |
| 4 | Tải lên ảnh JPG 5MB | Được nén trước, dung lượng lưu nhỏ hơn gốc |
| 5 | Tải lên file 201MB | Bị chặn ở client, không gọi API |
| 6 | Mở file **cũ** nguyên khối | Tải xuống bình thường |
| 7 | Mở file **cũ** chia mảnh | Tải xuống bình thường |
| 8 | Đăng xuất → thử tải lên | Báo cần mật khẩu quyền sửa |
| 9 | `EDIT_KEY` → thử xoá file | Báo cần mật khẩu quản trị |
| 10 | `ADMIN_KEY` → xoá file mới | Mất khỏi bảng, **object mất khỏi R2**, doc mất khỏi MongoDB |
| 11 | Xoá cùng file đó lần nữa | **200**, không 500 |
| 12 | Hai tab: tab 1 tải file 200MB, tab 2 sửa ô và lưu | Sau khi tab 1 xong, **sửa của tab 2 vẫn còn** |
| 13 | Gọi `confirm` hai lần cùng `id` (bằng curl) | Cả hai trả 200, `countDocuments({_id})` === 1 |
| 14 | DevTools → Network cả phiên: tìm `R2_SECRET_ACCESS_KEY` | **Không có**. *(Access Key ID **có** trong `X-Amz-Credential` — đúng thiết kế, không phải lỗi)* |
| 15 | Xoá 4 biến R2 trên preview, redeploy | `GET ?id=` file **cũ** vẫn chạy; `sign-upload` trả 500 nêu tên biến thiếu |
| 16 | Gọi `?action=chunk` bằng curl | **426** kèm câu tiếng Việt |
| 17 | `curl -sI` một file mới | Header `Cache-Control` chứa `no-store` |
| 18 | Mở `bang-hang-muc.html` bằng `file://` | Rơi về `localStorage`, huy hiệu 🟡, không gọi API |
| 19 | Hai tab cùng kế hoạch: A sửa và lưu, rồi B (chưa đồng bộ) sửa và lưu | Tab B **hiện dải cảnh báo xung đột**, không ghi đè sửa của A |
| 20 | Ở dải cảnh báo bấm **Xem bản mới**, rồi thử lại và bấm **Ghi đè** | Cả hai nhánh đều hoạt động; đồng bộ chạy lại sau đó |
| 21 | Một người dùng lưu 20 lần liên tiếp | Không lần nào hiện dải cảnh báo |
| 22 | `npm start` | Không còn script này |

Mục **3, 12, 13, 15** bắt những lỗi red team tìm ra. Mục **6, 7, 19, 20** bắt những lỗi
validate tìm ra. Đừng bỏ mục nào.

### Kiểm tra MongoDB — truy vấn đã sửa

```js
// LẤY MỐC BẰNG SỐ, không dùng ISODate. createdAt được ghi bằng Date.now() nên là
// BSON Number; thứ tự kiểu của BSON xếp MỌI số trước MỌI date, nên {$gt: ISODate(...)}
// khớp ĐÚNG BẰNG KHÔNG bất kể collection chứa gì — bản 1 dùng cách đó, luôn "đạt" vô nghĩa.
var mocBatDau = 1788000000000;   // thay bằng Date.now() ghi lại lúc bắt đầu test

db.bim_files.countDocuments({ data: { $exists: true }, createdAt: { $gt: mocBatDau } })
// → phải bằng 0

// ĐỐI CHỨNG DƯƠNG — bắt buộc chạy, để chứng minh truy vấn thật sự hoạt động:
db.bim_files.countDocuments({ data: { $exists: true } })
// → phải LỚN HƠN 0 (file cũ vẫn còn đó).
// Nếu cả hai cùng bằng 0 thì truy vấn sai, không phải "collection sạch".
```

### Kiểm tra rollback — bắt buộc

| # | Việc | Kỳ vọng |
|---|---|---|
| R1 | Trên preview, `vercel rollback` về bản trước giai đoạn 2 | Deploy xong |
| R2 | Mở một file **R2** | **410** kèm câu tiếng Việt bảo tải lại — **không phải 200 với 0 byte** |
| R3 | Mở một file **cũ** | Tải xuống bình thường |
| R4 | Deploy lại bản mới | File R2 dùng lại được ngay, không mất gì |

Đây là thứ chứng minh giai đoạn 0 làm đúng việc của nó.

## Deploy production

Dùng skill `deploy-bim`. Trước khi deploy kiểm `git status` chắc chắn **không có `.env`**.

Sau khi deploy, chạy lại mục 1, 2, 3, 6, 7, 17 trên production.

## Ngừng bản LAN

Bản 1 ghi `serve.cjs` là "ngoài phạm vi" — **sai**. Chỉ có **một** file `bang-hang-muc.html`,
và `serve.cjs` phục vụ chính nó (`serve.cjs:77`). `SERVER_MODE` suy từ giao thức chứ không
từ backend (`:956`), còn `serve.cjs` có cài `?whoami=1` (`serve.cjs:220`) nên client LAN vẫn
vào được `storageMode = "server"` rồi nói giao thức mới với một máy chủ cũ: `sign-upload`
không có body → rơi xuống nhánh POST chung → `400 "File rỗng"` cho **mọi** lần tải lên LAN.

**Quyết định của chủ dự án (validate): giữ file, chỉ gỡ lối vào.**

- **Giữ** `serve.cjs`, `start-server.bat`, `data.json` trong repo làm tư liệu
- **Giữ** các dòng tương ứng trong `.vercelignore` (file còn thì vẫn cần chặn deploy)
- **Xoá** script `start`, `dev`, `serve` và trường `main` trong `package.json`
- **Thêm** một khối chú thích ở đầu `serve.cjs`:

  ```js
  // ============================================================
  //  KHÔNG CÒN DÙNG — giữ lại làm tư liệu, KHÔNG chạy được nữa.
  //  Từ 2026-09, file đính kèm lưu ở Cloudflare R2 qua presigned URL.
  //  bang-hang-muc.html (dùng chung với bản Vercel) gọi ?action=sign-upload,
  //  mà máy chủ này không có → mọi lần tải lên sẽ báo "File rỗng".
  //  Muốn dùng lại phải cài thêm 3 route sign-upload/confirm/302 ở đây.
  // ============================================================
  ```

Gỡ script npm là đủ để không ai vô tình chạy bằng lệnh quen (`npm start`). Ai cố ý gõ
`node serve.cjs` sẽ đọc thấy chú thích ngay dòng đầu.

> **Đánh đổi cần biết:** cách này để lại trong repo một máy chủ chạy được nhưng **hỏng
> phần tải file**. Nếu sau này có người chạy `node serve.cjs` mà không đọc chú thích, họ
> sẽ gặp `400 "File rỗng"` không rõ nguyên nhân. Xoá hẳn thì không có rủi ro đó — nhưng
> chủ dự án đã cân nhắc và chọn giữ.

## Script dọn file mồ côi

`scripts/don-file-mo-coi.mjs` — chạy tay, **không** tự động. `scripts/` đã bị `.vercelignore`
chặn nên không lên bundle production.

**Script này xoá được dữ liệu thật. Mọi chốt an toàn dưới đây là bắt buộc.**

```
1. Đọc MONGODB_DB / MONGODB_FILES_COLLECTION / R2_BUCKET từ process.env
   ĐÚNG NHƯ api/files.js:23-24 đọc — KHÔNG hardcode "bim_files"
2. IN RA db / collection / bucket đã phân giải, bắt người chạy đọc trước
3. Liệt kê toàn bộ object trong bucket (ListObjectsV2, phân trang đầy đủ)
4. Lấy toàn bộ `key` trong collection — phân trang đầy đủ; LỖI CON TRỎ THÌ DỪNG HẲN,
   không được coi kết quả đọc dở là danh sách đầy đủ
5. CHẶN AN TOÀN — dừng ngay nếu bất kỳ điều nào đúng:
     · tập key rỗng
     · số orphan > 20% tổng số object
     · doc `status:"pending"` — object của chúng KHÔNG BAO GIỜ bị coi là mồ côi
6. Mặc định CHẠY KHÔ, chỉ in ra
7. Với --xoa: in tên bucket, bắt GÕ LẠI đúng tên bucket rồi mới xoá; cap 100 object/lần
8. Chiều ngược lại (chỉ BÁO CÁO, không xoá): doc trong bim_files mà `_id` không xuất hiện
   trong mảng files/filesDuyet/filesChapThuan nào của bim_app
```

**Vì sao cần chừng đó chốt:** mọi cách hỏng của script đều biểu hiện y hệt nhau — **tập key
rỗng** — và script sẽ đọc thành "toàn bộ kho là rác". Lệch `MONGODB_DB`, lệch
`MONGODB_FILES_COLLECTION`, `.env` kéo nhầm môi trường (đã sửa ở giai đoạn 1.4), hay con trỏ
Mongo lỗi giữa chừng: tất cả đều dẫn tới cùng một kết cục. Ngưỡng 7 ngày **không** cứu được,
vì nó chỉ giữ lại file mới nhất.

Chiều ngược lại tồn tại vì có **bốn** đường sinh file mồ côi chứ không phải một:
`confirm` xong nhưng `save()` hỏng; xoá dòng bằng `doDeleteRows()` (`:2670-2678`) vốn **không
bao giờ** gọi `DELETE api/files`; `removeFile` bắn-rồi-quên (`:1646-1647`); và xoá từ site cũ
`bim-wheat`. Ba đường sau sinh ra doc *có* metadata mà *không dòng nào trỏ tới* — script chỉ
quét một chiều sẽ mù hoàn toàn với chúng.

**Chỉ báo cáo, chưa xoá** ở chiều ngược lại cho tới khi số liệu đủ tin.

## Cập nhật tài liệu

### `CLAUDE.md`

| Chỗ | Sửa thành |
|---|---|
| Bảng cấu trúc | File đính kèm ở Cloudflare R2, MongoDB chỉ giữ metadata. Đánh dấu `serve.cjs`/`data.json` là **tư liệu, không chạy được** |
| Phân quyền | Bỏ "3 bản giống nhau — sửa một chỗ thì sửa cả ba"; nay chỉ đồng bộ `api/data.js` + `api/files.js`, `serve.cjs` đứng ngoài |
| Bảo mật | Thêm 4 biến R2. Ghi rõ `.vercelignore` chặn `*.md`/`docs`/`plans`/`scripts`/`scratch` và **đừng gỡ** |
| Lệnh | Xoá `npm start`, `npm run dev`, `npm run serve` |
| Đồng bộ | Ghi rõ `POST /api/data?plan=` nay cần `ifMtime`, và 409 nghĩa là xung đột chứ không phải lỗi |

### `README.md`

Viết lại phần đầu: ứng dụng chạy trên Vercel, bản LAN đã ngừng và bị xoá. Giữ phần lịch sử
nếu muốn nhưng ghi rõ là đã bỏ.

### `docs/luu-file-r2.md` (mới)

Sơ đồ luồng, 4 biến môi trường, cách xoay khóa R2, cách chạy script dọn, và **ghi rõ Access
Key ID xuất hiện trong URL đã ký là bình thường** — để lần sau không ai tưởng là rò rỉ.

## File liên quan

- Tạo: `docs/luu-file-r2.md`, `scripts/don-file-mo-coi.mjs`
- Sửa: `CLAUDE.md`, `README.md`, `package.json` (gỡ script LAN), `serve.cjs` (thêm chú thích đầu file)
- **Không xoá file nào** — quyết định của chủ dự án ở bước validate

## Tiêu chí hoàn thành

- [ ] Đã gieo dữ liệu `bim_preview`: có ≥1 doc `data`, ≥1 doc `chunks` kèm đủ mảnh, và 1 kế hoạch trỏ tới chúng
- [ ] 22 mục kiểm thử đạt trên preview
- [ ] 4 mục rollback R1–R4 đạt
- [ ] Truy vấn MongoDB đạt **và đối chứng dương trả > 0**
- [ ] Đã deploy production; chạy lại mục 1, 2, 3, 6, 7, 17, 19 đạt
- [ ] `npm start` / `npm run dev` / `npm run serve` không còn; `serve.cjs` có khối chú thích ở đầu file
- [ ] `serve.cjs`, `start-server.bat`, `data.json` **vẫn còn** trong repo và **vẫn** nằm trong `.vercelignore`
- [ ] `scripts/don-file-mo-coi.mjs` chạy khô in đúng db/collection/bucket đã phân giải
- [ ] **Thử script với `MONGODB_FILES_COLLECTION` sai → script DỪNG vì tập key rỗng, không báo "toàn bộ là mồ côi"**
- [ ] Chiều ngược lại chạy được ở chế độ chỉ-báo-cáo
- [ ] `CLAUDE.md`, `README.md` đã cập nhật; `docs/luu-file-r2.md` tồn tại
- [ ] `curl` `/CLAUDE.md` và `/docs/luu-file-r2.md` trên production → **404**
- [ ] `git status` sạch, không có `.env`, không có `scratch/`

## Rủi ro

| Rủi ro | Cách xử lý |
|---|---|
| Quên thêm origin preview sau mỗi lần deploy preview | Lỗi CORS giống hệt lỗi chữ ký. Việc lặp lại, không phải một lần |
| Chạy `--xoa` khi `.env` trỏ sai môi trường | Chốt chặn ở bước 5 + bắt gõ lại tên bucket + cap 100 |
| Ai đó chạy `node serve.cjs` rồi gặp "File rỗng" khó hiểu | Khối chú thích ở đầu file nêu rõ nguyên nhân và cách khắc phục. Đánh đổi đã biết của quyết định giữ file |
| Gieo nhầm dữ liệu từ `bim_preview` ngược về `bim` | Đoạn mongosh chỉ `insertOne` vào `dst`; `src` chỉ đọc. Đọc kỹ trước khi chạy |
| Deploy production khi chưa test đủ | Bắt buộc qua preview. Không rút gọn |
| Test trên site cũ `bim-wheat` rồi kết luận nhầm | Chỉ test `bim-ruddy` và domain preview |

---

## Whole-Plan Consistency Sweep

- **Files reread:** `plan.md`, `phase-00`, `phase-01`, `phase-02`, `phase-03`, `phase-04`, `phase-05`
- **Decision deltas checked:** 15 (red team) + 4 (validate) = **19**

| Delta | Đã đồng bộ ở |
|---|---|
| Bỏ `response-content-disposition`, gắn header lúc PUT | plan.md § Kiến trúc · phase-01 test 2&3 · phase-02 § Tên file · phase-03 `uploadDirect` |
| Thuộc tính `download` ở `:1387` | plan.md § Vì sao không sửa client · phase-03 § Phía tải xuống + `grep` |
| Guard 410 + `no-store` + rollback | **phase-00 (mới)** · plan.md § Rollback · phase-02 GET · phase-04 R1–R4 |
| `pending` → `ready`, `confirm` idempotent | plan.md § Hình dạng document · phase-02 · phase-04 mục 13 |
| Ký `HEAD` riêng | phase-01 test 4 · phase-02 `confirm` |
| Thu hẹp `filesBusy` + `findRow()` lại | phase-03 · phase-04 mục 12 |
| `getR2()` lười | phase-02 · phase-04 mục 15 |
| Bảng gỡ bỏ đủ (`POST ?name=`, `MAX_FILE`) | phase-02 § Gỡ bỏ |
| Ngừng bản LAN (**giữ file**, gỡ script npm) | plan.md § Phạm vi · phase-05 § Ngừng bản LAN |
| *(validate)* Gieo dữ liệu `bim_preview` | phase-05 § Gieo dữ liệu · mục 6, 7, 15, R3 |
| *(validate)* `ifMtime` chống ghi đè | **phase-04 (mới)** · plan.md § Phạm vi, § Rủi ro · phase-05 mục 19–21 |
| *(validate)* Đo dung lượng file cũ | phase-00 bước 3 · plan.md § Phạm vi |
| Preview tách DB + bucket | phase-01 §1.1/§1.4 · phase-04 § Kiểm thử |
| Script dọn có chốt an toàn | phase-04 § Script dọn |
| Truy vấn epoch số + đối chứng dương | phase-04 § Kiểm tra MongoDB · plan.md tiêu chí 6 |
| Tiêu chí "khóa R2" viết lại | plan.md tiêu chí 7 · phase-04 mục 14 |
| `retryUp` thật sự được gọi | phase-03 `uploadDirect` + `grep` |
| `.vercelignore` / `.gitignore` | **đã thực hiện** · phase-00 · phase-04 |

- **Reconciled stale references:** `--accent-soft` (không tồn tại → `--accent-weak`) ·
  `localhost:3000` (→ xoá, cổng thật 8787) · "lifecycle rule" (→ script thủ công) ·
  bim-wheat từ "Thấp" → "Cao" · "150 dòng" → 90 dòng · `serve.cjs` từ "ngoài phạm vi" → xoá hẳn
- **Unresolved contradictions: 0**

### Việc tách ra làm sau (không nằm trong plan này)

1. `api/data.js` là last-write-wins, không kiểm version — giai đoạn 3 chỉ thu cửa sổ nguy
   hiểm chứ không đóng hẳn. Sửa triệt để cần điều kiện `mtime` ở `POST /api/data?plan=`.
2. `global.__mongoClient` cache không kiểm tra sức khoẻ (`api/files.js:47-54`,
   `api/data.js:45-53`) — một lần Atlas rớt là đầu độc mọi request trên instance đó.
   *(Red team finding #16, bị bác khỏi plan này vì là lỗi sẵn có và chạm sang `api/data.js`.)*
3. `doDeleteRows()` (`:2670-2678`) không xoá file đính kèm của dòng bị xoá — rò rỉ sẵn có,
   nay tốn kém hơn vì mỗi file tới 200MB.
