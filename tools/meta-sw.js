/* Meta worker — the only worker file a bootstrap deployment hosts.

   Adapted from the toothpaste bootstrapper for GN-Math. Differences:
   - Inner worker is an esbuild-iife bundle of the real module worker
     (static-worker.mjs + _static/*.mjs + _c runtime imports), stored in
     the pack as inner.js so /static-worker.mjs requests always hit the
     stub on the door host (no SW update-check loop).
   - The real worker only routes /_v/ proxy requests; it does not serve
     app files. After inner dispatch declines, we serve the request from
     the active bundle cache (ignoreSearch: app uses ?v= cache-busters).
   - Worker-side fetch() calls are NOT intercepted by a service worker's
     own fetch handler, so the inner worker gets a shimmed self.fetch
     that resolves same-origin URLs from the bundle cache first — that's
     how backend.mjs' localFetch reaches chrome-transport.wasm.gz.
   - Every pack-served response gets COEP/COOP/DIP headers injected —
     door hosts (GitHub Pages, S3) can't set headers and the app needs
     cross-origin isolation like the real gn-math.dev origin.

   Also watches the manifest feed: on activate, if the manifest names a
   newer revision than the active pointer, it downloads, verifies and
   unpacks the new pack itself and swaps the pointer — doors update without
   being redeployed. The manifest list is stamped by tools/package-bootstrap.mjs. */

const MANIFESTS = __MANIFESTS__;
const META_CACHE = "gn-boot-v1";
const BUNDLE_PREFIX = "gn-bundle-";
const ACTIVE_KEY = ".gn-active";
const PREV_KEY = ".gn-previous";
const INNER_PATH = "inner.js";

const scopeURL = self.location.href.slice(0, self.location.href.lastIndexOf("/") + 1);
const realAdd = self.addEventListener.bind(self);
const realFetch = self.fetch.bind(self);

/* ---------------- pointer ---------------- */

async function pointer(key) {
    const meta = await caches.open(META_CACHE);
    const res = await meta.match(scopeURL + key);
    return res ? res.text() : null;
}

async function bundleNames() {
    return (await caches.keys()).filter((n) => n.startsWith(BUNDLE_PREFIX)).sort();
}

/* ---------------- inner runtime ---------------- */

let innerBundle = null;
let innerListeners = null;

async function scriptMap(cache) {
    const map = new Map();
    for (const req of await cache.keys()) {
        const path = new URL(req.url).pathname;
        if (path.endsWith(".js")) {
            map.set(path, await (await cache.match(req)).text());
        }
    }
    return map;
}

function evalSource(src, name) {
    (0, eval)(src + "\n//# sourceURL=" + name);
}

/* Shared bundle lookup — static-server mapping: "/" and extensionless
 * paths resolve to their index.html, literals match directly, ?v=
 * cache-busters ignored. */
async function bundleMatch(cache, pathname) {
    const candidates = [pathname];
    if (pathname.endsWith("/")) {
        candidates.unshift(pathname + "index.html");
    } else if (!/\.[a-z0-9]+$/i.test(pathname)) {
        candidates.push(pathname + "/index.html", pathname + "index.html");
    }
    for (const p of candidates) {
        const hit = await cache.match(new URL(p, scopeURL).href, { ignoreSearch: true });
        if (hit) return hit;
    }
    return null;
}

/* Fetch the inner worker sees: same-origin paths resolve from the bundle
 * cache first (a worker's own fetch bypasses its own fetch handler), then
 * everything else falls through to the network. Responses carry the same
 * isolation headers the real origin sends — backend.mjs returns
 * localFetch() output straight to the page for navigations. */
function makeInnerFetch(bundleName) {
    return async (input, options) => {
        const url = new URL(input instanceof Request ? input.url : String(input), scopeURL);
        if (url.origin === new URL(scopeURL).origin && url.href.startsWith(scopeURL)) {
            const cache = await caches.open(bundleName);
            const hit = await bundleMatch(cache, url.pathname);
            if (hit) return frameHeaders(hit);
        }
        return realFetch(input, options);
    };
}

/* Replace global hooks while inner code runs. Everything else (clients,
 * caches, registration, location, indexedDB) stays real. */
function installGlobals(map, listeners, bundleName) {
    const fakeAdd = (type, fn) => {
        const list = listeners.get(type) || [];
        list.push(fn);
        listeners.set(type, list);
    };
    const fakeImportScripts = (...urls) => {
        for (const u of urls) {
            const path = new URL(u, scopeURL).pathname;
            const src = map.get(path);
            if (src === undefined) throw new Error("importScripts miss: " + path);
            evalSource(src, path.split("/").pop());
        }
    };
    Object.defineProperty(self, "addEventListener", { value: fakeAdd, configurable: true });
    Object.defineProperty(self, "removeEventListener", { value: () => {}, configurable: true });
    Object.defineProperty(self, "importScripts", { value: fakeImportScripts, configurable: true });
    Object.defineProperty(self, "fetch", { value: makeInnerFetch(bundleName), configurable: true });
    for (const t of ["fetch", "message", "install", "activate", "push", "sync", "notificationclick"]) {
        Object.defineProperty(self, "on" + t, {
            set: (fn) => fakeAdd(t, fn),
            get: () => undefined,
            configurable: true,
        });
    }
}

async function loadInner(name) {
    const cache = await caches.open(name);
    const entry = await cache.match(scopeURL + INNER_PATH);
    if (!entry) throw new Error("bundle missing worker");
    const src = await entry.text();
    const map = await scriptMap(cache);
    const listeners = new Map();
    installGlobals(map, listeners, name);
    evalSource(src, INNER_PATH);
    innerBundle = name;
    innerListeners = listeners;
}

async function ensureInner() {
    if (innerListeners) return innerListeners;
    const name = await pointer(ACTIVE_KEY);
    if (!name) return null;
    try {
        await loadInner(name);
    } catch {
        // A bad build rolls back to the previous pointer once — after that
        // we pass requests through to the network so the door page survives.
        const prev = await pointer(PREV_KEY);
        if (prev && prev !== name) {
            const meta = await caches.open(META_CACHE);
            await meta.put(scopeURL + ACTIVE_KEY, new Response(prev));
            await loadInner(prev);
        } else {
            return null;
        }
    }
    return innerListeners;
}

/* Dispatch one captured listener with a duck-typed event. */
async function dispatch(listeners, type, makeEvent) {
    const fns = listeners.get(type);
    if (!fns) return undefined;
    let result;
    const pendings = [];
    let stopped = false;
    for (const fn of fns) {
        if (stopped) break;
        const event = makeEvent((p) => pendings.push(Promise.resolve(p)), (r) => {
            result = r;
        });
        if (event && typeof event === "object") {
            event.stopImmediatePropagation = () => { stopped = true; };
            if (!event.stopPropagation) event.stopPropagation = () => {};
            if (!event.preventDefault) event.preventDefault = () => {};
        }
        await fn(event);
    }
    await Promise.all(pendings);
    return result;
}

/* ---------------- pack serving ---------------- */

/* Mirror the real origin's headers — gn-math.dev sends COEP require-corp
 * + COOP same-origin on EVERY response (no DIP). Doors can't set headers,
 * and in static mode the inner worker STRIPS these from its own
 * responses, so the worker stamps them back onto everything it returns
 * for this scope. */
function frameHeaders(response) {
    const headers = new Headers(response.headers);
    headers.delete("Document-Isolation-Policy");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function packFetch(request) {
    const name = innerBundle || (await pointer(ACTIVE_KEY));
    if (!name) return null;
    const url = new URL(request.url);
    if (!url.href.startsWith(scopeURL)) return null;
    const cache = await caches.open(name);
    const hit = await bundleMatch(cache, url.pathname);
    return hit ? frameHeaders(hit) : null;
}

/* ---------------- update check ---------------- */

const MIME = {
    ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
    ".ico": "image/x-icon", ".webp": "image/webp", ".ttf": "font/ttf",
    ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
    ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
    ".webm": "video/webm", ".map": "application/json", ".bin": "application/octet-stream",
    ".gz": "application/gzip", ".pack": "application/octet-stream",
};
const mime = (p) => MIME[p.slice(p.lastIndexOf(".")).toLowerCase()] || "application/octet-stream";

async function sha256hex(buf) {
    const d = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function unpackInto(raw, cacheName) {
    const bytes = new Uint8Array(raw);
    const view = new DataView(raw);
    if (String.fromCharCode.apply(null, Array.from(bytes.subarray(0, 7))) !== "GNPACK1" || bytes[7] !== 0) {
        throw new Error("corrupt pack");
    }
    let offset = 8;
    const count = view.getUint32(offset, true); offset += 4;
    const dec = new TextDecoder();
    const cache = await caches.open(cacheName);
    for (let i = 0; i < count; i++) {
        const plen = view.getUint32(offset, true); offset += 4;
        const path = dec.decode(bytes.subarray(offset, offset + plen)); offset += plen;
        const dlen = view.getUint32(offset, true); offset += 4;
        const data = bytes.slice(offset, offset + dlen); offset += dlen;
        await cache.put(scopeURL + path, new Response(data, {
            headers: { "Content-Type": mime(path), "Cache-Control": "public, max-age=31536000, immutable" },
        }));
    }
    await cache.put(scopeURL + ".gn-ok", new Response("1"));
}

async function checkUpdate() {
    let manifest = null;
    for (const url of MANIFESTS) {
        try {
            const res = await realFetch(new URL(url, scopeURL).href, { cache: "no-store" });
            if (res.ok) { manifest = await res.json(); break; }
        } catch { /* try next */ }
    }
    if (!manifest || !manifest.r || !manifest.h) return;
    const active = await pointer(ACTIVE_KEY);
    if (active === BUNDLE_PREFIX + manifest.r) return;
    const res = await realFetch(manifest.u || new URL(manifest.p, scopeURL).href);
    if (!res.ok) return;
    const packed = await res.arrayBuffer();
    if ((await sha256hex(packed)) !== manifest.h) return;
    const raw = await new Response(
        new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
    const name = BUNDLE_PREFIX + manifest.r;
    await unpackInto(raw, name);
    const meta = await caches.open(META_CACHE);
    if (active) await meta.put(scopeURL + PREV_KEY, new Response(active));
    await meta.put(scopeURL + ACTIVE_KEY, new Response(name));
    // Next navigation picks the new build up; drop the stale runtime.
    innerBundle = null;
    innerListeners = null;
    const keep = new Set([name, await pointer(PREV_KEY), META_CACHE]);
    for (const key of await caches.keys()) {
        if (key.startsWith(BUNDLE_PREFIX) && !keep.has(key)) await caches.delete(key);
    }
}

/* ---------------- real event wiring ---------------- */

realAdd("install", (event) => {
    event.waitUntil((async () => {
        const l = await ensureInner().catch(() => null);
        if (l) await dispatch(l, "install", (waitUntil) => ({ waitUntil }));
        await self.skipWaiting();
    })());
});

realAdd("activate", (event) => {
    event.waitUntil((async () => {
        const l = await ensureInner().catch(() => null);
        if (l) await dispatch(l, "activate", (waitUntil) => ({ waitUntil }));
        await checkUpdate().catch(() => {});
        await self.clients.claim();
    })());
});

realAdd("fetch", (event) => {
    event.respondWith((async () => {
        try {
            const l = await ensureInner().catch((e) => { globalThis.__gnErr = String(e && e.stack || e); return null; });
            if (l) {
                let answered = false;
                const res = await dispatch(l, "fetch", (waitUntil, respond) => ({
                    request: event.request,
                    clientId: event.clientId,
                    resultingClientId: event.resultingClientId,
                    preloadResponse: event.preloadResponse,
                    replacesClientId: event.replacesClientId,
                    handled: event.handled,
                    waitUntil,
                    respondWith: (r) => {
                        if (!answered) {
                            answered = true;
                            respond(Promise.resolve(r));
                        }
                    },
                }));
                if (res) {
                    const resolved = globalThis.GN_DEBUG
                        ? await Promise.resolve(res).catch((e) => new Response(
                            "GNDBG inner rejected " + String(e && e.stack || e),
                            { status: 599, headers: { "content-type": "text/plain" } },
                        ))
                        : await res;
                    /* The inner worker strips isolation headers in static
                     * mode — the real origin re-adds them at the HTTP
                     * layer, so we do it here for same-scope responses. */
                    return new URL(event.request.url).href.startsWith(scopeURL)
                        ? frameHeaders(resolved) : resolved;
                }
            }
            // Inner declined — serve app files out of the verified bundle.
            const packed = await packFetch(event.request);
            if (packed) return packed;
            if (globalThis.GN_DEBUG) {
                return new Response("GNDBG packFetch null " + JSON.stringify({
                    url: event.request.url, scope: scopeURL,
                    inner: innerBundle, err: globalThis.__gnErr || null,
                    active: await pointer(ACTIVE_KEY).catch(() => "ERR"),
                }), { status: 599, headers: { "content-type": "text/plain" } });
            }
            return realFetch(event.request);
        } catch (err) {
            return new Response("GNDBG threw " + String(err && err.stack || err), { status: 599, headers: { "content-type": "text/plain" } });
        }
    })());
});

async function gnLog(entry) {
    try {
        const wins = await self.clients.matchAll({ type: "window" });
        for (const c of wins) c.postMessage({ __gnlog: entry });
    } catch { }
}

realAdd("message", (event) => {
    event.waitUntil((async () => {
        const dbg = globalThis.GN_DEBUG;
        if (dbg) await gnLog("msg keys:" + JSON.stringify(event.data && typeof event.data === "object" ? Object.keys(event.data) : event.data) + " ports:" + (event.ports ? event.ports.length : -1));
        const l = await ensureInner().catch((e) => { if (dbg) gnLog("msg-inner-err:" + e); return null; });
        if (!l) { if (dbg) await gnLog("NO-LISTENERS"); return; }
        if (dbg) await gnLog("listeners:" + [...l.keys()].join(","));
        const ports = event.ports ? [...event.ports] : event.ports;
        if (dbg && ports) for (const [pi, port] of ports.entries()) {
            const orig = port.postMessage.bind(port);
            port.postMessage = (m, x) => { gnLog("port" + pi + "->page " + JSON.stringify(m).slice(0, 200)); return orig(m, x); };
            port.addEventListener?.("message", (me) => gnLog("port" + pi + "<-page " + JSON.stringify(me.data).slice(0, 200)));
            port.start?.();
        }
        try {
            const r = await dispatch(l, "message", (waitUntil) => ({
                data: event.data,
                source: event.source,
                ports,
                waitUntil,
            }));
            if (dbg) await gnLog("dispatched r=" + JSON.stringify(r));
        } catch (e) {
            if (dbg) await gnLog("dispatch-err:" + String(e && e.stack || e).slice(0, 300));
        }
    })());
});
