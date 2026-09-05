# Pha 04 — Kéo file về, sổ ghi, cắm lịch

**Ưu tiên:** vừa (làm sau cũng được) · **Trạng thái:** ⬜ chưa làm · **Cần:** [Pha 03](phase-03-day-file-len.md)

## Mục tiêu

Chiều ngược lại: file có trên bảng mà thư mục chưa có thì tải về. Cộng sổ ghi để
phân biệt "chưa từng đồng bộ" với "đã bị xoá" — thứ khiến đồng bộ hai chiều không
biến thành máy hồi sinh file.

## Vì sao cần sổ ghi

Nhìn hai bên tại một thời điểm thì hai tình huống dưới đây **trông giống hệt nhau**:

| Hiện tượng | Cách hiểu A | Cách hiểu B |
|---|---|---|
| Có trên bảng, không trong thư mục | chưa tải về bao giờ → **tải về** | đã tải rồi, người ta xoá → **đừng tải lại** |
| Có trong thư mục, không trên bảng | bản vẽ mới → **đẩy lên** | vừa xoá trên web → **đừng đẩy lên** |

Không có sổ ghi thì file xoá trên web sẽ **sống lại từ thư mục ở mỗi lần chạy**, và
xoá bao nhiêu lần cũng vô ích. `.bim-sync.json` lưu "lần trước tôi thấy những gì",
rồi so ba chiều: lần trước × thư mục bây giờ × bảng bây giờ.

## Bảng quyết định

| Lần trước | Thư mục | Bảng | Làm gì |
|---|---|---|---|
| — | có | không | **Đẩy lên** (file mới) |
| — | không | có | **Kéo về** (chưa từng tải) |
| có | có | có | Không làm gì |
| có | **không** | có | Người xoá khỏi thư mục → **BÁO**, không tải lại, không xoá trên web |
| có | có | **không** | Người xoá trên web → **BÁO**, không đẩy lên lại |
| có | không | không | Xoá khỏi sổ ghi |

Hai dòng in đậm là lý do tồn tại của cả pha này.

## Việc

1. Đọc `.bim-sync.json`; chưa có thì coi như "lần trước không thấy gì"
2. Áp bảng quyết định cho từng file
3. Kéo về: `GET /api/files?id=` (file trong thùng rác cần `ADMIN_KEY` — **bỏ qua**,
   script chỉ có `EDIT_KEY`), ghi vào đúng thư mục cột
4. Ghi lại sổ sau mỗi dòng xong, không đợi đến cuối
5. Báo cáo cuối: đẩy lên N · kéo về M · bỏ qua K · **cần bạn quyết: P mục**
6. Hướng dẫn cắm Task Scheduler 15 phút (chỉ MỘT máy)

## Todo

- [ ] Đọc / ghi `.bim-sync.json`
- [ ] Bảng quyết định ba chiều
- [ ] Kéo file về đúng thư mục cột
- [ ] Báo cáo phân nhóm rõ, tách hẳn mục "cần bạn quyết"
- [ ] Ghi sổ theo từng dòng
- [ ] Hướng dẫn cắm lịch + cảnh báo chỉ một máy
- [ ] Ghi log ra file để xem lại khi chạy theo lịch

## Nghiệm thu

- Thư mục trống, bảng có file → chạy → file về đủ, tên tiếng Việt đúng, mở được
- Chạy lại → không tải lại gì
- **Xoá một file trong thư mục** → chạy lại → *không* tải về lại, mà **báo** "đã
  xoá khỏi thư mục, còn trên web"
- **Xoá một file trên web** (vào thùng rác) → chạy lại → *không* đẩy lên lại, mà
  **báo** "đã xoá trên web, còn trong thư mục"
- Xoá `.bim-sync.json` → chạy lại → không hỏng, coi mọi thứ là mới, không xoá gì
- Chạy theo Task Scheduler → có log đọc được, biết lần chạy nào làm gì

## Rủi ro

| Rủi ro | Xử lý |
|---|---|
| `.bim-sync.json` hỏng / bị xoá | Coi như trống; hệ quả xấu nhất là báo thừa, không mất dữ liệu |
| Kéo về 624 MB lần đầu qua ổ mạng | Chậm nhưng chỉ một lần; có tiến độ từng file |
| Hai máy cùng cắm lịch | Khoá từ pha 01; nhắc rõ trong hướng dẫn |
| Máy cắm lịch tắt → không đồng bộ | Chấp nhận; chọn máy luôn bật khi quyết |
| File trong thùng rác không kéo về được | Đúng như thiết kế — script chỉ có `EDIT_KEY`; báo và bỏ qua |

## Bảo mật

- Vẫn chỉ `EDIT_KEY`. Script **không** đọc được file trong thùng rác, và đó là điều
  mong muốn.
- Log không chứa mật khẩu, không chứa URL đã ký.

## Tiếp theo

Xong pha này thì tính năng đủ dùng. Việc sau đó, nếu cần: đóng gói `.exe` cho máy
không cài được Node.
