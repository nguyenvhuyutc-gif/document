// Đẩy file từ thư mục NAS lên bảng web. Chủ sở hữu: bim-03.
// Hợp đồng: scripts/dong-bo/HOP-DONG.md, mục "day-len.mjs".
//
// Module CHỈ export hàm: không chạy gì lúc import, không process.exit, không
// console.log (báo tiến độ qua onLog). Lỗi thì throw Error kèm câu tiếng Việt.
// Nhận `nenTang` qua tham số, không import — để test bằng bản giả.
//
// Chỉ dùng EDIT_KEY.
//
// Chỗ đứng trong luồng (bản hợp đồng đã sửa):
//   quetThuMuc → locFileChuaOnDinh → soKhop → keo-ve.quyetDinh(sổ ghi) → dayCaDong
// `soKhop` ở đây chỉ nói "có trên đĩa mà chưa có trên bảng", KHÔNG phải quyết định
// cuối: thứ đó có thể là file người dùng vừa XOÁ trên web. Chỉ `quyetDinh` đọc sổ
// ghi nên chỉ nó phân biệt được, và `dayCaDong` nhận danh sách đã quyết.
import fs from "node:fs/promises";
import path from "node:path";

const MAX_UPLOAD = 500 * 1024 * 1024;      // khớp trần của api/files.js

// Năm cột file, ĐÚNG thứ tự của bảng (khớp FKEYS trong bang-hang-muc.html và bảng
// cột trong HOP-DONG.md). Chép ở đây thay vì import từ cay-thu-muc.mjs vì mỗi
// module chỉ sở hữu file của mình — nhưng thứ tự phải khớp, nếu không báo cáo của
// hai module xếp cột khác nhau và người đọc tưởng thiếu file.
const THU_TU_COT = ["files", "filesCad", "filesTvgs", "filesDuyet", "filesChapThuan"];

// Tên bỏ qua khi quét: rác của Windows/Office chứ không phải hồ sơ.
//   ~$…     = file khoá của Word/Excel khi đang mở
//   .bim-id = dấu của cây thư mục (cay-thu-muc.mjs)
const BO_QUA = new Set([".bim-id", "thumbs.db", "desktop.ini", ".ds_store", ".bim-sync.json", ".bim-sync.lock"]);

// Đuôi file TẢI DỞ của keo-ve.keoMotFile. Phải bỏ qua, nếu không thành vòng tròn
// khép kín giữa hai module: một lần tải về 200MB bị giết giữa chừng (mất mạng, Task
// Scheduler hết giờ) để lại file dở trên NAS, lần chạy sau module này thấy nó và đẩy
// ngược lên web thành hồ sơ chính thức.
// Kiểm theo ĐUÔI chứ không theo tên đầy đủ: tên tạm mang tên file gốc ở đầu.
// (keo-ve nay đặt tên bắt đầu bằng "." nên đã bị chặn sẵn ở trên — đây là lớp thứ
// hai, phòng khi có ai đổi cách đặt tên tạm về sau.)
const DUOI_TAM = ".bim-tam";

function nghi(ms) { return new Promise((ok) => setTimeout(ok, ms)); }
function duongDaiCua(nenTang) {
  return nenTang && typeof nenTang.duongDai === "function" ? nenTang.duongDai : (p) => p;
}

// ---------------------------------------------------------------------------
// Quét một thư mục cột, trả về danh sách file thấy được.
// Thư mục chưa tồn tại KHÔNG phải lỗi: chạy khô có thể quét trước khi cây được
// dựng. Còn lỗi khác (mất quyền, NAS rớt) thì để nguyên cho người điều phối thấy.
// ---------------------------------------------------------------------------
export async function quetThuMuc(duongDanCot, nenTang) {
  if (!duongDanCot) return [];
  const dai = duongDaiCua(nenTang);
  let muc;
  try {
    muc = await fs.readdir(dai(duongDanCot), { withFileTypes: true });
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return [];
    throw new Error("Không đọc được thư mục “" + duongDanCot + "”: " + (e && e.message));
  }

  const ra = [];
  for (const m of muc) {
    if (!m.isFile()) continue;                       // thư mục con: không phải việc của module này
    const ten = m.name;
    if (ten.startsWith(".")) continue;               // file ẩn kiểu Unix
    if (ten.startsWith("~$")) continue;              // Office đang mở file
    const thap = ten.toLowerCase();
    if (BO_QUA.has(thap)) continue;
    if (thap.endsWith(DUOI_TAM)) continue;           // file tải dở của keo-ve
    const duongDan = path.join(duongDanCot, ten);
    let st;
    try {
      st = await fs.stat(dai(duongDan));
    } catch (e) {
      continue;                                      // vừa bị xoá giữa readdir và stat — coi như không thấy
    }
    ra.push({ ten, size: st.size, mtime: st.mtimeMs, duongDan });
  }
  // sắp theo tên để thứ tự đẩy và báo cáo ổn định giữa các lần chạy
  ra.sort((a, b) => a.ten.localeCompare(b.ten, "vi"));
  return ra;
}

// ---------------------------------------------------------------------------
// Lọc ra file CHƯA ỔN ĐỊNH — phần khó nhất của cả script.
//
// Tình huống phải chặn: ai đó copy bản vẽ 200MB vào NAS, script chạy đúng lúc đó
// và đọc phải file mới được nửa → đẩy lên một file HỎNG. Tệ hơn: lần chạy sau tên
// và kích thước trên đĩa đã "khớp" với thứ đã lên, nên soKhop() coi là xong và BỎ
// QUA nó vĩnh viễn. File hỏng nằm đó cho tới khi có người mở ra — thường là lúc
// cần nhất.
//
// HAI chốt, phải có cả hai:
//   1. mtime quá mới  → còn đang được ghi, chờ lần sau.
//   2. đọc lại kích thước sau ~3s → còn đổi nghĩa là đang chép dở.
// Chốt 1 bắt phần lớn trường hợp mà không tốn gì; chốt 2 bắt file copy chậm qua
// mạng, thứ có thể giữ nguyên mtime hàng chục giây trong khi kích thước bò lên.
//
// Chỉ nghỉ MỘT lần cho cả mẻ, không phải mỗi file 3s.
// `doiLaiMs` và `nenTang` là tham số THÊM ngoài hợp đồng: cái đầu để test chạy
// nhanh, cái sau để stat lại đi qua đường dẫn dài (\\?\) như lúc quét.
// ---------------------------------------------------------------------------
export async function locFileChuaOnDinh(dsFile, { tuoiToiThieuGiay = 60, doiLaiMs = 3000, nenTang } = {}) {
  const ds = Array.isArray(dsFile) ? dsFile : [];
  const dai = duongDaiCua(nenTang);
  const bayGio = Date.now();
  const cho = [], ungVien = [];

  for (const f of ds) {
    if (bayGio - f.mtime < tuoiToiThieuGiay * 1000) cho.push(f);   // chốt 1
    else ungVien.push(f);
  }
  if (!ungVien.length) return { dung: [], cho };

  await nghi(doiLaiMs);

  const dung = [];
  for (const f of ungVien) {
    let st = null;
    try {
      st = await fs.stat(dai(f.duongDan));
    } catch (e) {
      cho.push(f);                                   // biến mất giữa chừng → để lần sau
      continue;
    }
    // So cả mtime lẫn size. Hợp đồng chỉ đòi size, nhưng có kiểu ghi đè giữ nguyên
    // kích thước mà đổi nội dung — mtime bắt được, và kiểm thêm không tốn gì.
    if (st.size !== f.size || st.mtimeMs !== f.mtime) cho.push(f);   // chốt 2
    else dung.push(f);
  }
  return { dung, cho };
}

// ---------------------------------------------------------------------------
// So file trên đĩa với file đã có trên bảng. Khớp bằng TÊN + KÍCH THƯỚC, không
// băm nội dung: băm 500MB qua đường mạng NAS mỗi lần chạy là quá đắt.
//
// `canDay` nghĩa là "có trên đĩa mà chưa có trên bảng" — CHƯA phải "hãy đẩy lên".
// File người dùng vừa xoá trên web cũng rơi vào đây; phân biệt là việc của
// keo-ve.quyetDinh(), thứ duy nhất đọc sổ ghi.
// ---------------------------------------------------------------------------
export function soKhop(dsDia, mangBang) {
  const dia = Array.isArray(dsDia) ? dsDia : [];
  const daLen = new Set(
    (Array.isArray(mangBang) ? mangBang : [])
      .map((f) => ((f && f.name) || "") + "\u0000" + Number((f && f.size) || 0))
  );
  const canDay = [], daCo = [];
  for (const f of dia) {
    (daLen.has(f.ten + "\u0000" + Number(f.size || 0)) ? daCo : canDay).push(f);
  }
  return { canDay, daCo };
}

// Content-Disposition theo RFC 5987. Header HTTP chỉ chở được ASCII, mà tên bản vẽ
// hầu hết có dấu tiếng Việt — thiếu phần filename* là người tải về nhận một cái tên
// hex vô nghĩa, và KHÔNG có đường sửa ở phía client (thuộc tính download của thẻ <a>
// bị bỏ qua sau khi chuyển hướng sang khác origin).
function headerTenFile(ten) {
  const ascii = String(ten || "file").replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(ten || "file");
}

async function docJson(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) {}
  throw new Error("máy chủ trả lỗi HTTP " + r.status);
}

// ---------------------------------------------------------------------------
// Đẩy MỘT file: xin URL ký → PUT thẳng lên kho → xác nhận.
// KHÔNG BAO GIỜ ghi `uploadUrl` ra log hay ra thông báo lỗi: nó mang chữ ký còn
// hiệu lực, ai cầm được cũng ghi đè được object đó.
// ---------------------------------------------------------------------------
export async function dayMotFile(cauHinh, file, meta) {
  const ten = (meta && meta.name) || file.ten;
  const kieu = (meta && meta.type) || "application/octet-stream";
  if (file.size > MAX_UPLOAD) throw new Error("QUA_LON");

  const dau = { "x-edit-key": cauHinh.EDIT_KEY };
  const q = "?action=sign-upload"
    + "&name=" + encodeURIComponent(ten)
    + "&type=" + encodeURIComponent(kieu)
    + "&size=" + file.size
    // Máy chủ đóng dấu cột vào phiên tải lên. Thiếu nó thì file nằm ở cột "Ý kiến
    // TVGS" sẽ không được bên TVGS (người không có mật khẩu) xoá — họ chỉ đụng
    // được file mang đúng dấu này.
    + "&cot=" + encodeURIComponent((meta && meta.cot) || "");
  const ky = await fetch(cauHinh.BASE_URL + "/api/files" + q, { method: "POST", headers: dau }).then(docJson);
  if (!ky || !ky.ok || !ky.uploadUrl) {
    throw new Error("Không xin được đường tải lên: " + ((ky && ky.error) || "máy chủ từ chối"));
  }

  // Đọc cả file vào bộ nhớ rồi PUT một lần. Truyền theo luồng sẽ thành chunked
  // encoding, mà URL ký của S3 đòi Content-Length — nên với 500MB thì tốn 500MB
  // RAM, chấp nhận được vì script chạy ở máy trạm chứ không phải trong hàm.
  const noiDung = await fs.readFile(file.duongDan);
  let r;
  try {
    r = await fetch(ky.uploadUrl, {
      method: "PUT",
      headers: { "content-type": kieu, "content-disposition": headerTenFile(ten) },
      body: noiDung,
    });
  } catch (e) {
    throw new Error("Mất kết nối khi tải “" + ten + "” lên kho lưu trữ");
  }
  if (!r.ok) throw new Error("Kho lưu trữ từ chối “" + ten + "” (HTTP " + r.status + ")");

  const xong = await fetch(
    cauHinh.BASE_URL + "/api/files?action=confirm&id=" + encodeURIComponent(ky.id)
      + "&key=" + encodeURIComponent(ky.key),
    { method: "POST", headers: dau }
  ).then(docJson);
  if (!xong || !xong.ok || !xong.file) {
    throw new Error("Xác nhận thất bại: " + ((xong && xong.error) || "máy chủ từ chối"));
  }

  // Trả về ĐÚNG hình dạng bảng đang lưu. Cố ý KHÔNG đặt `pairUid`.
  //
  // Hành vi thật ở giao diện PHỤ THUỘC cột đó đã được dùng hay chưa — đo bằng chính
  // normalizeRowShape của bang-hang-muc.html, không phải suy đoán:
  //   · cột chưa file nào mang `pairUid` (dòng mới, hoặc cột chỉ toàn file do script
  //     đẩy) → lần mở bảng kế tiếp giao diện TỰ ghép file thứ i với file PDF thứ i,
  //     đúng thứ tự trong thư mục.
  //   · cột đã có file được gán qua giao diện → phép ghép tự động KHÔNG chạy lại;
  //     file script đẩy lên nằm ở khối "chưa gán" dưới đáy cột, quản trị bấm nút
  //     mũi tên để đưa vào ô.
  // Đặt sẵn "" thì mất luôn nhánh đầu và MỌI file đều phải gán tay — nên để trống.
  return {
    id: xong.file.id,
    name: xong.file.name,
    size: xong.file.size,
    type: xong.file.type,
    url: xong.file.url,
    uploadedAt: new Date().toISOString(),
    note: "",
  };
}

// đoán kiểu MIME từ đuôi — đủ để trình duyệt mở đúng thứ hay tải xuống
const KIEU = {
  pdf: "application/pdf", dwg: "application/acad", dxf: "application/dxf",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", zip: "application/zip",
  rar: "application/vnd.rar", txt: "text/plain", rvt: "application/octet-stream",
};
export function kieuTheoDuoi(ten) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(ten || ""));
  return (m && KIEU[m[1].toLowerCase()]) || "application/octet-stream";
}

// `dsCanDay` là MAP { [cot]: FileDia[] }, và CHỈ dạng đó. Cố ý không nhận thêm dạng
// mảng phẳng: map khớp thẳng với `thuMucCot` mà cay-thu-muc trả về, nên người điều
// phối không phải bẻ hình dạng ở giữa — mỗi lần bẻ là thêm một chỗ để lệch.
// Trả về [{cot, file}] theo ĐÚNG thứ tự cột của bảng.
function xepTheoCot(dsCanDay) {
  const ra = [];
  if (!dsCanDay) return ra;
  if (Array.isArray(dsCanDay)) {
    throw new Error("dsCanDay phải là map { [cot]: FileDia[] }, không phải mảng — xem HOP-DONG.md");
  }
  // kiểm tên cột TRƯỚC khi duyệt: cột lạ mà im lặng bỏ qua thì file trong đó biến
  // mất khỏi báo cáo, và không ai biết vì sao thiếu
  const la = Object.keys(dsCanDay).filter((k) => THU_TU_COT.indexOf(k) < 0);
  if (la.length) throw new Error("dsCanDay có cột lạ: " + la.join(", "));
  for (const cot of THU_TU_COT) {
    for (const f of (Array.isArray(dsCanDay[cot]) ? dsCanDay[cot] : [])) ra.push({ cot, file: f });
  }
  return ra;
}

// ---------------------------------------------------------------------------
// Đẩy những file ĐÃ ĐƯỢC QUYẾT ĐỊNH là cần đẩy, của MỘT dòng.
//
// KHÔNG tự quét, KHÔNG tự soKhop, KHÔNG tự ghi bảng:
//   · quyết định đẩy hay không là của keo-ve.quyetDinh() — chỉ nó đọc sổ ghi, nên
//     chỉ nó phân biệt được "file mới" với "file người dùng vừa xoá trên web".
//   · ghi bảng là của nen-tang.ghiBangMotDong(), gọi sau mỗi dòng để đứt giữa
//     chừng chỉ mất một dòng.
//
// VẪN lọc lại độ ổn định ngay trước khi đẩy: giữa lúc điều phối quét và lúc đến
// lượt dòng này có thể đã trôi qua vài phút, đủ để ai đó bắt đầu chép đè một file.
// Đây là chốt cuối, và là chốt rẻ nhất so với việc đẩy lên một bản vẽ hỏng.
//
// Một file lỗi KHÔNG làm hỏng cả dòng: gom vào `loi` rồi đi tiếp. Bản vẽ thứ ba
// hỏng không phải lý do để hai bản đã lên bị bỏ.
// ---------------------------------------------------------------------------
export async function dayCaDong(cauHinh, row, dsCanDay, nenTang, { chayKho = true, onLog } = {}) {
  const noi = typeof onLog === "function" ? onLog : () => {};
  const daDay = [], cho = [], loi = [], seDay = [];

  const cong = xepTheoCot(dsCanDay);
  // Dòng không có gì cần đẩy → về NGAY, không nghỉ giây nào. Bảng vài chục dòng mà
  // mỗi lần chạy chỉ dăm dòng có bản vẽ mới thì chốt ổn định gần như không tốn gì;
  // còn lúc đẩy hàng loạt thì 3 giây mỗi dòng là cái giá đáng trả.
  if (!cong.length) return { daDay, cho, loi, seDay };

  // lọc ổn định MỘT lần cho cả dòng — một lần nghỉ 3s, không phải mỗi file một lần
  const { dung, cho: chuaXong } = await locFileChuaOnDinh(cong.map((x) => x.file), { nenTang });
  const conDung = new Set(dung);
  for (const f of chuaXong) {
    cho.push(f);
    noi("chờ (đang được ghi): " + f.ten);
  }

  for (const { cot, file } of cong) {
    if (!conDung.has(file)) continue;                // đã nằm trong `cho`
    if (chayKho) {
      seDay.push({ ...file, cot });
      noi("[chạy khô] sẽ đẩy: " + cot + "/" + file.ten + " (" + file.size + " byte)");
      continue;
    }
    try {
      noi("đang đẩy: " + cot + "/" + file.ten + " (" + file.size + " byte)");
      const len = await dayMotFile(cauHinh, file, { name: file.ten, type: kieuTheoDuoi(file.ten), cot });
      len.cot = cot;                                 // người điều phối cần biết bỏ vào cột nào
      daDay.push(len);
    } catch (e) {
      const ly_do = e && e.message === "QUA_LON"
        ? "vượt 500MB — không đẩy được"
        : (e && e.message) || "lỗi không rõ";
      loi.push({ ten: file.ten, cot, ly_do });
      noi("LỖI " + cot + "/" + file.ten + ": " + ly_do);
    }
  }

  return { daDay, cho, loi, seDay };
}
