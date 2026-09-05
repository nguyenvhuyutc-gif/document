# Hợp đồng giao diện — script đồng bộ NAS

**Bắt buộc đọc trước khi viết dòng code nào.** Ba module do ba phiên viết song song;
đây là thứ duy nhất giữ cho chúng ghép được với nhau.

| File | Chủ sở hữu | Không ai khác được sửa |
|---|---|---|
| `scripts/dong-bo/nen-tang.mjs` | **bim-02** | ✔ |
| `scripts/dong-bo/cay-thu-muc.mjs` | **bim-e4** | ✔ |
| `scripts/dong-bo/day-len.mjs` | **bim-03** | ✔ |
| `scripts/dong-bo-thu-muc.mjs` | **bim-e5** (điều phối) | ✔ |
| `scripts/dong-bo/HOP-DONG.md` | **bim-e5** | đề nghị đổi thì nhắn, đừng tự sửa |

## Bẫy đã biết — đọc trước

**1. `POST /api/data` ghi đè cả document.** Document là `{rows, people, statuses}`;
gửi mỗi `{rows}` là xoá sạch người và tình trạng của cả kế hoạch. Chi tiết ở
`ghiBangMotDong` bên dưới. *(bim-02 phát hiện — hợp đồng bản đầu của tôi sai chỗ này.)*

**2. Máy đang phát triển đã bật LongPathsEnabled**, nên đường dẫn dài chạy được cả
khi không có `\\?\`. **Đừng lấy đó làm bằng chứng bỏ được tiền tố** — máy trạm khác
và NAS thật thường chưa bật.

**3. Trần 260 ký tự có hai tầng.** `\\?\` chỉ cứu tầng `fs` của Node. Mỗi thành phần
tên vẫn tối đa 255 ký tự, và Explorer cùng nhiều bản Excel/CAD vẫn không mở nổi
đường dẫn dài. Người dùng mở bản vẽ bằng CAD chứ không bằng Node — nên `cay-thu-muc`
**vẫn phải cắt tên còn ~40 ký tự**.

**4. `.gitignore` có `.env*`** và chỉ mở ngoại lệ cho đúng `.env.example`. File mẫu
`scripts/.env.dong-bo.example` sẽ bị git bỏ qua nếu không thêm ngoại lệ
`!.env.dong-bo.example`. *(bim-02 phát hiện — bim-e5 xử lý khi tạo file mẫu.)*

**5. File tạm lúc tải về PHẢI bắt đầu bằng dấu chấm.** `quetThuMuc` bỏ qua tên bắt
đầu bằng `.`, bắt đầu bằng `~$`, và danh sách `BO_QUA` — đuôi `.bim-tam` không khớp
cái nào. Tải một file 200MB bị giết giữa chừng để lại `ban-ve.pdf.bim-tam`, và lần
chạy sau `day-len` coi đó là bản vẽ mới rồi **đẩy bản tải dở lên web thành hồ sơ**.
Vòng tròn khép kín giữa hai module. Tên đúng: `.ban-ve.pdf.bim-tam`.
*(bim-02 phát hiện khi rà chéo — lỗi do chính module của họ gây ra cho module khác.)*

**6. `pairUid` để trống — ghép tự động chạy hay không TUỲ CỘT.** Điều kiện ở
`bang-hang-muc.html` là "cả CỘT chưa file nào mang `pairUid`", tính trên từng cột
chứ không phải cả dòng. Nên:

| Tình huống | Kết quả |
|---|---|
| Cột trống, script đẩy 2 file | **ghép theo thứ tự** — đây là lần đồng bộ đầu, phổ biến nhất |
| Cột đã có file gán qua giao diện | file mới nằm ở khối "chưa gán" |
| Cột có file mang `pairUid = ""` | tất cả về khối "chưa gán" |

*(bim-02 nêu, bim-03 đo lại bằng cách bốc `normalizeRowShape` ra chạy thật và đính
chính: không phải "không bao giờ ghép".)* Đừng nói với người dùng là "script đẩy lên
thì luôn phải gán tay" — lần đầu trên bảng còn trống thì tự ghép đúng.

**7. JavaScript phân biệt hoa thường, Windows thì không.** Nên **mọi cấu trúc lấy
tên file hoặc thư mục làm khoá đều sai mặc định** — không riêng phép so trực tiếp,
mà cả `Set`, `Map`, khoá object, `indexOf`, `includes`. `BV-01.PDF` và `bv-01.pdf`
là **một** file trên đĩa.

Đã cắn **ba lần ở ba module, ba người khác nhau**: `soKhop` (so phân biệt),
`quyetDinh` (đã sửa), và `daDung` trong `cay-thu-muc` — chỗ này là một `Set`, không
phải phép so nào cả, và nặng nhất: hai hạng mục chỉ khác hoa thường không bị coi là
trùng nên dùng chung một thư mục, `.bim-id` ghi đè lẫn nhau, hai dòng giành nhau một
thư mục vĩnh viễn, file của hai hạng mục lẫn vào nhau.

Quy tắc: **hạ hoa thường ở KHOÁ, giữ nguyên tên gốc khi TẠO** thư mục hay file.

Chỗ va thật thường là nơi tên KHÔNG mang số thứ tự — cấp Quyển va, cấp Nhóm thì
không vì tên đã có số đứng đầu. Đặt phép kiểm ở đúng chỗ va.
*(bim-02 tìm ra bằng cách chạy thật; bim-e4 chỉ ra gốc rộng hơn "phép so".)*

### 8. `\b` không nhận ký tự tiếng Việt — dò từ khoá phải bỏ dấu TRƯỚC

`/\bĐẾN\b/` **không bao giờ khớp** chuỗi chứa "ĐẾN". `\b` là ranh giới giữa `\w`
(chỉ `[A-Za-z0-9_]`) và phần còn lại; `Đ` nằm ngoài ASCII nên không phải `\w`, ranh
giới không tồn tại ở đó. Không lỗi, không cảnh báo — chỉ lặng lẽ trả `false`.

Cắn ở `cay-thu-muc`: phép dò "ĐẾN" quyết định thư mục tên `T47-T50` (dải liên tục)
hay `T47,T50` (chỉ hai trụ đó) — sai thì người tìm bản vẽ trụ T49 mở đúng thư mục
rồi không thấy gì. Module chạy đúng vì dò trên chuỗi đã qua `lamSach`; script đo thì
dò trên chuỗi còn dấu và in nhãn sai toàn bộ, suýt kết luận nhầm là module hỏng.

Quy tắc: **mọi phép dò từ khoá tiếng Việt chỉ chạy trên chuỗi đã bỏ dấu.** Cùng
họ với bẫy 7 — cả hai đều là "phép so trông thì đúng, im lặng khi sai".
*(bim-e4 tìm ra.)*

## Luật chung

1. **Module chỉ export hàm.** Không chạy gì lúc `import`, không `process.exit()`,
   không `console.log` trừ khi nhận cờ `onLog`.
2. **Lỗi thì `throw new Error("câu tiếng Việt nói rõ chuyện gì")`.** Người điều phối
   bắt và quyết định dừng hay đi tiếp.
3. **Mọi hàm có ghi đều nhận `{chayKho}`.** `chayKho: true` → **không ghi gì**, chỉ
   trả về mô tả việc sẽ làm. Đây là mặc định của cả script.
4. **Không đụng file ngoài file của mình.** Test để ở `scratch/thu-<tên-module>.mjs`
   (`scratch/` đã bị gitignore).
5. Chỉ dùng `EDIT_KEY`. Không đọc, không ghi, không nhắc tới `ADMIN_KEY`.
6. Node thuần, không thêm phụ thuộc npm nào.

## Kiểu dữ liệu dùng chung

```js
// Một file như bảng trên web lưu
// @typedef FileBang { id, name, size, type, url, uploadedAt, note, pairUid }

// Một dòng của bảng
// @typedef Dong { id, level, hangMuc, files[], filesCad[], filesTvgs[],
//                 filesDuyet[], filesChapThuan[] }

// Cấu hình đã phân giải
// @typedef CauHinh { EDIT_KEY, BASE_URL, THU_MUC_GOC, PLAN_ID }

// Một file nhìn thấy trên đĩa
// @typedef FileDia { ten, size, mtime, duongDan }
```

**Năm cột file, đúng thứ tự này** (khớp `FKEYS` trong `bang-hang-muc.html`):

| Khoá | Thư mục con | Nhãn trên bảng |
|---|---|---|
| `files` | `PDF` | File đang trình (PDF) |
| `filesCad` | `DWG-Excel` | File đang trình (DWG + Excel) |
| `filesTvgs` | `TVGS` | Ý kiến TVGS |
| `filesDuyet` | `Da duyet` | File đã duyệt |
| `filesChapThuan` | `Chap thuan` | Hồ sơ chấp thuận |

---

## `nen-tang.mjs` — bim-02

```js
export function docCauHinh(thuMucScript): CauHinh
// Tìm `.env.dong-bo` trước, rồi mới `.env`. CHỈ trong đúng thư mục được truyền
// vào — KHÔNG lần lên thư mục cha: lần lên là vớ nhầm `.env` của repo, thứ chứa
// connection string MongoDB. Thiếu biến → throw, nói rõ THIẾU BIẾN NÀO.

export function duongDai(p): string
// Chuẩn hoá + thêm \\?\ khi cần. PHẢI đúng cho cả hai dạng:
//   Z:\a\b        → \\?\Z:\a\b
//   \\nas\share\a → \\?\UNC\nas\share\a
// Đường dẫn đã có tiền tố thì trả nguyên.

export async function layKhoa(thuMucGoc, { hanPhut = 30, chayKho }): Promise<Khoa>
// Khoa = { duocPhep: boolean, chuSoHuu?: string, nhaKhoa: () => Promise<void> }
// Khoá là file .bim-sync.lock TRÊN NAS, nội dung JSON { may, luc }.
// Thấy khoá còn hạn → duocPhep:false + chuSoHuu = tên máy kia.
// Khoá quá hanPhut → chiếm lại, duocPhep:true.

export async function docBang(cauHinh): Promise<{ rows: Dong[], mtime: number, name: string }>
// GET {BASE_URL}/api/data?plan={PLAN_ID}
// PHẢI gọi trước ghiBangMotDong — nó ghi nhớ nguyên document đã đọc.

export async function ghiBangMotDong(cauHinh, rows, mtime): Promise<{ mtime: number }>
// POST {BASE_URL}/api/data?plan=&ifMtime=  kèm header x-edit-key
//
// ⚠️ BẪY MẤT DỮ LIỆU — đọc kỹ trước khi đụng vào hàm này.
// `POST /api/data` GHI ĐÈ CẢ document bằng `$set: { data: payload }`, KHÔNG merge
// (api/data.js:291). Mà document thật là `{ rows, people, statuses }` chứ không
// chỉ có rows. Gửi mỗi `{ rows }` lên là **xoá sạch danh sách người và danh sách
// tình trạng của cả kế hoạch**, ngay lần đẩy file đầu tiên, không báo lỗi gì.
//
// Vì vậy hàm này gửi `{ ...bảnGốcTừDocBang, rows }`.
// Gọi khi chưa từng docBang cùng cauHinh → **throw**, không đoán. Thà dừng còn hơn xoá.
//
// Máy chủ trả conflict:true → throw Error("XUNG_DOT") để người điều phối dừng sạch.

export async function docSoGhi(thuMucGoc): Promise<SoGhi>
export async function ghiSoGhi(thuMucGoc, so, { chayKho }): Promise<void>
// SoGhi = { planId, capNhat, files: { [khoaFile]: { rowId, cot, ten, size } } }
// File .bim-sync.json hỏng/thiếu → trả sổ rỗng, KHÔNG throw.

export function khoaFile(rowId, cot, ten): string
// Khoá định danh trong sổ ghi. Dùng chung ở mọi module — đừng tự chế cách khác.
//
// ⚠️ KHÔNG có `size` trong khoá. Sửa một bản vẽ rồi lưu đè là chuyện hằng ngày:
// tên giữ nguyên, size đổi. Nếu size nằm trong khoá thì khoá cũ biến mất khỏi đĩa
// → sổ ghi kết luận "ai đó xoá file khỏi thư mục" và báo động, dù không ai xoá gì.
// Mục "cần bạn quyết" đầy báo động giả thì người dùng ngừng đọc nó, và cảnh báo
// thật chìm theo.
// `size` vẫn LƯU trong sổ (ngoài khoá) để phát hiện file đổi nội dung.
// *(bim-02 phát hiện.)*
```

---

## `cay-thu-muc.mjs` — bim-e4

```js
export const COT       // [{ key:"files", thuMuc:"PDF" }, …] đúng 5 cột, đúng thứ tự bảng trên

export function tinhMaWbs(rows): string[]      // ["1","1.1","1.1.1",…] cùng chỉ số với rows
export function laDongLa(rows, i): boolean     // dòng kế tiếp có level <= level của nó

export function tenThuMuc(row, ma, cap, daDung: Set<string>, tuyChon?):
  { ten, laDuPhong, laTrung, tenGoc? }
// Tên phụ thuộc CẤP (05/09, cấu trúc viết tắt do người dùng chốt):
//   cấp Phần  → BỎ, không tạo thư mục (trừ khi dòng đó không có con)
//   cấp Tập   → số thứ tự + tên tra bảng: "1 Chinh tuyen vuot de"
//   cấp Nhóm  → số thứ tự + viết tắt chữ cái đầu: "1 CKN" · "2 KCPD"
//   cấp Quyển → mã quyển + tên rút gọn: "I.1-1 CKN SD-CTP-T47"
// Trả object vì người gọi cần biết tên có phải bản dự phòng (Tập chưa có trong
// bảng tra) hay có trùng — cả hai đều phải vào `canhBao`, không được im lặng.
//
// Số thứ tự chỉ tốn 4 ký tự tổng nhưng giữ cho Explorer sắp đúng trình tự bảng.
// Không có nó thì "KCK" (Kết cấu khác) nhảy từ cuối lên thứ hai, chen giữa Cọc
// khoan nhồi và Kết cấu phần dưới — phá trình tự thi công người đọc quen.

export const BANG_TRA_TAP    // tên viết ngắn cho cấp Tập, đè được qua `bangTraTap`
export function vietTatCumTu(chu)
export function rutTenTap(chu, bangTra)
export function rutTenQuyen(chu)

export async function docCayHienCo(thuMucGoc, nenTang): Promise<Map<string, string>>
// rowId → đường dẫn tuyệt đối. CHỈ đọc thư mục có .bim-id.
// Thư mục không có .bim-id: không đọc, không sửa, không báo lỗi.

export async function dungCay(thuMucGoc, rows, nenTang, { chayKho, bangTraTap }):
  Promise<KetQuaCay>
// KetQuaCay = { taoMoi, doiTen, moCoi, thuMucCot, loi, canhBao, boQuaCapPhan }
//   thuMucCot     Map rowId → {[cot]: đường dẫn}. Thứ day-len cần. Có cả khi chayKho.
//   loi           lỗi KHÔNG chặn: rename bị Windows từ chối (file đang mở), không
//                 tạo được thư mục, hai thư mục trùng .bim-id. Nuốt lỗi là người
//                 dùng tưởng xong.
//   canhBao       Tập chưa có trong bảng tra (đang dùng tên dự phòng dài), tên
//                 viết tắt bị trùng phải thêm "(2)", đường dẫn sắp chạm trần.
//   boQuaCapPhan  dòng cấp Phần đã bỏ — để báo cáo giải thích được vì sao 47 dòng
//                 chỉ ra 45 thư mục.
```

---

## `day-len.mjs` — bim-03

```js
export async function quetThuMuc(duongDanCot, nenTang): Promise<FileDia[]>
// Bỏ qua: file ẩn, tên bắt đầu "~$", .bim-id, Thumbs.db, desktop.ini

export async function locFileChuaOnDinh(dsFile, { tuoiToiThieuGiay = 60 }): Promise<{dung: FileDia[], cho: FileDia[]}>
// HAI chốt, cả hai đều cần:
//   1. mtime mới hơn tuoiToiThieuGiay → cho
//   2. đọc size lần nữa sau ~3s, khác lần đầu → cho
// Đây là phần khó nhất của cả script: file copy dở lọt qua sẽ được đẩy lên hỏng,
// và vì tên+size đều "khớp" nên KHÔNG BAO GIỜ được sửa lại.

export function soKhop(dsDia: FileDia[], mangBang: FileBang[]): { canDay: FileDia[], daCo: FileDia[] }
// Khớp bằng tên + size. Không băm nội dung.
//
// ⚠️ Hàm này KHÔNG biết sổ ghi, nên `canDay` của nó CHƯA phải quyết định cuối.
// "Có trên đĩa, không trên bảng" có thể là bản vẽ mới (đẩy lên) HOẶC file người
// dùng vừa xoá trên web (đừng đẩy lên lại). Chỉ `keo-ve.quyetDinh()` phân biệt
// được, vì chỉ nó đọc sổ ghi. Xem `dayCaDong` bên dưới.

export async function dayMotFile(cauHinh, file: FileDia, meta: {name, type}): Promise<FileBang>
// sign-upload → PUT S3 (BẮT BUỘC kèm Content-Disposition RFC 5987) → confirm
// > 500MB → throw Error("QUA_LON")
// KHÔNG ghi URL đã ký ra log — nó chứa chữ ký còn hiệu lực.

export async function dayCaDong(cauHinh, row, dsCanDay, nenTang, { chayKho, onLog }):
  Promise<{ daDay: FileBang[], cho: FileDia[], loi: [{ten, ly_do}] }>
// ĐỔI CHỮ KÝ (05/09): nhận thẳng `dsCanDay` — danh sách file ĐÃ ĐƯỢC QUYẾT ĐỊNH —
// thay vì tự gọi soKhop trên cả thư mục.
//
// Vì sao: `quyetDinh()` trong keo-ve.mjs là NGƯỜI QUYẾT DUY NHẤT, vì chỉ nó đọc
// sổ ghi. Nếu dayCaDong tự soKhop rồi đẩy, thì file người dùng vừa xoá trên web
// sẽ được đẩy lên lại TRƯỚC KHI quyetDinh kịp nói đừng — xoá bao nhiêu lần cũng
// vô ích, đúng cái bệnh mà cả pha 04 sinh ra để chữa. *(bim-02 phát hiện.)*
//
// Hai cách khác đã cân nhắc và loại: cho dayCaDong nhận `soGhi` rồi tự loại (nhân
// đôi logic bảng quyết định ở hai module — chỗ chắc chắn lệch nhau sau này), và
// để file điều phối tự trừ (logic quyết định nằm ngoài hàm thuần, không test được).
//
// Đẩy hết file trong dsCanDay của MỘT dòng. KHÔNG tự ghi bảng — trả về để người
// điều phối ghi. `locFileChuaOnDinh` vẫn chạy trong này, kết quả vào `cho`.

// ⚠️ LUỒNG ĐÚNG — `soKhop` KHÔNG nằm trong luồng chính:
//   quetThuMuc → locFileChuaOnDinh → quyetDinh(sổ, TOÀN BỘ dsDia, TOÀN BỘ mangBang)
//                → dayCaDong(dsCanDay)
//
// KHÔNG được lấy `soKhop().canDay` làm `dsDia` cho `quyetDinh`. `canDay` đã loại
// hết file đang khớp hai bên, mà `quyetDinh` cần THẤY chúng mới phân biệt được 6
// dòng bảng. Nối hai hàm đó lại thì từ lần chạy thứ hai, MỌI file đang đồng bộ tốt
// đều sinh một cảnh báo giả "đã xoá khỏi thư mục" — 32 file hiện có là 32 dòng rác
// trong mục "cần bạn quyết", mỗi 15 phút. Mục cảnh báo đầy rác thì không ai đọc nữa.
// Lần chạy đầu còn tệ hơn theo kiểu khác: file đã có đủ hai bên rơi vào "chưa từng
// tải" và bị kéo về lại toàn bộ.
//
// `quyetDinh` vốn đã bao trọn việc của `soKhop`. `soKhop` giữ lại làm hàm phụ trợ
// (test, chẩn đoán), không dùng trong luồng. *(bim-02 phát hiện khi rà chéo.)*
```

---

## `keo-ve.mjs` — bim-02

```js
export function quyetDinh(soGhi, dsDia, mangBang, rowId, cot):
  { keoVe: FileBang[], dayLen: FileDia[], canQuyet: MucCanQuyet[] }
// MucCanQuyet = { ten, tinhHuong, rowId, cot, size, duongDan?, id? }
//
// HÀM THUẦN — không đụng đĩa, không gọi mạng. Đây là NGƯỜI QUYẾT DUY NHẤT của cả
// script, và là thứ đáng test nhất: phủ đủ 6 dòng bảng quyết định ở phase-04.
//
// Hai dòng quan trọng nhất của bảng:
//   lần trước CÓ · đĩa KHÔNG · bảng CÓ  → canQuyet (người xoá khỏi thư mục), KHÔNG kéo lại
//   lần trước CÓ · đĩa CÓ · bảng KHÔNG  → canQuyet (người xoá trên web),   KHÔNG đẩy lại

export async function keoMotFile(cauHinh, fileBang, duongDanCot, nenTang, { chayKho })
// Tải ra tên `.tam` → kiểm đủ byte → rename sang tên thật. Tải thẳng ra tên thật
// mà đứt mạng là để lại file cụt, lần sau thấy đúng tên thì coi như xong và bản vẽ
// hỏng nằm lại vĩnh viễn — cùng loại bẫy với "file copy dở" của day-len, chiều ngược.
//
// KHÔNG BAO GIỜ ghi đè file đã có trên đĩa. Trùng tên khác nội dung → canQuyet.
//
// File trong thùng rác trả 404 y hệt file đã xoá hẳn (api/files.js cố ý vậy), nên
// KHÔNG phân biệt được hai trường hợp. Báo trung thực "không tải được (đã vào thùng
// rác hoặc đã bị xoá hẳn)" và xếp vào canQuyet — đừng im lặng bỏ qua, đừng xin
// ADMIN_KEY cho script.
```

---

## Ai gọi ai

```
dong-bo-thu-muc.mjs  (bim-e5)
  ├─ nen-tang.docCauHinh / layKhoa / docBang / docSoGhi
  ├─ cay-thu-muc.dungCay          → thuMucCot
  ├─ day-len.dayCaDong            → cho từng dòng
  ├─ nen-tang.ghiBangMotDong      → sau mỗi dòng
  └─ nen-tang.ghiSoGhi + báo cáo
```

`cay-thu-muc.mjs` và `day-len.mjs` **nhận `nenTang` như tham số**, không `import`
trực tiếp — để test được bằng bản giả, không phải chờ bim-02 xong.

## Test bằng bản giả

Mỗi người tự dựng `nenTang` giả trong test của mình:

```js
const nenTangGia = {
  duongDai: (p) => p,
  docBang: async () => ({ rows: [...], mtime: 1 }),
  khoaFile: (r, c, t, s) => `${r}|${c}|${t}|${s}`,
};
```

Không ai phải chờ ai. Ghép là việc của bim-e5.

## Xong thì làm gì

Nhắn `bim-e5`: tên file, các hàm đã export, số phép kiểm đạt, và chỗ nào bạn thấy
hợp đồng này chưa ổn. **Đừng tự commit** — bim-e5 gom và commit một lần.
