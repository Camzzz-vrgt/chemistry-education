import { createChromeEngine, ChromeSession, pickProfile } from '/_c/53a78ce891/r/chrome-transport.mjs';
import { WispClient } from '/_c/53a78ce891/r/wisp.mjs';
import '/_c/53a78ce891/r/wasm_exec.mjs';

const localFetch = self.fetch.bind(self);
const gameRoute = /^\/(?:games\.html$|s\/|_game\/|gh\/|npm\/|wp\/)/;
const safeResponseHeaders = ['accept-ranges', 'cache-control', 'content-disposition', 'content-range', 'content-type', 'etag', 'expires', 'last-modified'];
let engine, session, tunnel, connecting, sourceOrigin;

async function startEngine() {
  const response = await localFetch('/_c/53a78ce891/r/chrome-transport.wasm.gz');
  if (!response.ok || !response.body) throw new Error('The browser transport could not be loaded.');
  const wasm = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return createChromeEngine({ Go: globalThis.Go, wasm });
}

function getSession() {
  if (connecting) return connecting;
  if (session && !tunnel.closed) return Promise.resolve({ transport: session, sourceOrigin });
  connecting = (async () => {
    engine ||= startEngine().catch(error => { engine = null; throw error; });
    const loaded = await engine;
    session?.close();
    const { client, endpoint } = await globalThis.gnOpenWisp(url => new WispClient(url));
    try {
      session = new ChromeSession({ engine: loaded, wisp: client, profile: pickProfile(navigator.userAgent, loaded.api.profiles()) });
      tunnel = client;
      sourceOrigin = new URL(endpoint).origin.replace(/^ws/, 'http');
      return { transport: session, sourceOrigin };
    } catch (error) {
      client.close();
      throw error;
    }
  })().finally(() => { connecting = null; });
  return connecting;
}

function sourceURL(url, sourceOrigin) {
  const target = new URL(sourceOrigin);
  target.pathname = url.pathname;
  target.search = url.search;
  return target;
}

async function sendThroughWisp(request, url, referrer) {
  const { transport, sourceOrigin } = await getSession();
  let target = url.origin === self.location.origin ? sourceURL(url, sourceOrigin) : url;
  const headers = new Headers();
  for (const name of ['accept', 'range', 'if-range']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (referrer) headers.set('Referer', sourceURL(referrer, sourceOrigin).href);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120000)]);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const result = await transport.fetch(target.href, { method: request.method, headers, signal });
    const location = result.headers.get('location');
    if (location && [301, 302, 303, 307, 308].includes(result.status)) {
      await result.body?.cancel();
      target = new URL(location, target);
      if (!['https:', 'http:'].includes(target.protocol)) break;
      continue;
    }
    const responseHeaders = new Headers();
    for (const name of safeResponseHeaders) {
      const value = result.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(result.body, { status: result.status, statusText: result.statusText, headers: responseHeaders });
  }
  throw new Error('Too many redirects.');
}

globalThis.gnStaticBackend = function handleStaticBackend(event, url) {
  const request = event.request;
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  const referrer = request.referrer && request.referrer !== 'about:client' ? new URL(request.referrer) : null;
  const fromGame = referrer?.origin === self.location.origin && gameRoute.test(referrer.pathname);
  const local = url.origin === self.location.origin;
  const game = local && gameRoute.test(url.pathname);
  const fallback = local && fromGame && !url.pathname.startsWith('/_');
  const musicArt = !local && request.destination === 'image' && /(?:^|\.)(?:ytimg\.com|ggpht\.com|googleusercontent\.com)$/.test(url.hostname);
  if (!game && !fallback && !musicArt) return false;

  event.respondWith((async () => {
    try {
      if (!game && fallback) {
        const response = await localFetch(request);
        if (response.status !== 404) return response;
        await response.body?.cancel();
      }
      return await sendThroughWisp(request, url, fromGame ? referrer : null);
    } catch (error) {
      return new Response('Could not load this resource through Wisp.\n' + error.message, {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
  })());
  return true;
};
