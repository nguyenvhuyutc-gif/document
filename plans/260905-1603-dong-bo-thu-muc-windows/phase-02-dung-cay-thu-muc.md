# Pha 02 — Dựng cây thư mục

**Ưu tiên:** cao · **Trạng thái:** ⬜ chưa làm · **Cần:** [Pha 01](phase-01-khung-va-cau-hinh.md)

## Mục tiêu

Từ `state.rows` dựng cây thư mục trên NAS khớp cây WBS, mỗi thư mục dòng mang
`.bim-id` bất biến. Xong pha này là đã dùng được: người ta thả file đúng chỗ, dù
chưa có gì tự đẩy lên.

## Điều quan trọng

- **Tên thư mục không bao giờ giống hệt tên hạng mục.** Tên hạng mục chứa `:` và
  `/` (`QUYỂN I.1-2:`, `CTP/T-T56`) — Windows cấm cả hai. Phải thay, nên khớp
  ngược bằng tên là không đáng tin → đó là lý do có `.bim-id`.
- **`.bim-id` chứa `row.id`**, không phải mã WBS. Mã WBS đổi khi chèn dòng; `row.id`
  thì không.
- Thư mục con cột **chỉ tạo cho dòng lá**. Dòng cha chỉ là thư mục nhóm.
- Cây thư mục **cũ** trên NAS phải nguyên vẹn: thư mục nào không có `.bim-id` thì
  không đọc, không sửa, không báo lỗi.

## Cấu trúc

```
<THU_MUC_GOC>\
├─ .bim-sync.json                       mã kế hoạch (pha 04 thêm sổ ghi)
├─ 1 PHAN I - CAC BAN VE PHAN CAU\
│  └─ 1.1 TAP I - PHAN CAU CHINH TUYEN\
│     └─ 1.1.1 COC KHOAN NHOI\
│        └─ 1.1.1.1 QUYEN I.1-1 - COC KHOAN NHOI\
│           ├─ .bim-id                  row.id
│           ├─ PDF\
│           ├─ DWG-Excel\
│           ├─ TVGS\                    nếu cột filesTvgs đã có
│           ├─ Da duyet\
│           └─ Chap thuan\
```

Mã WBS đứng đầu để Explorer tự xếp đúng thứ tự.

## Quy tắc đặt tên

1. Bỏ thẻ HTML, gộp khoảng trắng
2. Thay `\ / : * ? " < > |` bằng `-`
3. Bỏ dấu tiếng Việt (NAS và một số phần mềm CAD vẫn khó chịu với Unicode)
4. Cắt còn 40 ký tự, không cắt giữa từ
5. Ghép: `<mã WBS> <tên đã cắt>`, rồi **`trim()`** — dòng hạng mục rỗng sẽ ra
   `"1.1.1.5 "`, phải tự cắt khoảng trắng cuối chứ **không dựa vào việc Windows
   âm thầm cắt hộ**. Kết quả: thư mục tên đúng bằng mã WBS.
6. Trùng tên sau khi cắt → thêm ` (2)`, ` (3)`

### Số liệu khảo sát dữ liệu thật (bim-e4, kế hoạch SBGB 47 dòng)

- 47 dòng: **29 lá · 18 cha** → sẽ tạo **47 thư mục dòng + 145 thư mục cột = 192**
- Cấp sâu nhất 4, mã WBS tối đa 5 cấp
- **30/47 dòng có ký tự Windows cấm** — quá nửa, chủ yếu dấu `:` trong `QUYỂN I.1-1:`.
  Quy tắc 2 là bắt buộc, không phải phòng xa.
- **Trùng tên sau khi cắt: 0.** Có hai dòng tên giống hệt nhau (1.1.1.2 và 1.1.1.3)
  nhưng mã WBS đứng đầu nên tên thư mục vẫn khác. Quy tắc 6 gần như không kích
  hoạt — vẫn làm, như lưới an toàn.
- **1 dòng hạng mục rỗng** → xem quy tắc 5.

## Việc

1. Tính mã WBS cho từng dòng (cùng cách `computeCodes()` ở client)
2. Xác định dòng lá: dòng kế tiếp có `level` ≤ `level` của nó
3. Quét cây hiện có, gom bản đồ `row.id → đường dẫn thư mục` từ mọi `.bim-id`
4. Với mỗi dòng: chưa có thư mục thì tạo; **đã có mà tên lệch thì đổi tên**
5. Dòng lá: tạo các thư mục con cột còn thiếu
6. Thư mục có `.bim-id` không khớp dòng nào → **chỉ liệt kê**, không xoá không đổi
7. ~~Ghi `.bim-sync.json` ở gốc~~ — **BỎ.** File đó thuộc `nen-tang.mjs` với cấu
   trúc `{planId, capNhat, files}`; module cây ghi vào là **xoá mất sổ ghi của pha
   04**. bim-e4 phát hiện lúc đang làm và đã không ghi — đúng. Muốn lưu dấu vết
   "cây dựng lúc nào" thì thêm trường qua `nen-tang.ghiSoGhi()`, gọi từ file điều
   phối sau khi `dungCay()` trả về.

`dungCay()` trả thêm hai mảng ngoài hợp đồng bản đầu, cả hai đều cần:

- **`loi[]`** — lỗi không chặn: đổi tên bị Windows từ chối (file đang mở), không
  tạo được thư mục, hai thư mục trùng `.bim-id`. Hợp đồng bản đầu không có chỗ
  chứa chúng, mà mục "Rủi ro" lại yêu cầu "báo rõ, bỏ qua, chạy tiếp" — nuốt lỗi
  là người dùng tưởng xong.
- **`canhBao[]`** — đường dẫn sắp chạm trần 260 ký tự. Xem mục dưới.

## Todo

- [ ] Tính mã WBS + xác định dòng lá
- [ ] `tenThuMuc(row, ma)` theo 6 quy tắc trên
- [ ] Quét cây, đọc mọi `.bim-id`
- [ ] Tạo thư mục thiếu + `.bim-id`
- [ ] Đổi tên thư mục khi tên hạng mục đổi
- [ ] Tạo thư mục con cột cho dòng lá
- [ ] Liệt kê thư mục mồ côi
- [ ] Chạy khô in ra cây sẽ dựng, không tạo gì

## Nghiệm thu

- Chạy khô → in đúng danh sách thư mục sẽ tạo, NAS không đổi
- `--thuc-hien` → cây dựng đúng, mỗi thư mục dòng có `.bim-id` đúng `row.id`
- Chạy lại lần hai → **không tạo thêm gì**, báo "đã khớp"
- Đổi tên một hạng mục trên web → chạy lại → thư mục **đổi tên theo**, `.bim-id`
  giữ nguyên, file bên trong còn nguyên
- Tạo tay một thư mục lạ không có `.bim-id` → chạy lại → không bị đụng tới
- **Xoá `.bim-id` của một thư mục → chạy lại → thư mục đó bị LỜ HOÀN TOÀN** (nó đã
  thành thư mục lạ), script tạo thư mục MỚI cho dòng đó. Người dùng thấy hai thư
  mục và tự dọn.

  > Bản đầu của mục nghiệm thu này ghi "thư mục đó vào danh sách mồ côi" — **sai và
  > tự mâu thuẫn**, bim-e4 phát hiện. "Mồ côi" theo định nghĩa ở trên là thư mục
  > **có** `.bim-id` mà không khớp dòng nào. Mất `.bim-id` rồi thì không còn gì để
  > script nhận ra, mà đọc thư mục lạ để đoán thì phá đúng ràng buộc lõi. Thà tạo
  > thư mục mới và để người dùng thấy hai cái, còn hơn đoán mò rồi gắn nhầm file
  > vào nhầm hạng mục.
- Hạng mục có `:` và `/` trong tên → thư mục tạo được, không lỗi

## Rủi ro

| Rủi ro | Xử lý |
|---|---|
| Đường dẫn vượt 260 ký tự | `\\?\` từ pha 01; cắt tên còn 40 ký tự |
| Đổi tên thư mục lúc có người đang mở file bên trong | Windows sẽ chặn → bắt lỗi, báo rõ, bỏ qua thư mục đó, chạy tiếp |
| Bảng có hai dòng trùng tên hoàn toàn | Mã WBS khác nhau nên tên thư mục vẫn khác |
| Tạo 150 thư mục trên NAS chậm | Chấp nhận — chỉ chạy một lần đầu |

## Bảo mật

Chỉ đọc bảng, không ghi web. Không cần mật khẩu cho pha này ngoài việc đọc.

## Tiếp theo

[Pha 03](phase-03-day-file-len.md) — quét và đẩy file lên.
