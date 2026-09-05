#!/usr/bin/env node
// ============================================================
//  Chuẩn hoá cột "Tiến độ kế hoạch" về dd/mm/yyyy.
//
//    node scripts/chuan-hoa-cot-tien-do.mjs                 # chạy khô, in đối chiếu
//    node scripts/chuan-hoa-cot-tien-do.mjs --thuc-hien     # ghi thật
//    ... [--url https://…] [--plan <id>]
//
//  GHI QUA API kèm `ifMtime`, KHÔNG ghi thẳng MongoDB. Nếu có ai vừa lưu bảng
//  trong lúc script chạy, máy chủ trả 409 và script dừng — thay vì đè mất thay
//  đổi của họ. Đây là lý do duy nhất script này không nói chuyện với MongoDB.
//
//  Ba dạng dữ liệu gặp trong bảng và cách đọc:
//
//   1. "15/07"        dd/mm thiếu năm  → thêm năm theo tháng (xem NAM_CHO)
//   2. "7-Oct"        Excel đọc dd/mm theo kiểu Mỹ mm/dd rồi hiện lại thành d-Mon.
//                     Phải ĐẢO để về ngày gốc: ngày = số tháng của "Oct" (10),
//                     tháng = số đứng trước (7) → 10/07. Người dùng đã xác nhận
//                     cách đọc này ngày 04/09/2026; cách đọc thẳng mặt chữ sẽ cho
//                     ra mốc tháng 1, lạc khỏi dải tiến độ tháng 6-10 của dự án.
//   3. "10/07-15/07"  khoảng ngày → chuẩn hoá cả hai đầu, giữ dấu –
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const THUC_HIEN = argv.includes("--thuc-hien");
const doiSo = (ten, mac) => {
  const i = argv.indexOf(ten);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : mac;
};
const BASE = doiSo("--url", "https://bvtc.vcijsc.com");

function napEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const dong of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(dong);
    if (!m) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
napEnv();

function thoat(msg) { console.error("\n  DỪNG: " + msg + "\n"); process.exit(1); }

// ---- quy tắc đọc ngày ----
const THANG = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Dải tiến độ dự án nằm trong 2026, phần đuôi sang đầu 2027. Mốc tháng 1-5 mà
// không ghi năm thì thuộc 2027 — khớp với "01/10-12/01/2027" đã có sẵn trong bảng.
function NAM_CHO(thang) { return thang >= 6 ? 2026 : 2027; }

const hai = (n) => (n < 10 ? "0" + n : String(n));
function dinhDang(ngay, thang, nam) {
  if (!(ngay >= 1 && ngay <= 31 && thang >= 1 && thang <= 12)) return null;
  return hai(ngay) + "/" + hai(thang) + "/" + nam;
}

function motMoc(t) {
  t = String(t || "").trim();
  let m;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) return dinhDang(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(t))) return dinhDang(+m[1], +m[2], 2000 + +m[3]);
  if ((m = /^(\d{1,2})\/(\d{1,2})$/.exec(t))) return dinhDang(+m[1], +m[2], NAM_CHO(+m[2]));
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) return dinhDang(+m[3], +m[2], +m[1]);
  // "7-Oct" — ĐẢO (xem ghi chú đầu file)
  if ((m = /^(\d{1,2})-([A-Za-z]{3,})$/.exec(t))) {
    const mon = THANG[m[2].slice(0, 3).toLowerCase()];
    if (mon) { const ngay = mon, thang = +m[1]; return dinhDang(ngay, thang, NAM_CHO(thang)); }
  }
  // "Oct-7" — dạng lật của cùng một lỗi
  if ((m = /^([A-Za-z]{3,})-(\d{1,2})$/.exec(t))) {
    const mon = THANG[m[1].slice(0, 3).toLowerCase()];
    if (mon) { const ngay = +m[2], thang = mon; return dinhDang(ngay, thang, NAM_CHO(thang)); }
  }
  return null;
}

function chuanHoa(t) {
  t = String(t || "").trim();
  if (!t) return "";
  // Khoảng ngày: chỉ nhận khi CẢ HAI vế có dấu "/" — nếu không, "7-Oct" sẽ bị
  // cắt đôi thành khoảng và hỏng.
  const m = /^(.+?)\s*[-–—]\s*(.+)$/.exec(t);
  if (m && m[1].includes("/") && m[2].includes("/")) {
    const a = motMoc(m[1]), b = motMoc(m[2]);
    if (a && b) return a + " – " + b;
  }
  return motMoc(t);      // null = không đọc được, sẽ được giữ nguyên và báo cáo
}

const goHtml = (s) => String(s || "")
  .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

// ---- lấy dữ liệu ----
const KEY = process.env.ADMIN_KEY || process.env.EDIT_KEY || "";
const hAuth = KEY ? { "x-edit-key": KEY } : {};

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║  CHUẨN HOÁ CỘT TIẾN ĐỘ KẾ HOẠCH VỀ dd/mm/yyyy             ║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log("  máy chủ : " + BASE);
console.log("  chế độ  : " + (THUC_HIEN ? ">>> GHI THẬT <<<" : "chạy khô (chỉ in ra)"));

let planId = doiSo("--plan", "");
if (!planId) {
  const l = await (await fetch(BASE + "/api/data?list=1")).json();
  if (!l || !l.ok || !l.plans || !l.plans.length) thoat("không đọc được danh sách kế hoạch");
  if (l.plans.length > 1) {
    console.log("\n  Có " + l.plans.length + " kế hoạch — chỉ định bằng --plan <id>:");
    for (const p of l.plans) console.log("    " + p.id + "   " + p.name);
    thoat("cần chọn kế hoạch");
  }
  planId = l.plans[0].id;
}

const doc = await (await fetch(BASE + "/api/data?plan=" + encodeURIComponent(planId))).json();
if (!doc || !doc.ok || !doc.data) thoat("không đọc được kế hoạch " + planId);
const rows = Array.isArray(doc.data.rows) ? doc.data.rows : [];
console.log("  kế hoạch: " + (doc.name || planId) + "  (" + rows.length + " dòng)");
console.log("  mtime   : " + doc.mtime + "\n");

// ---- đối chiếu ----
const doi = [], khongDoc = [], giuNguyen = [];
for (let i = 0; i < rows.length; i++) {
  const cu = rows[i].tienDo;
  const txt = goHtml(cu);
  if (!txt) continue;
  const moi = chuanHoa(txt);
  if (moi === null) { khongDoc.push({ dong: i + 1, txt: txt }); continue; }
  if (moi === cu) { giuNguyen.push(i + 1); continue; }
  doi.push({ i: i, dong: i + 1, cu: txt, moi: moi,
             hangMuc: goHtml(rows[i].hangMuc).slice(0, 40) });
}

console.log("── Sẽ đổi (" + doi.length + " dòng) ──");
for (const d of doi) {
  console.log("  dòng " + String(d.dong).padStart(3) + "  "
    + d.cu.padEnd(20) + " →  " + d.moi.padEnd(26) + "  " + d.hangMuc);
}
if (giuNguyen.length) console.log("\n  " + giuNguyen.length + " dòng đã đúng chuẩn, giữ nguyên.");
if (khongDoc.length) {
  console.log("\n── KHÔNG đọc được, giữ nguyên (" + khongDoc.length + " dòng) ──");
  for (const k of khongDoc) console.log("  dòng " + String(k.dong).padStart(3) + "  " + JSON.stringify(k.txt));
}

if (!doi.length) { console.log("\n  Không có gì để đổi.\n"); process.exit(0); }

if (!THUC_HIEN) {
  console.log("\n  Đây là lần chạy khô — chưa ghi gì. Thêm --thuc-hien để ghi thật.\n");
  process.exit(0);
}

// ---- ghi ----
const luu = path.join(ROOT, "scratch", "sao-luu-tien-do-" + planId + "-" + doc.mtime + ".json");
fs.mkdirSync(path.dirname(luu), { recursive: true });
fs.writeFileSync(luu, JSON.stringify(doc.data, null, 2), "utf8");
console.log("\n  Đã lưu bản trước khi sửa ra:\n    " + luu);

for (const d of doi) rows[d.i].tienDo = d.moi;

const res = await fetch(BASE + "/api/data?plan=" + encodeURIComponent(planId)
  + "&ifMtime=" + (doc.mtime || 0), {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json" }, hAuth),
  body: JSON.stringify({ rows: rows, people: doc.data.people || [], statuses: doc.data.statuses || [] }),
});
const j = await res.json().catch(() => null);

if (j && j.conflict) {
  thoat("có người vừa lưu bảng trong lúc script chạy (409).\n"
    + "        KHÔNG ghi gì cả — chạy lại script để lấy bản mới nhất.");
}
if (!res.ok || !j || !j.ok) {
  thoat("máy chủ trả " + res.status + ": " + JSON.stringify(j));
}
console.log("\n  ✓ Đã ghi " + doi.length + " dòng. mtime mới: " + j.mtime + "\n");
