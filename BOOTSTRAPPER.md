# GN-Math bootstrapper

Same technique as the toothpaste bootstrapper: a ~19 KB static "door"
installs a meta service worker, which downloads a single gzipped pack of
the real GN-Math site, verifies it, unpacks it into Cache Storage, and
serves the app — including the whole Wisp/scramjet proxy stack — from the
cache. The payload pack is hosted separately (jsDelivr/GitHub or any
static host), so the door itself stays tiny.

## Layout

```
bootstrap/            deploy target — the door (~19 KB + optional pack)
  index.html          installer/decoy cover (registers the SW, shows logo)
  study.html          identical alternate entry
  static-worker.mjs   the META worker — the only worker file served (7.5 KB)
  boot-manifest.json  revision + pack hash + pack URL (136 B)
  assets/logo.png
  assets/*.pack       only in same-origin mode (6.9 MB — do not deploy
                      on the door if you want it small)
payload/              files to upload to the payload host
  assets/<hash>.pack  gzipped GNPACK1 archive of the full site
  boot-manifest.json
tools/package-bootstrap.mjs   builder
tools/meta-sw.js              meta worker source (edit this, then rebuild)
```

## Build

Run from the repo root (needs `index.html` + `static-worker.mjs` present —
the repo root IS the site, no app build step):

```bash
node tools/package-bootstrap.mjs
```

Outputs `bootstrap/`, `payload/`, and `gn-math-bootstrap.zip`.

### Remote payload (recommended deploy shape)

```bash
GN_PAYLOAD_URL=https://cdn.jsdelivr.net/gh/<org>/<repo>@<tag> \
node tools/package-bootstrap.mjs
```

Then upload `payload/` to that repo/tag and deploy `bootstrap/` minus
`bootstrap/assets/*.pack` — total door ≈ 19 KB. The installer and the meta
worker fetch `boot-manifest.json` + the pack from the payload host.

- `GN_PACK_URL` — override just the pack URL
- `GN_MANIFEST_URL` — extra manifest feed checked before the local one
  (SW-side updates: bumping it swaps the bundle on next activate)
- `GN_DEBUG=1` — bake debug mode (599 marker bodies, port/message
  logging broadcast to clients as `{__gnlog}`)

### Same-origin mode (local testing)

No env vars: the pack is copied into `bootstrap/assets/` and fetched
same-origin. Serve `bootstrap/` with any static server:

```bash
cd bootstrap && python -m http.server 8778
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

Pull the upstream repo, rebuild, re-upload `payload/`. The manifest
revision is a content hash — new pack → new bundle → next SW activate
swaps it. The door never changes unless `tools/meta-sw.js` or the
installer does.
