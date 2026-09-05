# Pha 03 — Đẩy file lên web

**Ưu tiên:** cao (giá trị chính) · **Trạng thái:** ⬜ chưa làm · **Cần:** [Pha 02](phase-02-dung-cay-thu-muc.md)

## Mục tiêu

Quét thư mục cột, tìm bản vẽ chưa có trên bảng, đẩy lên S3 và gắn vào đúng dòng
đúng cột.

## Điều quan trọng

- **File đang copy dở là cái bẫy lớn nhất.** Ai đó copy bản vẽ 200 MB vào NAS,
  script chạy đúng lúc đó và đọc phải file mới được nửa → đẩy lên một file hỏng,
  và vì tên + kích thước "khớp" nên lần sau **không sửa lại nữa**. Phải chặn ở
  pha này, không để sang pha sau.
- **Ghi bảng theo từng dòng.** Gom cả mẻ rồi ghi một lần thì nhanh, nhưng đứt giữa
  chừng là hàng chục file nằm trên S3 mà không dòng nào trỏ tới.
- Đường đẩy lên **dùng đúng API sẵn có**: `sign-upload → PUT S3 → confirm`. Không
  viết đường ghi S3 riêng — lệch một chi tiết là sinh loại rác mới.
- `Content-Disposition` **bắt buộc** gửi kèm lúc PUT, nếu không tên file mất và
  người tải về nhận tên hex.

## Nhận diện file đã có

Tên file + dung lượng. Trùng cả hai → coi như đã có, bỏ qua. Không băm nội dung:
624 MB qua ổ mạng mỗi lần quét là quá chậm.

Hệ quả phải nói với người dùng: **sửa bản vẽ mà giữ nguyên tên và đúng bằng kích
thước cũ thì script không thấy.** Trường hợp hiếm nhưng có thật.

## Việc

1. Với mỗi thư mục dòng (có `.bim-id`), duyệt từng thư mục cột
2. Đọc danh sách file: tên, kích thước, `mtime`
3. **Lọc file chưa ổn định:** bỏ qua file có `mtime` trong vòng 60 giây; đọc kích
   thước hai lần cách 3 giây, khác nhau thì để lần sau
4. So với mảng tương ứng của dòng (`files` / `filesCad` / `filesTvgs` / …)
5. File chưa có → `sign-upload` (kèm tên, kiểu, kích thước) → `PUT` lên S3 kèm
   `Content-Disposition` → `confirm`
6. Gắn `{id, name, size, type, url, uploadedAt}` vào mảng của dòng
7. **Xong một dòng thì ghi bảng ngay** — `POST /api/data?ifMtime=`
8. 409 → dừng hẳn, báo "có người vừa sửa bảng, chạy lại"
9. File > 500 MB → bỏ qua, báo rõ (giới hạn của web)

## Todo

- [ ] Duyệt thư mục cột, đọc file + `mtime` + kích thước
- [ ] Lọc file đang copy dở (2 chốt: tuổi file, kích thước ổn định)
- [ ] So khớp tên + kích thước với mảng của dòng
- [ ] Đẩy lên qua `sign-upload → PUT → confirm`
- [ ] `Content-Disposition` đúng chuẩn RFC 5987 cho tên tiếng Việt
- [ ] Ghi bảng theo từng dòng, kiểm `mtime`
- [ ] Xử lý 409, file quá lớn, lỗi mạng giữa chừng
- [ ] Chạy khô in bảng đối chiếu "file này → dòng này, cột này"

## Nghiệm thu

- Chạy khô → in đúng file nào sẽ lên dòng nào cột nào, **không đẩy gì**
- Thả một PDF vào `PDF\` của một dòng → chạy → lên đúng dòng đúng cột, tên tiếng
  Việt nguyên vẹn, tải về từ web mở được
- Chạy lại → không đẩy lại file đó
- Đang copy một file lớn vào NAS mà chạy script → file đó **bị bỏ qua**, lần sau
  mới lên, và lên nguyên vẹn
- Sửa bảng ở tab khác trong lúc script chạy → script dừng ở 409, không ghi đè
- Thả file 600 MB → bỏ qua, báo "quá 500 MB"
- Sau khi chạy: `node scripts/don-file-mo-coi.mjs` **không** báo thêm rác mới

## Rủi ro

| Rủi ro | Xử lý |
|---|---|
| **File đọc phải lúc đang copy** | Hai chốt ở bước 3; nếu vẫn lọt thì thùng rác cho phép xoá và làm lại |
| Đứt mạng giữa chừng | Ghi theo từng dòng → mất nhiều nhất một dòng; `don-file-mo-coi.mjs` dọn phần sót |
| 409 liên tục vì có người đang nhập liệu | Dừng và báo, không thử lại vô hạn; chạy lại lúc khác |
| Đẩy nhầm file rác (Thumbs.db, ~$xxx.xlsx) | Bỏ qua file ẩn, file bắt đầu bằng `~$`, và `.bim-id` |
| Tên file trùng nhau trong cùng thư mục | Không xảy ra — Windows không cho |

## Bảo mật

- Cần `EDIT_KEY`. Không cần `ADMIN_KEY`.
- Không ghi URL đã ký ra log — chúng chứa chữ ký còn hiệu lực.

## Tiếp theo

[Pha 04](phase-04-keo-ve-va-so-ghi.md) — kéo file về, sổ ghi, cắm lịch.
