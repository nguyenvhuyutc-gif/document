#!/usr/bin/env node
// ============================================================
//  Dọn file mồ côi trên Amazon S3 — CHẠY TAY, không bao giờ tự động.
//
//  SCRIPT NÀY XOÁ ĐƯỢC DỮ LIỆU THẬT. Mặc định chỉ chạy khô và in ra.
//
//    node scripts/don-file-mo-coi.mjs          # chạy khô, chỉ in
//    node scripts/don-file-mo-coi.mjs --xoa    # xoá thật, bắt gõ lại tên bucket
//
//  Hai chiều kiểm tra:
//    A. Object trên S3 mà không doc nào trong bim_files trỏ tới  → xoá được
//    B. Doc trong bim_files mà không dòng nào trong bim_app trỏ tới → CHỈ BÁO CÁO
//
//  Vì sao chiều B tồn tại: có nhiều đường sinh file mồ côi chứ không phải một —
//  confirm xong nhưng save() hỏng; xoá từ site cũ bim-wheat (chạy code cũ trên
//  cùng MongoDB); tab đang mở bản HTML cũ trong cache. Chúng sinh ra doc CÓ
//  metadata mà KHÔNG dòng nào trỏ tới — script chỉ quét chiều A sẽ mù với chúng.
//
//  Từ khi có thùng rác, hai đường lớn nhất đã bịt: doDeleteRows() và removeFile()
//  nay đẩy file sang status "trashed" thay vì bỏ mặc. Doc "trashed" KHÔNG phải rác
//  và script này bỏ qua chúng ở cả hai chiều — chiều A vì doc vẫn giữ `key`, chiều
//  B nhờ nhánh lọc riêng. Máy chủ tự xoá chúng sau 30 ngày.
//
//  Thư mục scripts/ nằm trong .vercelignore nên không bao giờ lên bundle production.
// ============================================================
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { AwsClient } from "aws4fetch";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const XOA = process.argv.includes("--xoa");
const CAP_XOA = 100;              // trần số object xoá trong một lần chạy
const NGUONG_ORPHAN = 0.20;       // > 20% tổng số object là dấu hiệu lệch cấu hình

// ---- nạp .env thủ công (không thêm phụ thuộc) ----
function napEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return false;
  for (const dong of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(dong);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
  return true;
}

function thoat(msg) {
  console.error("\n  DỪNG: " + msg + "\n");
  process.exit(1);
}

// ---- S3 ----
// Đọc env và dựng base URL ĐÚNG NHƯ api/files.js làm — hai chỗ này phải khớp,
// lệch một chữ là script nhìn vào bucket khác với bucket ứng dụng đang ghi.
function taoS3() {
  const thieu = ["S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"]
    .filter((k) => !process.env[k]);
  if (thieu.length) thoat("thiếu biến môi trường S3: " + thieu.join(", "));
  return {
    client: new AwsClient({
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      service: "s3",
      region: process.env.S3_REGION,
    }),
    // PATH-STYLE — bắt buộc vì tên bucket có dấu chấm (xem ghi chú ở api/files.js).
    base: `https://s3.${process.env.S3_REGION}.amazonaws.com/${process.env.S3_BUCKET}`,
  };
}

function goXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// Liệt kê TOÀN BỘ object — phân trang đầy đủ. Trang lỗi thì ném, không trả về
// danh sách đọc dở: coi kết quả dở dang là "danh sách đầy đủ" chính là cách
// script này biến cả kho thành rác.
async function lietKeS3(s3) {
  const keys = new Map();          // key -> size
  let token = null, trang = 0;
  do {
    // KHÔNG thêm dấu "/" sau tên bucket: path-style thì ListObjectsV2 là
    // `GET /<bucket>?list-type=2`, thêm slash biến nó thành key rỗng.
    const u = new URL(s3.base);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("max-keys", "1000");
    if (token) u.searchParams.set("continuation-token", token);
    const res = await s3.client.fetch(u.toString(), { method: "GET" });
    if (!res.ok) throw new Error(`ListObjectsV2 trả HTTP ${res.status} ở trang ${trang + 1}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const k = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]);
      const s = /<Size>(\d+)<\/Size>/.exec(m[1]);
      if (k) keys.set(goXml(k[1]), s ? Number(s[1]) : 0);
    }
    const tr = /<IsTruncated>(true|false)<\/IsTruncated>/.exec(xml);
    const nt = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
    token = tr && tr[1] === "true" && nt ? goXml(nt[1]) : null;
    trang++;
    if (trang > 1000) throw new Error("phân trang quá 1000 lần — nghi ngờ vòng lặp vô hạn");
  } while (token);
  return keys;
}

function mb(n) { return (n / 1048576).toFixed(1) + " MB"; }

// ---- chạy ----
const coEnv = napEnv();
const dbName = process.env.MONGODB_DB || "bim";
const colFiles = process.env.MONGODB_FILES_COLLECTION || "bim_files";
const colApp = process.env.MONGODB_COLLECTION || "bim_app";
const bucket = process.env.S3_BUCKET || "";

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║  DỌN FILE MỒ CÔI — ĐỌC KỸ CẤU HÌNH ĐÃ PHÂN GIẢI BÊN DƯỚI  ║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log("  nguồn cấu hình  : " + (coEnv ? path.join(ROOT, ".env") : "chỉ biến môi trường (KHÔNG thấy .env)"));
console.log("  database        : " + dbName);
console.log("  collection file : " + colFiles);
console.log("  collection bảng : " + colApp);
console.log("  bucket S3       : " + (bucket || "(chưa đặt)"));
console.log("  chế độ          : " + (XOA ? ">>> XOÁ THẬT <<<" : "chạy khô (chỉ in ra)"));
console.log("");
console.log("  Nếu bất kỳ dòng nào ở trên KHÔNG đúng với môi trường bạn định dọn,");
console.log("  hãy Ctrl+C ngay. Lệch database hay lệch collection đều biểu hiện y hệt");
console.log("  nhau — thành 'toàn bộ kho là rác'.\n");

if (!process.env.MONGODB_URI) thoat("thiếu MONGODB_URI");
const s3 = taoS3();
const mongo = new MongoClient(process.env.MONGODB_URI);

try {
  await mongo.connect();
  const db = mongo.db(dbName);

  // ---- 1. toàn bộ object trên S3 ----
  process.stdout.write("Đang liệt kê object trên S3… ");
  const objects = await lietKeS3(s3);
  console.log(objects.size + " object");

  // ---- 2. toàn bộ key trong MongoDB ----
  // Con trỏ lỗi giữa chừng thì DỪNG HẲN. Danh sách key đọc dở trông y hệt một
  // collection rỗng, và script sẽ coi mọi object là mồ côi.
  process.stdout.write("Đang đọc key trong " + colFiles + "… ");
  const keyBiet = new Set();
  const keyPending = new Set();
  let soDoc = 0;
  try {
    const cur = db.collection(colFiles).find(
      { key: { $exists: true } },
      { projection: { key: 1, status: 1 } }
    );
    for await (const d of cur) {
      if (!d.key) continue;
      keyBiet.add(d.key);
      if (d.status === "pending") keyPending.add(d.key);
      soDoc++;
    }
  } catch (e) {
    thoat("lỗi khi đọc con trỏ MongoDB — KHÔNG dùng danh sách đọc dở: " + e.message);
  }
  console.log(soDoc + " doc (" + keyPending.size + " còn pending)");

  // ---- 3. chốt an toàn ----
  // Object của doc `pending` KHÔNG BAO GIỜ bị coi là mồ côi: phiên tải lên có thể
  // đang chạy dở ngay lúc này.
  const orphan = [...objects.keys()].filter((k) => !keyBiet.has(k));
  const tongByte = orphan.reduce((s, k) => s + (objects.get(k) || 0), 0);

  if (keyBiet.size === 0) {
    thoat(`tập key rỗng — không doc nào trong ${dbName}.${colFiles} có trường 'key'.\n`
      + "        Gần như chắc chắn là lệch database/collection, hoặc .env kéo nhầm môi trường,\n"
      + "        chứ không phải 'toàn bộ bucket là rác'. Kiểm lại 4 dòng cấu hình ở trên.");
  }
  if (objects.size > 0 && orphan.length / objects.size > NGUONG_ORPHAN) {
    thoat(`${orphan.length}/${objects.size} object là mồ côi (${Math.round(orphan.length / objects.size * 100)}%,`
      + ` ngưỡng ${NGUONG_ORPHAN * 100}%).\n`
      + "        Tỷ lệ này quá cao để là rác tự nhiên — nhiều khả năng bucket và database\n"
      + "        không thuộc cùng một môi trường. Kiểm lại trước khi xoá bất cứ thứ gì.");
  }

  // ---- 4. báo cáo chiều A ----
  console.log("\n── Chiều A: object trên S3 không doc nào trỏ tới ──");
  if (!orphan.length) console.log("  (không có)");
  else {
    for (const k of orphan.slice(0, 50)) console.log("  " + k + "   " + mb(objects.get(k) || 0));
    if (orphan.length > 50) console.log("  … và " + (orphan.length - 50) + " object nữa");
    console.log("  Tổng: " + orphan.length + " object, " + mb(tongByte));
  }

  // ---- 5. báo cáo chiều B (CHỈ BÁO CÁO, không xoá) ----
  console.log("\n── Chiều B: doc trong " + colFiles + " không dòng nào trỏ tới (CHỈ BÁO CÁO) ──");
  const idDuocTro = new Set();
  for await (const plan of db.collection(colApp).find({}, { projection: { data: 1 } })) {
    const rows = (plan.data && Array.isArray(plan.data.rows)) ? plan.data.rows : [];
    for (const row of rows) {
      // Bốn cột file — khớp FKEYS ở api/files.js và bang-hang-muc.html. Thiếu một
      // cột ở đây thì mọi file trong cột đó bị báo là rác, và ai tin báo cáo mà
      // xoá tay là mất dữ liệu thật.
      for (const fk of ["files", "filesCad", "filesTvgs", "filesDuyet", "filesChapThuan"]) {
        for (const f of (Array.isArray(row[fk]) ? row[fk] : [])) if (f && f.id) idDuocTro.add(String(f.id));
      }
    }
  }
  // Doc `trashed` KHÔNG phải rác: chúng nằm trong thùng rác, người dùng khôi phục
  // được và máy chủ tự xoá sau 30 ngày. Theo định nghĩa thì không dòng nào trỏ tới
  // chúng — trộn vào đây thì mỗi lần xoá file là báo cáo lại dài thêm một dòng, và
  // chẳng mấy chốc không ai đọc nữa. Đếm riêng để vẫn thấy được khối lượng.
  const docThua = [];
  let soTrash = 0, byteTrash = 0;
  for await (const d of db.collection(colFiles).find(
    { kind: { $ne: "chunk" } }, { projection: { name: 1, size: 1, status: 1, createdAt: 1, trashedAt: 1 } }
  )) {
    if (idDuocTro.has(String(d._id))) continue;
    if (d.status === "trashed") { soTrash++; byteTrash += d.size || 0; continue; }
    docThua.push(d);
  }
  if (!docThua.length) console.log("  (không có)");
  else {
    for (const d of docThua.slice(0, 50)) {
      console.log("  " + String(d._id).padEnd(26) + (d.status || "cũ").padEnd(9)
        + mb(d.size || 0).padStart(10) + "  " + (d.name || ""));
    }
    if (docThua.length > 50) console.log("  … và " + (docThua.length - 50) + " doc nữa");
    console.log("  Tổng: " + docThua.length + " doc. KHÔNG tự xoá — cần đọc kỹ rồi xử lý tay.");
    console.log("  (doc 'pending' mới tạo vài phút trước là phiên tải lên đang chạy, đừng đụng)");
  }
  if (soTrash) {
    console.log("\n  Ngoài ra: " + soTrash + " doc đang nằm trong thùng rác (" + mb(byteTrash)
      + ") — bỏ qua, máy chủ tự xoá sau 30 ngày.");
  }

  // ---- 6. xoá ----
  if (!XOA) {
    console.log("\nĐây là lần chạy khô — chưa xoá gì. Thêm --xoa để xoá chiều A.\n");
  } else if (!orphan.length) {
    console.log("\nKhông có gì để xoá.\n");
  } else {
    const canXoa = orphan.slice(0, CAP_XOA);
    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║                    SẮP XOÁ THẬT                          ║");
    console.log("╚══════════════════════════════════════════════════════════╝");
    console.log("  bucket : " + bucket);
    console.log("  số object sẽ xoá : " + canXoa.length
      + (orphan.length > CAP_XOA ? "  (trần " + CAP_XOA + "/lần, còn " + (orphan.length - CAP_XOA) + " lần sau)" : ""));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const tra = (await rl.question("\n  Gõ LẠI đúng tên bucket để xác nhận: ")).trim();
    rl.close();
    if (tra !== bucket) thoat("tên bucket không khớp — không xoá gì cả.");

    let ok = 0, loi = 0;
    for (const k of canXoa) {
      try {
        const res = await s3.client.fetch(s3.base + "/" + k, { method: "DELETE" });
        if (res.ok || res.status === 404) ok++;
        else { loi++; console.error("  lỗi HTTP " + res.status + " khi xoá " + k); }
      } catch (e) { loi++; console.error("  lỗi khi xoá " + k + ": " + e.message); }
    }
    console.log("\n  Đã xoá " + ok + " object" + (loi ? ", " + loi + " lỗi" : "") + ".\n");
  }
} finally {
  await mongo.close();
}
