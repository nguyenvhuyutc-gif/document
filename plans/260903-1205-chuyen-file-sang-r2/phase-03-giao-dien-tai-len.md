---
phase: 3
title: "Sửa luồng tải lên ở giao diện"
status: in-progress
priority: P1
dependencies: [2]
---

# Giai đoạn 3: Sửa luồng tải lên ở giao diện

## Tổng quan

Thay cơ chế cắt mảnh bằng: xin URL → `XMLHttpRequest.PUT` thẳng lên R2 → gọi `confirm`.
Nâng giới hạn lên 200MB, thêm thanh tiến độ %, và **thu hẹp phạm vi `filesBusy`** để
việc tải file không còn ăn mất chỉnh sửa của người khác.

## Yêu cầu

**Chức năng:**
- Tải lên file tới 200MB qua 3 bước sign → PUT → confirm
- **PUT phải kèm header `Content-Disposition` và `Content-Type`** — đây là nguồn duy nhất
  của tên file khi tải xuống
- Hiện % tiến độ thật
- Đồng bộ với máy chủ **không bị đóng băng** trong lúc PUT
- File cũ vẫn tải xuống được

**Phi chức năng:**
- Giữ phong cách code hiện tại: ES5, `var`, chuỗi `Promise`, không thư viện ngoài

## Phía tải xuống: không sửa dòng nào — nhưng vì lý do khác bản 1

`bang-hang-muc.html:1384-1389`:

```js
a.href = f.url || f.dataUrl || "#";
a.setAttribute("download", f.name || "file");          // ← BẢN 1 BỎ SÓT DÒNG NÀY
a.setAttribute("title", fileTooltip(f));
if (f.chunks) { a.setAttribute("data-chunks", …); }
```

Trình duyệt **bỏ qua `download` khi tài nguyên cuối khác origin** (Chrome 65+, Firefox,
Safari), nên sau 302 sang R2 thuộc tính này vô hiệu. Bản 1 trích dòng 1386 rồi nhảy sang
1389 và kết luận "không cần sửa" — kết luận đúng, lập luận sai.

**Lập luận đúng:** giữ nguyên `download` vì file **cũ** vẫn cùng origin và vẫn cần nó. File
mới thì tên đến từ `Content-Disposition: attachment` **đã lưu sẵn trên object R2** lúc PUT,
nên trình duyệt vẫn tải xuống đúng tên tiếng Việt.

Hệ quả: **nếu bỏ header lúc PUT thì không còn đường cứu ở phía client** — file sẽ lưu thành
`a1b2c3d4e5f6.dwg`, vì plan cố ý không nhét tên thật vào key.

`bang-hang-muc.html:2289-2299` chỉ chặn thẻ có `data-chunks`, không gọi `preventDefault`
với link R2 → xác nhận không có handler nào cản.

## Hàm mới thay `uploadChunked`

```js
// Header Content-Disposition chỉ được chứa ASCII, nên dùng đúng cách api/files.js:141,144-145
// đang làm: tên rút gọn ASCII + filename*=UTF-8'' cho tên thật.
function dispositionHeader(name) {
  var nm = String(name || "file");
  var ascii = nm.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nm);
}

// Tải 1 file lên R2: xin URL → PUT thẳng → báo server ghi metadata.
// Dùng XMLHttpRequest chứ không dùng fetch vì fetch không báo được tiến độ tải LÊN.
function uploadDirect(proc, onProgress) {
  return retryUp(function () {
    return fetch("api/files?action=sign-upload"
        + "&name=" + encodeURIComponent(proc.name)
        + "&type=" + encodeURIComponent(proc.type)
        + "&size=" + proc.blob.size,
        { method: "POST", headers: authHeaders() }).then(apiJson);
  }, 3).then(function (s) {
    if (!s || !s.ok || !s.uploadUrl) throw new Error((s && s.error) || "không xin được đường tải lên");
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("PUT", s.uploadUrl, true);
      // BẮT BUỘC: R2 lưu hai header này làm metadata của object. Đây là NGUỒN DUY NHẤT
      // của tên file và MIME lúc tải xuống — bỏ đi thì file lưu ra tên key ngẫu nhiên.
      // An toàn vì signQuery chỉ ký `host`, header thừa không tham gia chữ ký.
      xhr.setRequestHeader("Content-Disposition", dispositionHeader(proc.name));
      xhr.setRequestHeader("Content-Type", proc.type || "application/octet-stream");
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = function () {
        (xhr.status >= 200 && xhr.status < 300)
          ? resolve(s)
          : reject(new Error("kho lưu trữ trả lỗi HTTP " + xhr.status));
      };
      xhr.onerror = function () { reject(new Error("mất kết nối khi tải lên")); };
      xhr.send(proc.blob);
    });
  }).then(function (s) {
    return retryUp(function () {
      return fetch("api/files?action=confirm&id=" + encodeURIComponent(s.id)
          + "&key=" + encodeURIComponent(s.key)
          + "&name=" + encodeURIComponent(proc.name)
          + "&type=" + encodeURIComponent(proc.type),
          { method: "POST", headers: authHeaders() }).then(apiJson);
    }, 3);
  });
}
```

`retryUp` bọc **sign** và **confirm** (không bọc PUT — không thử lại 200MB tự động).
Bản 1 khai hai lần là "vẫn dùng `retryUp`" nhưng code mẫu của chính nó gọi `fetch` trần;
sau khi xoá `uploadChunked` thì `retryUp` còn **0 caller** và thành code chết. Việc bọc
`confirm` chỉ an toàn vì giai đoạn 2 đã làm `confirm` idempotent.

## Sửa `Content-Type` — đính chính lập luận của bản 1

Bản 1 viết "client **không gửi** `Content-Type`". **Không làm được.** `xhr.send(blob)` luôn
tự đặt `Content-Type` từ `blob.type`, và `maybeCompress` còn tạo blob gắn cứng `image/jpeg`
(`bang-hang-muc.html:1336-1338`). Không viết dòng nào cũng không ngăn được trình duyệt.

Lý do **thật** khiến nó vô hại: với `signQuery: true`, aws4fetch chỉ ký `host`, và
`content-type` nằm trong `UNSIGNABLE_HEADERS` — header thừa không bao giờ tham gia chữ ký.
Vì vậy plan **chủ động đặt** cả hai header, thay vì né tránh chúng.

Ghi đúng lý do là quan trọng: ai đó sau này chuyển sang ký header sẽ tìm hiểu vì sao, và
lời giải thích sai sẽ đẩy họ đi sai đường.

## Sửa phạm vi `filesBusy` — chặn mất dữ liệu

**Vấn đề:** `filesBusy = true` đặt ở `:1593` và giữ tới `:1630`, tức suốt cả lần tải. Vòng
đồng bộ 4 giây tại `:1126` bỏ qua khi cờ này bật, nên `state.rows` **đứng yên**. Khi xong,
`save()` → `pushToServer()` đẩy **nguyên cả document** (`:1095-1097`) và `api/data.js:155-159`
ghi đè bằng `$set` **không kiểm version**.

Với 50MB thì cửa sổ này vài giây. Với **200MB × 3 file tuần tự** thì là **hàng chục phút**:
A đính kèm file, B sửa 10 chỗ và lưu, A xong → **mọi sửa của B bị xoá sạch, im lặng**, phía
sau một thông báo xanh "Đã đính kèm 3 file". Vòng đồng bộ kế tiếp của B kéo bản của A về và
ghi đè luôn màn hình B. Bản 1 không nhắc gì tới chuyện này.

**Sửa:**

1. **Không** bật `filesBusy` trước khi PUT. PUT không đụng tới máy chủ của mình nữa, nên
   không có lý do gì phải dừng đồng bộ.
2. Chỉ bật `filesBusy` từ khi gọi `confirm` cho tới sau `save()` — cửa sổ vài trăm ms.
3. **Tra lại dòng sau khi `confirm` trả về**, vì trong lúc PUT vòng đồng bộ có thể đã thay
   `state.rows` và biến `row` bắt được từ trước đã cũ:

   ```js
   // KHÔNG dùng lại biến `row` bắt được trước khi PUT — đồng bộ có thể đã thay state.rows.
   var freshRow = findRow(rowId);
   if (!freshRow) { toast("Dòng đã bị xoá trong lúc tải — file không được gắn"); return; }
   if (!Array.isArray(freshRow[fkey])) freshRow[fkey] = [];
   freshRow[fkey].push(j.file);
   ```

4. Vì có thể render lại giữa chừng, `onProgress` phải **truy vấn lại ô** theo selector mỗi
   lần thay vì giữ tham chiếu DOM cũ (tham chiếu cũ sẽ rời khỏi cây và thanh % đứng im).

> Đây **không** giải quyết triệt để bài toán ghi đè — `api/data.js` vẫn là last-write-wins.
> Nó chỉ thu cửa sổ nguy hiểm từ hàng chục phút xuống còn vài trăm ms. Sửa triệt để cần
> điều kiện `mtime` ở `POST /api/data?plan=`, nằm ngoài phạm vi lần này. **Ghi lại thành
> việc tiếp theo.**

## Thanh tiến độ

Ô file đã có class `.uploading` gắn ở dòng **1595**, và CSS sẵn ở **dòng 377–379**:

```css
.files-cell.uploading { opacity: .55; pointer-events: none; }
.files-cell.uploading .file-add { position: relative; }
.files-cell.uploading .file-add span::after { content: " · đang tải…"; }
```

Sửa khối này (không thêm DOM mới):

```css
.files-cell.uploading {
  opacity: .55; pointer-events: none;
  background: linear-gradient(to right,
    var(--accent-weak) calc(var(--up, 0) * 100%),
    transparent calc(var(--up, 0) * 100%));
}
.files-cell.uploading .file-add span::after { content: " · " attr(data-up) "%"; }
```

> `--accent-weak` là biến **đã có** (dòng 66 và 74, đủ bản sáng và tối).
> Không có biến tên `--accent-soft` — đừng dùng.

```js
onProgress = function (r) {
  // Truy vấn lại mỗi lần: đồng bộ vẫn chạy trong lúc PUT nên ô có thể đã được render lại.
  var c = tbody.querySelector('.files-cell[data-id="' + rowId + '"][data-fkey="' + fkey + '"]');
  if (!c) return;
  c.classList.add("uploading");
  c.style.setProperty("--up", r.toFixed(3));
  var add = c.querySelector(".file-add span");
  if (add) add.setAttribute("data-up", String(Math.round(r * 100)));
};
```

Đặt `data-up="0"` khi bắt đầu để chữ không rỗng ở khoảnh khắc đầu tiên.

## Hằng số

```js
var MAX_UPLOAD = 200 * 1024 * 1024;   // 50MB → 200MB
// var CHUNK_SIZE = ...               ← xóa
```

## Gỡ bỏ

| Gỡ | Dòng |
|---|---|
| `dropChunks()` | 1531 (1 caller: `:1560`, cũng bị xoá) |
| `uploadChunked()` | 1536 (1 caller: `:1608`) |
| `CHUNK_SIZE` | 1298 (3 chỗ dùng: `:1537`, `:1542`, `:1607`) |
| Nhánh rẽ `size > CHUNK_SIZE ? … : fetch(…)` | quanh `:1607-1611` |

**Giữ nguyên tuyệt đối:** `downloadChunked()` (file cũ), dòng 1386–1389 (`href`, `download`,
`title`, `data-chunks`), `:2297`, `maybeCompress`, `apiJson`, `retryUp` (nay do `uploadDirect`
gọi), nhánh `localStorage` khi mở `file://`.

## File liên quan

- Sửa: `bang-hang-muc.html` — vùng "File đính kèm" (~1290–1660) và khối CSS dòng 377–379
- Không đụng: `api/*`

## Tiêu chí hoàn thành

- [ ] Tải lên file 1MB → thành công, tải xuống được
- [ ] Tải lên file **200MB** → thành công, thanh % chạy từ 0 đến 100
- [ ] **Tải lên file tên `Bản vẽ kiến trúc (P1).dwg` → tải xuống đúng nguyên tên đó**
- [ ] Tải lên file 201MB → báo "quá lớn", không gọi API
- [ ] Ảnh JPG 5MB → vẫn được nén trước khi tải
- [ ] Chọn 3 file cùng lúc → cả 3 lên đủ
- [ ] **Trong lúc tải file 200MB, tab thứ hai sửa một ô và lưu → sau khi tab 1 tải xong, sửa của tab 2 VẪN CÒN**
- [ ] Xoá dòng ở tab 2 trong lúc tab 1 đang tải → tab 1 báo "Dòng đã bị xoá", không ném lỗi
- [ ] Ngắt mạng giữa chừng → báo lỗi rõ, không treo icon xoay vĩnh viễn
- [ ] Chưa đăng nhập → báo cần mật khẩu, không gọi PUT
- [ ] File **cũ** vẫn tải xuống được (cả nguyên khối lẫn chia mảnh)
- [ ] Mở bằng `file://` → vẫn rơi về `localStorage`, không gọi API
- [ ] `grep -c "uploadChunked\|dropChunks\|CHUNK_SIZE" bang-hang-muc.html` → `0`
- [ ] `grep -c "downloadChunked" bang-hang-muc.html` → vẫn > 0
- [ ] `grep -c "retryUp" bang-hang-muc.html` → ≥ 3 (định nghĩa + 2 chỗ gọi trong `uploadDirect`)
- [ ] `grep -c 'setAttribute("download"' bang-hang-muc.html` → vẫn `1`

## Rủi ro

| Rủi ro | Cách xử lý |
|---|---|
| Quên `setRequestHeader("Content-Disposition", …)` | Mọi file mới lưu ra tên key ngẫu nhiên, và **không có đường sửa ở client**. Tiêu chí có mục tên tiếng Việt riêng |
| Xóa nhầm `downloadChunked` khi dọn code mảnh | Tên gần giống `uploadChunked`. Đã có mục `grep` kiểm |
| Xóa nhầm dòng `setAttribute("download")` vì tưởng thừa | File **cũ** vẫn cần nó. Đã có mục `grep` kiểm |
| Dùng lại biến `row` cũ sau khi PUT | Gắn file vào bản sao đã lỗi thời → file biến mất sau lần đồng bộ kế tiếp. Bắt buộc `findRow()` lại |
| Giữ `filesBusy` suốt lúc PUT cho tiện | Quay lại đúng lỗi mất dữ liệu ở trên. Tiêu chí có mục hai tab |
| Tải 200MB đứt giữa chừng phải làm lại | Chấp nhận. `retryUp` chỉ bọc sign/confirm, không bọc PUT |
