// ============================================================
//  API file đính kèm — file lưu ở Amazon S3, MongoDB chỉ giữ metadata.
//
//  TẢI LÊN (3 bước, client đẩy thẳng lên S3, function chỉ ký URL):
//   POST /api/files?action=sign-upload&name=&type=&size=   (cần EDIT_KEY)
//        -> ghi doc {status:"pending"}, trả { ok, id, key, uploadUrl }
//   (client tự PUT thẳng lên uploadUrl, KÈM header Content-Disposition + Content-Type)
//   POST /api/files?action=confirm&id=&key=                (cần EDIT_KEY)
//        -> xác minh bằng HEAD trên S3, chuyển pending -> ready
//        -> { ok, file: { id, name, size, type, url } }
//
//  TẢI XUỐNG (tự do, không cần mật khẩu — TRỪ file đang nằm trong thùng rác):
//   GET  /api/files?id=<id>          -> file mới: 302 sang S3 (URL ký, 5 phút)
//                                    -> file cũ:  trả thẳng từ MongoDB như trước
//   GET  /api/files?id=<id>&part=<i> -> mảnh thứ i của file cũ chia mảnh
//
//  THÙNG RÁC (toàn bộ cần ADMIN_KEY):
//   POST   /api/files?action=trash    body {items:[{id,planId,rowId,fkey,rowName}]}
//        -> đánh dấu status:"trashed" hàng loạt, KHÔNG đụng object trên S3
//   GET    /api/files?trash=1&plan=<id>
//        -> danh sách thùng rác của kế hoạch + dọn bản quá hạn 30 ngày
//   POST   /api/files?action=restore&id=<id>  -> bỏ cờ trashed
//   DELETE /api/files?id=<id>                 -> xoá hẳn: object S3 + doc
//
//  File trong thùng rác vẫn nằm nguyên chỗ cũ trên S3 — chỉ metadata đổi. Copy
//  một object 500MB sang prefix khác trong hàm 15 giây là rủi ro không đổi lấy gì.
//
//  File CŨ (nguyên khối `data`, hoặc chia mảnh `chunks`) vẫn đọc từ MongoDB —
//  không migrate, không đụng tới. Đường đọc đó KHÔNG bao giờ chạm tới S3, nên
//  thiếu biến môi trường S3 cũng không làm hỏng việc tải file cũ.
// ============================================================
const { MongoClient } = require("mongodb");
const crypto = require("crypto");
const { AwsClient } = require("aws4fetch");

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "bim";
const filesCollection = process.env.MONGODB_FILES_COLLECTION || "bim_files";
// Cùng collection mà api/data.js dùng — thùng rác phải đọc được document kế hoạch
// để biết file nào vẫn đang được bảng tham chiếu. Hai chỗ phải khớp tên.
const appCollection = process.env.MONGODB_COLLECTION || "bim_app";

const MAX_UPLOAD = 500 * 1024 * 1024;       // giới hạn 1 file (S3 không giới hạn, đây là chính sách)

// Bốn cột file của một dòng trong document kế hoạch. Phải khớp với hằng FKEYS ở
// bang-hang-muc.html — thiếu một cột ở đây thì lớp tự chữa lành của thùng rác coi
// file trong cột đó là rác và vẫn liệt kê nó dù bảng đang dùng.
const FKEYS = ["files", "filesCad", "filesDuyet", "filesChapThuan"];

const TRASH_TTL = 30 * 24 * 60 * 60 * 1000;   // file nằm thùng rác 30 ngày rồi tự xoá
// Dọn quá hạn chạy ngay trong request liệt kê thùng rác, mà mỗi lần xoá là một
// request HTTP tới S3 (~100-300ms). Trần 10 giữ tổng thời gian dưới ~3s, còn xa
// mức maxDuration 15s trong vercel.json. Phần dư để lần mở sau.
const TRASH_CLEAN_MAX = 10;
const TRASH_BATCH_MAX = 500;                  // trần số file cho một lần POST ?action=trash

// ---- phân quyền (giống api/data.js): EDIT_KEY = tải file lên, ADMIN_KEY = thêm quyền xoá ----
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function getRole(req) {
  const adminKey = process.env.ADMIN_KEY || "";
  const editKey = process.env.EDIT_KEY || "";
  if (!adminKey && !editKey) return "admin";
  const key = String(req.headers["x-edit-key"] || "");
  if (adminKey && key && safeEqual(key, adminKey)) return "admin";
  if (editKey && key && safeEqual(key, editKey)) return "edit";
  return "view";
}

async function connectMongo() {
  if (!uri) throw new Error("MONGODB_URI is not configured");
  if (global.__mongoClient && global.__mongoDb) {
    return { client: global.__mongoClient, db: global.__mongoDb };
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  global.__mongoClient = client;
  global.__mongoDb = db;
  return { client, db };
}

// Giống hệt readBody ở api/data.js. Vercel đã parse sẵn body JSON trong hầu hết
// trường hợp, nhưng `vercel dev` và một số runtime giao lại raw string hoặc
// Buffer — nhánh tự đọc stream là để hai môi trường hành xử như nhau.
async function readBody(req) {
  if (req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  let raw = req.body;
  if (raw == null) {
    raw = await new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
  return JSON.parse(raw);
}

// ---- Amazon S3 ----
// KHỞI TẠO LƯỜI, đúng nếp connectMongo() ở trên.
// KHÔNG dựng AwsClient ở tầng module: nếu 4 biến S3 thiếu hoặc RỖNG (bẫy đã biết
// của `vercel env add`, xem .claude/skills/deploy-bim/SKILL.md) thì hoặc là module
// ném lỗi lúc nạp và TOÀN BỘ /api/files trả 500 — kể cả GET file cũ trong MongoDB,
// thứ mà đường lai sinh ra để bảo vệ — hoặc là base URL thành
// "https://s3.undefined.amazonaws.com/undefined" và sign-upload trả 200 với URL
// trông hợp lệ, đẩy lỗi xuống tận xhr.onerror ở client dưới dạng "mất kết nối
// khi tải lên".
//
// S3_REGION phải khớp TUYỆT ĐỐI với vùng của bucket: SigV4 nhét vùng vào
// credential scope, nên sai vùng là 403 ở mọi request — và thông báo lỗi của S3
// không hề nhắc tới vùng.
let _s3 = null;
function getS3() {
  if (_s3) return _s3;
  const miss = ["S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"]
    .filter((k) => !process.env[k]);
  if (miss.length) throw new Error("Thiếu biến môi trường S3: " + miss.join(", "));
  _s3 = {
    client: new AwsClient({
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      service: "s3",
      region: process.env.S3_REGION,
    }),
    // PATH-STYLE (bucket nằm trong path), KHÔNG phải virtual-hosted style.
    // Bắt buộc vì tên bucket có dấu chấm: virtual-hosted sẽ thành
    // "com.vcijsc.bvtc.s3.ap-southeast-1.amazonaws.com", mà chứng chỉ TLS
    // "*.s3.<vùng>.amazonaws.com" chỉ khớp MỘT nhãn → lỗi TLS ở mọi request.
    // Path-style chạy với mọi tên bucket nên không cần rẽ nhánh.
    base: `https://s3.${process.env.S3_REGION}.amazonaws.com/${process.env.S3_BUCKET}`,
  };
  return _s3;
}

// Ký URL có hạn. signQuery: true → chữ ký nằm trong query string, và aws4fetch
// chỉ ký đúng header `host` (X-Amz-SignedHeaders=host). Nhờ đó client gửi thêm
// Content-Disposition / Content-Type lúc PUT cũng không làm lệch chữ ký, mà S3
// vẫn lưu chúng làm metadata của object.
//
// LƯU Ý: method là DÒNG ĐẦU TIÊN của canonical request trong SigV4 — URL ký cho
// "GET" KHÔNG dùng được cho "HEAD". Mỗi method phải ký riêng.
//
// KHÔNG thêm response-content-disposition / response-content-type vào query:
// aws4fetch dựng canonical query bằng encodeRfc3986(encodeURIComponent(v))
// (space → %20, * → %2A) còn URL gửi đi lấy từ URL.toString() (space → +, * → *).
// Chuỗi Content-Disposition chứa cả hai ký tự đó → chữ ký lệch → 403 mọi file.
async function signS3(key, method, expires) {
  const { client, base } = getS3();
  const u = new URL(`${base}/${key}`);
  u.searchParams.set("X-Amz-Expires", String(expires));
  const signed = await client.sign(u.toString(), { method, aws: { signQuery: true } });
  return signed.url;
}

// bim/2026-09/a1b2c3d4e5f6.dwg — chỉ ASCII.
// Tên thật (có dấu) lưu ở MongoDB và trong Content-Disposition của object,
// KHÔNG nhét vào key — tránh hẳn một lớp lỗi mã hoá trong chữ ký.
function makeKey(name) {
  const ym = new Date().toISOString().slice(0, 7);
  const rand = crypto.randomBytes(6).toString("hex");
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ""));
  return `bim/${ym}/${rand}${m ? "." + m[1].toLowerCase() : ""}`;
}
const KEY_RE = /^bim\/\d{4}-\d{2}\/[0-9a-f]{12}(\.[a-z0-9]{1,8})?$/;

function docBuffer(doc) {
  return doc.data && doc.data.buffer ? Buffer.from(doc.data.buffer) : Buffer.from(doc.data || "");
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const id = url.searchParams.get("id");
    const action = url.searchParams.get("action");

    // ---- Shim cho HTML cũ còn nằm trong cache trình duyệt ----
    // bang-hang-muc.html là file tĩnh và vercel.json chỉ đặt header cho /api/(.*),
    // nên không có gì ép tab đang mở tải lại. Không có shim này thì request rơi
    // xuống 405 "Method Not Allowed" — chuỗi tiếng Anh khó hiểu, hiện ra sau khi
    // retryUp đã thử lại 3 lần mỗi mảnh, tức là treo ô nhiều phút.
    // Đặt TRƯỚC cả bước kiểm quyền: người dùng cần biết "hãy tải lại trang",
    // không phải "sai mật khẩu".
    //
    // Bắt theo kiểu "mọi POST KHÔNG nằm trong danh sách trắng" chứ không liệt kê
    // action cũ: bản cũ tải file nhỏ (≤3.5MB) bằng POST ?name=&type= KHÔNG có
    // action nào cả — đó là đường tải lên phổ biến nhất, và liệt kê theo tên sẽ
    // bỏ sót đúng nó.
    //
    // MỖI action POST mới PHẢI được thêm vào đây, nếu không nó chết ở 426 với
    // thông báo "hãy tải lại trang" — một lỗi trông y hệt lỗi cache và tốn cả
    // buổi để tìm ra.
    const ACTION_POST = new Set(["sign-upload", "confirm", "trash", "restore"]);
    const postLaCu = req.method === "POST" && !ACTION_POST.has(action);
    if (postLaCu || (req.method === "DELETE" && url.searchParams.get("chunks"))) {
      res.status(426).json({ ok: false, error: "Bản web đã cập nhật — hãy tải lại trang (Ctrl+F5)" });
      return;
    }

    // Tải xuống (GET) tự do; tải lên (POST) cần EDIT_KEY; xoá và thùng rác cần ADMIN_KEY.
    //
    // Nút thùng rác ở giao diện bị ẩn khi không phải quản trị, nhưng canAdmin() bên
    // đó chỉ ẩn nút — ai mở DevTools cũng gọi thẳng được. Hàng rào thật nằm ở đây.
    const laThungRac = action === "trash" || action === "restore"
      || (req.method === "GET" && url.searchParams.get("trash"));
    if (laThungRac || req.method === "POST" || req.method === "DELETE") {
      const role = getRole(req);
      if ((laThungRac || req.method === "DELETE") && role !== "admin") {
        res.status(401).json({ ok: false, needKey: true, error: "Cần mật khẩu quản trị" });
        return;
      }
      if (role !== "admin" && role !== "edit") {
        res.status(401).json({ ok: false, needKey: true, error: "Cần mật khẩu quyền sửa để tải file lên" });
        return;
      }
    }

    const { db } = await connectMongo();
    const col = db.collection(filesCollection);

    // ---- Bước 1: xin URL để tải thẳng lên S3 ----
    if (req.method === "POST" && action === "sign-upload") {
      const name = url.searchParams.get("name") || "file";
      const type = url.searchParams.get("type") || "application/octet-stream";
      const size = Number(url.searchParams.get("size"));
      // Tách 400 và 413: báo "quá lớn" khi thật ra thiếu tham số sẽ dẫn debug đi sai hướng.
      if (!Number.isFinite(size) || size <= 0) {
        res.status(400).json({ ok: false, error: "Thiếu hoặc sai tham số size" });
        return;
      }
      if (size > MAX_UPLOAD) {
        res.status(413).json({ ok: false, error: "File quá lớn (giới hạn 500MB)" });
        return;
      }

      const key = makeKey(name);
      const newId = crypto.randomBytes(12).toString("hex");
      // KÝ TRƯỚC, ghi doc SAU. Ký là tính toán cục bộ, không gọi mạng, nhưng nó
      // ném lỗi khi 4 biến S3 thiếu hoặc rỗng. Ghi doc trước thì mỗi lần thử sẽ
      // để lại một doc `pending` mồ côi — và retryUp ở client thử 3 lần, còn script
      // dọn thì CỐ Ý không bao giờ đụng tới doc pending. Ký trước thì lỗi xảy ra
      // khi chưa có gì được ghi và chưa ai nhận được URL nào.
      // 1 giờ. Hạn này là trần thời gian truyền: URL hết hạn giữa chừng thì PUT hỏng
      // và client KHÔNG tự thử lại. 500MB trong 900s cũ đòi ~4.7 Mbps liên tục — quá
      // sát với đường lên của mạng văn phòng; 3600s hạ yêu cầu xuống ~1.2 Mbps.
      const uploadUrl = await signS3(key, "PUT", 3600);
      // Ghi doc `pending` để ràng id ↔ key ↔ người ký một cách nguyên tử, TRƯỚC khi
      // trả URL ra ngoài. Nhờ đó confirm không thể ghi metadata trỏ vào key của
      // người khác (key KHÔNG phải bí mật — nó nằm trong path của mọi URL đã ký),
      // confirm gọi lại lần hai không vỡ, và script dọn có danh sách pending có
      // thẩm quyền thay vì đoán theo tuổi file.
      await col.insertOne({ _id: newId, name, type, key, status: "pending", createdAt: Date.now() });
      res.status(200).json({ ok: true, id: newId, key, uploadUrl });
      return;
    }

    // ---- Bước 2: xác nhận đã lên S3, ghi metadata ----
    if (req.method === "POST" && action === "confirm") {
      const key = url.searchParams.get("key") || "";
      if (!id) { res.status(400).json({ ok: false, error: "Thiếu id" }); return; }
      if (!KEY_RE.test(key)) { res.status(400).json({ ok: false, error: "Key không hợp lệ" }); return; }

      const doc = await col.findOne({ _id: id });
      if (!doc || doc.key !== key) {
        res.status(400).json({ ok: false, error: "Phiên tải lên không hợp lệ" });
        return;
      }
      // Idempotent: retryUp ở client bọc lời gọi này, nên khi lần đầu thành công mà
      // response mất (cold start, Wi-Fi đổi sang 4G) thì lần thử lại phải trả 200 y hệt.
      // Không có nhánh này thì client thấy ok=false → save() không chạy → file 500MB
      // nằm trong S3 mà không dòng nào trỏ tới, còn người dùng bị báo là thất bại.
      if (doc.status === "ready") {
        res.status(200).json({ ok: true, file: fileOf(doc) });
        return;
      }
      if (doc.status !== "pending") {
        res.status(400).json({ ok: false, error: "Phiên tải lên không hợp lệ" });
        return;
      }

      // Ký RIÊNG cho HEAD — ký cho GET rồi gọi HEAD sẽ sai chữ ký.
      // Timeout 5s: confirm giờ có lời gọi ra ngoài trong một serverless invocation.
      // HEAD treo sẽ ăn hết budget và Vercel trả HTML lỗi, mà apiJson ở client biến
      // nó thành "máy chủ trả lỗi HTTP 504" — sau khi 500MB đã truyền xong.
      let head;
      try {
        head = await fetch(await signS3(key, "HEAD", 300), {
          method: "HEAD",
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        console.error("confirm: HEAD toi S3 that bai", e);
        res.status(503).json({ ok: false, error: "Kho lưu trữ không phản hồi, hãy thử lại" });
        return;
      }
      // Tách 404 và 403: báo "chưa thấy file" khi thật ra sai chữ ký sẽ dẫn debug
      // đi sai hướng cả buổi.
      if (head.status === 404) {
        res.status(400).json({ ok: false, error: "Chưa thấy file trên kho lưu trữ" });
        return;
      }
      if (head.status === 403) {
        console.error("confirm: S3 tra 403 — sai chu ky hoac sai quyen khoa API");
        res.status(500).json({ ok: false, error: "Lỗi chữ ký khi kiểm tra file" });
        return;
      }
      if (!head.ok) {
        console.error("confirm: S3 tra HTTP " + head.status);
        res.status(503).json({ ok: false, error: "Kho lưu trữ trả lỗi, hãy thử lại" });
        return;
      }

      // Lấy size từ HEAD chứ không tin client: vừa chính xác, vừa chặn ghi metadata
      // cho file chưa hề được tải lên.
      const size = Number(head.headers.get("content-length"));
      if (!Number.isFinite(size) || size <= 0) {
        res.status(400).json({ ok: false, error: "File trên kho lưu trữ rỗng" });
        return;
      }
      if (size > MAX_UPLOAD) {
        try { await fetch(await signS3(key, "DELETE", 300), { method: "DELETE", signal: AbortSignal.timeout(5000) }); }
        catch (e) { console.error("confirm: khong xoa duoc object qua lon", e); }
        await col.deleteOne({ _id: id, status: "pending" });
        res.status(413).json({ ok: false, error: "File quá lớn (giới hạn 500MB)" });
        return;
      }

      const confirmedAt = Date.now();
      const upd = await col.updateOne(
        { _id: id, key, status: "pending" },
        { $set: { status: "ready", size, confirmedAt } }
      );
      if (upd.matchedCount !== 1) {
        // Hai lời gọi confirm chạy song song: lời gọi kia vừa chuyển sang ready.
        const again = await col.findOne({ _id: id });
        if (again && again.key === key && again.status === "ready") {
          res.status(200).json({ ok: true, file: fileOf(again) });
          return;
        }
        res.status(400).json({ ok: false, error: "Phiên tải lên không hợp lệ" });
        return;
      }
      res.status(200).json({
        ok: true,
        file: fileOf({ _id: id, name: doc.name, type: doc.type, size }),
      });
      return;
    }

    // ---- Thùng rác: chuyển file vào ----
    // Nhận cả mẻ trong MỘT request: xoá 20 dòng × 3 file là 60 request nếu làm lẻ.
    if (req.method === "POST" && action === "trash") {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.status(400).json({ ok: false, error: "Body không phải JSON hợp lệ" }); return; }
      const items = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : null);
      if (!items || !items.length) { res.status(400).json({ ok: false, error: "Thiếu danh sách file" }); return; }
      if (items.length > TRASH_BATCH_MAX) {
        res.status(413).json({ ok: false, error: "Quá nhiều file trong một lần (tối đa " + TRASH_BATCH_MAX + ")" });
        return;
      }

      const now = Date.now();
      const ops = [];
      for (const it of items) {
        if (!it || !it.id) continue;
        ops.push({
          updateOne: {
            // Loại trừ `pending`: đó là phiên tải lên ĐANG CHẠY. Đụng vào thì
            // confirm sẽ thấy status lạ và báo "phiên tải lên không hợp lệ" —
            // người dùng mất file vừa tải xong mà không hiểu vì sao.
            filter: { _id: String(it.id), status: { $ne: "pending" } },
            update: {
              $set: {
                status: "trashed",
                trashedAt: now,
                // rowName lưu lại để thùng rác còn nói được "từ dòng: Móng M1"
                // kể cả khi dòng đó đã biến mất khỏi bảng.
                //
                // uploadedAt và note KHÔNG có ở đâu khác: chúng sống trong document
                // kế hoạch, và document đó vừa bị gỡ mất mục này. Không chép sang
                // đây thì khôi phục xong cột "Thời gian trình" trống trơn (hoặc tệ
                // hơn: hiện ngày XOÁ) và ghi chú của file bay mất.
                origin: {
                  planId: String(it.planId || ""),
                  rowId: String(it.rowId || ""),
                  fkey: String(it.fkey || "files"),
                  rowName: String(it.rowName || "").slice(0, 200),
                  uploadedAt: String(it.uploadedAt || ""),
                  note: String(it.note || "").slice(0, 4000),
                  viTri: Number(it.viTri) >= 0 ? Number(it.viTri) : 0,
                },
              },
            },
          },
        });
      }
      if (!ops.length) { res.status(400).json({ ok: false, error: "Không có id hợp lệ" }); return; }
      // ordered:false — một id đã bị xoá hẳn từ tab khác không được làm hỏng cả mẻ.
      const kq = await col.bulkWrite(ops, { ordered: false });
      res.status(200).json({ ok: true, trashed: kq.modifiedCount || 0, sent: ops.length });
      return;
    }

    // ---- Thùng rác: khôi phục ----
    if (req.method === "POST" && action === "restore") {
      if (!id) { res.status(400).json({ ok: false, error: "Thiếu id" }); return; }
      const doc = await col.findOne({ _id: id }, { projection: { status: 1, key: 1 } });
      if (!doc) { res.status(404).json({ ok: false, error: "File không còn trong thùng rác" }); return; }
      // Idempotent: client gọi lại sau khi mất response thì vẫn phải trả 200.
      if (doc.status !== "trashed") { res.status(200).json({ ok: true }); return; }
      // File CŨ (nằm trong MongoDB) vốn KHÔNG có trường status. Trả nó về đúng
      // trạng thái không-có-status thay vì đặt "ready" — script dọn có đọc trường
      // này và một giá trị bịa ra sẽ làm báo cáo sai.
      const update = doc.key
        ? { $set: { status: "ready" }, $unset: { trashedAt: "", origin: "" } }
        : { $unset: { status: "", trashedAt: "", origin: "" } };
      await col.updateOne({ _id: id }, update);
      res.status(200).json({ ok: true });
      return;
    }

    // ---- Thùng rác: liệt kê (kèm dọn bản quá hạn) ----
    if (req.method === "GET" && url.searchParams.get("trash")) {
      const planId = url.searchParams.get("plan") || "data";

      // 1. Dọn quá hạn. Quét TOÀN CỤC chứ không theo kế hoạch: rác của kế hoạch đã
      //    bị xoá cũng phải được dọn, mà sẽ không còn ai mở thùng rác của nó nữa.
      const hetHan = await col.find(
        { status: "trashed", trashedAt: { $lt: Date.now() - TRASH_TTL } },
        { projection: { key: 1, chunks: 1 }, limit: TRASH_CLEAN_MAX }
      ).toArray();
      for (const d of hetHan) await xoaVinhVien(col, d);

      // 2. File nào vẫn đang được bảng tham chiếu thì KHÔNG phải rác. Đây là lớp
      //    tự chữa lành: nếu save() xong mà bước restore hỏng giữa chừng, file sẽ
      //    tự biến khỏi thùng rác ở lần mở sau thay vì nằm lại gây hoang mang.
      const planDoc = await db.collection(appCollection)
        .findOne({ _id: planId }, { projection: { data: 1 } });
      const dangDung = new Set();
      const rows = (planDoc && planDoc.data && Array.isArray(planDoc.data.rows)) ? planDoc.data.rows : [];
      for (const row of rows) {
        for (const fk of FKEYS) {
          const arr = row && row[fk];
          if (Array.isArray(arr)) for (const f of arr) if (f && f.id) dangDung.add(String(f.id));
        }
      }

      const docs = await col.find(
        { status: "trashed", "origin.planId": planId },
        { projection: { name: 1, size: 1, type: 1, trashedAt: 1, origin: 1, key: 1 }, limit: 500 }
      ).sort({ trashedAt: -1 }).toArray();

      const items = [];
      for (const d of docs) {
        if (dangDung.has(String(d._id))) continue;
        const o = d.origin || {};
        items.push({
          id: d._id,
          name: d.name || "file",
          size: d.size || 0,
          type: d.type || "application/octet-stream",
          url: "api/files?id=" + d._id,
          trashedAt: d.trashedAt || 0,
          expiresAt: (d.trashedAt || 0) + TRASH_TTL,
          rowId: o.rowId || "",
          rowName: o.rowName || "",
          fkey: o.fkey || "files",
          // Ba trường để khôi phục file về đúng chỗ cũ, đúng mốc thời gian cũ.
          uploadedAt: o.uploadedAt || "",
          note: o.note || "",
          viTri: typeof o.viTri === "number" ? o.viTri : 0,
          // File cũ nằm trong MongoDB không có key nên không xin được URL ký —
          // client phải tải nó theo đường khác.
          onS3: !!d.key,
        });
      }
      res.status(200).json({
        ok: true, items,
        ttlDays: Math.round(TRASH_TTL / 86400000),
        cleaned: hetHan.length,
      });
      return;
    }

    // ---- Tải file xuống ----
    if (req.method === "GET") {
      if (!id) { res.status(400).json({ ok: false, error: "Thiếu id" }); return; }
      const doc = await col.findOne({ _id: id });
      if (!doc) { res.status(404).json({ ok: false, error: "Không tìm thấy file" }); return; }

      // File đã vào thùng rác thì không còn tải tự do được nữa — nó đã bị gỡ khỏi
      // bảng, ai biết id vẫn tải được thì việc xoá chẳng có nghĩa gì. Quản trị vẫn
      // tải được, vì đó chính là đường sao lưu trước khi xoá vĩnh viễn.
      if (doc.status === "trashed" && getRole(req) !== "admin") {
        res.status(404).json({ ok: false, error: "Không tìm thấy file" });
        return;
      }

      // ---- FILE MỚI: chuyển hướng thẳng sang S3 ----
      if (doc.key) {
        if (doc.status !== "ready" && doc.status !== "trashed") {
          // doc pending = phiên tải lên chưa xong, chưa phải một file
          res.status(404).json({ ok: false, error: "Không tìm thấy file" });
          return;
        }
        // no-store là BẮT BUỘC. Code file cũ bên dưới đặt max-age=31536000, immutable;
        // để header đó rơi vào nhánh này là nhét một credential 5 phút vào cache 1 năm:
        // 5 phút sau mọi lần bấm đều nhận AccessDenied từ S3, không xoá được nếu không
        // xoá dữ liệu site. Người dùng báo "file hỏng" trong khi file hoàn toàn nguyên vẹn.
        //
        // Tên file và MIME KHÔNG cần tham số response-* — chúng đã nằm sẵn trên object
        // (client gắn Content-Disposition + Content-Type lúc PUT).
        const urlKy = await signS3(doc.key, "GET", 300);
        res.setHeader("Cache-Control", "private, no-store");

        // ?signed=1 → trả URL đã ký dạng JSON thay vì chuyển hướng.
        // Cần cho việc tải file trong thùng rác: file đó đòi header x-edit-key, mà
        // thẻ <a> và window.open không gửi header được. Client xin URL kèm header
        // rồi mở thẳng URL đó. Cách này cũng tránh được CORS của bucket, thứ mà
        // fetch() sẽ vướng còn điều hướng của trình duyệt thì không.
        if (url.searchParams.get("signed")) {
          res.status(200).json({ ok: true, url: urlKy, name: doc.name || "file" });
          return;
        }
        res.setHeader("Location", urlKy);
        res.status(302).end();
        return;
      }

      // Chốt an toàn: doc không có `key`, cũng không có `data`/`chunks` thì docBuffer()
      // sẽ trả buffer rỗng mà không báo lỗi → người dùng nhận file 0 byte kèm cache
      // 1 năm. Thà hỏng ồn ào còn hơn hỏng im lặng. (Giữ nguyên từ giai đoạn 0 — đây
      // là thứ làm cho `vercel rollback` an toàn.)
      if (!doc.data && !Array.isArray(doc.chunks)) {
        res.setHeader("Cache-Control", "no-store");
        res.status(410).json({
          ok: false,
          error: "File này lưu ở kho mới, bản web đang chạy chưa đọc được. Hãy tải lại trang."
        });
        return;
      }

      // ---- FILE CŨ: đọc thẳng từ MongoDB, giữ nguyên như trước ----
      // file chia mảnh + ?part=i -> trả riêng mảnh đó (client tự ghép)
      const partRaw = url.searchParams.get("part");
      if (Array.isArray(doc.chunks) && partRaw != null) {
        const pi = Number(partRaw);
        if (!(pi >= 0 && pi < doc.chunks.length)) { res.status(400).json({ ok: false, error: "part không hợp lệ" }); return; }
        const cd = await col.findOne({ _id: doc.chunks[pi] });
        if (!cd) { res.status(404).json({ ok: false, error: "Mất mảnh file" }); return; }
        const cb = docBuffer(cd);
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", cb.length);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.status(200).send(cb);
        return;
      }

      // file chia mảnh, tải cả cục (chỉ dùng được khi tổng < giới hạn response;
      // giao diện web luôn tải theo ?part nên nhánh này chỉ là dự phòng)
      let buf;
      if (Array.isArray(doc.chunks)) {
        const parts = [];
        for (const cid of doc.chunks) {
          const cd = await col.findOne({ _id: cid });
          if (!cd) { res.status(404).json({ ok: false, error: "Mất mảnh file" }); return; }
          parts.push(docBuffer(cd));
        }
        buf = Buffer.concat(parts);
      } else {
        buf = docBuffer(doc);
      }
      const name = doc.name || "file";
      const asciiName = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
      res.setHeader("Content-Type", doc.type || "application/octet-stream");
      res.setHeader("Content-Length", buf.length);
      res.setHeader("Content-Disposition",
        "attachment; filename=\"" + asciiName + "\"; filename*=UTF-8''" + encodeURIComponent(name));
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.status(200).send(buf);
      return;
    }

    // ---- Xoá vĩnh viễn (object S3 hoặc mọi mảnh trong MongoDB) ----
    // Giao diện chỉ gọi đường này từ trong thùng rác. Xoá file ở bảng đi qua
    // ?action=trash. Nhưng tab đang mở bản HTML cũ vẫn gọi thẳng vào đây, nên
    // hành vi phải giữ nguyên: xoá là mất hẳn.
    if (req.method === "DELETE") {
      if (!id) { res.status(400).json({ ok: false, error: "Thiếu id" }); return; }
      const doc = await col.findOne({ _id: id }, { projection: { key: 1, chunks: 1 } });
      // Giữ guard này: bản HTML cũ gọi DELETE kiểu bắn-rồi-quên, nên xoá cùng một
      // file hai lần là chuyện bình thường (hai tab, hoặc hai người trên một dòng
      // đang đồng bộ). Bỏ đi thì lần thứ hai ném lỗi → 500 thay vì 200 êm ả.
      if (!doc) { res.status(200).json({ ok: true }); return; }
      await xoaVinhVien(col, doc);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: "Method Not Allowed" });
  } catch (error) {
    // KHÔNG trả nguyên error.message về client. Chuỗi đó có thể chứa cả URL đã ký
    // (kèm X-Amz-Credential và chữ ký còn hiệu lực), hoặc E11000 kèm tên database
    // và tên index — một kênh dò _id có sẵn.
    console.error(error);
    res.status(500).json({ ok: false, error: "Lỗi máy chủ" });
  }
};

function fileOf(doc) {
  return {
    id: doc._id,
    name: doc.name || "file",
    size: doc.size || 0,
    type: doc.type || "application/octet-stream",
    url: "api/files?id=" + doc._id,
  };
}

// Xoá hẳn một file: object trên S3 (nếu có), mọi mảnh trong MongoDB (file cũ),
// rồi chính doc. Dùng chung cho DELETE và cho việc dọn bản quá hạn 30 ngày —
// hai đường đó phải xoá y hệt nhau, tách ra là sớm muộn cũng lệch.
async function xoaVinhVien(col, doc) {
  if (doc.key) {
    // Xoá object hỏng thì VẪN xoá metadata và coi như xong — metadata trỏ vào hư
    // không tệ hơn một object mồ côi. Ghi log để script dọn còn có dấu vết.
    try {
      await fetch(await signS3(doc.key, "DELETE", 300), {
        method: "DELETE",
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.error("xoaVinhVien: khong xoa duoc object S3 " + doc.key, e);
    }
  }
  if (Array.isArray(doc.chunks) && doc.chunks.length) {
    await col.deleteMany({ _id: { $in: doc.chunks } });
  }
  await col.deleteOne({ _id: doc._id });
}
