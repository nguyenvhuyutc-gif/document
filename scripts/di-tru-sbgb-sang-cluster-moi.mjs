#!/usr/bin/env node
// ============================================================
//  Di kế hoạch SBGB từ cluster CŨ sang cluster MỚI, đồng thời đưa file đính kèm
//  từ trong MongoDB lên S3.
//
//    node scripts/di-tru-sbgb-sang-cluster-moi.mjs               # chạy khô
//    node scripts/di-tru-sbgb-sang-cluster-moi.mjs --thuc-hien   # làm thật
//
//  Cluster CŨ chỉ được ĐỌC — script không ghi, không xoá gì bên đó. Mọi thay đổi
//  chỉ xảy ra ở cluster MỚI và trên S3.
//
//  Ba điều script này cẩn thận:
//
//   1. GHÉP, KHÔNG GHI ĐÈ. Bản SBGB ở cluster mới có 7 ghi chú mà bản cũ không có.
//      Chép đè bản cũ sang là xoá mất công sức đó. Script chỉ gắn thêm file vào
//      từng dòng, mọi ô khác giữ nguyên.
//
//   2. GHÉP THEO THỨ TỰ DÒNG, có kiểm tên. Hai bản có row.id khác nhau (bản mới
//      được dựng lại) nên không ghép theo id được. Trước khi gắn, script so tên
//      hạng mục của từng cặp dòng; lệch một dòng là dừng toàn bộ.
//
//   3. IDEMPOTENT. Chạy lại lần hai không nhân đôi file: doc nào đã có ở cluster
//      mới thì bỏ qua, dòng nào đã có file id đó thì không gắn thêm.
//
//  Trước khi ghi, bản SBGB hiện tại ở cluster mới được lưu ra scratch/ dưới dạng
//  JSON — đường lùi nếu có gì sai.
// ============================================================
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { AwsClient } from "aws4fetch";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THUC_HIEN = process.argv.includes("--thuc-hien");

function docEnv(p) {
  const out = {};
  if (!fs.existsSync(p)) return null;
  for (const d of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(d);
    if (!m) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const TMP = process.env.TEMP || process.env.TMP || "";
const envMoi = docEnv(path.join(ROOT, ".env"));
const envCu = docEnv(path.join(TMP, "claude", ".env.truoc-khi-pull"));

function thoat(msg) {
  console.error("\n  DỪNG: " + msg + "\n");
  process.exit(1);
}
const host = (u) => (/@([^/?]+)/.exec(String(u || "")) || [, "?"])[1];
const mb = (n) => (n / 1048576).toFixed(1) + " MB";
const chuThuan = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ").trim().toLowerCase();

if (!envMoi || !envMoi.MONGODB_URI) thoat("không đọc được .env ở thư mục dự án");
if (!envCu || !envCu.MONGODB_URI) {
  thoat("không tìm thấy connection string của cluster cũ.\n"
    + "        Script đọc nó ở " + path.join(TMP, "claude", ".env.truoc-khi-pull") + "\n"
    + "        Nếu file đó mất, đặt biến môi trường MONGODB_URI_CU rồi chạy lại.");
}
if (process.env.MONGODB_URI_CU) envCu.MONGODB_URI = process.env.MONGODB_URI_CU;

if (host(envCu.MONGODB_URI) === host(envMoi.MONGODB_URI)) {
  thoat("hai connection string trỏ cùng một host (" + host(envMoi.MONGODB_URI) + ").\n"
    + "        Không có gì để di, và chạy tiếp thì rất dễ tự ghi đè lên chính mình.");
}

for (const k of ["S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"]) {
  if (!envMoi[k]) thoat("thiếu biến " + k + " trong .env — không đẩy file lên S3 được");
}

const s3 = new AwsClient({
  accessKeyId: envMoi.S3_ACCESS_KEY_ID,
  secretAccessKey: envMoi.S3_SECRET_ACCESS_KEY,
  service: "s3",
  region: envMoi.S3_REGION,
});
// PATH-STYLE — bắt buộc, tên bucket có dấu chấm. Xem ghi chú ở api/files.js.
const S3_BASE = `https://s3.${envMoi.S3_REGION}.amazonaws.com/${envMoi.S3_BUCKET}`;

async function kyS3(key, method, han) {
  const u = new URL(`${S3_BASE}/${key}`);
  u.searchParams.set("X-Amz-Expires", String(han));
  return (await s3.sign(u.toString(), { method, aws: { signQuery: true } })).url;
}
function taoKey(ten) {
  const ym = new Date().toISOString().slice(0, 7);
  const rand = crypto.randomBytes(6).toString("hex");
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(ten || ""));
  return `bim/${ym}/${rand}${m ? "." + m[1].toLowerCase() : ""}`;
}
function cdHeader(ten) {
  const nm = String(ten || "file");
  const ascii = nm.replace(/[^\x20-\x7E]/g, "_").split(String.fromCharCode(92)).join("_")
    .split(String.fromCharCode(34)).join("_");
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8'
    + String.fromCharCode(39, 39) + encodeURIComponent(nm);
}
function bufCuaDoc(d) {
  if (!d) return Buffer.alloc(0);
  if (d.data && d.data.buffer) return Buffer.from(d.data.buffer);
  return Buffer.from(d.data || "");
}

console.log("\n╔════════════════════════════════════════════════════════════╗");
console.log("║  DI KẾ HOẠCH SBGB SANG CLUSTER MỚI + ĐƯA FILE LÊN S3        ║");
console.log("╚════════════════════════════════════════════════════════════╝");
console.log("  cluster CŨ (chỉ đọc) : " + host(envCu.MONGODB_URI));
console.log("  cluster MỚI (sẽ ghi) : " + host(envMoi.MONGODB_URI));
console.log("  bucket S3 (sẽ ghi)   : " + envMoi.S3_BUCKET + "  (" + envMoi.S3_REGION + ")");
console.log("  chế độ               : " + (THUC_HIEN ? "LÀM THẬT" : "chạy khô (chỉ in ra)"));
console.log("");

const cliCu = new MongoClient(envCu.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
const cliMoi = new MongoClient(envMoi.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
let dat = 0, hong = 0;

try {
  await cliCu.connect();
  await cliMoi.connect();
  const dbCu = cliCu.db(envCu.MONGODB_DB || "bim");
  const dbMoi = cliMoi.db(envMoi.MONGODB_DB || "bim");
  const appCu = dbCu.collection(envCu.MONGODB_COLLECTION || "bim_app");
  const appMoi = dbMoi.collection(envMoi.MONGODB_COLLECTION || "bim_app");
  const fileCu = dbCu.collection(envCu.MONGODB_FILES_COLLECTION || "bim_files");
  const fileMoi = dbMoi.collection(envMoi.MONGODB_FILES_COLLECTION || "bim_files");

  const planCu = (await appCu.find({}).toArray()).find((p) => /^SBGB/i.test(String(p.name || "")));
  const planMoi = (await appMoi.find({}).toArray()).find((p) => /^SBGB/i.test(String(p.name || "")));
  if (!planCu) thoat("không tìm thấy kế hoạch SBGB ở cluster cũ");
  if (!planMoi) thoat("không tìm thấy kế hoạch SBGB ở cluster mới");

  const rowsCu = (planCu.data && planCu.data.rows) || [];
  const rowsMoi = (planMoi.data && planMoi.data.rows) || [];
  console.log("  cũ : " + planCu.name + "  (" + rowsCu.length + " dòng)");
  console.log("  mới: " + planMoi.name + "  (" + rowsMoi.length + " dòng)\n");

  // ---- chốt an toàn: hai bảng phải khớp từng dòng ----
  if (rowsCu.length !== rowsMoi.length) {
    thoat("số dòng lệch (" + rowsCu.length + " ≠ " + rowsMoi.length + ").\n"
      + "        Ghép theo thứ tự sẽ gắn file vào nhầm hạng mục.");
  }
  const lech = [];
  for (let i = 0; i < rowsCu.length; i++) {
    if (chuThuan(rowsCu[i].hangMuc) !== chuThuan(rowsMoi[i].hangMuc)) {
      lech.push(i + 1 + ": “" + chuThuan(rowsCu[i].hangMuc).slice(0, 40) + "” ≠ “"
        + chuThuan(rowsMoi[i].hangMuc).slice(0, 40) + "”");
    }
  }
  if (lech.length) {
    thoat(lech.length + " dòng có tên hạng mục lệch nhau — không ghép theo thứ tự được:\n        "
      + lech.slice(0, 5).join("\n        "));
  }
  console.log("  ✓ " + rowsCu.length + "/" + rowsCu.length + " dòng khớp tên theo đúng thứ tự\n");

  // ---- gom file cần di ----
  const FKEYS = ["files", "filesDuyet", "filesChapThuan"];
  const canDi = [];
  for (let i = 0; i < rowsCu.length; i++) {
    for (const fk of FKEYS) {
      for (const f of (Array.isArray(rowsCu[i][fk]) ? rowsCu[i][fk] : [])) {
        if (f && f.id) canDi.push({ dong: i, fk, f });
      }
    }
  }
  console.log("  " + canDi.length + " file đính kèm cần mang sang.\n");
  if (!canDi.length) thoat("không có file nào để di — kiểm lại kế hoạch nguồn");

  // ---- sao lưu bản SBGB hiện tại ở cluster mới ----
  const luuVao = path.join(ROOT, "scratch",
    "sao-luu-sbgb-cluster-moi-" + planMoi._id + ".json");
  if (THUC_HIEN) {
    fs.mkdirSync(path.dirname(luuVao), { recursive: true });
    fs.writeFileSync(luuVao, JSON.stringify(planMoi, null, 2), "utf8");
    console.log("  Đã lưu bản SBGB hiện tại ở cluster mới ra:\n    " + luuVao + "\n");
  } else {
    console.log("  (chạy thật sẽ lưu bản hiện tại ra " + path.basename(luuVao) + " trước khi ghi)\n");
  }

  // ---- di từng file ----
  console.log("── Đưa file lên S3 rồi ghi metadata ở cluster mới ──");
  const rowsGhep = JSON.parse(JSON.stringify(rowsMoi));
  let tongByte = 0;

  for (let n = 0; n < canDi.length; n++) {
    const { dong, fk, f } = canDi[n];
    const nhan = "  [" + String(n + 1).padStart(2) + "/" + canDi.length + "] "
      + String(f.name || "").slice(0, 46).padEnd(46);

    // đã gắn rồi thì thôi — cho phép chạy lại
    const daCo = (rowsGhep[dong][fk] || []).some((x) => x && String(x.id) === String(f.id));
    if (daCo) { console.log(nhan + "  (đã có ở bản mới, bỏ qua)"); continue; }

    const docCu = await fileCu.findOne({ _id: f.id });
    if (!docCu) { console.log(nhan + "  ✗ không thấy doc ở cluster cũ"); hong++; continue; }

    // dựng nội dung: nguyên khối `data`, hoặc ghép các mảnh `chunks`
    let buf;
    if (Array.isArray(docCu.chunks) && docCu.chunks.length) {
      const manh = [];
      let thieu = false;
      for (const cid of docCu.chunks) {
        const cd = await fileCu.findOne({ _id: cid });
        if (!cd) { thieu = true; break; }
        manh.push(bufCuaDoc(cd));
      }
      if (thieu) { console.log(nhan + "  ✗ mất mảnh file ở cluster cũ"); hong++; continue; }
      buf = Buffer.concat(manh);
    } else if (docCu.key) {
      console.log(nhan + "  (đã nằm trên S3 từ trước, chỉ chép metadata)");
      buf = null;
    } else {
      buf = bufCuaDoc(docCu);
    }
    if (buf && !buf.length) { console.log(nhan + "  ✗ nội dung rỗng"); hong++; continue; }

    const ten = docCu.name || f.name || "file";
    const kieu = docCu.type || f.type || "application/octet-stream";
    const key = docCu.key || taoKey(ten);
    const co = buf ? buf.length : (docCu.size || f.size || 0);

    if (!THUC_HIEN) {
      console.log(nhan + "  " + mb(co).padStart(9) + "  → " + key);
      tongByte += co; dat++;
      rowsGhep[dong][fk] = (rowsGhep[dong][fk] || []).concat([{ id: f.id }]);  // giữ chỗ cho lần đếm
      continue;
    }

    if (buf) {
      const r = await fetch(await kyS3(key, "PUT", 3600), {
        method: "PUT",
        headers: { "Content-Type": kieu, "Content-Disposition": cdHeader(ten) },
        body: buf,
      });
      if (r.status !== 200) {
        console.log(nhan + "  ✗ PUT lên S3 trả " + r.status);
        hong++; continue;
      }
    }

    // Ghi metadata TRƯỚC khi gắn vào bảng: doc thừa mà bảng chưa trỏ tới thì chỉ là
    // rác im lặng, còn bảng trỏ vào doc chưa tồn tại thì người dùng thấy file hỏng.
    await fileMoi.updateOne(
      { _id: f.id },
      {
        $set: {
          name: ten, type: kieu, key, status: "ready", size: co,
          createdAt: docCu.createdAt || Date.now(), confirmedAt: Date.now(),
          diTuCluster: host(envCu.MONGODB_URI),
        },
      },
      { upsert: true }
    );

    rowsGhep[dong][fk] = (rowsGhep[dong][fk] || []).concat([{
      id: f.id, name: ten, size: co, type: kieu,
      url: "api/files?id=" + f.id,
      note: f.note || "",
      uploadedAt: f.uploadedAt || new Date(docCu.createdAt || Date.now()).toISOString(),
    }]);
    console.log(nhan + "  " + mb(co).padStart(9) + "  ✓ " + key);
    tongByte += co; dat++;
  }

  console.log("\n  Tổng: " + dat + " file (" + mb(tongByte) + ")" + (hong ? ", " + hong + " lỗi" : ""));

  if (hong) {
    thoat(hong + " file lỗi — KHÔNG ghi bảng.\n"
      + "        Sửa nguyên nhân rồi chạy lại; những file đã lên S3 sẽ được bỏ qua.");
  }

  // ---- ghi bảng ----
  if (!THUC_HIEN) {
    console.log("\n  Đây là lần chạy khô — chưa ghi gì. Thêm --thuc-hien để làm thật.\n");
  } else {
    const data = Object.assign({}, planMoi.data || {}, { rows: rowsGhep });
    await appMoi.updateOne({ _id: planMoi._id }, { $set: { data, updatedAt: Date.now() } });
    console.log("\n  ✓ Đã gắn " + dat + " file vào kế hoạch “" + planMoi.name + "” ở cluster mới.");
    console.log("    Mọi ô khác giữ nguyên — 7 ghi chú của bản mới không bị đụng tới.\n");
  }
} catch (e) {
  console.error("\n  LỖI: " + (e && e.message));
  console.error(e);
  process.exitCode = 1;
} finally {
  await cliCu.close().catch(() => {});
  await cliMoi.close().catch(() => {});
}
