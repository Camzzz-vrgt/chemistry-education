/**
 * Keyword-mask build machinery (ported from toothpaste's plugins/maskFont.ts).
 *
 * The shipped mask font is an ordinary TTF whose cmap gains Private Use Area
 * code points pointing at the glyphs of normal ASCII characters. Text written
 * with those code points renders identically — same outlines, same kerning —
 * while DOM text, innerText, find-in-page and source scans see unrelated PUA
 * characters. The alias assignment is per-build so a mapping lifted from one
 * deployment finds nothing in the next.
 *
 * Only the cmap table is rewritten; outlines and every other table stay
 * byte-for-byte identical.
 */

/** Printable ASCII — anything a blocked term could contain. */
export const MASKABLE = Array.from({ length: 0x7f - 0x20 }, (_, i) =>
    String.fromCharCode(0x20 + i));

export const ALIASES_PER_CHAR = 3;
/* Supplementary Private Use Area-A (plane 15). Upstream's own text mask
 * (education/_c/…/i.js) claims the BMP PUA block U+E000-F8FF — its decoder
 * rewrites any BMP PUA it finds through *its* table, which corrupts our
 * aliases. Plane-15 code points are surrogate pairs their PUA regex can
 * never match, so both masks coexist with zero interaction. */
const PUA_START = 0xf0000;
const PUA_END = 0xffffd;

export function seededRandom(seed) {
    let state = seed >>> 0 || 0x9e3779b9;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 0x100000000;
    };
}

/** char -> array of ALIASES_PER_CHAR PUA code points (as strings), shuffled per build. */
export function buildAliasTable(random) {
    const pool = [];
    for (let code = PUA_START; code <= PUA_END; code += 1) pool.push(code);
    for (let i = pool.length - 1; i > 0; i -= 1) {
        const swap = Math.floor(random() * (i + 1));
        [pool[i], pool[swap]] = [pool[swap], pool[i]];
    }
    const table = {};
    let next = 0;
    for (const ch of MASKABLE) {
        table[ch] = Array.from({ length: ALIASES_PER_CHAR }, () =>
            String.fromCodePoint(pool[next++]));
    }
    return table;
}

const tagOf = (view, offset) =>
    String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1),
        view.getUint8(offset + 2), view.getUint8(offset + 3));

function readDirectory(view) {
    const count = view.getUint16(4);
    const records = [];
    for (let i = 0; i < count; i += 1) {
        const at = 12 + i * 16;
        records.push({
            tag: tagOf(view, at),
            checksum: view.getUint32(at + 4),
            offset: view.getUint32(at + 8),
            length: view.getUint32(at + 12),
        });
    }
    return records;
}

function readFormat4(view, base, map) {
    const segCount = view.getUint16(base + 6) / 2;
    const endCodes = base + 14;
    const startCodes = endCodes + segCount * 2 + 2;
    const idDeltas = startCodes + segCount * 2;
    const idRangeOffsets = idDeltas + segCount * 2;
    for (let seg = 0; seg < segCount; seg += 1) {
        const end = view.getUint16(endCodes + seg * 2);
        const start = view.getUint16(startCodes + seg * 2);
        const delta = view.getUint16(idDeltas + seg * 2);
        const rangeOffset = view.getUint16(idRangeOffsets + seg * 2);
        for (let code = start; code <= end && code !== 0xffff; code += 1) {
            let glyph;
            if (rangeOffset === 0) {
                glyph = (code + delta) & 0xffff;
            } else {
                const address = idRangeOffsets + seg * 2 + rangeOffset + (code - start) * 2;
                glyph = view.getUint16(address);
                if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
            }
            if (glyph !== 0) map.set(code, glyph);
        }
    }
}

function readFormat12(view, base, map) {
    const groups = view.getUint32(base + 12);
    for (let group = 0; group < groups; group += 1) {
        const at = base + 16 + group * 12;
        const start = view.getUint32(at);
        const end = view.getUint32(at + 4);
        const glyph = view.getUint32(at + 8);
        for (let code = start; code <= end; code += 1) {
            map.set(code, glyph + (code - start));
        }
    }
}

/** Every code point the font maps, merged across Unicode subtables. */
export function readCharacterMap(font) {
    const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
    const cmap = readDirectory(view).find((r) => r.tag === "cmap");
    if (!cmap) throw new Error("Font has no cmap table.");
    const map = new Map();
    const subtables = view.getUint16(cmap.offset + 2);
    const formats = [];
    for (let i = 0; i < subtables; i += 1) {
        const record = cmap.offset + 4 + i * 8;
        const platform = view.getUint16(record);
        const encoding = view.getUint16(record + 2);
        if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))) {
            formats.push({
                format: view.getUint16(cmap.offset + view.getUint32(record + 4)),
                base: cmap.offset + view.getUint32(record + 4),
            });
        }
    }
    for (const { format, base } of formats.sort((a, b) => a.format - b.format)) {
        if (format === 4) readFormat4(view, base, map);
        else if (format === 12) readFormat12(view, base, map);
    }
    return map;
}

function segments(codes, map) {
    const result = [];
    for (const code of codes) {
        const last = result.at(-1);
        if (last && last.end + 1 === code) {
            last.end = code;
            last.glyphs.push(map.get(code));
        } else {
            result.push({ start: code, end: code, glyphs: [map.get(code)] });
        }
    }
    return result;
}

function writeFormat4(map) {
    const codes = [...map.keys()].filter((c) => c < 0xffff).sort((a, b) => a - b);
    const runs = segments(codes, map);
    const segCount = runs.length + 1;
    const glyphIdArray = [];
    const deltas = [];
    const rangeOffsets = [];
    runs.forEach((run, index) => {
        const delta = run.glyphs[0] - run.start;
        if (run.glyphs.every((g, at) => g - (run.start + at) === delta)) {
            deltas.push(delta & 0xffff);
            rangeOffsets.push(0);
        } else {
            deltas.push(0);
            rangeOffsets.push((segCount - index + glyphIdArray.length) * 2);
            glyphIdArray.push(...run.glyphs);
        }
    });
    deltas.push(1);
    rangeOffsets.push(0);
    const length = 16 + segCount * 8 + glyphIdArray.length * 2;
    if (length > 0xffff) throw new Error("cmap format 4 subtable would exceed 64 KiB.");
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    const entrySelector = Math.floor(Math.log2(segCount));
    const searchRange = 2 ** entrySelector * 2;
    view.setUint16(0, 4);
    view.setUint16(2, length);
    view.setUint16(4, 0);
    view.setUint16(6, segCount * 2);
    view.setUint16(8, searchRange);
    view.setUint16(10, entrySelector);
    view.setUint16(12, segCount * 2 - searchRange);
    let at = 14;
    const write = (values) => {
        for (const v of values) { view.setUint16(at, v); at += 2; }
    };
    write([...runs.map((r) => r.end), 0xffff]);
    write([0]);
    write([...runs.map((r) => r.start), 0xffff]);
    write(deltas);
    write(rangeOffsets);
    write(glyphIdArray);
    return bytes;
}

function writeFormat12(map) {
    const codes = [...map.keys()].sort((a, b) => a - b);
    const groups = [];
    for (const code of codes) {
        const glyph = map.get(code);
        const last = groups.at(-1);
        if (last && last.end + 1 === code && last.glyph + (code - last.start) === glyph) {
            last.end = code;
        } else {
            groups.push({ start: code, end: code, glyph });
        }
    }
    const length = 16 + groups.length * 12;
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 12);
    view.setUint16(2, 0);
    view.setUint32(4, length);
    view.setUint32(8, 0);
    view.setUint32(12, groups.length);
    groups.forEach((group, i) => {
        const at = 16 + i * 12;
        view.setUint32(at, group.start);
        view.setUint32(at + 4, group.end);
        view.setUint32(at + 8, group.glyph);
    });
    return bytes;
}

function writeCmap(map) {
    const format4 = writeFormat4(map);
    const format12 = writeFormat12(map);
    const header = new Uint8Array(4 + 2 * 8);
    const view = new DataView(header.buffer);
    view.setUint16(0, 0);
    view.setUint16(2, 2);
    view.setUint16(4, 3);
    view.setUint16(6, 1);
    view.setUint32(8, header.length);
    view.setUint16(12, 3);
    view.setUint16(14, 10);
    view.setUint32(16, header.length + format4.length);
    const cmap = new Uint8Array(header.length + format4.length + format12.length);
    cmap.set(header, 0);
    cmap.set(format4, header.length);
    cmap.set(format12, header.length + format4.length);
    return cmap;
}

function checksum(bytes, start = 0, length = bytes.length) {
    let sum = 0;
    for (let at = start; at < start + length; at += 4) {
        let word = 0;
        for (let b = 0; b < 4; b += 1) {
            word = (word << 8) | (at + b < start + length ? bytes[at + b] : 0);
        }
        sum = (sum + (word >>> 0)) >>> 0;
    }
    return sum;
}

const pad4 = (length) => (length + 3) & ~3;

/** Rewrite the font with cmap replaced; every other table stays intact. */
function replaceCmap(font, cmap) {
    const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
    const records = readDirectory(view);
    const byOffset = [...records].sort((a, b) => a.offset - b.offset);
    const directoryLength = 12 + records.length * 16;
    const totalLength = byOffset.reduce(
        (len, r) => len + pad4(r.tag === "cmap" ? cmap.length : r.length),
        directoryLength);
    const output = new Uint8Array(totalLength);
    const out = new DataView(output.buffer);
    output.set(font.subarray(0, 12), 0);
    let cursor = directoryLength;
    const placed = new Map();
    for (const record of byOffset) {
        const data = record.tag === "cmap"
            ? cmap
            : font.subarray(record.offset, record.offset + record.length);
        output.set(data, cursor);
        placed.set(record.tag, {
            offset: cursor,
            length: data.length,
            checksum: record.tag === "cmap" ? checksum(cmap) : record.checksum,
        });
        cursor += pad4(data.length);
    }
    records.forEach((record, index) => {
        const at = 12 + index * 16;
        const entry = placed.get(record.tag);
        for (let b = 0; b < 4; b += 1) output[at + b] = record.tag.charCodeAt(b);
        out.setUint32(at + 4, entry.checksum);
        out.setUint32(at + 8, entry.offset);
        out.setUint32(at + 12, entry.length);
    });
    const head = placed.get("head");
    if (head) {
        out.setUint32(head.offset + 8, 0);
        out.setUint32(head.offset + 8, (0xb1b0afba - checksum(output)) >>> 0);
    }
    return output;
}

/** Add PUA aliases for every maskable character the font already covers. */
export function aliasFont(font, aliases) {
    const map = readCharacterMap(font);
    for (const [character, codes] of Object.entries(aliases)) {
        const glyph = map.get(character.charCodeAt(0));
        if (!glyph) continue;
        for (const alias of codes) map.set(alias.codePointAt(0), glyph);
    }
    return replaceCmap(font, writeCmap(map));
}

/**
 * Pack the term dictionary the way toothpaste does — NUL-delimited, then a
 * rolling XOR, then base64 — so the shipped JS carries no readable signatures.
 */
export function packTerms(terms) {
    const bytes = new TextEncoder().encode(terms.join("\0"));
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] ^= 0xa7 ^ ((i * 29) & 0xff);
    }
    return Buffer.from(bytes).toString("base64");
}
