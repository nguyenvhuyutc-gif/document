---
phase: 4
title: "Chống ghi đè ở api/data.js"
status: in-progress
priority: P1
dependencies: [3]
---

# Giai đoạn 4: Chống ghi đè ở `api/data.js`

<!-- Updated: Validation Session 1 — người dùng chọn đưa vào lần này thay vì để làm sau -->

## Tổng quan

Thêm điều kiện `mtime` vào đường lưu dữ liệu bảng, để một người lưu bản cũ không xoá mất
chỉnh sửa của người khác.

> **Giai đoạn này do validate thêm vào.** Bản 2 của plan xếp nó là "việc làm sau", nhưng
> chủ dự án quyết định đưa vào ngay. Đúng: giai đoạn 3 chỉ thu cửa sổ nguy hiểm từ hàng
> chục phút xuống vài trăm ms — **không đóng hẳn**. Với 10–30 người dùng chung một bảng,
> vài trăm ms vẫn đủ để mất dữ liệu, và lỗi này đã tồn tại từ trước chứ không do R2 sinh ra.

## Vấn đề

`api/data.js:155-159` ghi **nguyên cả document** bằng `$set` **không kiểm điều kiện gì**:

```js
await collection.updateOne(
  { _id: planId },
  { $set: { data: payload, updatedAt }, $setOnInsert: { name: "Kế hoạch 1", createdAt: updatedAt } },
  { upsert: true }
);
```

Client cũng đẩy nguyên cả `{rows, people, statuses}` (`bang-hang-muc.html:1095-1097`). Nghĩa là
**người lưu sau luôn thắng, và mọi thay đổi của người lưu trước biến mất không dấu vết** —
không cảnh báo, không nhật ký, không hoàn tác.

## Điểm thuận lợi: client đã sẵn dữ liệu cần

Không phải thêm cơ chế theo dõi nào:

| Có sẵn | Ở đâu |
|---|---|
| `var serverMtime = 0` | `bang-hang-muc.html:959` |
| Cập nhật sau khi lưu | `:1100` — `serverMtime = j.mtime \|\| serverMtime` |
| Cập nhật sau mỗi vòng đồng bộ | `:1135-1136` |
| Đặt khi mở kế hoạch | `:3175` — `serverMtime = j.mtime \|\| 0` |
| `GET /api/data?plan=` đã trả `mtime` | `api/data.js:150-152` |

Chỉ cần **gửi kèm giá trị đó khi lưu** và cho máy chủ kiểm.

## Phía máy chủ — `api/data.js`

```js
if (req.method === "POST") {
  // … đọc payload như cũ …
  const updatedAt = Date.now();
  const ifMtime = Number(q.get("ifMtime") || 0);

  // ifMtime = 0 → giữ nguyên hành vi cũ (upsert). Cần cho: kế hoạch mới chưa có
  // document, VÀ cho các tab đang mở bản HTML cũ chưa biết gửi tham số này.
  if (!ifMtime) {
    await collection.updateOne(
      { _id: planId },
      { $set: { data: payload, updatedAt }, $setOnInsert: { name: "Kế hoạch 1", createdAt: updatedAt } },
      { upsert: true }
    );
    return sendJson(res, 200, { ok: true, mtime: updatedAt });
  }

  // Có ifMtime → chỉ ghi khi document trên máy chủ vẫn đúng bản mà client đã đọc.
  const r = await collection.updateOne(
    { _id: planId, updatedAt: ifMtime },
    { $set: { data: payload, updatedAt } }
  );
  if (r.matchedCount === 1) return sendJson(res, 200, { ok: true, mtime: updatedAt });

  // Không khớp → có người khác đã lưu. KHÔNG ghi đè. Trả bản trên máy chủ về
  // để client có đủ thứ cần cho việc quyết định.
  const cur = await collection.findOne({ _id: planId });
  return sendJson(res, 409, {
    ok: false, conflict: true,
    mtime: cur ? (cur.updatedAt || 0) : 0,
    data: cur ? (cur.data || null) : null
  });
}
```

## Phía client — `bang-hang-muc.html`

**1. Gửi kèm `ifMtime` trong `pushToServer()`** (`:1094-1104`):

```js
var url = API + "?plan=" + encodeURIComponent(state.planId) + "&ifMtime=" + (serverMtime || 0);
```

**2. Xử lý 409 — không được im lặng bỏ, cũng không được tự ghi đè:**

```js
// 409 = có người khác đã lưu trong lúc mình đang sửa. Đây là lúc DUY NHẤT
// người dùng có đủ thông tin để quyết định, nên phải hỏi chứ không tự xử.
if (j && j.conflict) {
  savePending = false;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  syncPaused = true;                 // dừng vòng đồng bộ để bản của họ không bị nuốt
  showConflictBanner(j);             // hiện dải cảnh báo, không đóng được bằng Esc
  return;
}
```

**3. Dải cảnh báo — hai lựa chọn rõ ràng:**

```
⚠ Có người khác vừa sửa bảng này. Thay đổi của bạn CHƯA được lưu.

   [ Xem bản mới ]   ← lấy j.data về, mất thay đổi đang chờ của bạn
   [ Ghi đè bằng bản của tôi ]   ← lưu lại với ifMtime = j.mtime, xoá sửa của người kia
```

- **Xem bản mới:** nạp `j.data`, đặt `serverMtime = j.mtime`, bật lại đồng bộ
- **Ghi đè:** gọi lại `pushToServer` với `serverMtime = j.mtime` — lần này sẽ khớp và ghi được

Dải cảnh báo phải **ở lại cho tới khi người dùng bấm**. Vòng đồng bộ dừng trong lúc đó,
nếu không nó sẽ kéo bản của người kia về và xoá luôn màn hình của người này — đúng cái
lỗi ta đang sửa.

> **Vì sao không tự động gộp:** dữ liệu là một mảng dòng có thứ tự, người dùng sửa được
> mọi ô. Gộp tự động sẽ sai âm thầm, mà sai âm thầm là thứ tệ hơn cả lỗi hiện tại. Hỏi
> người dùng là lựa chọn trung thực duy nhất ở quy mô này.

## Tương thích ngược

Tab đang mở bản HTML cũ không gửi `ifMtime` → rơi vào nhánh `!ifMtime` → hành vi y như
hiện nay. Không hỏng gì, nhưng cũng không được bảo vệ. Đây là lý do nữa để shim 426 ở
giai đoạn 2 nhắc người dùng tải lại trang.

Site cũ `bim-wheat.vercel.app` cũng không gửi tham số này — nó vẫn ghi đè được như trước.
Nằm trong phần rủi ro chủ dự án đã chấp nhận.

## File liên quan

- Sửa: `api/data.js` — nhánh POST
- Sửa: `bang-hang-muc.html` — `pushToServer()`, thêm dải cảnh báo xung đột + CSS
- Không đụng: `api/files.js`, `serve.cjs`

## Tiêu chí hoàn thành

- [ ] Hai tab mở cùng kế hoạch. Tab A sửa và lưu. Tab B (chưa đồng bộ) sửa và lưu → tab B **hiện dải cảnh báo**, không ghi đè
- [ ] Bấm **Xem bản mới** → tab B hiện đúng bản của tab A, đồng bộ chạy lại
- [ ] Bấm **Ghi đè bằng bản của tôi** → lưu thành công, tab A thấy bản của B sau vòng đồng bộ kế
- [ ] Trong lúc dải cảnh báo hiện, vòng đồng bộ **dừng** — nội dung đang sửa không bị thay
- [ ] Một người dùng bình thường (không xung đột) lưu 20 lần liên tiếp → không lần nào ra 409
- [ ] Tạo kế hoạch mới rồi lưu lần đầu → chạy được (nhánh `ifMtime = 0`)
- [ ] Gọi `POST /api/data?plan=X` **không** kèm `ifMtime` → vẫn ghi được (tương thích ngược)
- [ ] Gọi kèm `ifMtime` sai → **409** kèm `data` và `mtime` của bản trên máy chủ
- [ ] Đổi tên và xoá kế hoạch vẫn chạy bình thường (không đụng tới hai nhánh đó)

## Rủi ro

| Rủi ro | Cách xử lý |
|---|---|
| Dải cảnh báo hiện nhầm khi chỉ có một người dùng | `serverMtime` được cập nhật sau **mọi** lần lưu và mọi vòng đồng bộ. Tiêu chí có mục lưu 20 lần liên tiếp |
| Không dừng đồng bộ lúc hiện cảnh báo | Vòng đồng bộ sẽ nuốt bản đang sửa — đúng lỗi đang sửa. Có mục kiểm riêng |
| Người dùng luôn bấm "Ghi đè" cho nhanh | Vẫn tốt hơn hiện tại: ít nhất họ **biết** mình đang ghi đè |
| Quên nhánh `ifMtime = 0` → kế hoạch mới không lưu được | Có mục kiểm riêng cho lần lưu đầu |
