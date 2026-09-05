// ============================================================
//  Dựng cây thư mục trên NAS khớp cây WBS của bảng.
//
//  Chốt an toàn quan trọng nhất: THƯ MỤC KHÔNG CÓ `.bim-id` THÌ KHÔNG ĐỌC,
//  KHÔNG SỬA, KHÔNG BÁO LỖI. Người dùng dựng cây mới ngay trong thư mục bản vẽ
//  đang dùng, nên cây cũ của công ty nằm cạnh cây mới một thời gian dài. Đệ quy
//  vào thư mục lạ là bắt đầu đọc dữ liệu không phải của mình — đừng làm.
//
//  Module chỉ export hàm, không chạy gì lúc import (luật 1 của HOP-DONG.md).
//  `nenTang` nhận qua tham số, không import — để test bằng bản giả.
//
//  ĐẶT TÊN THEO CẤP (phương án H, người dùng chốt 05/09/2026):
//    cấp 0  Phần  → BỎ, không tạo thư mục (trừ khi nó không có con)
//    cấp 1  Tập   → "<số> <tên tra từ BANG_TRA_TAP>"  vd "1 Chinh tuyen vuot de"
//    cấp 2  Nhóm  → "<số> <viết tắt chữ cái đầu>"     vd "1 CKN"
//    cấp 3+ Quyển → mã quyển + tên rút gọn            vd "I.1-1 CKN SD-CTP-T47"
//  KHÔNG có mã WBS đầy đủ ở đầu tên. Số ở cấp Tập/Nhóm chỉ là chữ số cuối của mã,
//  đủ để Explorer sắp đúng trình tự bảng mà chỉ tốn 2 ký tự.
//  Hai chỗ mã WBS vẫn phải xuất hiện, đều có lý do, đừng "dọn cho nhất quán":
//    · số thứ tự cấp Tập/Nhóm — không có thì Explorer sắp theo vần, "Kết cấu khác"
//      nhảy từ cuối lên thứ hai, phá trình tự thi công;
//    · hạng mục để trống — lùi về mã WBS vì không còn gì khác để đặt tên.
// ============================================================
import fs from "node:fs/promises";
import path from "node:path";

// Năm cột file, đúng thứ tự FKEYS trong bang-hang-muc.html.
export const COT = [
  { key: "files",          thuMuc: "PDF" },
  { key: "filesCad",       thuMuc: "DWG-Excel" },
  { key: "filesTvgs",      thuMuc: "TVGS" },
  { key: "filesDuyet",     thuMuc: "Da duyet" },
  { key: "filesChapThuan", thuMuc: "Chap thuan" },
];

// Tên ngắn cho cấp Tập. KHÔNG suy ra được từ tên gốc bằng bất kỳ quy tắc máy nào
// ("Song Hanh" ← "TẬP I: PHẦN CẦU SONG HÀNH VƯỢT ĐÊ TẢ SÔNG ĐUỐNG"), nên phải tra
// bảng. Khoá so khớp là chuỗi con đã bỏ dấu, viết hoa. Thêm Tập mới mà quên thêm
// vào đây thì thư mục mang tên dự phòng dài — script sẽ cảnh báo, không im lặng.
export const BANG_TRA_TAP = [
  { khop: "CHINH TUYEN", ten: "Chinh tuyen vuot de" },
  { khop: "CAU CAN",     ten: "Cau Can" },
  { khop: "SONG HANH",   ten: "Song Hanh" },
];

const TEN_BIM_ID = ".bim-id";
const DAI_TAP_DU_PHONG = 20;   // Tập chưa có trong bảng tra
const DAI_QUYEN = 26;          // khớp mẫu người dùng duyệt: "I.1-1 CKN SD-CTP-T47"

// Trần 260 ký tự là của Explorer, AutoCAD và Excel trên máy Windows CHƯA bật
// LongPathsEnabled — KHÔNG phải trần của việc ghi. NAS đo được 1039 ký tự với
// `\\?\UNC\`, nên script luôn ghi được; vượt 260 chỉ nghĩa là thư mục đó phải mở
// bằng máy đã bật LongPaths. Vì thế đây là canhBao, không phải loi.
const TRAN_EXPLORER = 260;
const CHO_TEN_FILE = 80;       // tên bản vẽ dài nhất đo được trong dự án này
const NGUONG_CANH_BAO = TRAN_EXPLORER - CHO_TEN_FILE;

// ---------------------------------------------------------------- mã WBS

// Y hệt computeCodes() trong bang-hang-muc.html. Sai một ly là mã trong cảnh báo
// lệch khỏi mã hiện trên bảng, người dùng không đối chiếu được.
export function tinhMaWbs(rows) {
  const ma = new Array(rows.length);
  const dem = [];
  for (let i = 0; i < rows.length; i++) {
    const L = rows[i].level | 0;
    dem[L] = (dem[L] || 0) + 1;
    dem.length = L + 1;
    ma[i] = dem.join(".");
  }
  return ma;
}

// Lá = không có con = dòng kế tiếp có level <= level của nó (hoặc hết bảng).
export function laDongLa(rows, i) {
  return !(i + 1 < rows.length && (rows[i + 1].level | 0) > (rows[i].level | 0));
}

// Dòng có file ở bất kỳ cột nào.
export function coFile(row) {
  return COT.some((c) => Array.isArray(row && row[c.key]) && row[c.key].length > 0);
}

// Dòng nào cần thư mục cột. KHÔNG chỉ dòng lá: người dùng gắn file thẳng vào dòng
// CHA thật — dữ liệu thật có 5 file nằm ở một dòng cha. Chỉ tạo cho dòng lá thì
// những file đó không có chỗ kéo về, và không có thư mục để thả file lên. Dòng cha
// vừa có thư mục con (các quyển) vừa có 5 thư mục cột của mình, Explorer không xung đột.
export function canThuMucCot(rows, i) {
  return laDongLa(rows, i) || coFile(rows[i]);
}

// ---------------------------------------------------------------- đặt tên

function htmlSangChu(s) {
  return String(s == null ? "" : s)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

function boDauTiengViet(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D");
}

// Bỏ dấu, thay ký tự Windows cấm, gộp khoảng trắng.
function lamSach(s) {
  return boDauTiengViet(s)
    .replace(/[\\/:*?"<>|]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, "")
    .replace(/\s+/g, " ").trim();
}

// Cắt còn `dai` ký tự nhưng không cắt giữa từ, rồi dọn ký tự lẻ ở cuối. Không dọn
// thì "…DẦM LIÊN TỤC (55+90+55)" cắt đúng 26 ra "I.3-2 KCDLT(" — dấu ngoặc mở lơ lửng.
function catGon(s, dai) {
  let r = s;
  if (r.length > dai) {
    const c = r.slice(0, dai);
    const k = c.lastIndexOf(" ");
    r = (k > 0 ? c.slice(0, k) : c).trim();
  }
  return r.replace(/[^A-Za-z0-9)\]]+$/, "").trim();
}

// Viết tắt chữ cái đầu mỗi từ: "CỌC KHOAN NHỒI" → "CKN".
export function vietTatCumTu(chu) {
  return boDauTiengViet(chu).split(/\s+/).filter(Boolean)
    .map((w) => w[0]).join("").toUpperCase();
}

// Tên ngắn cho cấp Tập. Trả kèm `laDuPhong` để người gọi cảnh báo.
export function rutTenTap(chu, bangTra = BANG_TRA_TAP) {
  const khoa = boDauTiengViet(chu).toUpperCase();
  for (const m of bangTra) if (khoa.includes(m.khop)) return { ten: m.ten, laDuPhong: false };
  return { ten: catGon(lamSach(chu), DAI_TAP_DU_PHONG), laDuPhong: true };
}

// Từ nối/lượng từ — bỏ đi thì tên ngắn mà không mất thông tin phân biệt.
const TU_BO = /^(CAC|TU|DEN|VA|TRU|MO|NHIP)$/i;

// Cấp Quyển: "QUYỂN I.1-1: CỌC KHOAN NHỒI CÁC TRỤ SD-CTP-T47, SD-CTT-T47"
//         →  "I.1-1 CKN SD-CTP-T47"
// Giữ mã quyển, viết tắt cụm chữ mô tả, giữ MÃ TRỤ ĐẦU TIÊN. Không khớp dạng
// "QUYỂN <mã>:" thì giữ nguyên chữ và chỉ cắt gọn — "THOÁT NƯỚC MẶT CẦU" viết tắt
// thành "TNMC" là mất nghĩa, không đáng.
// Mã trụ: bắt đầu bằng chữ, có ít nhất một chữ số. "SD-CTP-T47" · "T56-T" · "M2".
// KHÔNG khớp "(55+90+55)" — đó là khẩu độ nhịp, không phải mã trụ; nhận nhầm nó
// thì tên thư mục thành "I.3-2 KCDLT (55+90+55)".
const LA_MA_TRU = /^[A-Z][A-Z0-9-]*\d[A-Z0-9-]*$/i;
const LA_TU_THUAN = /^[A-Z]+$/i;

export function rutTenQuyen(chu) {
  // Tách mã quyển TRƯỚC khi lamSach: lamSach biến dấu ":" thành "-", sau đó
  // "I.1-1: CỌC" thành "I.1-1-COC" và token đầu "-COC" không còn là từ thuần chữ,
  // nên chữ "C" bị nuốt mất — tên ra "I.1-1 -KN" thay vì "I.1-1 CKN".
  const raw = String(chu == null ? "" : chu).replace(/^QUY[ỂE]N\s*/i, "").trim();
  const m = raw.match(/^([IVX]+\.\d+-\d+)\s*[:.\-]?\s*([\s\S]*)$/i);
  if (!m) return catGon(lamSach(raw), DAI_QUYEN);

  const maQuyen = m[1];
  // Mã trụ hay bị khoảng trắng chen vào quanh dấu gạch ("SHP/T -T46" → "SHP-T -T46").
  // Không nối lại thì token "-T46" cụt đầu và phần chữ nuốt mất "SHP-T".
  const moTa = lamSach(m[2]).replace(/\s*-\s*/g, "-").replace(/^[-,\s]+/, "");

  const chuDau = [];
  let maTru = "";
  for (const w of moTa.split(/[\s,]+/).filter(Boolean)) {
    if (LA_MA_TRU.test(w)) { maTru = w.replace(/[,.]+$/, ""); break; }
    if (LA_TU_THUAN.test(w)) chuDau.push(w);
    // token còn lại (ngoặc, số trần, ký hiệu) bỏ qua — không phải chữ, không phải mã trụ
  }
  const tat = chuDau.filter((w) => !TU_BO.test(w)).map((w) => w[0]).join("").toUpperCase();
  return catGon([maQuyen, tat, maTru].filter(Boolean).join(" "), DAI_QUYEN);
}

// `cap` quyết định quy tắc. `daDung` là Set tên đã dùng TRONG CÙNG thư mục cha.
export function tenThuMuc(row, ma, cap, daDung, tuyChon = {}) {
  const chu = htmlSangChu(row && row.hangMuc);
  let ten, laDuPhong = false;

  if (cap === 1) { const r = rutTenTap(chu, tuyChon.bangTraTap || BANG_TRA_TAP); ten = r.ten; laDuPhong = r.laDuPhong; }
  else if (cap === 2) ten = vietTatCumTu(lamSach(chu));
  else ten = rutTenQuyen(chu);

  // Cấp Tập và Nhóm mang thêm số thứ tự để Explorer sắp đúng trình tự bảng. Không
  // có nó thì cấp Nhóm hiện CKN < KCK < KCPD < KCPT — "Kết cấu khác" nhảy từ cuối
  // lên thứ hai, phá trình tự thi công.
  //
  // Cấp NHÓM dùng chữ số cuối mã WBS được, vì nhóm nằm trong Tập nên số tự đánh lại
  // từ 1 trong mỗi Tập. Cấp TẬP thì KHÔNG: bỏ cấp Phần khiến Tập của mọi Phần cùng
  // rơi về thư mục gốc, mà chữ số cuối đánh lại từ 1 trong mỗi Phần — hai Phần cho
  // ra "1 …", "2 …", "1 …", "2 …" và Explorer trộn hai Phần vào nhau, đúng cái mà
  // số thứ tự sinh ra để tránh. Nên người gọi truyền `tuyChon.so` chạy suốt 1..n.
  // Cấp NHÓM tự suy được số từ mã WBS. Cấp TẬP thì KHÔNG — nó phải do người gọi
  // đếm chạy suốt và truyền vào. Không truyền thì để tên KHÔNG SỐ, tuyệt đối đừng
  // lấy tạm chữ số cuối mã: số đó đánh lại từ 1 trong mỗi Phần, mà mọi Tập lại cùng
  // nằm ở thư mục gốc, nên nó sinh ra "1 …, 2 …, 1 …, 2 …" và Explorer trộn hai Phần
  // vào nhau — tệ hơn hẳn so với không có số.
  if (cap === 2) ten = ((tuyChon.so != null ? tuyChon.so : String(ma).split(".").pop()) + " " + ten).trim();
  else if (cap === 1 && tuyChon.so != null) ten = (tuyChon.so + " " + ten).trim();

  // Windows lặng lẽ bỏ dấu chấm và khoảng trắng cuối tên. Cắt tường minh ở đây để
  // tên ta tính ra bằng đúng tên trên đĩa — không thì lần chạy sau tưởng lệch và
  // đổi tên vô ích mỗi lần.
  ten = String(ten || "").replace(/[. ]+$/g, "").trim();
  // Tên chỉ gồm dấu chấm ("." hoặc "..") là lối thoát khỏi thư mục cha. Chặn TƯỜNG
  // MINH ở đây — dòng cắt dấu chấm cuối phía trên tình cờ cũng chặn được, nhưng nó
  // sinh ra để lo chuyện khác, ai dọn nó sau này sẽ mở lại lỗ này.
  if (/^\.+$/.test(ten)) ten = "";
  // Hạng mục để trống: không mã WBS ở đầu tên thì chẳng còn gì. Đây là chỗ DUY NHẤT
  // mã WBS vẫn phải xuất hiện.
  if (!ten) ten = String(ma);

  if (!daDung) return { ten, laDuPhong, laTrung: false };
  // So bằng chữ thường: Windows KHÔNG phân biệt hoa thường trong tên thư mục, nên
  // "Coc khoan nhoi" và "COC KHOAN NHOI" là MỘT thư mục. Dùng Set phân biệt hoa
  // thường thì hai dòng không bị coi là trùng, cùng trỏ vào một thư mục, và mỗi
  // lần chạy lại ghi đè .bim-id của nhau — file của dòng này bị đẩy lên dòng kia.
  const khoa = ten.toLowerCase();
  if (!daDung.has(khoa)) { daDung.add(khoa); return { ten, laDuPhong, laTrung: false }; }
  for (let n = 2; ; n++) {
    const thu = ten + " (" + n + ")";
    if (!daDung.has(thu.toLowerCase())) {
      daDung.add(thu.toLowerCase());
      return { ten: thu, laDuPhong, laTrung: true, tenGoc: ten };
    }
  }
}

// ---------------------------------------------------------------- đọc cây

async function docBimId(nenTang, thuMuc) {
  try {
    const raw = await fs.readFile(nenTang.duongDai(path.join(thuMuc, TEN_BIM_ID)), "utf8");
    return String(raw).trim() || null;
  } catch {
    return null;   // không có .bim-id, hoặc không đọc được → coi như thư mục lạ
  }
}

export async function docCayHienCo(thuMucGoc, nenTang, ketQua) {
  const banDo = new Map();
  const trung = [];

  async function quet(thuMuc) {
    let mucCon;
    try {
      mucCon = await fs.readdir(nenTang.duongDai(thuMuc), { withFileTypes: true });
    } catch {
      return;   // thư mục vừa bị xoá / không có quyền đọc → bỏ qua, không phá cả lượt chạy
    }
    for (const m of mucCon) {
      if (!m.isDirectory()) continue;
      const con = path.join(thuMuc, m.name);
      const id = await docBimId(nenTang, con);
      if (!id) continue;   // ← chốt an toàn: thư mục lạ thì không đọc, không đệ quy vào
      if (banDo.has(id)) trung.push({ duongDan: con, ly_do: "trùng .bim-id với " + banDo.get(id) });
      else banDo.set(id, con);
      await quet(con);
    }
  }

  await quet(thuMucGoc);
  if (ketQua && trung.length) ketQua.push(...trung);
  return banDo;
}

// ---------------------------------------------------------------- dựng cây

// Cha đổi tên thì đường dẫn đã ghi nhận của mọi con cháu cũng lệch theo. Sửa tiền
// tố trong bản đồ, nếu không con sẽ bị coi là "chưa có thư mục" và bị tạo mới —
// tách file ra khỏi thư mục đang dùng.
function doiTienTo(banDo, cu, moi) {
  for (const [id, p] of banDo) {
    if (p === cu) banDo.set(id, moi);
    else if (p.startsWith(cu + path.sep)) banDo.set(id, moi + p.slice(cu.length));
  }
}

async function taoThuMuc(nenTang, duongDan, chayKho) {
  if (chayKho) return;
  await fs.mkdir(nenTang.duongDai(duongDan), { recursive: true });
}

export async function dungCay(thuMucGoc, rows, nenTang, { chayKho = true, bangTraTap } = {}) {
  if (!Array.isArray(rows)) throw new Error("dungCay: cần mảng dòng của bảng");
  if (!thuMucGoc) throw new Error("dungCay: thiếu đường dẫn thư mục gốc");

  const loi = [];
  const canhBao = [];
  const hienCo = await docCayHienCo(thuMucGoc, nenTang, loi);
  const ma = tinhMaWbs(rows);

  const taoMoi = [];
  const doiTen = [];
  const boQuaCapPhan = [];
  const thuMucCot = new Map();
  const daDungTheoCha = new Map();
  const conSong = new Set();
  const chaTheoCap = [];
  let demTap = 0;   // số thứ tự cấp Tập, chạy suốt qua mọi Phần

  // Dòng nhảy cấp (0 → 2, thiếu cấp 1) không có cha ở đúng cấp trên. Lùi tìm tổ tiên
  // gần nhất thay vì rơi thẳng về gốc — rơi về gốc là mất quan hệ cha con.
  const chaGanNhat = (L) => {
    for (let k = L - 1; k >= 0; k--) if (chaTheoCap[k]) return chaTheoCap[k];
    return null;
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const L = row.level | 0;

    // Bỏ cấp Phần — nhưng CHỈ khi nó là thư mục nhóm. Dòng cấp 0 không có con mà bỏ
    // thì file của nó không còn chỗ nào để nằm.
    if (L === 0 && !laDongLa(rows, i)) {
      boQuaCapPhan.push({ rowId: row.id, ma: ma[i] });
      chaTheoCap.length = 0;      // con của nó rơi thẳng về thư mục gốc
      continue;
    }

    const duongDanCha = chaGanNhat(L) || thuMucGoc;
    if (!daDungTheoCha.has(duongDanCha)) daDungTheoCha.set(duongDanCha, new Set());

    if (L === 1) demTap++;
    const kq = tenThuMuc(row, ma[i], L, daDungTheoCha.get(duongDanCha),
      { bangTraTap, so: L === 1 ? demTap : undefined });
    if (kq.laDuPhong) {
      canhBao.push({
        duongDan: duongDanCha, ly_do: "Tập \"" + ma[i] + "\" chưa có tên viết tắt trong BANG_TRA_TAP — "
          + "đang dùng tên dự phòng \"" + kq.ten + "\" (" + kq.ten.length + " ký tự). Thêm vào bảng tra để tên ngắn và ổn định.",
      });
    }
    if (kq.laTrung) {
      canhBao.push({
        duongDan: path.join(duongDanCha, kq.ten), ly_do: "Dòng \"" + ma[i] + "\" trùng tên với dòng khác cùng thư mục "
          + "(\"" + kq.tenGoc + "\") nên phải thêm hậu tố — hai thư mục nhìn gần giống nhau, dễ mở nhầm.",
      });
    }
    const mongMuon = path.join(duongDanCha, kq.ten);

    conSong.add(row.id);
    const dangCo = hienCo.get(row.id);

    if (!dangCo) {
      try {
        await taoThuMuc(nenTang, mongMuon, chayKho);
        if (!chayKho) {
          await fs.writeFile(nenTang.duongDai(path.join(mongMuon, TEN_BIM_ID)), String(row.id), "utf8");
        }
        taoMoi.push({ rowId: row.id, duongDan: mongMuon });
      } catch (e) {
        loi.push({ duongDan: mongMuon, ly_do: "không tạo được thư mục: " + (e && e.message) });
      }
    } else if (dangCo !== mongMuon) {
      try {
        if (!chayKho) await fs.rename(nenTang.duongDai(dangCo), nenTang.duongDai(mongMuon));
        doiTen.push({ rowId: row.id, cu: dangCo, moi: mongMuon });
        doiTienTo(hienCo, dangCo, mongMuon);
      } catch (e) {
        // Windows chặn khi có người đang mở file bên trong. Báo rõ, giữ đường dẫn cũ
        // cho dòng này rồi chạy tiếp — một thư mục kẹt không nên chặn 46 dòng kia.
        loi.push({ duongDan: dangCo, ly_do: "không đổi tên được (có thể đang mở): " + (e && e.message) });
        chaTheoCap[L] = dangCo;
        chaTheoCap.length = L + 1;
        if (canThuMucCot(rows, i)) await dungCot(row.id, dangCo);
        continue;
      }
    }

    chaTheoCap[L] = mongMuon;
    chaTheoCap.length = L + 1;
    if (canThuMucCot(rows, i)) await dungCot(row.id, mongMuon);
  }

  // Thư mục con theo cột chỉ tạo cho dòng lá — dòng cha chỉ là thư mục nhóm.
  async function dungCot(rowId, goc) {
    const cot = {};
    for (const c of COT) {
      const p = path.join(goc, c.thuMuc);
      cot[c.key] = p;
      // Báo TRƯỚC khi dựng. Vượt ngưỡng KHÔNG chặn việc ghi (NAS chịu 1039 ký tự
      // với \\?\UNC\), chỉ nghĩa là thư mục này phải mở bằng máy đã bật LongPaths.
      if (p.length >= NGUONG_CANH_BAO) {
        canhBao.push({
          duongDan: p,
          ly_do: "đường dẫn " + p.length + " ký tự — cộng tên file sẽ vượt " + TRAN_EXPLORER
            + ". Script vẫn ghi được, nhưng Explorer/CAD trên máy chưa bật LongPathsEnabled sẽ không mở nổi.",
        });
      }
      try {
        await taoThuMuc(nenTang, p, chayKho);
      } catch (e) {
        loi.push({ duongDan: p, ly_do: "không tạo được thư mục cột: " + (e && e.message) });
      }
    }
    thuMucCot.set(rowId, cot);
  }

  // Thư mục mang .bim-id không khớp dòng nào: CHỈ liệt kê. Dòng có thể vừa bị xoá
  // nhầm trên web và đang chờ khôi phục — xoá thư mục ở đây là mất file thật.
  const moCoi = [];
  for (const [rowId, duongDan] of hienCo) {
    if (!conSong.has(rowId)) moCoi.push({ duongDan, rowId });
  }

  return { taoMoi, doiTen, moCoi, thuMucCot, loi, canhBao, boQuaCapPhan };
}
