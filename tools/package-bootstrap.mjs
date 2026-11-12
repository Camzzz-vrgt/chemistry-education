/* Assembles the deployable GN-Math bootstrapper bundle from the site files.

   Same shape as the toothpaste bootstrapper (tools/package-bootstrap.mjs):
   a small installer shell plus a meta service worker that evals the real
   worker out of a verified pack in Cache Storage. Deployed files stay
   under ~30 KB:

     bootstrap/
       index.html            — loader page + silent installer
       study.html            — identical alternate entry
       static-worker.mjs     — META worker (evals inner.js from cache)
       boot-manifest.json    — pack pointer the meta worker watches
       assets/logo.png       — gn-math mark for the loader
       .nojekyll

     payload/  (→ public repo → jsDelivr)
       assets/<hash>.pack    — GNPACK1 archive of the whole site
       boot-manifest.json

   GN-Math is already a fully static site (repo root == deploy root), so
   there is no build step — SRC walks the checkout itself. The real
   service worker is an ES module; it's esbuild-bundled to inner.js
   (classic iife) at pack time so the meta worker can eval it.

   Env:
     GN_PAYLOAD_URL   canonical payload root (e.g. a jsDelivr gh base) —
                      pack + manifest feed live there, leaving the door
                      at ~15 KB of html/js/png only.
     GN_PACK_URL      absolute URL the installer/meta-sw fetch the pack
                      from (overrides GN_PAYLOAD_URL for the pack only)
     GN_MANIFEST_URL  absolute manifest URL checked before the local one
*/

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { createRequire } from "node:module";

const ROOT = ".";
const OUT = "bootstrap";
const PAYLOAD_DIR = "payload";
const ZIP = "gn-math-bootstrap.zip";

/* Files that are repo/tooling only — never part of the deployed site. */
const EXCLUDE_DIRS = new Set([".git", ".tmp", "node_modules", "tools", "bootstrap", "payload"]);
const EXCLUDE_FILES = /^(?:\.|package\.json$|pnpm-lock|pnpm-workspace|.*\.zip$|BOOTSTRAPPER\.md$)/;

const PAYLOAD = (process.env.GN_PAYLOAD_URL || "").replace(/\/+$/, "");
const REMOTE_PACK = process.env.GN_PACK_URL || "";
const MANIFESTS = [
    ...(process.env.GN_MANIFEST_URL ? [process.env.GN_MANIFEST_URL] : []),
    ...(PAYLOAD ? [`${PAYLOAD}/boot-manifest.json`] : []),
    "boot-manifest.json",
];

/* esbuild — devDep here, or borrow the toothpaste install next door. */
async function loadEsbuild() {
    try {
        return await import("esbuild");
    } catch {
        for (const base of [join(import.meta.dirname, "..", "package.json"), "D:/toothpaste/package.json"]) {
            try {
                return createRequire(base)("esbuild");
            } catch { /* try next */ }
        }
    }
    return null;
}

if (!existsSync(join(ROOT, "index.html")) || !existsSync(join(ROOT, "static-worker.mjs"))) {
    console.error("run from the gn-math site root (needs index.html + static-worker.mjs)");
    process.exit(1);
}

// ---------- collect pack files ----------
/** @type {{path: string, data: Buffer}[]} */
const entries = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        if (dir === ROOT && (EXCLUDE_DIRS.has(name) || EXCLUDE_FILES.test(name))) continue;
        const abs = join(dir, name);
        const rel = relative(ROOT, abs).split(sep).join("/");
        if (statSync(abs).isDirectory()) {
            walk(abs);
        } else {
            entries.push({ path: rel, data: readFileSync(abs) });
        }
    }
})(ROOT);
entries.sort((a, b) => a.path.localeCompare(b.path));

// ---------- inner worker bundle ----------
/* static-worker.mjs is an ES module (import "./_static/config.mjs" etc).
 * Meta-SW evals classic source, so bundle it to an iife. Stored as
 * inner.js — never served for /static-worker.mjs, which keeps the door's
 * stub byte-stable across SW update checks. */
const esbuild = await loadEsbuild();
let innerSource = null;
if (esbuild) {
    const res = esbuild.buildSync({
        entryPoints: ["static-worker.mjs"],
        bundle: true,
        format: "iife",
        platform: "neutral",
        write: false,
        minify: false,
        logLevel: "silent",
    });
    innerSource = res.outputFiles[0].contents;
} else {
    console.error("esbuild unavailable — cannot bundle the inner worker");
    process.exit(1);
}
entries.push({ path: "inner.js", data: Buffer.from(innerSource) });
entries.sort((a, b) => a.path.localeCompare(b.path));

// ---------- serialize GNPACK1 ----------
const MAGIC = Buffer.from("GNPACK1\0");
const chunks = [MAGIC, Buffer.alloc(4)];
chunks[1].writeUInt32LE(entries.length, 0);
for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, "utf8");
    const lenHead = Buffer.alloc(4);
    lenHead.writeUInt32LE(pathBytes.length, 0);
    const dataHead = Buffer.alloc(4);
    dataHead.writeUInt32LE(entry.data.length, 0);
    chunks.push(lenHead, pathBytes, dataHead, entry.data);
}
const rawPack = Buffer.concat(chunks);
const pack = gzipSync(rawPack, { level: 9 });
const packSha = createHash("sha256").update(pack).digest("hex");
const packName = `assets/${packSha.slice(0, 12)}.pack`;
const revision = packSha.slice(12, 24);

// ---------- manifest ----------
const manifest = {
    p: packName,
    u: REMOTE_PACK || (PAYLOAD ? `${PAYLOAD}/${packName}` : ""),
    h: packSha,
    r: revision,
    n: entries.length,
};

// ---------- door page ----------
/* Minimal gn-math-branded loader. The heavy app shell stays inside the
 * pack — this page only needs to look like the site is waking up. */
const installerScript = `
(function () {
    var M = ${JSON.stringify(manifest)};
    var MIME = {
        ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
        ".ico": "image/x-icon", ".webp": "image/webp", ".ttf": "font/ttf",
        ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
        ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
        ".xml": "application/xml", ".pdf": "application/pdf", ".mp3": "audio/mpeg",
        ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm",
        ".map": "application/json", ".bin": "application/octet-stream",
        ".gz": "application/gzip", ".pack": "application/octet-stream"
    };
    var base = location.origin + location.pathname.replace(/[^/]*$/, "");
    var cacheName = "gn-bundle-" + M.r;
    var META = "gn-boot-v1";

    var statusEl = document.createElement("div");
    statusEl.setAttribute("style",
        "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483647;" +
        "background:rgba(20,22,34,.85);color:rgba(235,235,245,.92);border:1px solid rgba(255,255,255,.09);" +
        "border-radius:999px;padding:7px 16px;font:500 12px/1.4 system-ui,sans-serif;" +
        "letter-spacing:.02em;pointer-events:none;white-space:nowrap;");
    var setStatus = function (text) { statusEl.textContent = text; statusEl.style.opacity = text ? "1" : "0"; };
    document.body.appendChild(statusEl);
    setStatus("getting things ready\\u2026");

    function typeFor(path) {
        var dot = path.lastIndexOf(".");
        return MIME[dot < 0 ? "" : path.slice(dot).toLowerCase()] || "application/octet-stream";
    }
    async function unpack(raw) {
        var bytes = new Uint8Array(raw);
        var view = new DataView(raw);
        if (String.fromCharCode.apply(null, Array.from(bytes.subarray(0, 7))) !== "GNPACK1" || bytes[7] !== 0) {
            throw new Error("corrupt pack");
        }
        var offset = 8;
        var count = view.getUint32(offset, true); offset += 4;
        var dec = new TextDecoder();
        var records = [];
        for (var i = 0; i < count; i++) {
            var plen = view.getUint32(offset, true); offset += 4;
            var path = dec.decode(bytes.subarray(offset, offset + plen)); offset += plen;
            var dlen = view.getUint32(offset, true); offset += 4;
            records.push({ path: path, data: bytes.slice(offset, offset + dlen) });
            offset += dlen;
        }
        var cache = await caches.open(cacheName);
        for (var at = 0; at < records.length; at += 60) {
            await Promise.all(records.slice(at, at + 60).map(function (r) {
                return cache.put(base + r.path, new Response(r.data, {
                    headers: {
                        "Content-Type": typeFor(r.path),
                        "Cache-Control": "public, max-age=31536000, immutable"
                    }
                }));
            }));
            setStatus("unpacking " + Math.min(at + 60, count) + "/" + count + "\\u2026");
        }
        await cache.put(base + ".gn-ok", new Response("1"));
    }
    (async function () {
        var have = (await caches.keys()).indexOf(cacheName) >= 0 &&
            !!(await caches.open(cacheName).then(function (c) { return c.match(base + ".gn-ok"); }));
        if (!have) {
            setStatus("downloading\\u2026");
            var resp = await fetch(M.u || new URL(M.p, base));
            if (!resp.ok) throw new Error("pack fetch " + resp.status);
            var total = +resp.headers.get("content-length") || 0;
            var packed;
            if (resp.body && resp.body.getReader) {
                var reader = resp.body.getReader();
                var parts = [];
                var got = 0;
                for (;;) {
                    var chunk = await reader.read();
                    if (chunk.done) break;
                    parts.push(chunk.value);
                    got += chunk.value.length;
                    setStatus(total
                        ? "downloading " + Math.round((got / total) * 100) + "%\\u2026"
                        : "downloading " + (got / 1048576).toFixed(1) + " MB\\u2026");
                }
                packed = new Uint8Array(got);
                var at = 0;
                for (var pi = 0; pi < parts.length; pi++) { packed.set(parts[pi], at); at += parts[pi].length; }
                packed = packed.buffer;
            } else {
                packed = await resp.arrayBuffer();
            }
            setStatus("verifying\\u2026");
            var digest = await crypto.subtle.digest("SHA-256", packed);
            var hex = Array.prototype.map.call(new Uint8Array(digest), function (b) {
                return b.toString(16).padStart(2, "0");
            }).join("");
            if (hex !== M.h) throw new Error("pack hash mismatch");
            setStatus("unpacking\\u2026");
            var raw = await new Response(
                new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"))
            ).arrayBuffer();
            await unpack(raw);
        }
        setStatus("starting\\u2026");
        var meta = await caches.open(META);
        var prev = await meta.match(base + ".gn-active");
        var prevName = prev ? await prev.text() : null;
        if (prevName && prevName !== cacheName) {
            await meta.put(base + ".gn-previous", new Response(prevName));
        }
        await meta.put(base + ".gn-active", new Response(cacheName));
        await navigator.serviceWorker.register(new URL("static-worker.mjs", base), {
            scope: base.replace(location.origin, ""),
            updateViaCache: "none"
        });
        await navigator.serviceWorker.ready;
        location.reload();
    })().catch(function () {
        setStatus("couldn't finish \\u2014 refresh to retry");
        statusEl.style.color = "#ff9d9d";
    });
})();
`;

let installerFinal = installerScript;
try {
    installerFinal = `<script>${esbuild.transformSync(installerScript, { minify: true, target: "es2020" }).code}</script>`;
} catch { /* keep readable */ }

const doorHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GN-Math</title>
<link rel="icon" href="assets/logo.png">
<style>
html,body{height:100%;margin:0}
body{background:#0d1020;display:grid;place-items:center;
 background-image:radial-gradient(ellipse at 50% 30%,rgba(247,37,90,.08),transparent 60%),
 linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),
 linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);
 background-size:auto,36px 36px,36px 36px}
img{width:min(46vw,300px);image-rendering:pixelated;filter:drop-shadow(0 6px 24px rgba(247,37,90,.35))}
</style>
</head>
<body>
<img src="assets/logo.png" alt="">
${installerFinal}
</body>
</html>
`;

// ---------- emit ----------
rmSync(OUT, { recursive: true, force: true });
rmSync(PAYLOAD_DIR, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "assets"), { recursive: true });
mkdirSync(join(PAYLOAD_DIR, "assets"), { recursive: true });
writeFileSync(join(OUT, "index.html"), doorHtml);
writeFileSync(join(OUT, "study.html"), doorHtml);

// Meta worker: the only worker file a door hosts — minified like the rest.
const metaSrc = readFileSync(join(import.meta.dirname ?? "tools", "meta-sw.js"), "utf8")
    .replaceAll("__MANIFESTS__", JSON.stringify(MANIFESTS))
    .replaceAll("globalThis.GN_DEBUG", process.env.GN_DEBUG ? "true" : "false");
let swOut = metaSrc;
try {
    swOut = esbuild.transformSync(metaSrc, { minify: true, target: "es2020" }).code;
} catch { /* ship readable source */ }
writeFileSync(join(OUT, "static-worker.mjs"), swOut);
writeFileSync(join(OUT, "boot-manifest.json"), JSON.stringify(manifest));
writeFileSync(join(PAYLOAD_DIR, "boot-manifest.json"), JSON.stringify(manifest));

cpSync("gn-mathtitle.png", join(OUT, "assets", "logo.png"));

writeFileSync(join(PAYLOAD_DIR, packName), pack);
if (!PAYLOAD) cpSync(join(PAYLOAD_DIR, packName), join(OUT, packName)); // same-origin dev mode
writeFileSync(join(OUT, ".nojekyll"), "");

/* payload/ feeds a PUBLIC repo — assert only expected files exist so a
 * packer bug can't leak repo tooling into the payload. */
const PAYLOAD_ALLOWED = /^(boot-manifest\.json|assets\/[\w.-]+\.pack)$/;
(function assertPayloadClean(dir, prefix = "") {
    for (const name of readdirSync(dir)) {
        const rel = prefix ? `${prefix}/${name}` : name;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            assertPayloadClean(p, rel);
        } else if (!PAYLOAD_ALLOWED.test(rel)) {
            throw new Error(`unexpected file in payload/: ${rel} — refusing to pack for a public repo`);
        }
    }
})(PAYLOAD_DIR);

let files = 0;
let bytes = 0;
let doorBytes = 0;
(function walkOut(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkOut(p);
        else {
            files++;
            bytes += statSync(p).size;
            doorBytes += statSync(p).size;
        }
    }
})(OUT);

rmSync(ZIP, { force: true });
let zipped = false;
try {
    execFileSync(
        "python",
        [
            "-c",
            "import zipfile,os\n" +
                "z=zipfile.ZipFile('gn-math-bootstrap.zip','w',zipfile.ZIP_DEFLATED)\n" +
                "[z.write(os.path.join(r,f),os.path.relpath(os.path.join(r,f),'bootstrap')) for r,_,fs in os.walk('bootstrap') for f in fs]\n" +
                "z.close()",
        ],
        { stdio: "inherit" },
    );
    zipped = true;
} catch {
    try {
        execFileSync(
            "powershell",
            ["-NoProfile", "-Command", `Compress-Archive -Path 'bootstrap\\*' -DestinationPath '${ZIP}' -Force`],
            { stdio: "inherit" },
        );
        zipped = true;
    } catch { /* leave unzipped */ }
}

const kb = (n) => (n / 1024).toFixed(0);
const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`pack: ${entries.length} files, ${mb(rawPack.length)} MB raw -> ${mb(pack.length)} MB gz`);
console.log(`bootstrap/ ready — ${files} files, ${kb(doorBytes)} KB total (deploy target)`);
console.log(zipped ? "gn-math-bootstrap.zip written" : "zip skipped — upload the folder instead");
console.log(manifest.u ? `pack fetch: ${manifest.u}` : "pack fetch: same-origin (assets/*.pack copied into door — set GN_PAYLOAD_URL for remote hosting)");
