# Red Team Review — Assumption Destroyer

**Plan:** `plans/260903-1205-chuyen-file-sang-r2/` (move BIM attachments from MongoDB Binary to Cloudflare R2 presigned URLs)
**Reviewer perspective:** Assumption Destroyer (unstated dependencies, false "will work" claims, missing error paths, scale/integration assumptions)
**Tier:** Standard (Fact Checker + Contract Verifier)

---

## Finding 1: The presigned `response-content-disposition` signature is provably mismatched — every Vietnamese filename breaks download

- **Severity:** Critical
- **Location:** Phase 2, sections "Ký URL", "Quy tắc đặt key — chỉ ASCII", and `GET ?id=<id>` branch; plan.md acceptance criterion #2
- **Flaw:** The plan's entire filename-preservation strategy is "tên thật … gắn vào presigned GET qua `response-content-disposition`", implemented by `u.searchParams.set(k, extraQuery[k])` before `r2.sign(...)`. But `aws4fetch` builds the **canonical query string** with `encodeRfc3986(encodeURIComponent(value))` while the **wire URL** is produced by `URL.prototype.toString()`, which serializes via the `URLSearchParams` (`application/x-www-form-urlencoded`) rules. The two disagree on **space** (`%20` signed vs `+` sent) and on **`*`** (`%2A` signed vs `*` sent). A `Content-Disposition` header value contains both — a space after every `;` and the literal `*` in `filename*=UTF-8''`.
- **Failure scenario:** User uploads `Bản vẽ kiến trúc (P1).dwg`. `sign-upload` and the XHR PUT both succeed (they carry no `response-*` params). `confirm` writes metadata. The user then clicks the file. `GET /api/files?id=…` builds a presigned GET with `response-content-disposition`, returns 302. R2 recomputes the canonical query from the received bytes, gets a different string than the one signed, and returns **403 `SignatureDoesNotMatch`**. Result: *no new file can ever be downloaded*, while every other checkbox in Phases 1–3 passes. Phase 1 step 1.5 tests only `test/hello.txt` with no `response-*` params, so it cannot catch this. Phase 2's completion checkbox "`GET ?id=` file mới → 302, `curl -L` tải về đúng nội dung, đúng tên tiếng Việt" is the first place it surfaces — after `api/files.js` has already been fully rewritten.
- **Evidence:**
  - Signed form: `scratchpad/a4f/package/dist/aws4fetch.cjs.js:152` — `.map(pair => pair.map(p => encodeRfc3986(encodeURIComponent(p))))`; `aws4fetch.cjs.js:246-248` — `encodeRfc3986` replaces only `[!'()*]`, so space stays `%20` (from `encodeURIComponent`) and `*` becomes `%2A`.
  - Wire form: `aws4fetch.cjs.js:158-171` (`sign()` returns `this.url`) → `aws4fetch.cjs.js:78` `new Request(signed.url.toString(), signed)`.
  - Reproduced empirically (Node 22, exact `Content-Disposition` construction copied from `api/files.js:146-147`):
    ```
    WIRE  : response-content-disposition=attachment%3B+filename%3D%22B_n+v_+ki_n+tr_c+%28P1%29.dwg%22%3B+filename*%3DUTF-8%27%27B%25E1%25BA%25A3n%2520v%25E1%25BA%25BD…
    CANON : response-content-disposition=attachment%3B%20filename%3D%22B_n%20v_%20ki_n%20tr_c%20%28P1%29.dwg%22%3B%20filename%2A%3DUTF-8%27%27B%25E1%25BA%25A3n%2520v%25E1%25BA%25BD…
    MATCH?: false
    ```
  - Source of the `Content-Disposition` string the plan says to reuse: `api/files.js:146-147`.
- **Suggested fix:** Do not put `response-content-disposition` through `URLSearchParams`. Either (a) build the query string manually with RFC3986 encoding and hand `aws4fetch` a URL whose `search` is already canonical, or (b) drop `response-content-disposition` entirely and set `ContentDisposition` **on the object at PUT time** (sign the PUT with `x-amz-meta-*` / set it in `confirm` via a CopyObject), or (c) restrict the disposition value to `filename*=UTF-8''<pct-encoded>` only, with no spaces and no `*` — which is impossible for `filename*`. Add a Phase 1 curl test that presigns a GET **with a Vietnamese `response-content-disposition`**, not just `test/hello.txt`.

---

## Finding 2: The plan's central "zero client change" evidence silently deletes line 1387 — the `download` attribute

- **Severity:** Critical
- **Location:** plan.md, "Phát hiện then chốt rút ngắn phạm vi"; Phase 3 "Tổng quan" and "Giữ nguyên tuyệt đối"
- **Flaw:** plan.md quotes the render code as two consecutive lines:
  ```js
  a.href = f.url || f.dataUrl || "#";
  if (f.chunks) { a.setAttribute("data-chunks", ...); }
  ```
  The real code has **`a.setAttribute("download", f.name || "file");` between them**, at line 1387. The plan's scope reduction ("Phía tải xuống không sửa dòng nào", "Ngoài phạm vi: Luồng tải xuống ở client") rests on a quotation that omits the one attribute whose semantics change under a cross-origin redirect. There is no mention of `download` anywhere in any of the five plan files.
- **Failure scenario:** Chrome honors `download` at click time because `api/files?id=…` is same-origin, but once the 302 lands on `*.r2.cloudflarestorage.com` the resource is cross-origin and Blink discards the `download` attribute's suggested filename (Chrome 65+ cross-origin `<a download>` behaviour); Firefox and Safari likewise ignore it. The saved filename therefore comes **entirely** from R2's `Content-Disposition` — the exact header Finding 1 shows is unsigned-mismatched. If R2 returns no `Content-Disposition` at all (e.g. the implementer drops the param to work around Finding 1), the browser saves the file as `aabbccddeeff.dwg` — the random ASCII key from `makeKey()`, since the plan deliberately keeps the real name **out** of the key. Acceptance criteria plan.md #2 and Phase 4 test #2 ("đúng tên tiếng Việt có dấu") then fail with no client-side lever left, because the plan already declared the client download path out of scope.
- **Evidence:**
  - `bang-hang-muc.html:1386` — `a.href = f.url || f.dataUrl || "#";`
  - `bang-hang-muc.html:1387` — `a.setAttribute("download", f.name || "file");` ← **omitted from the plan's quote**
  - `bang-hang-muc.html:1389` — `if (f.chunks) { a.setAttribute("data-chunks", …) }`
  - Click interception confirmed narrow: `bang-hang-muc.html:2289-2299` — `if (flink && flink.getAttribute("data-chunks")) { e.preventDefault(); … downloadChunked(ff); }`. New R2 files carry no `chunks`, so no handler intercepts and no `preventDefault` fires — this half of the plan's claim **is** correct.
  - `f.url` format confirmed compatible: `api/files.js:186` and `:208` both emit `url: "api/files?id=" + newId`, matching the plan's `confirm` response.
- **Suggested fix:** State the dependency explicitly: the download filename is delivered by R2, not by the `download` attribute. Either remove the `download` attribute for R2-backed files (it is inert and misleading), or keep the download inside the app by proxying/streaming — and add "tên file khi lưu = tên trong `Content-Disposition` của R2" as an explicit Phase 2 acceptance test on a **real Vietnamese filename**, run before Phase 3 starts.

---

## Finding 3: `confirm` sends HEAD to a URL signed for GET — the HTTP method is inside the SigV4 canonical request

- **Severity:** High
- **Location:** Phase 2, `POST ?action=confirm&id=&key=&name=&type=` — "HEAD lên presigned GET của key → xác minh file có thật, lấy Content-Length"
- **Flaw:** SigV4 hashes the HTTP method as the first line of the canonical request. `aws4fetch` implements exactly that. A URL presigned with `method: "GET"` does not authorize a `HEAD` request; the recomputed signature differs. The plan asserts this works with no evidence, and its `signR2(key, method, expires, extraQuery)` helper already takes a `method` argument — the correct call is one word away.
- **Failure scenario:** Every upload completes the 200MB PUT successfully, then `confirm` issues HEAD, R2 answers **403 SignatureDoesNotMatch**, the plan's error path interprets any non-200 as "file not there" and returns `400 "Chưa thấy file trên kho lưu trữ"`. The user sees a message blaming the storage while the object is sitting in the bucket; the metadata is never written; every 200MB upload becomes a paid orphan. The error text actively misdirects debugging away from the signature. Phase 1 step 1.5 item 3 (`curl -I` on a presigned GET) is the only place this would be caught — and **it is not in Phase 1's "Tiêu chí hoàn thành" list**, whose only curl item is "CORS policy đã áp, `curl` PUT trả 200".
- **Evidence:**
  - `scratchpad/a4f/package/dist/aws4fetch.cjs.js:201-209` — `async canonicalString() { return [ this.method.toUpperCase(), this.encodedPath, this.encodedSearch, … ].join('\n') }`
  - Phase 1 completion checklist (`phase-01-ha-tang-r2.md:118-127`) contains no HEAD/GET verification item, so step 1.5.3 can be skipped without failing the phase gate.
- **Suggested fix:** Sign with `"HEAD"` (`signR2(doc.key, "HEAD", 60)`), and sign it **without** `response-content-*` params. Separately, distinguish 403 from 404 in the error path — "signature rejected" and "object missing" must not collapse to the same message. Promote the HEAD check into Phase 1's completion criteria.

---

## Finding 4: `retryUp` is claimed as "kept and still used" but the plan deletes both of its call sites and never calls it

- **Severity:** High
- **Location:** Phase 3, "Kiến trúc → Hàm mới thay `uploadChunked`", "Giữ nguyên tuyệt đối", and the risk row "Tải 200MB đứt giữa chừng phải làm lại"
- **Flaw:** Phase 3 states twice that `retryUp` survives and wraps sign/confirm: *"`retryUp` (vẫn dùng cho `sign-upload` và `confirm`)"* and *"`retryUp` chỉ bọc bước sign/confirm, không bọc PUT"*. The plan's own `uploadDirect` code sample calls plain `fetch(...).then(apiJson)` at both the sign step and the confirm step — `retryUp` appears nowhere in it. The prose and the code contradict each other, and the code is what gets implemented.
- **Failure scenario:** A 200MB upload finishes the PUT (the expensive part), then the `confirm` POST hits one transient blip — a Vercel cold-start 500, a Wi-Fi hiccup, an ISP reset. Without `retryUp`, the promise rejects immediately, `handleFilesSelected`'s `.catch` toasts an error, and the user must re-upload the whole 200MB. The object is already in R2 with no metadata → orphan, cleanable only by the manual script in Phase 4. The plan's risk table explicitly claims this is mitigated. Secondary effect: `retryUp` becomes unreferenced dead code that Phase 3's own grep-based completion criteria will not detect (they only grep for `uploadChunked|dropChunks|CHUNK_SIZE` and `downloadChunked`).
- **Evidence:**
  - Definition: `bang-hang-muc.html:1523-1528`. Self-recursion: `:1526`.
  - **Complete caller enumeration — 2 external call sites, both inside `uploadChunked`:** `bang-hang-muc.html:1543` (per-chunk POST) and `bang-hang-muc.html:1554` (the `finish` POST). `uploadChunked` spans `:1536-1563` and is deleted by Phase 3. After deletion: **0 callers.**
- **Suggested fix:** Wrap the sign and confirm fetches in `retryUp(fn, 3)` in the actual code sample, and make `confirm` idempotent server-side (`updateOne` with `upsert` keyed on `_id`, or tolerate E11000) so a retried confirm cannot fail on duplicate key.

---

## Finding 5: The LAN mode is declared out of scope, but the plan edits the *same* HTML file the LAN server serves — LAN uploads break

- **Severity:** High
- **Location:** plan.md "Ngoài phạm vi: `serve.cjs` / chế độ LAN (không còn dùng)"; Phase 3 "Không đụng: `api/*`, `serve.cjs`"; Phase 4 "CLAUDE.md → `serve.cjs` là code lỗi thời, không còn dùng"
- **Flaw:** There is exactly **one** `bang-hang-muc.html`, shared by the Vercel deployment and by `serve.cjs`. "Not touching `serve.cjs`" does not isolate LAN mode, because the *client* is what changes. `SERVER_MODE` is derived from the protocol, not from the backend, and `serve.cjs` implements `?whoami=1`, so the LAN client will successfully enter `storageMode = "server"` and then speak the new R2 protocol to a server that only understands the old one.
- **Failure scenario:** Anyone who runs `npm start` (still shipped and still documented) opens `http://192.168.x.x:8787`. `SERVER_MODE` is true, `whoami` succeeds, `storageMode` becomes `"server"`, `serverUp` is true. The user attaches a file. The client POSTs `api/files?action=sign-upload&…` with **no body**. `serve.cjs` matches neither `action === "chunk"` nor `action === "finish"`, falls through to the generic single-file POST branch, reads a zero-length body and answers `400 {ok:false, error:"File rỗng"}`. The user gets "Lỗi khi tải … File rỗng" — a message with no relationship to the actual cause. Nothing in Phase 3 or Phase 4's 13-item matrix tests LAN mode (test 13 covers only `file://`, which correctly falls back to `localStorage`).
- **Evidence:**
  - `bang-hang-muc.html:956` — `var SERVER_MODE = /^https?:$/.test(location.protocol);`
  - `bang-hang-muc.html:3302-3315` — `whoami` succeeds → `storageMode = "server"`.
  - `serve.cjs:220` — `if (req.method === "GET" && query.whoami) { … }` (so `whoami` **does** succeed on LAN).
  - `serve.cjs:77` `/api/files` router; `:137` `action === "chunk"`; `:149` `action === "finish"`; `:170` generic `if (req.method === "POST")`; `:175` `if (!buf.length) return sendJson(res, 400, {ok:false, error:"File rỗng"})`.
  - `bang-hang-muc.html:1592` — `var serverUp = SERVER_MODE && storageMode === "server";`
  - `package.json:8-10` still exposes `start` / `dev` / `serve` → `node serve.cjs`; `README.md:3-18` documents the LAN layout as current.
- **Suggested fix:** Pick one and write it down: (a) delete `serve.cjs`, `start`/`dev`/`serve` scripts and `start-server.bat` in Phase 4 so the broken path cannot be reached, or (b) add the three routes (`sign-upload` / `confirm` / R2 delete) to `serve.cjs`, or (c) make the client detect capability (e.g. `whoami` returns `storage: "r2" | "mongo"`) and keep the legacy upload path for `mongo`. "Out of scope" is not one of the options while `bang-hang-muc.html` is shared.

---

## Finding 6: Raising `MAX_UPLOAD` 4× stretches the `filesBusy` sync freeze, and `api/data.js` has no optimistic concurrency — silent lost updates for 30 users

- **Severity:** High
- **Location:** Phase 3, "Hằng số" (`MAX_UPLOAD = 200 * 1024 * 1024`) and "Nhiều file trong một lần chọn thì tải tuần tự"; plan.md acceptance criterion #1
- **Flaw:** `handleFilesSelected` sets `filesBusy = true` for the whole upload chain, and the poller refuses to sync while `filesBusy` is set. When the chain finishes it calls `save()`, which pushes the **entire** `{rows, people, statuses}` document; `api/data.js` writes it with an unconditional `$set` and no mtime/version guard. The plan quadruples the maximum duration of that freeze (50MB → 200MB) and explicitly chooses **sequential** multi-file upload, so selecting three 200MB models multiplies it again — with no mention of the consequence anywhere in the risk tables.
- **Failure scenario:** User A attaches a 200MB `.rvt`. On a typical Vietnamese office asymmetric link (~20 Mbps up) that is ~13 minutes; three files sequentially is ~40 minutes. Throughout, A's tab never polls, so A's `state.rows` is frozen at T0. Users B and C edit rows, add people, change statuses — all saved. When A's upload completes, `save()` → `pushToServer()` overwrites the plan document with A's 40-minute-old snapshot plus one new file entry. **Every edit B and C made is silently destroyed**, with no conflict, no error and no toast. The brainstorm sizes the deployment at 10–30 users, so this is not a corner case. The current 50MB/3.5MB-chunk path has the same defect but a 4× smaller window; the plan enlarges it without acknowledgement.
- **Evidence:**
  - `bang-hang-muc.html:1593` — `filesBusy = true;` … `:1630` — `filesBusy = false;` (set for the entire `files.forEach` chain)
  - `bang-hang-muc.html:1126` — `if (savePending || filesBusy || state.comboRowId || state.statusRowId) return;` (poller skipped)
  - `bang-hang-muc.html:1095-1097` — `pushToServer` sends `JSON.stringify({rows, people, statuses})` wholesale, with **no** `mtime` in the payload
  - `api/data.js:155-159` — `collection.updateOne({_id: planId}, {$set: {data: payload, updatedAt}, …}, {upsert: true})` — no `updatedAt` precondition, pure last-write-wins
  - Scale target: `docs/brainstorm-chuyen-file-sang-r2.md:52` — "Quy mô | 10–100GB, 10–30 người dùng"
- **Suggested fix:** Do not gate the whole chain on `filesBusy`. Since the PUT no longer goes through the app server, only the tiny `confirm`→`save()` window needs protection: keep polling alive during the R2 PUT and re-merge just the new file entry into fresh `state.rows` before `save()`. Alternatively add an `If-Match` style `mtime` precondition to `POST /api/data?plan=` and reject stale writes. This should be a Phase 3 requirement, not an unlisted risk.

---

## Finding 7: The XHR cannot suppress `Content-Type` — the plan's headline `SignatureDoesNotMatch` mitigation is not implementable

- **Severity:** Medium
- **Location:** Phase 2 "KHÔNG ký `Content-Type`"; Phase 3 `uploadDirect` (`// KHÔNG set Content-Type …`) and the risk row "Lỡ tay set `Content-Type` trên XHR → `SignatureDoesNotMatch` / Ghi comment cảnh báo ngay tại chỗ `xhr.open`"; plan.md global risk table ("Không ký và không gửi `Content-Type` khi PUT")
- **Flaw:** `XMLHttpRequest.send(blob)` sets `Content-Type` from `blob.type` automatically per the XHR spec, whenever the author has not set it. The plan's invariant ("client PUT **không gửi** header `Content-Type`") therefore cannot be honoured by *not writing a line* — and a code comment cannot prevent the browser from doing it. `proc.blob` is either the original `File` (browser-assigned type: `application/pdf`, `image/png`, …) or, after `maybeCompress`, a canvas blob explicitly typed `image/jpeg`.
- **Failure scenario:** The plan's stated global mitigation is false. It happens to be harmless in the chosen configuration — with `signQuery: true`, `X-Amz-SignedHeaders` covers only `host`, so an extra unsigned `Content-Type` is ignored by R2 — but the plan does not know that, and records the wrong reason for its own safety. Anyone who later switches to header-based signing, adds `allHeaders`, or tries to reproduce the "no Content-Type" invariant will chase a phantom. Practical consequence: every R2 object is stored with the browser's `Content-Type`, not `application/octet-stream`, which the plan's design assumes.
- **Evidence:**
  - `bang-hang-muc.html:1336-1338` — `maybeCompress` resolves `{ blob: blob, type: "image/jpeg", name: nm }` where `blob` is `canvas.toBlob(…, "image/jpeg", 0.82)` → `blob.type === "image/jpeg"`.
  - `bang-hang-muc.html:1324-1325` — non-image path returns the original `File` unchanged, so `blob.type` is whatever the OS assigned.
  - Why it is nonetheless harmless: `scratchpad/a4f/package/dist/aws4fetch.cjs.js:105-106` — `X-Amz-Content-Sha256` is only added when `!signQuery`; `:212` — with `signQuery` the payload hash is `UNSIGNED-PAYLOAD`; `:146-152` — only headers present on the Request enter `signedHeaders`, and `UNSIGNABLE_HEADERS` (`:146` region, `aws4fetch.cjs.js:22-32`) lists `content-type` as never signable anyway.
- **Suggested fix:** Replace the invariant with the true one: *"presigned URLs use `signQuery: true`, so only `host` is signed; any extra request header is ignored by R2."* Delete the risk row and the comment-based mitigation. If a deterministic stored `Content-Type` is actually wanted, send `Blob([proc.blob])` (empty type) or accept the browser's value and drop `response-content-type` from the GET.

---

## Finding 8: The Phase 4 MongoDB proof query compares a Number field against a date — it passes vacuously

- **Severity:** Medium
- **Location:** Phase 4, "Kiểm tra MongoDB sau khi test"; completion criterion "Truy vấn MongoDB xác nhận không có document `Binary` tạo mới"; plan.md acceptance criterion #6
- **Flaw:** The query is `db.bim_files.find({ data: {$exists: true}, createdAt: {$gt: <mốc bắt đầu test>} }).count()`. Every `createdAt` written by the current code is `Date.now()` — a BSON **Double/Int64**, not a `Date`. The natural way a tester supplies "mốc bắt đầu test" in `mongosh` is `ISODate(...)` or `new Date(...)`. MongoDB's canonical BSON type ordering places all numbers **before** all dates, so `{$gt: ISODate(…)}` matches **zero** numeric values regardless of what is in the collection.
- **Failure scenario:** A regression leaves an old `Binary` write path reachable (for example the bare `POST /api/files?name=&type=` branch is not actually deleted — Phase 2's "Gỡ bỏ" table lists `readRawBody`, `MAX_BYTES` and `Binary` but never names that branch explicitly). The tester runs the verification query, gets `0`, ticks the box, and ships. The single acceptance test that proves the whole migration achieved its stated purpose is unfalsifiable as written.
- **Evidence:**
  - `api/files.js:161` — `insertOne({ _id: chunkId, kind: "chunk", …, data: new Binary(buf), createdAt: Date.now() })`
  - `api/files.js:206` — `createdAt: Date.now()` in the whole-file insert (with `data: new Binary(buf)` at `:205`)
  - `api/files.js:181` — `createdAt: Date.now()` for the `finish` metadata doc
  - Phase 2's removal table (`phase-02-api-files.md`, "Gỡ bỏ") lists `action=chunk`, `action=finish`, `DELETE ?chunks=`, `readRawBody()`, `MAX_BYTES`, `Binary` — the anonymous `POST` upload branch at `api/files.js:190-210` is never named, and `MAX_FILE` (`api/files.js:27`, used only at `:175`) is not named either.
- **Suggested fix:** Use a numeric bound: `{ data: {$exists: true}, createdAt: {$gt: <ms epoch number>} }`, and verify by a positive control (confirm the query returns >0 when run against the pre-migration mark). Add the bare `POST` branch and `MAX_FILE` to the explicit removal list so the grep-style checks cover them.

---

## Finding 9: `scratch/` and `scripts/` are excluded from neither `.gitignore` nor `.vercelignore` — the plan's own secret-safety claim does not hold for them

- **Severity:** Medium
- **Location:** Phase 1 step 1.5 ("Viết script tạm `scratch/test-r2.mjs` (không commit)") and its risk row ("Lỡ commit `.env` → `.gitignore` đã chặn `.env*`"); Phase 4 "Script dọn file mồ côi → Tạo `scripts/don-file-mo-coi.mjs`"
- **Flaw:** Phase 1's non-functional requirement is "Khóa không được nằm trong bất kỳ file nào của repo", and its risk mitigation cites `.gitignore`. `.gitignore` blocks `node_modules/`, `.env*`, `data-files/`, `.vercel`, `.claude/settings.local.json` — **nothing named `scratch`**. `.vercelignore` excludes `serve.cjs`, `data.json`, `node_modules`, `.claude`, `data-files`, `.env*` — **nothing named `scratch` or `scripts`**. "không commit" and "chạy tay khi cần" are discipline, not enforcement.
- **Failure scenario:** (a) `scratch/test-r2.mjs` is written with the R2 keys pasted inline for the curl test (the fastest way to satisfy step 1.5), forgotten, and swept up by a `git add -A` — the plan's own guard ("kiểm tra `git status` trước mỗi commit") is the only barrier, and Phase 1's checklist only asks about `.env`. (b) Independently of any commit, both `scratch/` and `scripts/` are uploaded into the Vercel deployment on the next `npm run deploy`, so `scripts/don-file-mo-coi.mjs` — a script whose stated purpose is bulk-deleting R2 objects — ships inside the production function bundle.
- **Evidence:**
  - `.gitignore:1-15` — full contents; no `scratch`, no `scripts`.
  - `.vercelignore:1-19` — full contents; no `scratch`, no `scripts`.
  - `phase-01-ha-tang-r2.md:116` — "Tạm (không commit): `scratch/test-r2.mjs`"; `:135` — "Lỡ commit `.env` | `.gitignore` đã chặn `.env*`"
  - `phase-01-ha-tang-r2.md:118-127` — completion checklist verifies `.env` only.
- **Suggested fix:** Add `scratch/` to `.gitignore` and `scratch/`, `scripts/`, `plans/`, `docs/` to `.vercelignore` **as the first action of Phase 1**, before any key is created. Require the test script to read `process.env`, never literals.

---

## Finding 10: Acceptance criteria "no `accessKeyId` in any response" is guaranteed to fail — the presigned URL contains the Access Key ID by construction

- **Severity:** Medium
- **Location:** plan.md acceptance criterion #7 ("Khóa R2 không xuất hiện trong bất kỳ response nào gửi về client"); Phase 2 completion checkbox "`grep -i "R2_SECRET\|accessKeyId" api/files.js` → khóa chỉ đọc từ `process.env`, không lọt vào response"; Phase 4 test #11 ("**Không** có `R2_SECRET_ACCESS_KEY` hay `accessKeyId` trong bất kỳ response nào")
- **Flaw:** Every SigV4 query-signed URL embeds `X-Amz-Credential=<ACCESS_KEY_ID>/<date>/auto/s3/aws4_request`. The `sign-upload` response returns that URL to the browser, and the download 302's `Location` header does the same. So the Access Key ID **is** in responses, in the DevTools Network tab, and in browser history — unavoidably, by design. Only the *secret* stays server-side. As written, a diligent tester performing Phase 4 test #11 will find `accessKeyId` material and must either fail the gate or silently redefine it — and the plan calls test #11 one of "hai mục dễ bỏ sót nhất", i.e. the one it most wants performed literally.
- **Failure scenario:** Either the migration is blocked on an unsatisfiable criterion, or — worse — the tester learns to wave the criterion through, at which point the check that would actually catch a leaked `R2_SECRET_ACCESS_KEY` has lost its teeth. Compounding this: `api/files.js`'s catch-all returns `String(error && error.message || error)` straight to the client, so any thrown error whose message embeds a signed URL (a `new URL()` failure, an R2 error body echoed into a thrown message) exports the Access Key ID plus a live signature in a 500 body — and the plan does not change that handler.
- **Evidence:**
  - `scratchpad/a4f/package/dist/aws4fetch.cjs.js:126` — `params.set('X-Amz-Credential', this.accessKeyId + '/' + this.credentialString);` (executed whenever `signQuery` is set, `:121-127`)
  - `api/files.js:236-237` — `catch (error) { console.error(error); res.status(500).json({ ok: false, error: String(error && error.message || error) }); }` — unchanged by Phase 2, which lists only `getRole`/`safeEqual`/`connectMongo`/`docBuffer` as preserved.
- **Suggested fix:** Reword to "`R2_SECRET_ACCESS_KEY` never appears in any response; the Access Key ID appears only inside short-lived presigned URLs, which is expected." Add a real check: `grep -o 'X-Amz-Signature' ` on responses is fine, but assert `R2_SECRET_ACCESS_KEY` specifically. Sanitize the 500 handler to a generic message plus `console.error` before publishing presigned URLs.

---

### Verification Results

**Tier:** Standard (Fact Checker + Contract Verifier)
**Claims checked:** 34 · **VERIFIED:** 29 · **FAILED:** 4 · **UNVERIFIED:** 1

#### Fact Checker — line numbers and symbols cited by the plan

| # | Claim (plan location) | Result |
|---|---|---|
| 1 | `bang-hang-muc.html:1386` = `a.href = f.url \|\| f.dataUrl \|\| "#"` | VERIFIED (`bang-hang-muc.html:1386`) |
| 2 | plan.md quotes 1386 followed directly by the `f.chunks` line | **FAILED** — `bang-hang-muc.html:1387` (`a.setAttribute("download", …)`) sits between them and is omitted (see Finding 2) |
| 3 | `bang-hang-muc.html:1389` = `data-chunks` attribute | VERIFIED (`:1389`) |
| 4 | `bang-hang-muc.html:1297` = `MAX_UPLOAD` | VERIFIED (`:1297`, `50 * 1024 * 1024`) |
| 5 | `bang-hang-muc.html:1298` = `CHUNK_SIZE` | VERIFIED (`:1298`, `3.5 * 1024 * 1024`) |
| 6 | `bang-hang-muc.html:1531` = `dropChunks()` | VERIFIED (`:1531`) |
| 7 | `bang-hang-muc.html:1536` = `uploadChunked()` | VERIFIED (`:1536`) |
| 8 | `bang-hang-muc.html:1595` = `.uploading` class applied | VERIFIED (`:1595`, `if (cell) cell.classList.add("uploading")`) |
| 9 | `bang-hang-muc.html:2297` = call to `downloadChunked` | VERIFIED (`:2297`) |
| 10 | `bang-hang-muc.html:377-379` = `.files-cell.uploading` CSS block | VERIFIED (`:377`, `:378`, `:379` — exact three rules quoted) |
| 11 | `--accent-weak` exists at lines 66 and 74, light + dark | VERIFIED (`:66` `data-theme="light"`, `:74` `data-theme="dark"`) — note it is in fact defined 4×, also `:28` (base `:root`) and `:53` (`@media prefers-color-scheme: dark`); the plan's two citations are correct but incomplete |
| 12 | `--accent-soft` does not exist | VERIFIED (`grep -c 'accent-soft' bang-hang-muc.html` → `0`) |
| 13 | Upload/attachment region ≈ lines 1290–1660 | VERIFIED (`:1296` section header … `:1650` end of `removeFile`) |
| 14 | Data sanitizer filters on `(f.url \|\| f.dataUrl)` | VERIFIED (`bang-hang-muc.html:3072`) — new R2 objects carry `url: "api/files?id=…"` from `confirm` and survive |
| 15 | `confirm` returns `url: "api/files?id=" + id`, matching existing shape | VERIFIED (`api/files.js:186`, `api/files.js:208`) |
| 16 | `aws4fetch@1.0.20` exposes a `require` export for CommonJS | VERIFIED (`npm view aws4fetch exports` → `"require": {"default": "./dist/aws4fetch.cjs.js"}`, `"main": "dist/aws4fetch.cjs.js"`) |
| 17 | `package.json` `engines` pins Node `22.x` | VERIFIED (`package.json:26-28`) |
| 18 | Node 22 / aws4fetch relies on global `crypto.subtle` | VERIFIED (`aws4fetch.cjs.js:223,230,233` use bare `crypto.subtle`; global WebCrypto present in Node ≥19; no conflict with `const crypto = require("crypto")` at `api/files.js:16`, which is module-scoped to `api/files.js`) |
| 19 | Setting `X-Amz-Expires` on the URL before signing is honoured | VERIFIED (`aws4fetch.cjs.js:122-123` — default `86400` applied only `if (!params.has('X-Amz-Expires'))`) |
| 20 | "HEAD lên presigned GET" authorizes a HEAD request | **FAILED** — method is line 1 of the canonical request (`aws4fetch.cjs.js:201-209`); see Finding 3 |
| 21 | `Content-Disposition` "chỉ chuyển nó vào query của presigned URL" works | **FAILED** — signed vs. wire encodings diverge on space and `*`; reproduced (see Finding 1) |
| 22 | "Phía tải xuống không sửa dòng nào" (no click handler intercepts non-chunked links) | VERIFIED for interception (`bang-hang-muc.html:2289-2299` gates on `data-chunks`; no other `preventDefault` touches `.file-link`) — but see Findings 1 & 2 for why the claim still fails |
| 23 | `serve.cjs` / LAN mode is safely out of scope | **FAILED** — client change lands in the shared HTML; `serve.cjs:220` `whoami` + `bang-hang-muc.html:956` route LAN users into the new protocol (see Finding 5) |
| 24 | Phase 4 MongoDB proof query matches what the code writes | UNVERIFIED / type-mismatched — field name `data` and `createdAt` exist (`api/files.js:161,181,205-206`) but `createdAt` is a Number, so a date-valued `$gt` matches nothing (see Finding 8) |
| 25 | `.gitignore` protects the Phase 1 scratch script | **FAILED** — `.gitignore` has no `scratch` entry; `.vercelignore` has neither `scratch` nor `scripts` (see Finding 9) |

#### Contract Verifier — symbols the plan REMOVES (all call sites enumerated)

| Symbol | Call sites (file:line) | Plan accounts for all? |
|---|---|---|
| `uploadChunked` | def `bang-hang-muc.html:1536`; **1 caller** `:1608` | VERIFIED — `:1608` is inside the branch Phase 3 replaces |
| `dropChunks` | def `:1531`; **1 caller** `:1560` (inside `uploadChunked`) | VERIFIED |
| `CHUNK_SIZE` | def `:1298`; **3 uses** `:1537`, `:1542` (both in `uploadChunked`), `:1607` (the branch condition Phase 3 deletes) | VERIFIED |
| `readRawBody` | def `api/files.js:63`; **2 callers** `:154` (`action=chunk`), `:191` (bare `POST`) | VERIFIED — but Phase 2 never names the bare `POST` branch at `:190-210` in its removal table (see Finding 8) |
| `MAX_BYTES` | def `api/files.js:26`; **2 uses** `:68` (in `readRawBody`), `:197` | VERIFIED |
| `MAX_FILE` | def `api/files.js:27`; **1 use** `:175` (in `action=finish`) | **NOT LISTED** — becomes dead after `finish` is removed; add to the removal table |
| `action=chunk` | server `api/files.js:152-165`; client `bang-hang-muc.html:1544`; **also `serve.cjs:137`** | PARTIAL — `serve.cjs` deliberately untouched, which is the substance of Finding 5 |
| `action=finish` | server `api/files.js:168-187`; client `:1555`; **also `serve.cjs:149`** | PARTIAL — same as above |
| `DELETE ?chunks=` | server `api/files.js:89`, `:213-220`; client `:1533` (`dropChunks`); **also `serve.cjs:81`, `:188`** | PARTIAL — same as above |
| `Binary` | import `api/files.js:16`; **2 uses** `:161`, `:205` | VERIFIED |

#### Contract Verifier — symbols the plan KEEPS (dependency on deleted code?)

| Symbol | Definition | Depends on anything the plan deletes? |
|---|---|---|
| `downloadChunked` | `bang-hang-muc.html:1565-1583`, called at `:2297` | NO — uses only `f.url + "&part="`, `toast`, `Blob`, `URL.createObjectURL`. Safe. |
| `docBuffer` | `api/files.js:78-80`; used `:129`, `:137`, `:141` | NO — all three uses are in the GET branch the plan preserves. Safe. |
| `getRole` / `safeEqual` | `api/files.js:31-44`; `getRole` used `:87` | NO — depends only on `process.env` and node `crypto`. Safe. |
| `connectMongo` | `api/files.js:46-61`; used `:99` | NO. Safe. |
| `maybeCompress` | `bang-hang-muc.html:1323-1343`; used `:1602` | NO. Safe — but it is the source of the `image/jpeg` blob type in Finding 7. |
| `apiJson` | `:1515-1521`; used `:1545`, `:1557`, `:1611` — **all three deleted** | Safe **only because** the plan's `uploadDirect` calls it twice. If `uploadDirect` changes, `apiJson` orphans. |
| `retryUp` | `:1523-1528`; used `:1543`, `:1554` — **both deleted, 0 callers remain** | **FAILED** — the plan's replacement code never calls it, contradicting Phase 3's own text (see Finding 4). |

#### FAILED claims (numbered)

1. **plan.md, "Phát hiện then chốt rút ngắn phạm vi"** — the two-line code quote skips `bang-hang-muc.html:1387` (`a.setAttribute("download", f.name || "file")`). The omitted line is the one that changes semantics under a cross-origin 302.
2. **Phase 2, `confirm` branch** — "HEAD lên presigned GET của key" is not authorized: `aws4fetch.cjs.js:201-209` puts `this.method.toUpperCase()` in the canonical request.
3. **Phase 2, GET branch / plan.md global risk table** — moving `Content-Disposition` into the presigned query does not survive signing: `aws4fetch.cjs.js:152` signs `%20`/`%2A` while `URL.toString()` sends `+`/`*`. Reproduced.
4. **plan.md "Ngoài phạm vi" + Phase 3 "Không đụng: serve.cjs"** — LAN mode is not isolated; the shared `bang-hang-muc.html` drives `serve.cjs:170-175` into a `400 "File rỗng"` (`bang-hang-muc.html:956`, `:3315`, `serve.cjs:220`).
5. **Phase 3, "Giữ nguyên tuyệt đối: … `retryUp` (vẫn dùng cho `sign-upload` và `confirm`)"** — the plan's own `uploadDirect` sample never calls `retryUp`; both existing call sites (`:1543`, `:1554`) are deleted.
6. **Phase 1 risk table** — `.gitignore` does not cover `scratch/`, and `.vercelignore` covers neither `scratch/` nor `scripts/`.

*(Item 5 in the table above is the same defect as Finding 4; counted once in the 4-FAILED total for Fact Checker claims, with the Contract Verifier failure listed separately.)*
