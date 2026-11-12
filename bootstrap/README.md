# bootstrap/

The GN-Math bootstrapper — same technique as the toothpaste bootstrapper.
A ~20 KB static "door" installs a meta service worker, which downloads a
single gzipped pack of the real site (`education/`), verifies it, unpacks
it into Cache Storage, and serves the app — including the whole
Wisp/scramjet proxy stack — from the cache. The payload pack is hosted
from this repo via jsDelivr, so the door itself stays tiny.

## Repo layout

```
education/              the GN-Math site source (deploy root — untouched)
bootstrap/              this folder — the bootstrapper
  tools/package-bootstrap.mjs   builder
  tools/meta-sw.js              meta worker source (edit, then rebuild)
  payload/                      hosted payload (jsDelivr serves it)
    assets/<hash>.pack          gzipped GNPACK1 archive of the site
    boot-manifest.json
door/                   build output — the thing you deploy (gitignored)
gn-math-bootstrap.zip   zipped door (gitignored)
```

## Build

Run from the repo root:

```bash
node bootstrap/tools/package-bootstrap.mjs
```

Outputs `door/`, `bootstrap/payload/`, and `gn-math-bootstrap.zip`.

### Remote payload (the deploy shape)

```bash
GN_PAYLOAD_URL=https://cdn.jsdelivr.net/gh/Camzzz-vrgt/chemistry-education@main/bootstrap/payload \
node bootstrap/tools/package-bootstrap.mjs
```

Then push `bootstrap/payload/` and deploy `door/` — ≈20 KB of html/js/png.
The installer and the meta worker fetch `boot-manifest.json` + the pack
from jsDelivr.

- `GN_PACK_URL` — override just the pack URL
- `GN_MANIFEST_URL` — extra manifest feed checked before the local one
  (SW-side updates: bumping it swaps the bundle on next activate)
- `GN_DEBUG=1` — bake debug mode (599 marker bodies, port/message
  logging broadcast to clients as `{__gnlog}`)

### Same-origin mode (local testing)

No env vars: the pack is copied into `door/assets/` and fetched
same-origin. Serve `door/` with any static server:

```bash
cd door && python -m http.server 8778
```

## How it works

- `index.html` (the door) fetches the manifest, downloads the pack,
  SHA-256-verifies and unpacks it into a `gn-bundle-<rev>` cache, writes
  an active-pointer into `gn-boot-v1`, then registers
  `static-worker.mjs` and reloads.
- The meta worker evals `inner.js` — an esbuild iife bundle of the real
  `static-worker.mjs` + `_static/*.mjs` + `_c` runtime — with shimmed
  `addEventListener`/`importScripts`/`fetch`/`on*` hooks, so the real
  worker code runs unchanged inside it.
- Every fetch first goes to the inner listeners (proxy routing,
  `gnStaticBackend`, `routeStaticPosts`). If the inner worker declines,
  same-scope paths fall back to the bundle cache (`/` → `/index.html`).
- `self.fetch` inside the inner worker resolves same-scope paths from
  the bundle first (that's how `backend.mjs`'s `localFetch` loads
  `chrome-transport.wasm.gz`); everything else hits the network.
- Isolation headers: gn-math.dev sends `Cross-Origin-Embedder-Policy:
  require-corp` + `Cross-Origin-Opener-Policy: same-origin` on every
  response, and in static mode the real worker *strips* these from its
  own responses (the origin re-adds them at the HTTP layer). Doors can't
  set headers, so the meta worker stamps them back onto every same-scope
  response it returns — without this the proxied iframes get
  `ERR_BLOCKED_BY_RESPONSE`.
- `gnProxyBridge` survives evaluation: message events dispatch through
  with real `ports`/`source`/`waitUntil`, so the tab↔SW transport RPC
  (`$controller$init`, `gnProxyBridgeProbe`, `$sw$initRemoteTransport`,
  `gnStaticPost`) works unchanged.

## Verified

Playwright-driven on `127.0.0.1:8778`, clean (non-debug) build:

- Door installs SW, app boots fully from the pack (all files `200 SW`)
- Browser app → search → `https://example.com` loads through
  Wisp → scramjet → iframe renders real page content
- Bridge handshake round-trips (`ready` RPC, `{ready:true}` probe)

## Updating GN-Math

Pull the upstream repo into `education/`, rebuild, push — jsDelivr picks
up the new `bootstrap/payload/`. The manifest revision is a content hash:
new pack → new bundle → next SW activate swaps it. The door never
changes unless `tools/meta-sw.js` or the installer does.
