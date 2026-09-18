#!/usr/bin/env node
// ============================================================
//  Đồng bộ thư mục NAS ↔ bảng theo dõi hạng mục.
//
//    node scripts/dong-bo-thu-muc.mjs                 chạy khô — chỉ in việc sẽ làm
//    node scripts/dong-bo-thu-muc.mjs --thuc-hien     ghi thật
//    node scripts/dong-bo-thu-muc.mjs --dung-cay      chỉ dựng cây, không đụng file
//
//  KHÔNG BAO GIỜ XOÁ, ở cả hai bên. File biến mất một bên thì báo vào mục "cần bạn
//  quyết" và để người quyết — xem bảng quyết định trong keo-ve.mjs.
//
//  File này chỉ ĐIỀU PHỐI. Mọi logic nằm ở bốn module trong dong-bo/, mỗi module
//  một người viết theo scripts/dong-bo/HOP-DONG.md. Đọc hợp đồng trước khi sửa.
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as nenTang from "./dong-bo/nen-tang.mjs";
import * as cayThuMuc from "./dong-bo/cay-thu-muc.mjs";
import * as dayLen from "./dong-bo/day-len.mjs";
import * as keoVe from "./dong-bo/keo-ve.mjs";
import * as thayBan from "./dong-bo/thay-ban-moi.mjs";

const THU_MUC_SCRIPT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const THUC_HIEN = argv.includes("--thuc-hien");
const CHI_DUNG_CAY = argv.includes("--dung-cay");
const chayKho = !THUC_HIEN;

const log = (s) => console.log(s);
const nhomLoi = [], nhomCanhBao = [], canQuyet = [];
let soDay = 0, soKeo = 0, soCho = 0;

class LoiDung extends Error {}
const dung = (msg) => { throw new LoiDung(msg); };

function nhan(row) {
  return String(row.hangMuc || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 52)
    || "(dòng trống)";
}
function ghiSo(soGhi, rowId, cot, ten, size) {
  soGhi.files[nenTang.khoaFile(rowId, cot, ten)] = { rowId, cot, ten, size };
}

async function main() {
  // Thư mục CỦA SCRIPT, không phải cwd: bấm đúp .bat thì cwd là gốc repo, và
  // docCauHinh sẽ đi tìm .env của repo (có connection string MongoDB) thay vì
  // scripts/.env.dong-bo.
  const cauHinh = nenTang.docCauHinh(THU_MUC_SCRIPT);

  log("\n╔══════════════════════════════════════════════════════════╗");
  log("║  ĐỒNG BỘ THƯ MỤC NAS ↔ BẢNG THEO DÕI HẠNG MỤC             ║");
  log("╚══════════════════════════════════════════════════════════╝");
  log("  máy chủ    : " + cauHinh.BASE_URL);
  log("  kế hoạch   : " + cauHinh.PLAN_ID);
  log("  thư mục    : " + cauHinh.THU_MUC_GOC + "   (" + cauHinh.THU_MUC_GOC.length + " ký tự)");
  log("  chế độ     : " + (THUC_HIEN ? ">>> GHI THẬT <<<" : "chạy khô (chỉ in ra)")
    + (CHI_DUNG_CAY ? "  · chỉ dựng cây" : ""));

  // CHỐT BẮT BUỘC. Đường dẫn UNC mất một dấu gạch (`\Vci-…` thay vì `\\Vci-…`) thì
  // path.resolve biến nó thành `D:\Vci-…` trên ổ hiện tại — một thư mục không có
  // thật. Không hàm nào ném lỗi: script quét ra rỗng, kết luận "cần kéo về toàn bộ",
  // rồi tạo cả cây thư mục nhầm chỗ trên ổ D. Đã xảy ra một lần trong lúc phát triển.
  if (!fs.existsSync(nenTang.duongDai(cauHinh.THU_MUC_GOC))) {
    dung("KHÔNG tìm thấy thư mục gốc:\n        " + cauHinh.THU_MUC_GOC
      + "\n        Kiểm ba thứ: đường dẫn UNC có đủ HAI dấu gạch đầu không, đã đăng"
      + "\n        nhập NAS chưa, và tài khoản này có quyền đọc thư mục đó không.");
  }
  if (cauHinh.THU_MUC_GOC.startsWith("\\\\") === false && !/^[A-Za-z]:/.test(cauHinh.THU_MUC_GOC)) {
    dung("THU_MUC_GOC không phải đường dẫn tuyệt đối: " + cauHinh.THU_MUC_GOC);
  }
  log("");

  const khoa = await nenTang.layKhoa(cauHinh.THU_MUC_GOC, { hanPhut: 30, chayKho });
  if (!khoa.duocPhep) {
    dung("máy khác đang chạy đồng bộ: " + (khoa.chuSoHuu || "không rõ")
      + "\n        Đợi nó xong rồi chạy lại. Khoá tự hết hạn sau 30 phút.");
  }

  try {
    const bang = await nenTang.docBang(cauHinh);
    const rows = bang.rows;
    let mtime = bang.mtime;
    log("  Đọc bảng: " + rows.length + " dòng · mtime " + mtime + "\n");

    // ---- 1. dựng cây ----
    log("── Dựng cây thư mục ──");
    const cay = await cayThuMuc.dungCay(cauHinh.THU_MUC_GOC, rows, nenTang, { chayKho });
    log("  " + cay.taoMoi.length + " tạo mới · " + cay.doiTen.length + " đổi tên · "
      + cay.moCoi.length + " mồ côi · " + (cay.boQuaCapPhan || []).length + " dòng cấp Phần bỏ qua");
    for (const c of cay.canhBao || []) nhomCanhBao.push(c);
    for (const l of cay.loi || []) nhomLoi.push(l);

    if (!CHI_DUNG_CAY) await dongBoFile(cauHinh, rows, cay, mtime);
    inBaoCao(cay);
  } finally {
    await khoa.nhaKhoa().catch(() => {});
  }
}

// Ghi vào metadata file cái đường dẫn TƯƠNG ĐỐI tính từ THU_MUC_GOC, để nút "mở
// trong Explorer" trên web biết file nằm ở đâu. Tương đối chứ không tuyệt đối vì
// hai lý do: mỗi máy map NAS một kiểu (ổ Z: hay UNC), và đường dẫn tuyệt đối mang
// tên máy chủ nội bộ — thứ không nên nằm trong cơ sở dữ liệu dùng chung.
//
// Khớp theo tên file, HẠ HOA THƯỜNG: Windows coi "BV-01.PDF" và "bv-01.pdf" là một
// (bẫy 7 trong HOP-DONG.md), nên so phân biệt hoa thường là bỏ sót đúng những file
// đã đồng bộ xong.
function datNasPath(cauHinh, row, cot, dsDia) {
  let doi = false;
  const theoTen = new Map();
  for (const d of dsDia || []) theoTen.set(String(d.ten || "").toLowerCase(), d);
  for (const f of Array.isArray(row[cot]) ? row[cot] : []) {
    const d = theoTen.get(String(f.name || "").toLowerCase());
    if (!d || !d.duongDan) continue;
    const tuongDoi = path.relative(cauHinh.THU_MUC_GOC, d.duongDan);
    // relative() trả chuỗi bắt đầu bằng ".." khi file nằm NGOÀI thư mục gốc. Ghi
    // cái đó vào bảng là cho nút trên web trỏ ra ngoài phạm vi đồng bộ — bỏ qua.
    if (!tuongDoi || tuongDoi.startsWith("..")) continue;
    if (f.nasPath !== tuongDoi) { f.nasPath = tuongDoi; doi = true; }
  }
  return doi;
}

async function dongBoFile(cauHinh, rows, cay, mtimeBanDau) {
  let mtime = mtimeBanDau;
  const soGhi = await nenTang.docSoGhi(cauHinh.THU_MUC_GOC);
  const boKhoiSoTong = [];
  const COT = cayThuMuc.COT.map((c) => c.key);
  let nasPathDoi = false;
  let i = 0;

  log("\n── Quét thư mục và đồng bộ ──");
  log("  (mỗi dòng có file mới sẽ nghỉ ~3 giây để chắc file không đang chép dở)");

  for (const row of rows) {
    i++;
    const thuMucCot = cay.thuMucCot.get(row.id);
    if (!thuMucCot) continue;                       // dòng cha, không có thư mục cột

    const dsCanDay = {};
    const dsKeoVe = [];
    let coViec = false;

    for (const cot of COT) {
      const duongDanCot = thuMucCot[cot];
      if (!duongDanCot) continue;

      const tatCa = await dayLen.quetThuMuc(duongDanCot, nenTang);
      const { dung: onDinh, cho } = await dayLen.locFileChuaOnDinh(tatCa, { nenTang });
      soCho += cho.length;

      // quyetDinh nhận danh sách ĐẦY ĐỦ, KHÔNG phải soKhop().canDay — xem bẫy trong
      // HOP-DONG.md. Lọc trước là sinh cảnh báo giả cho MỌI file đang khớp hai bên.
      const qd = keoVe.quyetDinh(soGhi, onDinh, row[cot] || [], row.id, cot);
      if (datNasPath(cauHinh, row, cot, onDinh)) nasPathDoi = true;
      if (qd.dayLen.length) { dsCanDay[cot] = qd.dayLen; coViec = true; }
      for (const f of qd.keoVe) dsKeoVe.push({ f, duongDanCot, cot });
      for (const m of qd.canQuyet) canQuyet.push(m);
      for (const k of qd.boKhoiSo || []) boKhoiSoTong.push(k);
    }

    if (!coViec && !dsKeoVe.length) continue;
    log("  [" + i + "/" + rows.length + "] " + nhan(row));

    if (coViec) mtime = await dayMotDong(cauHinh, rows, row, dsCanDay, soGhi, mtime);
    for (const m of dsKeoVe) await keoMot(cauHinh, m, row, soGhi);
  }

  // Ghi đường dẫn NAS vào bảng — MỘT lần cho cả lần chạy, khác với việc đẩy file
  // (ghi ngay từng dòng). Ở đây gom được vì hỏng thì chẳng mất gì: không file nào
  // nằm chờ trên S3, chỉ là nút "mở trong Explorer" chưa dùng được tới lần sau.
  // Cũng vì thế mà lỗi ở đây chỉ thành cảnh báo, không làm đứt cả lần chạy.
  if (nasPathDoi && !chayKho) {
    try {
      const r = await nenTang.ghiBangMotDong(cauHinh, rows, mtime);
      mtime = r.mtime;
    } catch (e) {
      nhomCanhBao.push("Không ghi được đường dẫn NAS vào bảng (" + e.message
        + "). File vẫn đồng bộ đúng, chỉ nút “mở trong Explorer” chưa dùng được — chạy lại là xong.");
    }
  }

  if (!chayKho) mtime = await hoiThayBanLech(cauHinh, rows, soGhi, mtime);

  for (const k of boKhoiSoTong) delete soGhi.files[k];
  if (!chayKho) await nenTang.ghiSoGhi(cauHinh.THU_MUC_GOC, soGhi, { chayKho });
}

// Hỏi từng file lệch nội dung, thay bản trên web bằng bản trong thư mục.
// CHỈ chạy khi ghi thật, và chỉ với mục mang dấu loai:"lech" — mọi mục "cần bạn
// quyết" khác vẫn chỉ được báo ra. Người trả lời Enter suông là bỏ qua.
async function hoiThayBanLech(cauHinh, rows, soGhi, mtimeBanDau) {
  let mtime = mtimeBanDau;
  const lech = thayBan.locMucLech(canQuyet);
  if (!lech.length) return mtime;

  const { duoc, vi } = thayBan.hoiDuocKhong(cauHinh);
  if (!duoc) {
    nhomCanhBao.push(lech.length + " file có bản trong thư mục khác bản trên web. "
      + "Script không hỏi được để thay (" + vi + ") nên để nguyên — xem mục CẦN BẠN QUYẾT.");
    return mtime;
  }

  log("\n── Có " + lech.length + " file khác nội dung giữa thư mục và web ──");
  log("  Trả lời cho từng file. Enter suông = giữ nguyên, không thay.");
  log("  Đồng ý thì bản trong thư mục lên web, bản cũ vào thùng rác (giữ 30 ngày).\n");

  for (const m of lech) {
    log("  " + m.ten);
    log("     thư mục " + m.size + " byte  ·  web " + m.sizeWeb + " byte");
    const dong = rows.find((r) => r && String(r.id) === String(m.rowId));
    if (dong) log("     dòng: " + nhan(dong));

    const co = await thayBan.hoiMotCau("     Đẩy bản trong thư mục lên web? (y = đẩy, Enter = giữ nguyên): ");
    if (!co) { log("     → giữ nguyên\n"); continue; }

    const kq = await thayBan.thayMotBan(cauHinh, m, { rows, mtime, nenTang, dayLen });
    if (!kq.ok) { nhomLoi.push({ ten: m.ten, ly_do: kq.loi }); log("     → KHÔNG THAY ĐƯỢC: " + kq.loi + "\n"); continue; }

    mtime = kq.mtime;
    ghiSo(soGhi, m.rowId, m.cot, m.ten, m.size);       // sổ phải mang size mới
    m.daThay = true;                                    // gỡ khỏi mục "cần bạn quyết" ở báo cáo
    if (kq.canhBao) nhomCanhBao.push(m.ten + " — " + kq.canhBao);
    log("     → đã thay" + (kq.canhBao ? " (kèm cảnh báo)" : "") + "\n");
  }

  for (let k = canQuyet.length - 1; k >= 0; k--) if (canQuyet[k].daThay) canQuyet.splice(k, 1);
  return mtime;
}

async function dayMotDong(cauHinh, rows, row, dsCanDay, soGhi, mtime) {
  const kq = await dayLen.dayCaDong(cauHinh, row, dsCanDay, nenTang, { chayKho, onLog: log });
  for (const l of kq.loi || []) nhomLoi.push({ ten: l.ten, ly_do: l.ly_do });
  soDay += (chayKho ? (kq.seDay || []) : (kq.daDay || [])).length;
  if (chayKho || !kq.daDay.length) return mtime;

  for (const f of kq.daDay) {
    if (!Array.isArray(row[f.cot])) row[f.cot] = [];
    // Đặt đường dẫn NAS ngay lúc đẩy: vòng quét ở trên đã chạy XONG trước khi file
    // này vào bảng, nên không đặt ở đây thì phải chờ tới lần chạy sau nút mới dùng
    // được — đúng lúc người ta vừa thả bản vẽ vào và muốn bấm ngay.
    const dia = (dsCanDay[f.cot] || []).find(
      (x) => String(x.ten || "").toLowerCase() === String(f.name || "").toLowerCase());
    if (dia && dia.duongDan) {
      const td = path.relative(cauHinh.THU_MUC_GOC, dia.duongDan);
      if (td && !td.startsWith("..")) f.nasPath = td;
    }
    row[f.cot].push(f);
    ghiSo(soGhi, row.id, f.cot, f.name, f.size);
  }
  // Ghi bảng NGAY sau mỗi dòng. Gom cả mẻ rồi ghi một lần thì đứt giữa chừng là
  // hàng chục file nằm trên S3 mà không dòng nào trỏ tới.
  try {
    const r = await nenTang.ghiBangMotDong(cauHinh, rows, mtime);
    return r.mtime;
  } catch (e) {
    if (String(e.message).includes("XUNG_DOT")) {
      dung("có người vừa sửa bảng (409). Đã ghi xong các dòng trước, dòng này và"
        + "\n        phần sau CHƯA chạy. Chạy lại để tiếp tục từ trạng thái mới.");
    }
    throw e;
  }
}

async function keoMot(cauHinh, { f, duongDanCot, cot }, row, soGhi) {
  try {
    const kq = await keoVe.keoMotFile(cauHinh, f, duongDanCot, nenTang, { chayKho });
    soKeo++;
    if (!chayKho) ghiSo(soGhi, row.id, cot, f.name, f.size);
    if (kq && kq.canQuyet) canQuyet.push(kq.canQuyet);
  } catch (e) {
    nhomLoi.push({ ten: f.name, ly_do: e.message });
  }
}

function inBaoCao(cay) {
  log("\n══════════════════════════════════════════════");
  log("  " + (chayKho ? "SẼ LÀM" : "ĐÃ LÀM"));
  log("══════════════════════════════════════════════");
  log("  thư mục tạo mới : " + cay.taoMoi.length);
  log("  thư mục đổi tên : " + cay.doiTen.length);
  log("  file đẩy lên    : " + soDay);
  log("  file kéo về     : " + soKeo);
  if (soCho) log("  file đang chép dở, để lần sau : " + soCho);

  if (cay.moCoi.length) {
    log("\n── Thư mục không khớp dòng nào (" + cay.moCoi.length + ") ──");
    log("  Dòng đã bị xoá khỏi bảng, hoặc .bim-id bị sửa. KHÔNG tự xoá.");
    for (const m of cay.moCoi.slice(0, 10)) log("  · " + m.duongDan);
  }
  if (nhomCanhBao.length) {
    log("\n── Cảnh báo (" + nhomCanhBao.length + ") ──");
    for (const c of nhomCanhBao.slice(0, 15)) {
      log("  · " + (c.ly_do || c) + (c.duongDan ? "\n      " + c.duongDan : ""));
    }
  }
  if (canQuyet.length) {
    log("\n── CẦN BẠN QUYẾT (" + canQuyet.length + ") ──");
    log("  Script KHÔNG tự xử những mục này.");
    for (const m of canQuyet.slice(0, 20)) {
      log("  · " + m.ten + "  —  " + m.tinhHuong);
      if (m.duongDan) log("      " + m.duongDan);
    }
    if (canQuyet.length > 20) log("  … và " + (canQuyet.length - 20) + " mục nữa");
  }
  if (nhomLoi.length) {
    log("\n── LỖI (" + nhomLoi.length + ") ──");
    for (const l of nhomLoi.slice(0, 15)) log("  ✗ " + l.ten + "  —  " + l.ly_do);
  }
  if (chayKho) log("\n  Đây là lần chạy khô — chưa ghi gì. Thêm --thuc-hien để làm thật.");
  log("");
}

// process.exitCode chứ không process.exit(): thoát cứng khi còn handle đang đóng
// làm libuv ném "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)".
main().then(
  () => { process.exitCode = nhomLoi.length ? 1 : 0; },
  (e) => {
    if (e instanceof LoiDung) console.error("\n  DỪNG: " + e.message + "\n");
    else console.error("\n  LỖI: " + ((e && e.stack) || e) + "\n");
    process.exitCode = 1;
  }
);
