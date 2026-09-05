# Pha 01 — Khung script, cấu hình, khoá chạy

**Ưu tiên:** cao (mọi pha sau dựa vào) · **Trạng thái:** ⬜ chưa làm

Liên quan: [plan.md](plan.md) · [brainstorm](brainstorm-dong-bo-thu-muc.md)

## Mục tiêu

Script chạy được, đọc đúng cấu hình, nối được tới web, và **không thể vô tình ghi
gì**. Chưa đụng NAS.

## Điều quan trọng

- Kho là **NAS**, không chạy được app → script chạy trên máy trạm, trỏ vào UNC
  (`\\nas\duan\SBGB`) hoặc ổ map (`Z:\SBGB`). Cả hai phải chạy được.
- Windows giới hạn đường dẫn 260 ký tự. Node vượt được bằng tiền tố `\\?\` nhưng
  **chỉ với đường dẫn tuyệt đối đã chuẩn hoá** — phải xử lý ngay từ tầng đọc/ghi,
  không vá sau.
- Nhiều máy có thể cùng chạy → cần khoá. Khoá đặt **trên NAS**, không phải trên máy.

## Yêu cầu

- Đọc `.env` cạnh script: `EDIT_KEY`, `BASE_URL`, `THU_MUC_GOC`, `PLAN_ID`
- Không đọc `.env` của dự án — máy chạy là máy khác, không có repo
- Thiếu biến nào → dừng, nói rõ thiếu gì, không đoán
- **Mặc định chạy khô.** `--thuc-hien` mới ghi
- In ra cấu hình đã phân giải trước khi làm gì (đúng nếp `don-file-mo-coi.mjs`)
- Khoá: tạo `.bim-sync.lock` trên NAS, ghi tên máy + giờ; thấy khoá còn hạn thì
  nhường và thoát êm. Khoá quá 30 phút coi như máy kia treo, chiếm lại
- Kết nối web: đọc `GET /api/data?plan=` lấy `rows` + `mtime`

## Việc

1. Dựng khung `scripts/dong-bo-thu-muc.mjs`: đọc `.env`, phân giải tham số, in cấu hình
2. Hàm `duongDai(p)` — chuẩn hoá đường dẫn, thêm `\\?\` khi cần
3. Kiểm tra `THU_MUC_GOC` tồn tại và ghi được (tạo rồi xoá một file thử)
4. Khoá vào/ra, kèm nhánh chiếm lại khoá quá hạn
5. Đọc bảng từ web, in số dòng và `mtime`
6. `dong-bo.bat` gọi script, giữ cửa sổ mở để đọc kết quả
7. `scripts/.env.dong-bo.example` — mẫu, **không** chứa giá trị thật

## Todo

- [ ] Khung script + đọc `.env` + in cấu hình
- [ ] `duongDai()` xử lý `\\?\`, thử với đường dẫn > 260 ký tự
- [ ] Kiểm thư mục gốc tồn tại + ghi được
- [ ] Khoá `.bim-sync.lock` (tạo / nhường / chiếm lại khi quá hạn)
- [ ] Đọc bảng từ web
- [ ] `dong-bo.bat` + `.env.dong-bo.example`
- [ ] Chạy thử trên UNC **và** trên ổ map

## Nghiệm thu

- Chạy thiếu biến → dừng, báo đúng tên biến thiếu
- Chạy đúng → in cấu hình + "đọc được N dòng từ web", **không ghi gì**
- Mở hai cửa sổ chạy cùng lúc → cái thứ hai báo "máy khác đang chạy" rồi thoát
- Sửa giờ trong file khoá về 40 phút trước → lần chạy sau chiếm lại được
- Đường dẫn NAS dài > 260 ký tự vẫn đọc được

## Rủi ro

| Rủi ro | Xử lý |
|---|---|
| UNC không chạy nhưng ổ map chạy (hoặc ngược lại) | Thử cả hai ngay ở pha này, trước khi xây tiếp |
| Máy chạy không có Node | Kiểm trước; nếu không cài được thì tính đóng gói `.exe` |
| `.env` bị người khác đọc | Chỉ `EDIT_KEY`, **không** `ADMIN_KEY`; đặt quyền NTFS cho đúng tài khoản |
| Khoá không xoá được khi script bị Ctrl+C | Khoá có hạn 30 phút nên tự hết; ghi rõ trong hướng dẫn |

## Bảo mật

- `.env` của script nằm ngoài repo, **không commit**
- Chỉ `EDIT_KEY` — script không xoá gì nên không cần `ADMIN_KEY`
- Không ghi mật khẩu ra log, kể cả khi lỗi

## Tiếp theo

[Pha 02](phase-02-dung-cay-thu-muc.md) — dựng cây thư mục.
