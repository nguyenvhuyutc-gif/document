#!/usr/bin/env node
// ============================================================
//  Thăm dò NAS — chạy MỘT LẦN để trả lời bốn câu quyết định cả hướng thiết kế:
//
//    1. Node đọc được thư mục NAS qua UNC không?
//    2. Tiền tố \\?\UNC\ có hoạt động trên chính NAS đó không?
//    3. Đường dẫn lồng sâu tới bao nhiêu ký tự thì gãy?
//    4. Tên một thành phần dài bao nhiêu ký tự thì NAS từ chối?
//
//    node scripts/thu-nas.mjs "\\\\nas\\duan\\SBGB"
//    node scripts/thu-nas.mjs            # lấy THU_MUC_GOC trong scripts/.env.dong-bo
//    node scripts/thu-nas.mjs "..." --giu   # giữ lại thư mục thử để xem tận mắt
//
//  AN TOÀN: chỉ tạo/xoá TRONG một thư mục tạm mang tên .thu-nas-tam-<pid> do
//  chính script tạo ra, rồi xoá đi. Không đọc, không sửa, không xoá bất cứ thứ
//  gì đang có sẵn trên NAS. Không cần mật khẩu, không chạm tới web.
// ============================================================
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { duongDai, docCauHinh } from "./dong-bo/nen-tang.mjs";

const THU_MUC_SCRIPT = path.dirname(fileURLToPath(import.meta.url));
const GIU = process.argv.includes("--giu");
const ketQua = [];

function in_(s = "") { process.stdout.write(s + "\n"); }
function muc(ten, tra, ghiChu = "") {
  ketQua.push({ ten, tra });
  in_(`  ${tra === true ? "✔" : tra === false ? "✘" : "ⓘ"} ${ten}${ghiChu ? "  — " + ghiChu : ""}`);
}
const loi = (e) => `${e.code || ""} ${e.message}`.trim();

function layGoc() {
  const tuDongLenh = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (tuDongLenh) return tuDongLenh;
  try { return docCauHinh(THU_MUC_SCRIPT).THU_MUC_GOC; }
  catch (e) {
    in_("\n  DỪNG: chưa cho đường dẫn NAS, mà cũng không đọc được cấu hình.");
    in_("        " + e.message);
    in_('        Cách dùng: node scripts/thu-nas.mjs "\\\\\\\\nas\\\\duan\\\\SBGB"\n');
    process.exit(1);
  }
}

// Tạo thư mục lồng dần cho tới khi gãy. Mỗi cấp một tên dài `buoc` ký tự.
// Mỗi cấp đều GHI VÀ ĐỌC LẠI một file — mkdir chạy được không có nghĩa là ghi
// file trong đó chạy được, và cái người dùng cần là ghi được file.
async function doSau(goc, boc, buoc = 40) {
  let hienTai = goc, sauNhat = 0, hongTai = null;
  for (let cap = 1; cap <= 40; cap++) {
    const tiep = path.join(hienTai, ("c" + cap + "-").padEnd(buoc, "d"));
    try {
      await fsp.mkdir(boc(tiep), { recursive: false });
      const tep = path.join(tiep, "thu.txt");
      await fsp.writeFile(boc(tep), "x");
      if ((await fsp.readFile(boc(tep), "utf8")) !== "x") throw new Error("đọc lại sai nội dung");
      sauNhat = tep.length;
      hienTai = tiep;
    } catch (e) { hongTai = { dai: tiep.length, ly_do: loi(e) }; break; }
  }
  return { sauNhat, hongTai };
}

// Tìm độ dài tên MỘT thành phần lớn nhất mà NAS chấp nhận (chặt nhị phân).
async function doTenMotCap(goc, boc) {
  let thap = 1, cao = 255, tot = 0;
  while (thap <= cao) {
    const giua = (thap + cao) >> 1;
    const ten = "t".repeat(giua);
    try {
      await fsp.mkdir(boc(path.join(goc, ten)));
      await fsp.rmdir(boc(path.join(goc, ten)));
      tot = giua; thap = giua + 1;
    } catch { cao = giua - 1; }
  }
  return tot;
}

// ---------- chạy ----------
const goc = layGoc();
in_("\n============================================================");
in_("  Thăm dò NAS");
in_("  Thư mục gốc : " + goc);
in_("  Sau duongDai: " + duongDai(goc));
in_("============================================================\n");

if (!path.win32.isAbsolute(goc) && process.platform === "win32") {
  in_("  DỪNG: đường dẫn phải tuyệt đối (UNC \\\\nas\\share\\... hoặc ổ map Z:\\...)\n");
  process.exit(1);
}

in_("1 & 2. Đọc thư mục gốc");
let doc_thuong = false;
try { const ds = await fsp.readdir(goc); doc_thuong = true; muc("đọc được qua đường dẫn thường", true, ds.length + " mục"); }
catch (e) { muc("đọc được qua đường dẫn thường", false, loi(e)); }

let doc_dai = false;
try { const ds = await fsp.readdir(duongDai(goc)); doc_dai = true; muc("đọc được qua \\\\?\\ (duongDai)", true, ds.length + " mục"); }
catch (e) { muc("đọc được qua \\\\?\\ (duongDai)", false, loi(e)); }

if (!doc_thuong && !doc_dai) {
  in_("\n  DỪNG: không vào được thư mục gốc bằng cách nào cả. Kiểm lại đường dẫn,");
  in_("        quyền truy cập, và việc máy đã đăng nhập vào NAS chưa.\n");
  process.exit(1);
}

// Thư mục tạm riêng của lần chạy này — mọi thứ bên dưới nằm gọn trong đó.
const tam = path.join(goc, ".thu-nas-tam-" + process.pid);
const boc = doc_dai ? duongDai : (p) => p;   // NAS không nuốt \\?\ thì thử đường thường
try { await fsp.mkdir(boc(tam)); }
catch (e) {
  in_("\n  DỪNG: không tạo được thư mục thử trên NAS — " + loi(e));
  in_("        Đọc được nhưng không ghi được: script đồng bộ sẽ không chạy.\n");
  process.exit(1);
}
muc("tạo được thư mục trên NAS", true, path.basename(tam));

try {
  in_("\n3. Đường dẫn lồng sâu — tăng dần tới khi gãy" + (doc_dai ? " (dùng \\\\?\\)" : " (KHÔNG có \\\\?\\)"));
  const sau = await doSau(tam, boc);
  muc("ghi + đọc lại được file sâu nhất", sau.sauNhat > 0, sau.sauNhat + " ký tự");
  if (sau.hongTai) muc("gãy tại", null, sau.hongTai.dai + " ký tự — " + sau.hongTai.ly_do);
  else muc("chạm trần 40 cấp mà chưa gãy", null, "NAS không giới hạn ở khoảng này");

  // Đối chứng: cùng phép đo nhưng KHÔNG có tiền tố. Chênh lệch giữa hai con số
  // chính là thứ \\?\ mua được trên NAS này.
  if (doc_dai) {
    const tamB = path.join(tam, "khong-tien-to");
    await fsp.mkdir(boc(tamB));
    const sauB = await doSau(tamB, (p) => p);
    muc("sâu nhất khi KHÔNG có \\\\?\\", null, sauB.sauNhat + " ký tự"
      + (sauB.hongTai ? " (gãy tại " + sauB.hongTai.dai + ": " + sauB.hongTai.ly_do + ")" : ""));
    // Không có tiền tố mà vẫn vượt 260 nghĩa là CHÍNH MÁY NÀY đã bật
    // LongPathsEnabled. Đừng suy ra máy trạm khác cũng thế — mặc định Windows
    // là TẮT, và Explorer/CAD vẫn tắc dù cờ có bật.
    if (sauB.sauNhat > 260) muc("máy này đã bật LongPathsEnabled", null,
      "phép so trên KHÔNG chứng minh máy trạm khác bỏ được \\\\?\\");
  }

  in_("\n4. Độ dài tên MỘT thành phần");
  const cap = await doTenMotCap(tam, boc);
  muc("tên một cấp dài nhất tạo được", cap > 0, cap + " ký tự"
    + (cap >= 255 ? " (chạm trần thử nghiệm 255)" : ""));
} finally {
  if (GIU) in_("\n  (--giu: để lại " + tam + " — nhớ xoá tay sau khi xem)");
  else {
    try { await fsp.rm(boc(tam), { recursive: true, force: true }); in_("\n  Đã dọn thư mục thử."); }
    catch (e) { in_("\n  [!] KHÔNG dọn được " + tam + " — " + loi(e) + "\n      Xoá tay giúp."); }
  }
}

in_("\n============================================================");
in_("  Kết luận cho đội");
in_("============================================================");
in_(doc_dai
  ? "  \\\\?\\ CHẠY trên NAS này → hướng Node đứng vững, duongDai() dùng được."
  : "  \\\\?\\ KHÔNG chạy trên NAS này → phải cắt tên thật ngắn, không dựa vào tiền tố.");
in_("  Lấy con số 'sâu nhất' ở mục 3 trừ đi độ dài THU_MUC_GOC để biết cây thư mục");
in_("  còn được phép dài bao nhiêu. Nhớ chừa chỗ cho tên bản vẽ (đo được 74 ký tự).");
in_("");
