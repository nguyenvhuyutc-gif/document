# Thùng rác file — brainstorm & quyết định

**Ngày:** 03/09/2026 · **Trạng thái:** đã triển khai, chưa deploy

## Yêu cầu

1. Popup xác nhận trước khi xoá file
2. Thùng rác: xoá → vào thùng rác; khôi phục về chỗ cũ; xoá vĩnh viễn mới đụng DB + S3
3. Tải toàn bộ file trong thùng rác về máy
4. Chỉ Admin truy cập thùng rác

## Ràng buộc phát hiện lúc scout

- `bim_files` giữ metadata, **không biết** file thuộc kế hoạch/dòng/cột nào → phải thêm `origin`
- File gắn vào 3 mảng trong document kế hoạch: `files`, `filesDuyet`, `filesChapThuan`
- `removeFile` cũ: fire-and-forget DELETE, xoá S3 ngay, không xác nhận
- Xoá dòng **không** xoá file → mồ côi trên S3 vĩnh viễn
- Đã có mẫu modal xác nhận xoá dòng → tái dùng cho #1
- Dự án không dùng thư viện JS ngoài nào (chỉ Google Fonts)
- Shim tương thích chặn mọi POST lạ bằng 426 → action mới phải vào danh sách trắng

## Quyết định

| Câu hỏi | Chọn | Lý do |
|---|---|---|
| Phạm vi | Xoá file lẻ **+** xoá dòng | Vá luôn lỗ rò rỉ file mồ côi |
| Dòng gốc đã mất | Hộp chọn dòng + cột đích | File không bao giờ kẹt |
| Tải hàng loạt | File System Access API + fallback | Không thư viện, không nạp RAM |
| Vòng đời | 30 ngày, dọn lười khi mở | Không cần cron |
| Phạm vi UI | Theo kế hoạch đang mở | Tái dùng `save()` + bảo vệ 409 |
| Vị trí trên S3 | **Không** di chuyển object | Copy 500MB trong hàm 15s là rủi ro thừa |
| Dọn quá hạn | Trong request liệt kê, ≤10 file | S3 Lifecycle không biết gì về MongoDB → doc ma |

### Mâu thuẫn phải gỡ

Chọn "xoá dòng → thùng rác" cộng "chặn restore khi dòng mất" = phần lớn thùng rác
thành nghĩa địa (dòng gốc *luôn* mất ở luồng đó). Gỡ bằng hộp chọn dòng đích.

## Kiến trúc

```
bim_files thêm:  status:"trashed" · trashedAt · origin{planId,rowId,fkey,rowName}

POST   ?action=trash    (mảng, 1 request)   admin
GET    ?trash=1&plan=   (list + dọn quá hạn) admin
POST   ?action=restore&id=                   admin
DELETE ?id=             (xoá hẳn)            admin
GET    ?id=&signed=1    (URL ký dạng JSON)   — tránh CORS, không cần header ở <a>
```

**Thứ tự khôi phục bắt buộc:** `save()` (có bảo vệ 409) → chờ `serverMtime` đổi →
`?action=restore`. Đảo ngược = file bỏ cờ trashed mà không dòng nào trỏ tới.

**Tự chữa lành:** server loại khỏi danh sách thùng rác những file đang được bảng
tham chiếu → restore hỏng giữa chừng thì lần mở sau file tự biến mất khỏi đó.

## Rủi ro còn lại

| Rủi ro | Xử lý |
|---|---|
| Tab cache HTML cũ gọi thẳng DELETE | Không tránh được, chờ tải lại trang |
| Site cũ `bim-wheat` xoá vĩnh viễn | Không có quyền deploy bên đó |
| `canAdmin()` chỉ ẩn nút | Hàng rào thật ở server, đã kiểm 401 |
| File cũ trong MongoDB vào thùng rác vẫn ăn hạn mức 512MB | Xoá vĩnh viễn mới giải phóng |
| FSA API không có trên Firefox/Safari | Fallback tải lần lượt |
| `bang-hang-muc.html` vượt 4000 dòng | Chấp nhận — tách sẽ phá kiến trúc một-file |

## Kiểm chứng

45/45 đạt trên `vercel dev` + MongoDB + S3 thật:
`scratch/thu-thung-rac.mjs` (25) · `thu-tai-len-local.mjs` (12) · `thu-gioi-han.mjs` (8)
Thêm `thu-script-don.mjs`: xác nhận `don-file-mo-coi.mjs` bỏ qua doc `trashed`.

## Việc chưa xong

**CORS bucket chỉ cho `http://localhost:3000`.** Preflight từ
`https://bim-ruddy.vercel.app` trả 403 → tải file lên trên production đang hỏng,
và "tải cả thư mục" cũng sẽ hỏng ở đó. Phải thêm origin production vào CORS bucket.
User `bim-dev` không có quyền `GetBucketCORS`/`PutBucketCORS` nên phải sửa ở AWS Console.
