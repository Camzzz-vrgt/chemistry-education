/*
 * Keyword mask runtime.
 *
 * Two render-safe encodings keep suspicious words off the wire and out of the DOM:
 *
 *  - DOM text: blocked terms are rewritten to this build's plane-15 Private
 *    Use Area aliases (U+F0000-FFFFD, surrogate pairs). The "Glyphs" font
 *    (unicode-range U+F0000-FFFFD, prepended to every font stack) draws
 *    those code points with the original letterforms, so the page looks
 *    identical while textContent/innerText/source carry only PUA. Plane 15
 *    is chosen because upstream's own mask (…/i.js) decodes any BMP PUA it
 *    finds through its own table — plane-15 pairs never collide.
 *    window.__kwMaskMode === "all" masks every printable char (catalog pages).
 *
 *  - Attributes/title: font can't reach tooltips or browser chrome, so blocked
 *    terms get invisible Unicode marker pairs (variation selector + format
 *    char). Visually identical, substring-dead.
 *
 * Stamped at pack time: __ALIASES__, __TERMS_PACKED__, __FONT_PATH__.
 */
(function () {
    "use strict";
    if (window.__kwMaskRunning) return;
    window.__kwMaskRunning = true;

    var ALIASES = __ALIASES__;
    var FONT_PATH = "__FONT_PATH__";
    var FONT_PATH_MC = "__FONT_PATH_MC__";

    function unpackTerms(value) {
        var bytes = Uint8Array.from(atob(value), function (c) { return c.charCodeAt(0); });
        for (var i = 0; i < bytes.length; i++) bytes[i] ^= 0xa7 ^ ((i * 29) & 0xff);
        return new TextDecoder().decode(bytes).split("\0");
    }
    var BLOCKED = unpackTerms("__TERMS_PACKED__").sort(function (a, b) { return b.length - a.length; });
    var byFirst = new Map();
    for (var i = 0; i < BLOCKED.length; i++) {
        var t = BLOCKED[i], g = byFirst.get(t[0]) || [];
        g.push(t);
        byFirst.set(t[0], g);
    }

    var MARK_RE = /[\u200B-\u200D\u2060-\u2064\uFEFF]|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu;
    var PUA_RE = /[\u{F0000}-\u{FFFFD}]/gu;
    var reverse = new Map();
    for (var ch in ALIASES) {
        for (var j = 0; j < ALIASES[ch].length; j++) reverse.set(ALIASES[ch][j], ch);
    }

    function avalanche(v) {
        var m = v >>> 0;
        m = Math.imul(m ^ (m >>> 16), 0x7feb352d);
        m = Math.imul(m ^ (m >>> 15), 0x846ca68b);
        return (m ^ (m >>> 16)) >>> 0;
    }
    function hash(value, seed) {
        var r = (seed ^ 0x811c9dc5) >>> 0;
        for (var i = 0; i < value.length; i++) r = Math.imul(r ^ value.charCodeAt(i), 0x01000193);
        return avalanche(r);
    }
    function randomSeed() {
        try { var s = new Uint32Array(1); crypto.getRandomValues(s); return s[0]; }
        catch (e) { return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0; }
    }
    var seed = randomSeed();

    function unveil(value) { return String(value).replace(MARK_RE, ""); }
    function containsBlocked(value) {
        var lower = unveil(value).toLowerCase();
        for (var i = 0; i < BLOCKED.length; i++) if (lower.indexOf(BLOCKED[i]) !== -1) return true;
        return false;
    }
    function segment(raw) {
        var lower = raw.toLowerCase(), out = [], plain = 0, i = 0;
        while (i < lower.length) {
            var cands = byFirst.get(lower[i]), term = null;
            if (cands) for (var k = 0; k < cands.length; k++) {
                if (lower.startsWith(cands[k], i)) { term = cands[k]; break; }
            }
            if (!term) { i += 1; continue; }
            if (plain < i) out.push({ text: raw.slice(plain, i), blocked: false });
            out.push({ text: raw.slice(i, i + term.length), blocked: true });
            i += term.length; plain = i;
        }
        if (plain < raw.length) out.push({ text: raw.slice(plain), blocked: false });
        return out;
    }
    function paint(term, offset) {
        var state = hash(term, seed ^ offset), out = "";
        for (var i = 0; i < term.length; i++) {
            var codes = ALIASES[term[i]];
            if (!codes) { out += term[i]; continue; }
            out += codes[avalanche(state ^ Math.imul(i + 1, 0x9e3779b1)) % codes.length];
        }
        return out;
    }
    function mask(value) {
        var raw = unveil(value), out = "", offset = 0;
        for (var p of segment(raw)) {
            out += p.blocked ? paint(p.text, offset) : p.text;
            offset += p.text.length;
        }
        return out;
    }
    function maskAll(value) { return paint(unveil(value), 0); }
    function unmask(value) {
        return String(value).replace(PUA_RE, function (a) { return reverse.get(a) || a; });
    }
    window.__kwUnmask = unmask;

    /* ---- veil: invisible markers for font-unreachable text ---- */
    var VS_BMP = 14, VS_SUP = 240, FMT_START = 0x2060, FMT_COUNT = 5;
    function variationSelector(v) {
        var s = v % (VS_BMP + VS_SUP);
        return s < VS_BMP ? String.fromCodePoint(0xfe00 + s) : String.fromCodePoint(0xe0100 + s - VS_BMP);
    }
    function markerAt(state, index) {
        var mixed = avalanche(state ^ Math.imul(index + 1, 0x9e3779b1));
        return variationSelector(mixed) + String.fromCodePoint(FMT_START + ((mixed >>> 16) % FMT_COUNT));
    }
    function veil(value) {
        var raw = unveil(value);
        if (!raw) return raw;
        var lower = raw.toLowerCase(), state = hash(raw, seed), out = "", i = 0;
        while (i < raw.length) {
            var hit = 0;
            for (var t = 0; t < BLOCKED.length; t++) {
                if (lower.startsWith(BLOCKED[t], i)) { hit = BLOCKED[t].length; break; }
            }
            if (hit) {
                var chars = [...raw.slice(i, i + hit)], st = avalanche(state ^ i);
                out += chars.map(function (c, n) {
                    var code = c.codePointAt(0);
                    var word = (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
                    return (n === chars.length - 1 || !word) ? c : c + markerAt(st, n);
                }).join("");
                i += hit;
            } else { out += raw[i]; i += 1; }
        }
        return out;
    }

    /* ---- font: PUA-only Glyphs faces first in every stack ---- */
    var fontURL = new URL(FONT_PATH, document.currentScript.src).href;
    var fontURLMC = FONT_PATH_MC ? new URL(FONT_PATH_MC, document.currentScript.src).href : null;
    var pickFace = function (ff) {
        return fontURLMC && ff.indexOf("Minecraftia") !== -1 ? '"GlyphsM",' : '"Glyphs",';
    };
    function installFont(root) {
        var style = document.createElement("style");
        style.setAttribute("data-km-skip", "");
        style.textContent =
            '@font-face{font-family:"Glyphs";src:url("' + fontURL + '") format("truetype");font-display:block;unicode-range:U+F0000-FFFFD}' +
            (fontURLMC ? '@font-face{font-family:"GlyphsM";src:url("' + fontURLMC + '") format("truetype");font-display:block;unicode-range:U+F0000-FFFFD}' : '') +
            'html{font-family:"Glyphs",Inter,system-ui,sans-serif}';
        (document.head || document.documentElement).appendChild(style);
        patchStacks();
    }
    function patchRule(rule) {
        try {
            if (rule.style && rule.style.fontFamily && rule.style.fontFamily.indexOf("Glyphs") === -1) {
                rule.style.fontFamily = pickFace(rule.style.fontFamily) + rule.style.fontFamily;
            }
        } catch (e) {}
    }
    function patchStacks() {
        for (var s = 0; s < document.styleSheets.length; s++) {
            var rules;
            try { rules = document.styleSheets[s].cssRules; } catch (e) { continue; }
            for (var r = 0; r < rules.length; r++) {
                patchRule(rules[r]);
                if (rules[r].cssRules) for (var n = 0; n < rules[r].cssRules.length; n++) patchRule(rules[r].cssRules[n]);
            }
        }
    }

    /* ---- DOM watcher ---- */
    var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, TITLE: 1 };
    var SKIP_ROOT = "[data-km-skip]";
    var TEXT_ATTR = ["title", "alt", "placeholder", "aria-label", "aria-description",
        "aria-roledescription", "aria-valuetext", "label"];
    var MODE_ALL = window.__kwMaskMode === "all";
    /* "attrs" — title/attribute veiling only. Upstream pages run their own
     * PUA mask (see _c/…/i.js: textContent/data getters decode their table),
     * so writing our own PUA text there collides with their decoder and
     * corrupts letters. Their system already covers every letter/digit —
     * what's left exposed is <title> and element attributes. */
    var MODE_ATTRS = window.__kwMaskMode === "attrs";

    function maskTextNode(node) {
        if (MODE_ATTRS) return;
        var parent = node.parentElement;
        if (!parent || parent.closest("select, option, " + SKIP_ROOT)) return;
        var value = node.nodeValue;
        if (!value) return;
        var next;
        if (MODE_ALL) {
            if (!/[ -~]/.test(value)) return;
            next = maskAll(value);
        } else {
            if (!containsBlocked(value)) return;
            next = mask(value);
        }
        if (next !== value) node.nodeValue = next;
    }
    function veilElement(el) {
        if (el.closest("select.native-select, " + SKIP_ROOT)) return;
        for (var a = 0; a < TEXT_ATTR.length; a++) {
            var attr = TEXT_ATTR[a];
            if (!el.hasAttribute(attr)) continue;
            var cur = el.getAttribute(attr) || "", next = containsBlocked(cur) ? veil(cur) : cur;
            if (next !== cur) el.setAttribute(attr, next);
        }
        if (el.style && el.style.fontFamily && el.style.fontFamily.indexOf("Glyphs") === -1) {
            el.style.fontFamily = pickFace(el.style.fontFamily) + el.style.fontFamily;
        }
        if (el instanceof HTMLOptionElement && containsBlocked(el.text)) {
            var nt = veil(el.text);
            if (nt !== el.text) el.text = nt;
        }
    }
    function walk(node) {
        if (node instanceof Text) {
            var p = node.parentElement;
            if (p && (SKIP_TAGS[p.tagName] || p instanceof HTMLInputElement || p instanceof HTMLTextAreaElement)) return;
            maskTextNode(node);
            return;
        }
        if (node instanceof Element) {
            if (node.matches("select.native-select, " + SKIP_ROOT)) return;
            veilElement(node);
            if (SKIP_TAGS[node.tagName]) return;
        }
        var kids = node.childNodes;
        for (var i = 0; i < kids.length; i++) walk(kids[i]);
    }
    function veilTitle() {
        var next = containsBlocked(document.title) ? veil(document.title) : document.title;
        if (next !== document.title) document.title = next;
    }

    function start() {
        if (!MODE_ATTRS) installFont();
        walk(document.documentElement);
        veilTitle();
        var observer = new MutationObserver(function (records) {
            for (var r = 0; r < records.length; r++) {
                var rec = records[r];
                if (rec.type === "characterData" && rec.target instanceof Text) maskTextNode(rec.target);
                else if (rec.type === "attributes" && rec.target instanceof Element) veilElement(rec.target);
                else if (rec.type === "childList") {
                    for (var i = 0; i < rec.addedNodes.length; i++) walk(rec.addedNodes[i]);
                }
            }
            veilTitle();
            patchStacks();
        });
        observer.observe(document.documentElement, {
            subtree: true, childList: true, characterData: true,
            attributes: true, attributeFilter: TEXT_ATTR,
        });
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(patchStacks);
    }

    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
