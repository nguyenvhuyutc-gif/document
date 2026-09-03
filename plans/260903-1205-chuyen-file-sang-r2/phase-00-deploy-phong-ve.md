---
phase: 0
title: "Deploy phòng vệ (chốt an toàn rollback)"
status: in-progress
priority: P1
dependencies: []
---

# Giai đoạn 0: Deploy phòng vệ

## Tổng quan

Một thay đổi rất nhỏ vào code **hiện tại**, deploy **riêng một mình**, trước mọi thứ khác.
Đây là thứ duy nhất làm cho `vercel rollback` an toàn về sau.

> Giai đoạn này **không** đụng gì tới R2. Không cần bucket, không cần biến môi trường mới.
> Có thể làm ngay hôm nay, kể cả khi chưa có tài khoản Cloudflare.

## Vì sao cần

`docBuffer()` tại `api/files.js:76-78`:

```js
function docBuffer(doc) {
  return doc.data && doc.data.buffer ? Buffer.from(doc.data.buffer) : Buffer.from(doc.data || "");
}
```

Doc kiểu R2 (chỉ có `key`, không có `data`, không có `chunks`) đi qua đây thành
**buffer rỗng, không ném lỗi**. Handler tiếp tục chạy tới `api/files.js:140-147` và trả:

- `200 OK`
- đúng `Content-Type`, đúng tên file tiếng Việt
- `Content-Length: 0`
- `Cache-Control: public, max-age=31536000, immutable`

Người dùng nhận file `.rvt` **0 byte**. Revit báo hỏng. Không có log lỗi ở đâu cả. Và
header `immutable` ghim kết quả rỗng đó **một năm** trong cache trình duyệt — sống lâu
hơn cả lần rollback sinh ra nó.

Nghĩa là nếu không có giai đoạn này, **rollback biến một lỗi ồn ào thành hỏng dữ liệu
âm thầm**. Đó là kiểu rollback tệ nhất.

## Thay đổi

Trong nhánh `GET` của `api/files.js`, ngay **sau** khi tìm được doc và **trước** mọi xử lý
`chunks`/`data`, chèn:

```js
// Chốt an toàn cho tương lai: doc kiểu R2 (chỉ có `key`) lọt vào bản code này thì
// docBuffer() sẽ trả buffer rỗng mà không báo lỗi, và người dùng nhận file 0 byte
// kèm cache 1 năm. Thà hỏng ồn ào còn hơn hỏng im lặng.
if (!doc.data && !Array.isArray(doc.chunks)) {
  res.setHeader("Cache-Control", "no-store");
  res.status(410).json({
    ok: false,
    error: "File này lưu ở kho mới, bản web đang chạy chưa đọc được. Hãy tải lại trang."
  });
  return;
}
```

Với dữ liệu hôm nay đây là **no-op tuyệt đối** — mọi doc hiện có đều có `data` hoặc `chunks`.

Deploy kèm luôn thay đổi `.vercelignore` / `.gitignore` **đã thực hiện** (chặn `*.md`,
`docs`, `plans`, `scripts`, `scratch`) — nó cũng là bản vá độc lập, không liên quan R2.

## File liên quan

- Sửa: `api/files.js` — chèn ~10 dòng vào nhánh GET
- Đã sửa sẵn: `.vercelignore`, `.gitignore`
- Không đụng: mọi file khác

## Các bước

1. Chèn khối guard ở trên vào `api/files.js`
2. Xác minh no-op tại chỗ: đếm doc thiếu cả hai trường

   ```js
   db.bim_files.countDocuments({ data: { $exists: false }, chunks: { $exists: false } })
   // → phải bằng 0 TRƯỚC khi deploy. Khác 0 thì dừng lại và tìm hiểu vì sao.
   ```

3. **Đo dung lượng file cũ đang chiếm** *(validate thêm vào)*

   Đường lai để file cũ nằm lại MongoDB **vĩnh viễn**. Nếu chúng đã chiếm gần hết 512MB
   của gói M0 thì việc chuyển file mới sang R2 **không giải quyết được vấn đề gốc** — và
   ta cần biết điều đó **trước khi** làm 5 giai đoạn, không phải sau.

   ```js
   db.bim_files.aggregate([
     { $group: {
         _id: { $cond: [{ $ifNull: ["$chunks", false] }, "chia mảnh", "nguyên khối"] },
         so_file: { $sum: 1 },
         tong_MB: { $sum: { $divide: [{ $ifNull: ["$size", 0] }, 1048576] } }
     } }
   ])
   db.stats().dataSize / 1048576          // tổng dung lượng thật của database, tính bằng MB
   ```

   | Kết quả | Ý nghĩa |
   |---|---|
   | < 100MB | Thoải mái. Đường lai giữ nguyên, làm tiếp bình thường |
   | 100–350MB | Vẫn làm tiếp, nhưng lên lịch migrate file cũ sau |
   | > 350MB | **Dừng lại báo cáo.** Cần migrate file cũ ngay, nếu không M0 vẫn đầy dù đã chuyển R2 |

4. Deploy production bằng skill `deploy-bim`
5. Xác minh sau deploy (xem tiêu chí)

## Tiêu chí hoàn thành

- [x] Truy vấn đếm ở bước 2 trả về `0` trước khi deploy — **đã đo 2026-09-03: đúng 0**
- [x] **Đã đo dung lượng ở bước 3** — `dataSize` = **352,8 MB / 512 MB**, tức **> 350MB → CHẠM NGƯỠNG DỪNG**. Xem § Phiên 2 trong `plan.md`: đường lai không đủ, phải migrate file cũ
- [ ] Mở một file đính kèm **cũ** trên production → tải xuống bình thường, không đổi gì
- [ ] Mở một file đính kèm cũ loại **chia mảnh** → vẫn tải bình thường
- [ ] `curl -s -o /dev/null -w '%{http_code}' https://bim-ruddy.vercel.app/CLAUDE.md` → **404**
- [ ] `curl -s -o /dev/null -w '%{http_code}' https://bim-ruddy.vercel.app/docs/phan-quyen-mat-khau.md` → **404**
- [ ] Trang chủ và `/api/data` vẫn chạy (smoke test của skill `deploy-bim`)
- [ ] `git status` không có `.env`

## Rủi ro

| Rủi ro | Cách xử lý |
|---|---|
| Chèn guard **sai vị trí** (trước khi tìm doc, hoặc sau khi đã đọc buffer) → chặn nhầm file cũ | Đặt ngay sau chỗ kiểm `if (!doc)` trả 404. Tiêu chí 2 và 3 sẽ bắt được nếu sai |
| Truy vấn ở bước 2 trả khác 0 | Có doc lạ trong collection — **dừng lại**, đừng deploy, tìm hiểu nguồn gốc trước |
| `.vercelignore` chặn nhầm file ứng dụng cần | Ứng dụng không đọc `.md` nào lúc chạy; `bang-hang-muc.html` và `api/` không bị chặn. Smoke test xác nhận |
