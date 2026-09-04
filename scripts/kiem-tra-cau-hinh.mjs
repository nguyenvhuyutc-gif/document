#!/usr/bin/env node
// ============================================================
//  Kiểm tra cấu hình ở máy — CHỈ ĐỌC với MongoDB, chỉ ghi 1 object thử trên S3
//  rồi xoá ngay. Chạy được bất cứ lúc nào, không hỏng gì.
//
//    node scripts/kiem-tra-cau-hinh.mjs
//
//  Nó trả lời đúng ba câu:
//    1. .env đọc được không, và đang trỏ vào database/bucket nào?
//    2. MongoDB kết nối được không, và còn bao nhiêu chỗ trong gói M0?
//    3. S3 ký URL và giữ tên file tiếng Việt đúng không?
//
//  Câu 3 là câu quan trọng nhất: nó chứng minh cả kiến trúc chạy được. Nếu
//  presigned PUT không giữ nổi Content-Disposition tiếng Việt thì mọi file
//  tải lên sẽ lưu ra tên key ngẫu nhiên, và không có đường sửa ở phía client.
//
//  Thư mục scripts/ nằm trong .vercelignore nên không lên bundle production.
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { AwsClient } from "aws4fetch";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function napEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return null;
  for (const dong of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(dong);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
  return p;
}

let dat = 0, hong = 0, canh = 0;
function ok(nhan) { dat++; console.log("  ✓ " + nhan); }
function loi(nhan, chiTiet) {
  hong++;
  console.log("  ✗ " + nhan + (chiTiet ? "\n      → " + String(chiTiet).slice(0, 400) : ""));
}
// Cảnh báo ≠ hỏng. Dung lượng gần đầy là vấn đề thật nhưng KHÔNG phải lỗi cấu
// hình, nên nó không được làm exit code khác 0 — script này chỉ trả lời đúng
// một câu: "cấu hình ở máy chạy được không".
function canhBao(nhan, chiTiet) {
  canh++;
  console.log("  ⚠ " + nhan + (chiTiet ? "\n      → " + String(chiTiet).slice(0, 400) : ""));
}
function mb(n) { return (n / 1048576).toFixed(1) + " MB"; }

const duongEnv = napEnv();

console.log("\n══ 1. Cấu hình ══");
console.log("  nguồn : " + (duongEnv || "KHÔNG thấy .env — chỉ dùng biến môi trường"));
const CAN = ["MONGODB_URI", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"];
const thieu = CAN.filter((k) => !process.env[k]);
if (thieu.length) {
  loi("thiếu biến: " + thieu.join(", "), "điền vào .env rồi chạy lại");
  console.log("\n  ---- dừng, chưa kiểm tiếp được ----\n");
  process.exit(1);
}
ok("đủ 5 biến bắt buộc");

const DB = process.env.MONGODB_DB || "bim";
const BUCKET = process.env.S3_BUCKET;
const REGION = process.env.S3_REGION;
console.log("  database : " + DB + (DB === "bim" ? "   ⚠ ĐÂY LÀ DỮ LIỆU THẬT" : "   (an toàn để thử)"));
console.log("  bucket   : " + BUCKET);
console.log("  vùng     : " + REGION);
// Chỉ in 4 ký tự đầu của Access Key ID để đối chiếu, không in secret.
console.log("  khoá S3  : " + process.env.S3_ACCESS_KEY_ID.slice(0, 4) + "…"
  + " (dài " + process.env.S3_ACCESS_KEY_ID.length + " ký tự)");
if (/\s/.test(process.env.S3_ACCESS_KEY_ID) || /\s/.test(process.env.S3_SECRET_ACCESS_KEY)) {
  loi("khoá S3 có khoảng trắng", "sẽ báo InvalidAccessKeyId trông y hệt 'khoá sai'");
} else ok("khoá S3 không dính khoảng trắng thừa");

// ---- 2. MongoDB ----
console.log("\n══ 2. MongoDB ══");
// MONGODB_URI_DIRECT: lối thoát cho môi trường chặn truy vấn DNS SRV
// (mongodb+srv:// bắt buộc tra SRV). Bình thường KHÔNG cần đặt.
const uri = process.env.MONGODB_URI_DIRECT || process.env.MONGODB_URI;
const cli = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
try {
  await cli.connect();
  ok("kết nối được");

  for (const ten of [...new Set(["bim", DB])]) {
    const db = cli.db(ten);
    const stats = await db.command({ dbStats: 1 });
    const files = db.collection(process.env.MONGODB_FILES_COLLECTION || "bim_files");
    const soFile = await files.countDocuments({});
    const soMoi = await files.countDocuments({ key: { $exists: true } });
    const soCu = await files.countDocuments({ key: { $exists: false }, kind: { $ne: "chunk" } });
    const pct = (stats.dataSize / (512 * 1048576) * 100).toFixed(0);
    console.log("\n  [" + ten + "]  " + mb(stats.dataSize) + " / 512 MB  (" + pct + "% gói M0)");
    console.log("    bim_files: " + soFile + " doc · " + soMoi + " file mới (S3) · " + soCu + " file cũ (MongoDB)");
    if (ten === "bim") {
      if (stats.dataSize / 1048576 > 350) {
        canhBao("dataSize > 350 MB", "đường lai không đủ — cần chạy migrate file cũ sang S3");
      } else ok("dataSize dưới ngưỡng 350 MB");
    }
    // Doc thiếu cả ba trường là thứ guard 410 sinh ra để bắt.
    const laLung = await files.countDocuments({
      key: { $exists: false }, data: { $exists: false }, chunks: { $exists: false },
    });
    if (laLung) loi(ten + ": có " + laLung + " doc thiếu cả key/data/chunks", "tìm hiểu nguồn gốc trước khi deploy");
  }
} catch (e) {
  loi("không kết nối được MongoDB", e.message
    + (/querySrv/.test(e.message) ? "\n      (mạng chặn DNS SRV — hiếm; xem MONGODB_URI_DIRECT trong script)" : ""));
} finally {
  await cli.close().catch(() => {});
}

// ---- 3. S3 ----
console.log("\n══ 3. Amazon S3 ══");
const base = `https://s3.${REGION}.amazonaws.com/${BUCKET}`;
const s3 = new AwsClient({
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  service: "s3",
  region: REGION,
});
async function ky(key, method, han) {
  const u = new URL(`${base}/${key}`);
  u.searchParams.set("X-Amz-Expires", String(han));
  return (await s3.sign(u.toString(), { method, aws: { signQuery: true } })).url;
}
const TEN = "Bản vẽ kiến trúc (P1).dwg";
const KEY = "bim/_kiemtra/" + Date.now().toString(36) + ".dwg";
const NOIDUNG = "kiem tra cau hinh " + "x".repeat(400);

console.log("  base : " + base);
try {
  const ascii = TEN.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  const cd = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(TEN)}`;

  let r = await fetch(await ky(KEY, "PUT", 300), {
    method: "PUT",
    headers: { "Content-Disposition": cd, "Content-Type": "image/vnd.dwg" },
    body: NOIDUNG,
  });
  if (r.status !== 200) {
    loi("PUT trả " + r.status, r.status === 403
      ? "403 = sai chữ ký, sai vùng, hoặc thiếu quyền s3:PutObject"
      : (await r.text().catch(() => "")));
    throw new Error("dừng");
  }
  ok("PUT kèm Content-Disposition tiếng Việt → 200");

  r = await fetch(await ky(KEY, "GET", 300));
  const traVe = r.headers.get("content-disposition") || "";
  const noiDung = await r.text();
  if (noiDung !== NOIDUNG) loi("nội dung tải về không khớp");
  else ok("GET trả đúng nội dung");
  if (traVe.includes("filename*=UTF-8''" + encodeURIComponent(TEN))) {
    ok("S3 giữ nguyên tên tiếng Việt — “" + TEN + "”");
  } else loi("tên file tiếng Việt KHÔNG về nguyên vẹn", traVe || "(header rỗng)");

  r = await fetch(await ky(KEY, "HEAD", 300), { method: "HEAD" });
  if (r.status === 200 && Number(r.headers.get("content-length")) === NOIDUNG.length) {
    ok("HEAD ký riêng → 200, Content-Length đúng");
  } else loi("HEAD trả " + r.status, r.headers.get("content-length"));

  r = await fetch(await ky(KEY, "GET", 300), { method: "HEAD" });
  if (r.status === 403) ok("URL ký cho GET dùng làm HEAD bị từ chối (đúng như thiết kế)");
  else loi("URL ký cho GET dùng làm HEAD lại trả " + r.status, "giả định 'mỗi method ký riêng' đã sai");

  const u = new URL(base);
  u.searchParams.set("list-type", "2");
  u.searchParams.set("prefix", "bim/_kiemtra/");
  r = await s3.fetch(u.toString(), { method: "GET" });
  const xml = await r.text();
  if (r.status === 200 && xml.includes(KEY)) ok("ListObjectsV2 path-style chạy (script dọn dựa vào)");
  else loi("ListObjectsV2 trả " + r.status, xml.slice(0, 200));
} catch (e) {
  if (e.message !== "dừng") loi("lỗi khi gọi S3", e.message);
} finally {
  const r = await fetch(await ky(KEY, "DELETE", 300), { method: "DELETE" }).catch(() => null);
  if (r && (r.status === 204 || r.status === 200)) ok("đã xoá object thử");
  else loi("KHÔNG xoá được object thử", "xoá tay: " + KEY);
}

// ---- 4. CORS ----
// Script này chạy bằng Node nên KHÔNG bị CORS chặn — mọi phép thử ở trên vẫn đạt
// kể cả khi trình duyệt hoàn toàn không gọi được S3. Đó là lý do phần này tồn tại:
// thiếu origin trong CORS làm hỏng tải file lên ở đúng nơi khó phát hiện nhất
// (trình duyệt người dùng), mà lỗi lại trông y hệt lỗi chữ ký.
//
// Không dùng GetBucketCORS: khoá API thường không có quyền đó. Thay vào đó gửi
// đúng cái preflight mà trình duyệt gửi — 200 là được phép, 403 là không.
console.log("\n══ 4. CORS (trình duyệt gọi thẳng S3) ══");
// Đổi domain thì PHẢI sửa danh sách này — S3 khớp origin chính xác từng ký tự,
// và mọi phép thử khác trong script đều không phát hiện được thiếu sót đó.
const ORIGIN_CAN = [
  ["https://bvtc.vcijsc.com", "production"],
  ["http://localhost:3000", "vercel dev ở máy"],
];
for (const [org, ghiChu] of ORIGIN_CAN) {
  const kq = [];
  for (const method of ["PUT", "GET"]) {
    let ma = null;
    // Thử hai lần. Một cú fetch hỏng vì mạng chập chờn mà bị báo thành "thiếu
    // CORS" sẽ đẩy người đọc đi sửa nhầm chỗ — mà sửa CORS thì phải vào AWS
    // Console, không phải việc làm nhầm cho vui.
    for (let lan = 0; lan < 2 && ma === null; lan++) {
      try {
        const r = await fetch(`${base}/bim/_kiemtra/probe`, {
          method: "OPTIONS",
          headers: {
            Origin: org,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "content-disposition,content-type",
          },
          signal: AbortSignal.timeout(15000),
        });
        ma = r.status;
      } catch (e) {
        if (lan === 1) ma = "mạng";
      }
    }
    kq.push([method, ma]);
  }
  const nhan = org + "  (" + ghiChu + ")";
  const chuoi = kq.map(([m, s]) => m + ":" + s).join("  ");
  if (kq.every(([, s]) => s === 200)) {
    ok(nhan + " — PUT và GET đều được phép");
  } else if (kq.some(([, s]) => s === "mạng")) {
    canhBao(nhan + " — " + chuoi,
      "không gọi tới S3 được ở phép thử này. Trục trặc mạng, CHƯA kết luận được\n"
      + "      về CORS — chạy lại script trước khi đi sửa gì.");
  } else {
    canhBao(nhan + " — " + chuoi,
      org.startsWith("https")
        ? "thiếu origin này trong CORS của bucket → TẢI FILE LÊN TRÊN WEB THẬT SẼ HỎNG.\n"
        + "      AWS Console → S3 → " + BUCKET + " → Permissions → CORS, thêm origin vào AllowedOrigins."
        : "chỉ ảnh hưởng khi chạy thử bằng vercel dev ở máy");
  }
}

console.log("\n  ════ " + dat + " đạt, " + hong + " hỏng"
  + (canh ? ", " + canh + " cảnh báo" : "") + " ════");
if (!hong) {
  console.log("  Cấu hình ở máy chạy được."
    + (canh ? " Cảnh báo ở trên là việc cần xử lý, không phải lỗi cấu hình." : ""));
}
console.log("");
process.exit(hong ? 1 : 0);
