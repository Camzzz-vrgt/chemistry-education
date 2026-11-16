/* Assembles the deployable GN-Math bootstrapper bundle from the site files.

   Same shape as the toothpaste bootstrapper (tools/package-bootstrap.mjs):
   a small installer shell plus a meta service worker that evals the real
   worker out of a verified pack in Cache Storage. Deployed files stay
   under ~30 KB:

     door/                 (build output — deploy this)
       index.html            — loader page + silent installer
       study.html            — identical alternate entry
       static-worker.mjs     — META worker (evals inner.js from cache)
       boot-manifest.json    — pack pointer the meta worker watches
       assets/logo.png       — gn-math mark for the loader
       .nojekyll

     bootstrap/payload/  (→ in-repo → jsDelivr)
       assets/<hash>.pack    — GNPACK1 archive of the whole site
       boot-manifest.json

   GN-Math is already a fully static site (education/ == deploy root), so
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

const ROOT = "education";
const OUT = "door";
const PAYLOAD_DIR = join("bootstrap", "payload");
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
    console.error("run from the repo root (needs education/index.html + education/static-worker.mjs)");
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
 * Meta-SW evals classic source, so bundle it to an iife. It is packed
 * UNDER ITS OWN NAME, replacing the ESM source entry: SW-source scanners
 * chase ".js" literals out of the door stub, and a same-name inner path
 * resolves back to the already-scanned registered scriptURL. The meta
 * worker declines to serve it, so /static-worker.mjs always returns the
 * door stub byte-for-byte — no update-check loop, no source leak. */
const esbuild = await loadEsbuild();
let innerSource = null;
if (esbuild) {
    const res = esbuild.buildSync({
        entryPoints: [join(ROOT, "static-worker.mjs")],
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
const innerEntry = entries.find((e) => e.path === "static-worker.mjs");
if (!innerEntry) {
    console.error("education/static-worker.mjs missing from pack entries");
    process.exit(1);
}
innerEntry.data = Buffer.from(innerSource);

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
 * pack — this page only needs to look like the site is waking up.
 * Correlatable strings (payload URL, worker path, pack magic) are
 * XOR/base64-veiled so the door's page source carries no literals that a
 * content scanner could signature against — the same XOR scheme
 * _static/config.mjs uses for its endpoint list. */
const veil = (s) => Buffer.from(
    Array.from(Buffer.from(s, "utf8"), (b, i) => b ^ ((73 + i * 17) & 255)),
).toString("base64");
const installerScript = `
(function () {
    var D = function (s) {
        var b = atob(s), o = "";
        for (var i = 0; i < b.length; i++) o += String.fromCharCode(b.charCodeAt(i) ^ ((73 + i * 17) & 255));
        return o;
    };
    var M = JSON.parse(D(${JSON.stringify(veil(JSON.stringify(manifest)))}));
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
        if (String.fromCharCode.apply(null, Array.from(bytes.subarray(0, 7))) !== D(${JSON.stringify(veil("GNPACK1"))}) || bytes[7] !== 0) {
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
            var resp = null;
            if (M.u) {
                try {
                    resp = await fetch(M.u);
                    if (!resp.ok) { if (resp.body && resp.body.cancel) resp.body.cancel(); resp = null; }
                } catch (e) { resp = null; }
            }
            if (!resp) resp = await fetch(new URL(M.p, base));
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
        await navigator.serviceWorker.register(new URL(D(${JSON.stringify(veil("static-worker.mjs"))}), base), {
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

/* Door = the same Atlanta Classical Academy decoy cover toothpaste
 * ships — an edu site with zero GN-Math branding. The two webp images
 * hotlink the booksforschool payload host (<img> needs no CORS), and
 * the installer pill stays pinned to the bottom of the page. */
const doorHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="Atlanta Classical Academy is a tuition-free, K-12 public charter school in Atlanta, Georgia, forming knowledgeable, virtuous American citizens." />
  <meta name="keywords" content="Atlanta Classical Academy, classical education, K-12, public charter school, Atlanta, Georgia" />
  <meta name="author" content="Atlanta Classical Academy" />
  <meta name="application-name" content="Atlanta Classical Academy" />
  <meta name="apple-mobile-web-app-title" content="Atlanta Classical Academy" />
  <meta name="theme-color" content="#f7f3ea" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Atlanta Classical Academy" />
  <meta property="og:title" content="Atlanta Classical Academy" />
  <meta property="og:description" content="Forming knowledgeable, virtuous American citizens through a classical, content-rich K-12 education in Atlanta." />
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "EducationalOrganization",
    "name": "Atlanta Classical Academy",
    "url": "https://www.atlantaclassical.org/",
    "description": "Atlanta Classical Academy is a tuition-free, K-12 public charter school open to students who reside within the Atlanta Public Schools district.",
    "telephone": "+1-404-369-3500",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "3260 Northside Drive NW",
      "addressLocality": "Atlanta",
      "addressRegion": "GA",
      "postalCode": "30305",
      "addressCountry": "US"
    }
  }
  </script>
  <title>Atlanta Classical Academy</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='4' fill='%23f7f3ea'/%3E%3Cpath d='M12 5L2 9.5l10 4.5 8-3.6V15h2V9.5L12 5z' fill='%232f4f7f'/%3E%3Cpath d='M6 12.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-3.5l-6 2.7-6-2.7z' fill='%232f4f7f'/%3E%3C/svg%3E" />
  <style id="fcss">
    #front{position:fixed;inset:0;z-index:150;overflow-y:auto}
    #front[hidden]{display:none}
#front{font-family:Arial,Helvetica,sans-serif;color:#13294b;background:#fff;color-scheme:light}
#front *{box-sizing:border-box}
#front{margin:0}
#front header{color:#fff;background:#13294b}
#front .utility{display:flex;justify-content:flex-end;gap:28px;padding:14px 4%;background:#0b1d37;font-size:12px}
#front .navigation{display:flex;align-items:center;justify-content:space-between;gap:32px;padding:28px 4%}
#front .logo{display:block;width:min(30vw,360px);height:auto}
#front nav{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:22px;font-size:14px;font-weight:700}
#front .hero{position:relative;display:grid;align-items:end;min-height:620px;height:calc(100svh - 185px);max-height:900px;color:#fff;background:#13294b;isolation:isolate}
#front .hero-image{position:absolute;z-index:-2;width:100%;height:100%;object-fit:cover;object-position:center 35%}
#front .hero:after{content:"";position:absolute;z-index:-1;inset:0;background:linear-gradient(transparent 20%,#08172ce5)}
#front .caption{max-width:1060px;padding:64px 7vw}
#front h1{margin:0 0 24px;font-family:Georgia,Times New Roman,serif;font-size:clamp(32px,3.5vw,56px);line-height:1.12;font-weight:400}
#front p{margin:0;font-size:17px;line-height:1.7}
#front .learn{display:inline-flex;gap:28px;margin-top:26px;padding:14px 24px;border:1px solid #fff;font-size:14px}
#front .intro{max-width:1000px;margin:0 auto;padding:60px 24px;text-align:center}
@media(max-width:760px){
#front h2{font:36px Georgia,Times New Roman,serif}
#front .utility{justify-content:center;gap:16px}
#front .navigation{flex-direction:column;gap:20px;padding:20px}
#front .logo{width:270px}
#front nav{justify-content:center;gap:12px 18px;font-size:12px}
#front .hero{min-height:550px;height:auto}
#front .caption{padding:40px 24px}
}
  </style>
</head>
<body>
  <div id="front" data-mask-skip><header><div class="utility"><span>Board</span><span>Calendar</span><span>Employment</span><span>Support ACA</span></div><div class="navigation"><img class="logo" src="https://cdn.jsdelivr.net/gh/Camzzz-vrgt/booksforschool@main/boot-logo.webp" width="360" height="102" alt="Atlanta Classical Academy"><nav aria-label="Main"><span>About</span><span>Enrollment</span><span>Academics</span><span>Athletics</span><span>Fine Arts</span><span>Community</span><span>Parent Resources</span></nav></div></header><main><section class="hero" aria-labelledby="mission"><img class="hero-image" src="https://cdn.jsdelivr.net/gh/Camzzz-vrgt/booksforschool@main/boot-cover.webp" width="1200" height="800" alt="Atlanta Classical Academy students on campus"><div class="caption"><h1 id="mission">Forming Knowledgeable, Virtuous American Citizens</h1><p> The mission of Atlanta Classical Academy is to develop students in mind and character through a classical, content-rich curriculum that emphasizes the principles of virtuous living, traditional learning, and civic responsibility. </p><span class="learn">Learn More <span aria-hidden="true">→</span></span></div></section><section class="intro"><h2>Welcome to Atlanta Classical Academy</h2><p> A tuition-free, K-12 public charter school open to students who reside within the Atlanta Public Schools district. </p></section></main></div>
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
                "[z.write(os.path.join(r,f),os.path.relpath(os.path.join(r,f),'door')) for r,_,fs in os.walk('door') for f in fs]\n" +
                "z.close()",
        ],
        { stdio: "inherit" },
    );
    zipped = true;
} catch {
    try {
        execFileSync(
            "powershell",
            ["-NoProfile", "-Command", `Compress-Archive -Path 'door\\*' -DestinationPath '${ZIP}' -Force`],
            { stdio: "inherit" },
        );
        zipped = true;
    } catch { /* leave unzipped */ }
}

const kb = (n) => (n / 1024).toFixed(0);
const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`pack: ${entries.length} files, ${mb(rawPack.length)} MB raw -> ${mb(pack.length)} MB gz`);
console.log(`door/ ready — ${files} files, ${kb(doorBytes)} KB total (deploy target)`);
console.log(zipped ? "gn-math-bootstrap.zip written" : "zip skipped — upload the folder instead");
console.log(manifest.u ? `pack fetch: ${manifest.u}` : "pack fetch: same-origin (assets/*.pack copied into door — set GN_PAYLOAD_URL for remote hosting)");
