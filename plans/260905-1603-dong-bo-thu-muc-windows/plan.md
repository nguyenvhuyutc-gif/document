---
status: done
ngay: 2026-09-05
---

# Đồng bộ thư mục NAS ↔ web — kế hoạch

Script Node chạy trên máy trạm, trỏ vào thư mục bản vẽ trên NAS. Dựng cây thư mục
khớp cây WBS, đẩy bản vẽ mới lên web, kéo file thiếu về. **Không bao giờ tự xoá.**

Thiết kế và lý do: [brainstorm-dong-bo-thu-muc.md](brainstorm-dong-bo-thu-muc.md)

## Vì sao đáng làm

Bản vẽ đã nằm trên NAS. Đưa lên web hiện phải mở trình duyệt bấm từng file. 47 dòng
· 32 file · 624 MB và còn tăng.

## Nguyên tắc xuyên suốt

1. **Không xoá gì, ở cả hai bên.** Biến mất một bên thì báo cáo, người quyết.
2. **Chỉ đụng thư mục có `.bim-id`.** Cây thư mục cũ trên NAS không bị chạm tới.
3. **Chạy khô là mặc định.** Muốn ghi thật phải thêm `--thuc-hien`.
4. **Chỉ cần `EDIT_KEY`.** Không để `ADMIN_KEY` trên máy chung.

## Các pha

Làm song song bởi bốn phiên, mỗi phiên sở hữu trọn một file (xem `HOP-DONG.md`).

| Pha | Module | Ai | Trạng thái |
|---|---|---|---|
| [01](phase-01-khung-va-cau-hinh.md) | `nen-tang.mjs` | bim-02 | ✅ 49/49 |
| [02](phase-02-dung-cay-thu-muc.md) | `cay-thu-muc.mjs` | bim-e4 | ✅ 101/101 |
| [03](phase-03-day-file-len.md) | `day-len.mjs` | bim-03 | ✅ 32/32 |
| [04](phase-04-keo-ve-va-so-ghi.md) | `keo-ve.mjs` | bim-02 | ✅ 29/29 |
| — | `dong-bo-thu-muc.mjs` (điều phối) | bim-e5 | ✅ chạy thật xong |
| — | `docs/cam-lich-dong-bo.md` + `.bat` | bim-02 | ✅ |

## Đo được trên NAS thật

`\\<ten-nas>\<share>\...\<thu-muc-du-an>\04.WEB` — đường dẫn thật dài **76 ký tự**
(chỗ giữ chỗ, thay bằng đường dẫn của đơn vị bạn; đường dẫn thật đặt trong
`scripts/.env.dong-bo`, file đó bị `.gitignore` chặn)

| | |
|---|---|
| `\\?\UNC\` trên NAS | **chạy** — hướng Node đứng vững |
| Đường dẫn sâu nhất ghi + đọc được | **1039 ký tự** (NAS chạy Samba, trần cao hơn Windows) |
| Tên một thành phần | 255 ký tự |
| Cây đã tạo | 195 thư mục — 45 thư mục dòng + 150 thư mục cột |
| Đường dẫn dài nhất đang có | 216 ký tự |
| **Xấu nhất có thể** | **235** = thư mục sâu nhất 154 + tên file dài nhất 80 — dư **25** |

Trần 260 **không còn là ràng buộc của việc ghi** — chỉ còn là ràng buộc của Explorer
và CAD trên máy trạm.

Nhưng khoảng dư đang mỏng đi, và **con số phải canh là 25 chứ không phải 44**.

Đường dẫn dài nhất *đang có* là 216 — nhưng file dài nhất và thư mục sâu nhất là hai
chỗ khác nhau. Ngày ai đó thả bản vẽ tên 80 ký tự vào thư mục sâu 154 ký tự thì thành
**235**. Đó mới là số để canh, và nó chỉ còn cách trần 260 đúng 25 ký tự.

Riêng việc đổi tên cột sang dạng đọc được (`PDF` → `1 Dang trinh PDF`) đã ăn 10. Đặt
tên cột dài thêm, thêm một cấp vào cây, hay dời thư mục gốc xuống sâu hơn — cả ba đều
ăn vào 25 ký tự đó, nên **đo lại trước khi làm**.

Vượt 260 thì script **vẫn ghi và vẫn đồng bộ đúng** — Node đi đường `\\?\UNC\`. Hỏng
là hỏng ở Explorer và AutoCAD trên máy chưa bật LongPaths: không mở nổi file. Nghĩa là
**log sẽ không báo gì**, vì với script mọi thứ vẫn xanh.

## Tám bẫy đã tìm ra và bịt

Ghi đủ trong `scripts/dong-bo/HOP-DONG.md` § Bẫy đã biết. Ba cái đắt nhất:

1. **`POST /api/data` ghi đè cả document** — gửi mỗi `{rows}` là xoá sạch `people`
   và `statuses` của cả kế hoạch, im lặng. Lỗi nằm trong hợp đồng bản đầu.
2. **File tạm lúc kéo về không bắt đầu bằng dấu chấm** → lần chạy sau `day-len` coi
   bản tải dở là bản vẽ mới và đẩy ngược lên web thành hồ sơ. Vòng tròn giữa hai module.
3. **So tên phân biệt hoa thường** — cắn ba lần ở ba module. Nặng nhất: hai hạng mục
   chỉ khác hoa thường dùng chung một thư mục, `.bim-id` ghi đè lẫn nhau.

## File sẽ tạo

Tách module vì **ba phiên viết song song** — mỗi phiên sở hữu trọn một file thì
không ai sửa chồng lên ai. Cũng giữ được mỗi file dưới 200 dòng.

```
scripts/dong-bo-thu-muc.mjs       CLI + điều phối + kéo về + báo cáo   ← bim-e5
scripts/dong-bo/
├─ HOP-DONG.md                    hợp đồng giao diện, đọc trước khi code
├─ nen-tang.mjs                   .env · duongDai(\\?\) · khoá · đọc/ghi bảng · sổ ghi  ← bim-02
├─ cay-thu-muc.mjs                đặt tên · dựng cây · .bim-id · đổi tên            ← bim-e4
└─ day-len.mjs                    quét · lọc file copy dở · so khớp · đẩy lên       ← bim-03
dong-bo.bat                       bấm đúp để chạy
scripts/.env.dong-bo.example      mẫu cấu hình
```

`cay-thu-muc.mjs` và `day-len.mjs` **nhận `nenTang` qua tham số**, không `import`
trực tiếp — nhờ vậy mỗi phiên test được bằng bản giả, không phải chờ phiên khác.

**Không sửa file nào đang có** — đặc biệt không đụng `bang-hang-muc.html`,
`api/data.js`, `api/files.js`, `scripts/don-file-mo-coi.mjs` (đang có thay đổi chưa
commit của phiên khác).

### Trần 260 ký tự có hai tầng, đừng nhầm

`duongDai()` với tiền tố `\\?\` chỉ cứu tầng `fs` của Node. Vẫn còn:

- mỗi **thành phần** tên tối đa 255 ký tự
- **Explorer và nhiều bản Excel/CAD vẫn không mở nổi** đường dẫn dài, dù Node ghi được

Nên pha 02 **vẫn phải cắt tên thư mục còn ~40 ký tự**. Hai việc này ở hai module
khác nhau và cả hai đều cần thiết.

## Phụ thuộc

- Node 20+ trên máy chạy
- Đường dẫn NAS truy cập được (UNC hoặc ổ map)
- `EDIT_KEY` của môi trường production
- Cột `filesTvgs` — nếu phiên kia thêm xong thì pha 02 tạo luôn thư mục con cho nó

## Nghiệm thu chung — đã đạt trên NAS thật 05/09/2026

- ✅ Chạy khô in ra đúng việc sẽ làm, không đụng NAS lẫn web
- ✅ Thả một bản vẽ mới vào thư mục → chạy → file lên đúng dòng, đúng cột
- ✅ Chạy lại lần hai → không tải lên lại gì (0/0/0/0)
- ✅ Xoá file trên web → chạy lại → **không** sống lại từ thư mục
- ✅ Thư mục cũ trên NAS không bị đổi tên, xoá, hay thêm bớt gì

Kết quả cuối: **195 thư mục · 30 file · 588,5 MB · 45 dấu `.bim-id`**, cây gọn trong
`04.WEB`. 274 phép kiểm đạt, 0 hỏng.

Hai việc script **cố ý không tự xử**, chờ người quyết trên web:

- `QUYỂN II.1-1 CỌC KHOAN NHỒI TRỤ T56-TP ĐẾN T67-TP.pdf` và
  `03. KCPT dam SPT_T69-T79.pdf` — mỗi cái có **hai bản trùng tên trong cùng một ô**.
  Thư mục chỉ giữ được một, bản thứ hai không kéo về được. Đổi tên hoặc bỏ bớt một
  bản trên web là hết báo.
- Hai dòng WBS `1.1.1.3` và dòng kề nhau rút gọn ra cùng tên `I.1-2 CKN T49`, nên một
  cái mang hậu tố `(2)`. Không hỏng gì, chỉ dễ mở nhầm.
