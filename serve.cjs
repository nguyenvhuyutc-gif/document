// ============================================================
//  KHÔNG CÒN DÙNG — giữ lại làm tư liệu, KHÔNG chạy được nữa.
//
//  Từ 09/2026, file đính kèm lưu ở Amazon S3 qua presigned URL.
//  bang-hang-muc.html (dùng chung với bản Vercel) gọi ?action=sign-upload,
//  mà máy chủ này không có route đó → mọi lần tải file lên sẽ báo "File rỗng".
//  Phần bảng biểu vẫn chạy; chỉ riêng tải file lên là hỏng.
//
//  Muốn dùng lại phải cài thêm 3 route ở đây: sign-upload, confirm, và GET
//  chuyển hướng 302 — xem docs/luu-file-s3.md.
//
//  Các script npm start / dev / serve đã bị gỡ khỏi package.json để không ai
//  vô tình chạy bằng lệnh quen.
// ============================================================
//  (tư liệu) Bảng theo dõi hạng mục — máy chủ tĩnh + lưu dữ liệu chung
//  Chạy:  node serve.cjs        (hoặc bấm đúp start-server.bat)
//  Dữ liệu chung nằm ở: data.json (cùng thư mục này)
//  Không cần cài thêm gói — chỉ cần Node.js (https://nodejs.org).
// ============================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const root = __dirname;
const dataFile = path.join(root, "data.json");
const filesDir = path.join(root, "data-files");        // nơi lưu file đính kèm (chế độ local/LAN)
try { fs.mkdirSync(filesDir, { recursive: true }); } catch (e) {}
const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || "0.0.0.0"; // 0.0.0.0 = cho máy khác trong LAN vào; đổi 127.0.0.1 nếu chỉ dùng một mình

const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon"
};

function sendJson(res, code, obj) {
  var b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": b.length, "cache-control": "no-store" });
  res.end(b);
}

// ---- phân quyền (giống bản Vercel): EDIT_KEY = sửa/tải file, ADMIN_KEY = thêm quyền xoá ----
// Chạy LAN mặc định không đặt khoá → mọi người đều là quản trị (như trước giờ).
// Muốn khoá:  set EDIT_KEY=abc && set ADMIN_KEY=xyz && node serve.cjs
const editKey = process.env.EDIT_KEY || "";
const adminKey = process.env.ADMIN_KEY || "";
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function getRole(req) {
  if (!adminKey && !editKey) return "admin";
  var key = String(req.headers["x-edit-key"] || "");
  if (adminKey && key && safeEqual(key, adminKey)) return "admin";
  if (editKey && key && safeEqual(key, editKey)) return "edit";
  return "view";
}
// Trả 401 nếu request ghi không đủ quyền; xoá cần admin, còn lại cần edit
function denyIfNoRight(req, res, needAdmin) {
  var role = getRole(req);
  if (needAdmin && role !== "admin") {
    sendJson(res, 401, { ok: false, needKey: true, error: "Cần mật khẩu quản trị để xoá" });
    return true;
  }
  if (role !== "admin" && role !== "edit") {
    sendJson(res, 401, { ok: false, needKey: true, error: "Cần mật khẩu quyền sửa" });
    return true;
  }
  return false;
}

const server = http.createServer(function (req, res) {
  var rawUrl = req.url || "/";
  var qs = rawUrl.indexOf("?") >= 0 ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "";
  var query = {};
  qs.split("&").forEach(function (pair) {
    if (!pair) return;
    var kv = pair.split("=");
    query[decodeURIComponent(kv[0] || "")] = decodeURIComponent((kv[1] || "").replace(/\+/g, " "));
  });
  var url = decodeURIComponent(rawUrl.split("?")[0]);

  // ---- API file đính kèm (lưu vào thư mục data-files) ----
  // Giao thức giống bản Vercel (api/files.js): file nhỏ = 1 POST;
  // file lớn (≤50MB) = POST ?action=chunk từng mảnh rồi POST ?action=finish ghép lại.
  if (url === "/api/files") {
    // Tải xuống (GET) tự do; tải lên (POST) cần quyền sửa; xoá (DELETE) cần quản trị
    // dọn mảnh rời của lần tải hỏng chỉ cần quyền sửa — không đụng file hoàn chỉnh nào
    if ((req.method === "POST" || req.method === "DELETE") &&
        denyIfNoRight(req, res, req.method === "DELETE" && !query.chunks)) return;
    var readBody = function (limit, cb) {
      var chunks = [], size = 0, tooBig = false;
      req.on("data", function (c) { size += c.length; if (size > limit) { tooBig = true; req.destroy(); } else chunks.push(c); });
      req.on("end", function () { cb(tooBig, Buffer.concat(chunks)); });
    };
    var safeId = function (s) { return String(s || "").replace(/[^a-f0-9c]/gi, ""); };
    if (req.method === "GET") {
      var gid = safeId(query.id);
      if (!gid) return sendJson(res, 400, { ok: false, error: "Thiếu id" });
      var metaPath = path.join(filesDir, gid + ".json");
      var binPath = path.join(filesDir, gid);
      fs.readFile(metaPath, "utf8", function (mErr, mTxt) {
        if (mErr) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("Không tìm thấy file"); }
        var meta = {}; try { meta = JSON.parse(mTxt); } catch (e) {}
        var sendFile = function (buf) {
          var name = meta.name || "file";
          var asciiName = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
          res.writeHead(200, {
            "content-type": meta.type || "application/octet-stream",
            "content-length": buf.length,
            "content-disposition": "attachment; filename=\"" + asciiName + "\"; filename*=UTF-8''" + encodeURIComponent(name),
            "cache-control": "public, max-age=31536000, immutable"
          });
          res.end(buf);
        };
        // file chia mảnh + ?part=i → trả riêng mảnh đó
        if (Array.isArray(meta.chunks) && query.part != null) {
          var pi = Number(query.part);
          if (!(pi >= 0 && pi < meta.chunks.length)) return sendJson(res, 400, { ok: false, error: "part không hợp lệ" });
          fs.readFile(path.join(filesDir, safeId(meta.chunks[pi])), function (cErr, cBuf) {
            if (cErr) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("Mất mảnh file"); }
            res.writeHead(200, { "content-type": "application/octet-stream", "content-length": cBuf.length, "cache-control": "public, max-age=31536000, immutable" });
            res.end(cBuf);
          });
          return;
        }
        // file chia mảnh, tải cả cục → ghép tuần tự
        if (Array.isArray(meta.chunks)) {
          var parts = [], k = 0;
          (function next() {
            if (k >= meta.chunks.length) return sendFile(Buffer.concat(parts));
            fs.readFile(path.join(filesDir, safeId(meta.chunks[k])), function (cErr, cBuf) {
              if (cErr) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("Mất mảnh file"); }
              parts.push(cBuf); k++; next();
            });
          })();
          return;
        }
        fs.readFile(binPath, function (bErr, buf) {
          if (bErr) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("Không tìm thấy file"); }
          sendFile(buf);
        });
      });
      return;
    }
    if (req.method === "POST" && query.action === "chunk") {
      readBody(4.4 * 1024 * 1024 + 1024, function (tooBig, buf) {
        if (tooBig) return sendJson(res, 413, { ok: false, error: "Mảnh quá lớn" });
        if (!buf.length) return sendJson(res, 400, { ok: false, error: "Mảnh rỗng" });
        var cid = "c" + crypto.randomBytes(12).toString("hex");
        fs.writeFile(path.join(filesDir, cid), buf, function (err) {
          if (err) return sendJson(res, 500, { ok: false, error: String(err) });
          sendJson(res, 200, { ok: true, chunkId: cid });
        });
      });
      return;
    }
    if (req.method === "POST" && query.action === "finish") {
      var fname = query.name || "file";
      var ftype = query.type || "application/octet-stream";
      var ids = String(query.chunks || "").split(",").map(safeId).filter(Boolean);
      if (!ids.length) return sendJson(res, 400, { ok: false, error: "Thiếu danh sách mảnh" });
      var total = 0;
      for (var ci = 0; ci < ids.length; ci++) {
        try { total += fs.statSync(path.join(filesDir, ids[ci])).size; }
        catch (e) { return sendJson(res, 400, { ok: false, error: "Mất mảnh file — hãy tải lại" }); }
      }
      if (total > 50 * 1024 * 1024) {
        ids.forEach(function (cid) { try { fs.unlinkSync(path.join(filesDir, cid)); } catch (e) {} });
        return sendJson(res, 413, { ok: false, error: "File quá lớn (giới hạn 50MB)" });
      }
      var fid = crypto.randomBytes(12).toString("hex");
      fs.writeFile(path.join(filesDir, fid + ".json"), JSON.stringify({ name: fname, type: ftype, size: total, chunks: ids, createdAt: Date.now() }), "utf8", function (err) {
        if (err) return sendJson(res, 500, { ok: false, error: String(err) });
        sendJson(res, 200, { ok: true, file: { id: fid, name: fname, size: total, type: ftype, url: "api/files?id=" + fid, chunks: ids.length } });
      });
      return;
    }
    if (req.method === "POST") {
      var name = query.name || "file";
      var type = query.type || "application/octet-stream";
      readBody(50 * 1024 * 1024, function (tooBig, buf) {
        if (tooBig) return sendJson(res, 413, { ok: false, error: "File quá lớn" });
        if (!buf.length) return sendJson(res, 400, { ok: false, error: "File rỗng" });
        var id = crypto.randomBytes(12).toString("hex");
        fs.writeFile(path.join(filesDir, id), buf, function (err) {
          if (err) return sendJson(res, 500, { ok: false, error: String(err) });
          fs.writeFile(path.join(filesDir, id + ".json"), JSON.stringify({ name: name, type: type, size: buf.length, createdAt: Date.now() }), "utf8", function (err2) {
            if (err2) return sendJson(res, 500, { ok: false, error: String(err2) });
            sendJson(res, 200, { ok: true, file: { id: id, name: name, size: buf.length, type: type, url: "api/files?id=" + id } });
          });
        });
      });
      return;
    }
    // ---- Dọn các mảnh rời còn sót lại của một lần tải hỏng giữa chừng ----
    if (req.method === "DELETE" && query.chunks) {
      var loose = String(query.chunks).split(",").map(safeId).filter(Boolean);
      var gone = 0;
      loose.forEach(function (cid) {
        // chỉ xoá mảnh trần: file hoàn chỉnh luôn kèm một file .json meta bên cạnh
        if (fs.existsSync(path.join(filesDir, cid + ".json"))) return;
        try { fs.unlinkSync(path.join(filesDir, cid)); gone++; } catch (e) {}
      });
      return sendJson(res, 200, { ok: true, removed: gone });
    }
    if (req.method === "DELETE") {
      var did = safeId(query.id);
      if (did) {
        // file chia mảnh → xoá mọi mảnh ghi trong meta
        try {
          var mTxt = fs.readFileSync(path.join(filesDir, did + ".json"), "utf8");
          var meta = JSON.parse(mTxt);
          if (meta && Array.isArray(meta.chunks)) {
            meta.chunks.forEach(function (cid) { try { fs.unlinkSync(path.join(filesDir, safeId(cid))); } catch (e) {} });
          }
        } catch (e) {}
        try { fs.unlinkSync(path.join(filesDir, did)); } catch (e) {}
        try { fs.unlinkSync(path.join(filesDir, did + ".json")); } catch (e) {}
      }
      return sendJson(res, 200, { ok: true });
    }
    res.writeHead(405); return res.end("Method Not Allowed");
  }

  // ---- API dữ liệu — NHIỀU KẾ HOẠCH (data.json = { __plans: { id: {name,data,createdAt,updatedAt} } }) ----
  if (url === "/api/data") {
    // kiểm tra quyền của mật khẩu gửi kèm
    if (req.method === "GET" && query.whoami) {
      return sendJson(res, 200, { ok: true, role: getRole(req), protected: !!(editKey || adminKey) });
    }
    // Đọc (GET) tự do; ghi cần quyền sửa; xoá kế hoạch cần quản trị
    if ((req.method === "POST" || req.method === "DELETE") && denyIfNoRight(req, res, query.action === "delete")) return;
    var readStore = function (cb) {
      fs.readFile(dataFile, "utf8", function (err, txt) {
        var store = { __plans: {} };
        if (!err) {
          try {
            var parsed = JSON.parse(txt);
            if (parsed && parsed.__plans) store = parsed;
            else if (parsed && Array.isArray(parsed.rows)) {
              // nâng cấp data.json 1-bảng cũ thành kế hoạch "data"
              var mt = 0; try { mt = fs.statSync(dataFile).mtimeMs; } catch (e) {}
              store.__plans["data"] = { name: "Kế hoạch 1", data: parsed, createdAt: 0, updatedAt: mt || Date.now() };
            }
          } catch (e) {}
        }
        cb(store);
      });
    };
    var writeStore = function (store, cb) {
      var tmp = dataFile + ".tmp";                       // ghi an toàn: ghi tạm rồi đổi tên
      fs.writeFile(tmp, JSON.stringify(store), "utf8", function (err) {
        if (err) return cb(err);
        fs.rename(tmp, dataFile, cb);
      });
    };

    if (req.method === "GET" && query.list) {
      readStore(function (store) {
        var plans = Object.keys(store.__plans).map(function (id) {
          var p = store.__plans[id];
          return { id: id, name: p.name || "Kế hoạch 1", mtime: p.updatedAt || 0, createdAt: p.createdAt || 0 };
        });
        plans.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        sendJson(res, 200, { ok: true, plans: plans });
      });
      return;
    }

    if (req.method === "POST" && query.action === "create") {
      readStore(function (store) {
        var name = String(query.name || "Kế hoạch mới").trim().slice(0, 120) || "Kế hoạch mới";
        var id = "p" + crypto.randomBytes(8).toString("hex");
        var now = Date.now();
        store.__plans[id] = { name: name, data: null, createdAt: now, updatedAt: now };
        writeStore(store, function (err) {
          if (err) return sendJson(res, 500, { ok: false, error: String(err) });
          sendJson(res, 200, { ok: true, plan: { id: id, name: name, mtime: now } });
        });
      });
      return;
    }

    if (req.method === "POST" && query.action === "rename") {
      readStore(function (store) {
        var id = query.plan, name = String(query.name || "").trim().slice(0, 120);
        if (!id || !name || !store.__plans[id]) return sendJson(res, 400, { ok: false, error: "Thiếu plan hoặc name" });
        store.__plans[id].name = name;
        writeStore(store, function (err) {
          if (err) return sendJson(res, 500, { ok: false, error: String(err) });
          sendJson(res, 200, { ok: true });
        });
      });
      return;
    }

    if (req.method === "POST" && query.action === "delete") {
      readStore(function (store) {
        if (!query.plan) return sendJson(res, 400, { ok: false, error: "Thiếu plan" });
        delete store.__plans[query.plan];
        writeStore(store, function (err) {
          if (err) return sendJson(res, 500, { ok: false, error: String(err) });
          sendJson(res, 200, { ok: true });
        });
      });
      return;
    }

    var planId = query.plan || "data";

    if (req.method === "GET") {
      readStore(function (store) {
        var p = store.__plans[planId];
        if (!p) return sendJson(res, 200, { ok: true, mtime: 0, data: null, name: null });
        sendJson(res, 200, { ok: true, mtime: p.updatedAt || 0, data: p.data || null, name: p.name || null });
      });
      return;
    }

    if (req.method === "POST") {
      var chunks = [], size = 0, tooBig = false;
      req.on("data", function (c) { size += c.length; if (size > 25 * 1024 * 1024) { tooBig = true; req.destroy(); } else chunks.push(c); });
      req.on("end", function () {
        if (tooBig) return sendJson(res, 413, { ok: false, error: "Dữ liệu quá lớn" });
        var body = Buffer.concat(chunks).toString("utf8");
        var payload;
        try { payload = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: "JSON không hợp lệ" }); }
        readStore(function (store) {
          var now = Date.now();
          if (!store.__plans[planId]) store.__plans[planId] = { name: "Kế hoạch 1", data: null, createdAt: now, updatedAt: now };
          store.__plans[planId].data = payload;
          store.__plans[planId].updatedAt = now;
          writeStore(store, function (err) {
            if (err) return sendJson(res, 500, { ok: false, error: String(err) });
            sendJson(res, 200, { ok: true, mtime: now });
          });
        });
      });
      return;
    }
    res.writeHead(405); return res.end("Method Not Allowed");
  }

  // ---- tệp tĩnh ----
  if (url === "/") url = "/bang-hang-muc.html";
  var fp = path.normalize(path.join(root, url));
  if (fp.indexOf(root) !== 0) { res.writeHead(403); return res.end("Forbidden"); }  // chặn path traversal
  fs.readFile(fp, function (err, data) {
    if (err) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("Không tìm thấy: " + url); }
    res.writeHead(200, { "content-type": types[path.extname(fp).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
});

server.on("error", function (e) {
  if (e && e.code === "EADDRINUSE") { console.error("\n[LỖI] Cổng " + port + " đang bận. Đặt cổng khác: đóng cửa sổ, rồi chạy  set PORT=9000 && node serve.cjs\n"); }
  else { console.error(e); }
});

server.listen(port, host, function () {
  var ips = [];
  try {
    var nets = os.networkInterfaces();
    Object.keys(nets).forEach(function (k) { nets[k].forEach(function (n) { if (n.family === "IPv4" && !n.internal) ips.push(n.address); }); });
  } catch (e) {}
  console.log("=================================================");
  console.log("  BẢNG THEO DÕI HẠNG MỤC — máy chủ đã chạy");
  console.log("-------------------------------------------------");
  console.log("  Trên máy này :  http://localhost:" + port + "/");
  ips.forEach(function (ip) { console.log("  Máy cùng LAN :  http://" + ip + ":" + port + "/"); });
  console.log("  Dữ liệu chung:  " + dataFile);
  console.log("-------------------------------------------------");
  console.log("  Dừng máy chủ : đóng cửa sổ này (hoặc Ctrl+C)");
  console.log("=================================================");
});
