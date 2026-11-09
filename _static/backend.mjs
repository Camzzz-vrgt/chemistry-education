import { createChromeEngine, ChromeSession, pickProfile } from '../_c/53a78ce891/r/chrome-transport.mjs';
import { WispClient } from '../_c/53a78ce891/r/wisp.mjs';
import '../_c/53a78ce891/r/wasm_exec.mjs';

const localFetch = self.fetch.bind(self);
const base = new URL(globalThis.gnStaticBase);
const gameRoute = /^\/(?:games\.html$|s\/|_game\/|gh\/|npm\/|wp\/)/;
const safeResponseHeaders = ['accept-ranges', 'cache-control', 'content-disposition', 'content-range', 'content-type', 'etag', 'expires', 'last-modified'];
let engine, session, tunnel, connecting, sourceOrigin;

async function startEngine() {
  const response = await localFetch(globalThis.gnStaticURL('/_c/53a78ce891/r/chrome-transport.wasm.gz'));
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
    const selected = globalThis.gnOpenWisp
      ? await globalThis.gnOpenWisp(endpoint => new WispClient(endpoint))
      : { client: new WispClient(globalThis.gnWispEndpoint), endpoint: globalThis.gnWispEndpoint };
    try {
      await selected.client.ready;
      session = new ChromeSession({ engine: loaded, wisp: selected.client, profile: pickProfile(navigator.userAgent, loaded.api.profiles()) });
      tunnel = selected.client;
      sourceOrigin = new URL(selected.endpoint).origin.replace(/^ws/, 'http');
      return { transport: session, sourceOrigin };
    } catch (error) {
      selected.client.close();
      throw error;
    }
  })().finally(() => { connecting = null; });
  return connecting;
}

function relativePath(url) {
  if (url?.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
  return '/' + url.pathname.slice(base.pathname.length);
}

export function routeStaticPosts(proxyPrefix, decode, route) {
  self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'POST' || request.mode === 'navigate') return;
    const url = new URL(request.url);
    if (url.origin !== base.origin || url.pathname.startsWith(proxyPrefix)) return;

    event.respondWith((async () => {
      const client = event.clientId && await self.clients.get(event.clientId);
      const source = client && new URL(client.url);
      const framePath = source?.origin === base.origin && source.pathname.startsWith(proxyPrefix)
        ? source.pathname.slice(proxyPrefix.length) : '';
      const [controller, frame, destination] = framePath.split('/');
      if (!destination || !/^[a-z0-9]+$/.test(controller) || !/^[a-z0-9]+$/.test(frame)) {
        return new Response('Static files support GET and HEAD.', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }

      try {
        const target = new URL(decode(destination));
        if (!['https:', 'http:'].includes(target.protocol)) throw new Error('Invalid proxy origin.');
        target.pathname = relativePath(url) ?? url.pathname;
        target.search = url.search;
        target.hash = '';
        const proxyURL = new URL(proxyPrefix + controller + '/' + frame + '/' + encodeURIComponent(target.href), base);
        return await route({
          clientId: event.clientId,
          request: {
            url: proxyURL.href,
            method: request.method,
            headers: request.headers,
            body: request.body,
            referrer: request.referrer,
            destination: request.destination,
            mode: request.mode,
            cache: request.cache
          }
        }, proxyURL);
      } catch {
        return new Response('Could not send this POST through Wisp.', { status: 502 });
      }
    })());
  });
}

function sourceURL(url, pathname, origin) {
  const target = new URL(origin);
  target.pathname = pathname;
  target.search = url.search;
  return target;
}

async function sendThroughWisp(request, url, pathname, referrer) {
  const { transport, sourceOrigin } = await getSession();
  let target = pathname ? sourceURL(url, pathname, sourceOrigin) : url;
  const headers = new Headers();
  for (const name of ['accept', 'range', 'if-range']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (referrer) headers.set('Referer', sourceURL(referrer, relativePath(referrer), sourceOrigin).href);
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
    let body = result.body;
    const type = responseHeaders.get('content-type') || '';
    if (body && base.pathname !== '/' && pathname && target.origin === sourceOrigin && result.status === 200 && /html|javascript|css/.test(type)) {
      body = (await result.text()).replace(/(["'\x60(])\/(?=(?:s\/|_game\/|_c\/|assets\/|(?:favicon|gn-mathtitle|refresh-icon|setting)\.png\b))/g, '$1' + base.pathname);
      responseHeaders.delete('etag');
    }
    return new Response(body, { status: result.status, statusText: result.statusText, headers: responseHeaders });
  }
  throw new Error('Too many redirects.');
}

globalThis.gnStaticBackend = function handleStaticBackend(event, url) {
  const request = event.request;
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  const referrer = request.referrer && request.referrer !== 'about:client' ? new URL(request.referrer) : null;
  const pathname = relativePath(url);
  if (request.mode === 'navigate' && ['/', '/index.html', '/music.html'].includes(pathname)) {
    event.respondWith((async () => {
      const response = await localFetch(request);
      if (!response.ok || response.headers.get('content-type')?.includes('text/html')) return response;
      const headers = new Headers(response.headers);
      headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(response.body, { status: response.status, headers });
    })());
    return true;
  }
  const fromGame = gameRoute.test(relativePath(referrer) || '');
  const game = gameRoute.test(pathname || '');
  const fallback = pathname && fromGame && !pathname.startsWith('/_');
  const musicArt = url.origin !== base.origin && request.destination === 'image' && /(?:^|\.)(?:ytimg\.com|ggpht\.com|googleusercontent\.com)$/.test(url.hostname);
  if (!game && !fallback && !musicArt) return false;

  event.respondWith((async () => {
    try {
      if (!game && fallback) {
        const response = await localFetch(request);
        if (response.status !== 404) return response;
        await response.body?.cancel();
      }
      return await sendThroughWisp(request, url, pathname, fromGame ? referrer : null);
    } catch (error) {
      return new Response('Could not load this resource through Wisp.\n' + error.message, {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
  })());
  return true;
};
