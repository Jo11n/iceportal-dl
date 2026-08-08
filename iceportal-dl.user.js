// ==UserScript==
// @name         ICEportal-dl Media Downloader
// @namespace    https://github.com/Jo11n/iceportal-dl
// @version      0.1.0
// @description  Download-Helfer für das ICEportal der DB (Audiobücher, Podcasts und Zeitschriften)
// @author       Jo11n
// @match        https://iceportal.de/*
// @grant        GM_download
// @connect      iceportal.de
// @license      MIT
// @homepageURL  https://github.com/Jo11n/iceportal-dl
// @supportURL   https://github.com/Jo11n/iceportal-dl/issues
// @downloadURL  https://raw.githubusercontent.com/Jo11n/iceportal-dl/main/iceportal-dl.user.js
// @updateURL    https://raw.githubusercontent.com/Jo11n/iceportal-dl/main/iceportal-dl.user.js
// ==/UserScript==

(function () {
  'use strict';

  const BASE = 'https://iceportal.de';
  const RETRY_COUNT = 2;
  const RETRY_DELAY_MS = 600;
  // Resolving chapter URLs (and background author enrichment) tolerates parallelism;
  // only the auto-download triggers are throttled, since browsers block bursts.
  const RESOLVE_CONCURRENCY = 4;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function sanitize(str) {
    return (str || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // The portal escapes punctuation in some chapter titles ("Book\, Kapitel 1");
  // strip the stray backslash and normalize whitespace.
  function cleanText(str) {
    return (str || '')
      .replace(/\\(?=[,.;:!?'"()\[\]])/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function pad(n, total) {
    return String(n).padStart(String(total).length, '0');
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Runs fn over items with at most `limit` in flight at once, preserving order in the result.
  async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let index = 0;
    async function worker() {
      while (index < items.length) {
        const current = index++;
        results[current] = await fn(items[current], current);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  // Train wifi drops packets mid-tunnel; retry a couple of times.
  async function fetchWithRetry(url) {
    let lastErr;
    for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        return resp;
      } catch (e) {
        lastErr = e;
        if (attempt < RETRY_COUNT) await delay(RETRY_DELAY_MS * (attempt + 1));
      }
    }
    throw lastErr;
  }

  // Outside the train (or with a VPN routing around the wifi captive portal), iceportal.de
  // still responds with 200 OK but serves an HTML placeholder instead of the train's JSON API.
  const fetchJSON = async path => {
    const resp = await fetchWithRetry(BASE + path);
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('Keine Zugdaten verfügbar – bist du mit dem Zug-WLAN verbunden? (Ggf. VPN deaktivieren.)');
    }
  };

  // The portal ships its own filter definitions (content type + duration
  // buckets) with the list; reused instead of inventing thresholds.
  let audiobookFilterDefs = [];
  // Genre is the free-text "subtitle" (bracketed tag), not part of the filter
  // definition; collected so the genre dropdown offers only values in use.
  let audiobookGenres = [];
  let podcastFilterDefs = [];

  // Display labels for duration buckets — shared by both audiobook and podcast
  // filter bars so all four buckets format consistently.
  const DURATION_LABELS = {
    zeit_unter30minuten:    '< 30 Min.',
    zeit_unter1stunde:      '< 1h',
    zeit_unter2stunden:     '< 2h',
    zeit_laengerals2stunden: '> 2h',
  };

  async function listBooks() {
    const data = await fetchJSON('/api1/rs/page/hoerbuecher');
    const group = data.teaserGroups[0];
    audiobookFilterDefs = (group.filter && group.filter.items || []).filter(f => f.id !== 'alle');
    const books = group.items
      // skip promo/ad tiles (type "adCard") whose href points off-site.
      .filter(item => item.type === 'audio')
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(item => ({
        title: item.subtitle ? `${item.title} [${item.subtitle}]` : item.title,
        slug: item.navigation.href.split('/').pop(),
        genre: item.subtitle || '',
        filterIds: item.filterIds || [],
      }));
    audiobookGenres = [...new Set(books.map(b => b.genre).filter(Boolean))].sort();
    return books;
  }

  // Memoized: the list view fetches details for every book just to show the
  // author, so caching means expanding a book afterwards is free.
  const bookDetailsCache = new Map();

  async function getBookDetails(slug) {
    if (bookDetailsCache.has(slug)) return bookDetailsCache.get(slug);
    const data = await fetchJSON(`/api1/rs/page/hoerbuecher/${slug}`);
    bookDetailsCache.set(slug, data);
    return data;
  }

  const podcastDetailsCache = new Map();

  async function listPodcasts() {
    const data = await fetchJSON('/api1/rs/page/podcasts');
    const group = data.teaserGroups[0];
    podcastFilterDefs = (group.filter && group.filter.items || []).filter(f => f.id !== 'alle');
    const podcasts = group.items
      .filter(item => item.type === 'audio')
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(item => ({
        title: item.title,
        slug: item.navigation.href.split('/').pop(),
        filterIds: item.filterIds || [],
      }));
    return podcasts;
  }

  async function getPodcastDetails(slug) {
    if (podcastDetailsCache.has(slug)) return podcastDetailsCache.get(slug);
    const data = await fetchJSON(`/api1/rs/page/podcasts/${slug}`);
    podcastDetailsCache.set(slug, data);
    return data;
  }

  // chapter.path from the book details API is e.g. "audiobook/path/{slug}/{n}",
  // which maps directly to /api1/rs/audiobook/path/{slug}/{n}.
  async function resolveChapterURL(chapterPath) {
    const clean = String(chapterPath || '').replace(/^\//, '');
    const data = await fetchJSON(`/api1/rs/${clean}`);
    const resolved = data.path;
    return resolved.startsWith('http') ? resolved : BASE + resolved;
  }

  // "marker" lives on the item itself (not nested under "picture").
  async function listMagazines() {
    const data = await fetchJSON('/api1/rs/page/zeitungskiosk');
    return data.teaserGroups[0].items
      .filter(item => item.marker && item.marker.text === 'Freies Exemplar')
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(item => ({ title: item.title, href: item.navigation.href }));
  }

  async function getMagazineDetails(href) {
    return fetchJSON(`/api1/rs/page${href}`);
  }

  // details.navigation.href is the direct PDF download path, e.g.
  // "api1/rs/magazines/file/freeCopy/{slug}/{hash}" (no leading slash).
  function resolveMagazineURL(details) {
    const href = details.navigation.href;
    return href.startsWith('/') ? BASE + href : `${BASE}/${href}`;
  }

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  function clickDownloadLink(href, filename) {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function triggerDownload(url, filename) {
    if (typeof GM_download !== 'undefined') GM_download({ url, name: filename });
    else clickDownloadLink(url, filename);
  }

  function buildFilename(author, bookTitle, serialNumber, chapterTitle, totalChapters, ext = 'mp3') {
    const track  = pad(serialNumber, totalChapters);
    const parts  = [author, bookTitle, track, sanitize(cleanText(chapterTitle) || `Kapitel ${serialNumber}`)];
    return parts.join(' - ') + '.' + ext;
  }

  function buildMagazineFilename(title, date, ext) {
    const parts = [sanitize(title), date].filter(Boolean);
    return parts.join(' - ') + '.' + ext;
  }

  function buildPodcastFilename(podcastTitle, serialNumber, episodeTitle, ext) {
    const padded = pad(serialNumber, 9999);
    return `${sanitize(podcastTitle)} - ${padded} - ${sanitize(cleanText(episodeTitle))}.${ext}`;
  }

  // Extension from the path, falling back only if the URL somehow has none.
  // The fallback is caller-supplied so the guess matches the content type.
  function extFromUrl(url, fallback) {
    return url.split('?')[0].split('.').pop() || fallback;
  }

  function formatDuration(totalSeconds) {
    const s = Math.round(totalSeconds || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(sec).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function parseISODuration(iso) {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
    if (!m) return 0;
    return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + parseInt(m[3] || '0', 10);
  }

  // ---------------------------------------------------------------------------
  // MP4 metadata tagging
  // ---------------------------------------------------------------------------
  //
  // Portal .m4a files already carry a moov → udta → meta → ilst chain with `moov`
  // last and `ilst` at its tail. Tags are added by appending atoms inside `ilst`
  // and bumping the four ancestor size fields; `mdat` never moves, so sample
  // offsets stay valid and the worst case is "tags don't show", never corruption.

  const COPYRIGHT = String.fromCharCode(0xA9); // the "©" byte that prefixes ©nam/©ART/…

  // A box is [uint32 size][4-char type][payload].
  function mp4Box(type, payload) {
    const box = new Uint8Array(8 + payload.length);
    new DataView(box.buffer).setUint32(0, box.length);
    for (let i = 0; i < 4; i++) box[4 + i] = type.charCodeAt(i) & 0xFF;
    box.set(payload, 8);
    return box;
  }

  // An iTunes metadata value lives in a "data" atom: [typeIndicator][locale=0][payload].
  // typeIndicator: 1 = UTF-8 text, 0 = binary (trkn), 13 = JPEG, 14 = PNG.
  function mp4DataAtom(typeIndicator, payload) {
    const inner = new Uint8Array(8 + payload.length);
    new DataView(inner.buffer).setUint32(0, typeIndicator); // bytes 4..8 (locale) stay 0
    inner.set(payload, 8);
    return mp4Box('data', inner);
  }

  function textAtom(type, text) {
    return mp4Box(type, mp4DataAtom(1, new TextEncoder().encode(text)));
  }

  function concatBytes(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }

  function buildIlstAtoms(tags) {
    const chunks = [];
    if (tags.title)  chunks.push(textAtom(COPYRIGHT + 'nam', tags.title));
    if (tags.artist) chunks.push(textAtom(COPYRIGHT + 'ART', tags.artist));
    if (tags.album)  chunks.push(textAtom(COPYRIGHT + 'alb', tags.album));
    if (tags.track && tags.track.no) {
      // trkn payload: 2 reserved, uint16 track, uint16 total, 2 reserved.
      const p = new Uint8Array(8);
      const d = new DataView(p.buffer);
      d.setUint16(2, tags.track.no);
      d.setUint16(4, tags.track.total || 0);
      chunks.push(mp4Box('trkn', mp4DataAtom(0, p)));
    }
    if (tags.cover && tags.cover.bytes) {
      chunks.push(mp4Box('covr', mp4DataAtom(tags.cover.mime === 'image/png' ? 14 : 13, tags.cover.bytes)));
    }
    return concatBytes(chunks);
  }

  // Direct child boxes within [start, end). Intentionally 32-bit only — a
  // 64-bit box (size == 1) is treated as malformed and bails the splice,
  // downloading untagged. Safe since the portal's tag boxes are always small.
  function mp4Children(dv, start, end) {
    const out = [];
    let offset = start;
    while (offset + 8 <= end) {
      const size = dv.getUint32(offset);
      if (size < 8 || offset + size > end) break;
      const type = String.fromCharCode(dv.getUint8(offset + 4), dv.getUint8(offset + 5), dv.getUint8(offset + 6), dv.getUint8(offset + 7));
      out.push({ type, start: offset, size, end: offset + size });
      offset += size;
    }
    return out;
  }

  // Returns a new buffer with tags spliced in, or the original untouched if the
  // expected box layout isn't present.
  function tagMp4(arrayBuffer, tags) {
    const newAtoms = buildIlstAtoms(tags);
    if (newAtoms.length === 0) return arrayBuffer;

    const bytes = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);

    // Descend moov → udta → meta → ilst, requiring each to be the last box in
    // its parent (parent.end === child.end) so a plain append can't shift media.
    const moov = mp4Children(dv, 0, bytes.length).find(b => b.type === 'moov');
    if (!moov || moov.end !== bytes.length) return arrayBuffer;
    const udta = mp4Children(dv, moov.start + 8, moov.end).find(b => b.type === 'udta');
    if (!udta || udta.end !== moov.end) return arrayBuffer;
    // `meta` is a FullBox: 4 bytes of version/flags precede its children.
    const meta = mp4Children(dv, udta.start + 8, udta.end).find(b => b.type === 'meta');
    if (!meta || meta.end !== udta.end) return arrayBuffer;
    const ilst = mp4Children(dv, meta.start + 12, meta.end).find(b => b.type === 'ilst');
    if (!ilst || ilst.end !== meta.end) return arrayBuffer;

    const insertAt = ilst.end;
    const out = new Uint8Array(bytes.length + newAtoms.length);
    out.set(bytes.subarray(0, insertAt), 0);
    out.set(newAtoms, insertAt);
    out.set(bytes.subarray(insertAt), insertAt + newAtoms.length);

    // Grow the four ancestor size fields. Their headers all sit before insertAt,
    // so their positions are unchanged in `out`.
    const odv = new DataView(out.buffer);
    for (const box of [ilst, meta, udta, moov]) {
      odv.setUint32(box.start, dv.getUint32(box.start) + newAtoms.length);
    }
    return out.buffer;
  }

  // Best-effort; returns null on failure/unsupported format so tagging proceeds
  // without art rather than failing the download.
  async function fetchCover(src) {
    if (!src) return null;
    try {
      // cover src is base-relative with no leading slash; new URL() joins it.
      const url = new URL(src, BASE + '/').href;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes[0] === 0x89 && bytes[1] === 0x50) return { bytes, mime: 'image/png' };
      if (bytes[0] === 0xFF && bytes[1] === 0xD8) return { bytes, mime: 'image/jpeg' };
      return null; // e.g. webp — no ilst image type for it, so skip the cover
    } catch (e) {
      return null;
    }
  }

  function buildTags(author, bookTitle, chapter, total, cover) {
    return {
      title:  cleanText(chapter.title) || `Kapitel ${chapter.serialNumber}`,
      artist: cleanText(author),
      album:  cleanText(bookTitle),
      track:  { no: chapter.serialNumber, total },
      cover,
    };
  }

  const fetchAudioBuffer = async url => (await fetchWithRetry(url)).arrayBuffer();

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    clickDownloadLink(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // Buffer, tag, and download. Any failure degrades to a plain streamed download.
  async function downloadTaggedChapter(url, filename, tags) {
    if (!/\.(m4a|m4b|mp4)(\?|$)/i.test(url)) {
      triggerDownload(url, filename); // not an MP4 container — nothing to tag
      return;
    }
    let buffer;
    try {
      buffer = await fetchAudioBuffer(url);
    } catch (e) {
      console.error('[ICE DL] buffering failed, streaming untagged', e);
      triggerDownload(url, filename);
      return;
    }
    let tagged;
    try {
      tagged = tagMp4(buffer, tags);
    } catch (e) {
      console.error('[ICE DL] tagging failed, downloading untagged', e);
      tagged = buffer;
    }
    triggerBlobDownload(new Blob([tagged], { type: 'audio/mp4' }), filename);
  }

  // ---------------------------------------------------------------------------
  // Audiobook merge: combine chapters into one progressive .m4b
  // ---------------------------------------------------------------------------
  //
  // All chapters of a book share one AAC config (checked at merge time), so their
  // samples concatenate without re-encoding. Builds one progressive file
  // (ftyp/mdat/moov) with an audio track plus a QuickTime text chapter track
  // (audio track → tref 'chap' → text track), the de-facto .m4b chapter format.

  const TE = new TextEncoder();
  function _u32(n) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0); return a; }
  function _u16(n) { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, n & 0xFFFF); return a; }
  function _str4(s) { return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]); }
  function _box(type, ...parts) { const p = concatBytes(parts); return concatBytes([_u32(8 + p.length), _str4(type), p]); }
  function _fullbox(type, version, flags, ...parts) { return _box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts); }
  const _MATRIX = concatBytes([_u32(0x00010000), _u32(0), _u32(0), _u32(0), _u32(0x00010000), _u32(0), _u32(0), _u32(0), _u32(0x40000000)]);

  // Pack ints into big-endian uint32 bytes directly. Never build a large table
  // via `_box(type, ...arr.map(_u32))` — spreading ~700k samples (a full book)
  // overflows the call stack.
  function _u32Array(nums) {
    const out = new Uint8Array(nums.length * 4);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < nums.length; i++) dv.setUint32(i * 4, nums[i] >>> 0);
    return out;
  }

  // Shared sub-boxes (identical across the audio and chapter tracks).
  const _dinf = () => _box('dinf', _fullbox('dref', 0, 0, _u32(1), _fullbox('url ', 0, 1)));
  const _mdhd = (timescale, ticks) => _fullbox('mdhd', 0, 0, _u32(0), _u32(0), _u32(timescale), _u32(ticks), _u16(0x55C4), _u16(0));
  const _hdlr = (type, name) => _fullbox('hdlr', 0, 0, _u32(0), _str4(type), _u32(0), _u32(0), _u32(0), concatBytes([TE.encode(name), new Uint8Array([0])]));
  const _tkhd = (trackId, flags, volume, ticks) => _fullbox('tkhd', 0, flags, _u32(0), _u32(0), _u32(trackId), _u32(0), _u32(ticks), _u32(0), _u32(0), _u16(0), _u16(0), _u16(volume), _u16(0), _MATRIX, _u32(0), _u32(0));

  function _boxList(dv, start, end) {
    const list = [];
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o), hdr = 8;
      const type = String.fromCharCode(dv.getUint8(o + 4), dv.getUint8(o + 5), dv.getUint8(o + 6), dv.getUint8(o + 7));
      if (size === 1) { size = dv.getUint32(o + 8) * 2 ** 32 + dv.getUint32(o + 12); hdr = 16; }
      if (size < 8 || o + size > end) break;
      list.push({ type, start: o, size, dataStart: o + hdr, end: o + size });
      o += size;
    }
    return list;
  }
  const _find = (l, t) => l.find(x => x.type === t);

  function muxParseChapter(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    const b = new Uint8Array(arrayBuffer);
    const top = _boxList(dv, 0, b.length);
    const ftyp = _find(top, 'ftyp'), moov = _find(top, 'moov');
    const trak = _find(_boxList(dv, moov.dataStart, moov.end), 'trak');
    const mdia = _find(_boxList(dv, trak.dataStart, trak.end), 'mdia');
    const mdiaKids = _boxList(dv, mdia.dataStart, mdia.end);
    const mdhd = _find(mdiaKids, 'mdhd');
    const timescale = b[mdhd.dataStart] === 1 ? dv.getUint32(mdhd.dataStart + 20) : dv.getUint32(mdhd.dataStart + 12);
    const minf = _find(mdiaKids, 'minf');
    const stbl = _find(_boxList(dv, minf.dataStart, minf.end), 'stbl');
    const sk = _boxList(dv, stbl.dataStart, stbl.end);

    const stsd = _find(sk, 'stsd');
    const mp4a = _boxList(dv, stsd.dataStart + 8, stsd.end)[0];
    const mp4aBytes = b.slice(mp4a.start, mp4a.end);

    let p = _find(sk, 'stsz').dataStart + 4;
    const uniform = dv.getUint32(p); p += 4;
    const count = dv.getUint32(p); p += 4;
    const sizes = new Array(count);
    if (uniform) sizes.fill(uniform); else for (let i = 0; i < count; i++) { sizes[i] = dv.getUint32(p); p += 4; }

    p = _find(sk, 'stts').dataStart + 4;
    const sttsN = dv.getUint32(p); p += 4;
    const deltas = new Array(count); let si = 0;
    for (let e = 0; e < sttsN; e++) { const c = dv.getUint32(p); p += 4; const d = dv.getUint32(p); p += 4; for (let k = 0; k < c; k++) deltas[si++] = d; }

    p = _find(sk, 'stsc').dataStart + 4;
    const stscN = dv.getUint32(p); p += 4;
    const stscE = [];
    for (let e = 0; e < stscN; e++) { const fc = dv.getUint32(p); const spc = dv.getUint32(p + 4); const sdi = dv.getUint32(p + 8); p += 12; stscE.push({ fc, spc, sdi }); }

    const stco = _find(sk, 'stco'), co64 = _find(sk, 'co64');
    const chunkOffsets = [];
    if (stco) { p = stco.dataStart + 4; const n = dv.getUint32(p); p += 4; for (let i = 0; i < n; i++) { chunkOffsets.push(dv.getUint32(p)); p += 4; } }
    else { p = co64.dataStart + 4; const n = dv.getUint32(p); p += 4; for (let i = 0; i < n; i++) { chunkOffsets.push(dv.getUint32(p) * 2 ** 32 + dv.getUint32(p + 4)); p += 8; } }

    const offsets = new Array(count); let sIdx = 0;
    for (let c = 0; c < chunkOffsets.length; c++) {
      let spc = stscE[0].spc;
      for (let e = 0; e < stscE.length; e++) { if (stscE[e].fc <= c + 1) spc = stscE[e].spc; else break; }
      let off = chunkOffsets[c];
      for (let k = 0; k < spc && sIdx < count; k++) { offsets[sIdx] = off; off += sizes[sIdx]; sIdx++; }
    }
    const totalBytes = sizes.reduce((n, s) => n + s, 0);
    const data = new Uint8Array(totalBytes);
    let d = 0;
    for (let i = 0; i < count; i++) { data.set(b.subarray(offsets[i], offsets[i] + sizes[i]), d); d += sizes[i]; }

    return { timescale, mp4aBytes, sizes, deltas, data, count, ftypBytes: b.slice(ftyp.start, ftyp.end) };
  }

  function _rleStts(deltas) {
    const runs = [];
    for (const d of deltas) { const last = runs[runs.length - 1]; if (last && last.d === d) last.c++; else runs.push({ c: 1, d }); }
    const body = new Uint8Array(runs.length * 8);
    const dv = new DataView(body.buffer);
    for (let i = 0; i < runs.length; i++) { dv.setUint32(i * 8, runs[i].c >>> 0); dv.setUint32(i * 8 + 4, runs[i].d >>> 0); }
    return _fullbox('stts', 0, 0, _u32(runs.length), body);
  }

  function _textSampleEntry() {
    const payload = concatBytes([
      _u32(0), _u32(1),                 // displayFlags, textJustification
      _u16(0), _u16(0), _u16(0),        // background color
      _u16(0), _u16(0), _u16(0), _u16(0), // default text box
      _u32(0), _u32(0),                 // reserved
      _u16(0), _u16(0),                 // fontNumber, fontFace
      new Uint8Array([0]), _u16(0),     // reserved
      _u16(0xFFFF), _u16(0xFFFF), _u16(0xFFFF), // foreground color
      new Uint8Array([0]),              // empty font name (pascal)
    ]);
    return _box('text', new Uint8Array(6), _u16(1), payload);
  }

  // Wrap tag atoms in a fresh udta → meta → ilst chain (merged file has none).
  function _buildTagUdta(tags) {
    const atoms = buildIlstAtoms(tags);
    if (!atoms.length) return null;
    const hdlr = _fullbox('hdlr', 0, 0, _u32(0), _str4('mdir'), _str4('appl'), _u32(0), _u32(0), new Uint8Array([0]));
    return _box('udta', _fullbox('meta', 0, 0, hdlr, _box('ilst', atoms)));
  }

  // chapters: array from muxParseChapter (all same timescale + mp4aBytes).
  function buildMergedM4b(chapters, titles, tags) {
    const timescale = chapters[0].timescale;
    const sizes = chapters.flatMap(c => Array.from(c.sizes));
    const deltas = chapters.flatMap(c => Array.from(c.deltas));
    const audioData = concatBytes(chapters.map(c => c.data));
    const totalTicks = deltas.reduce((n, d) => n + d, 0);
    const chapterTicks = chapters.map(c => c.deltas.reduce((n, d) => n + d, 0));
    const ftyp = chapters[0].ftypBytes;

    const chapSamples = titles.map(t => { const txt = TE.encode(t); return concatBytes([_u16(txt.length), txt]); });
    const chapData = concatBytes(chapSamples);
    const mdat = concatBytes([_u32(8 + audioData.length + chapData.length), _str4('mdat'), audioData, chapData]);
    const audioStart = ftyp.length + 8;
    const chapStart = audioStart + audioData.length;

    const aStbl = _box('stbl',
      _fullbox('stsd', 0, 0, _u32(1), chapters[0].mp4aBytes),
      _rleStts(deltas),
      _fullbox('stsc', 0, 0, _u32(1), _u32(1), _u32(sizes.length), _u32(1)),
      _fullbox('stsz', 0, 0, _u32(0), _u32(sizes.length), _u32Array(sizes)),
      _fullbox('stco', 0, 0, _u32(1), _u32(audioStart)));
    const aMinf = _box('minf', _fullbox('smhd', 0, 0, _u16(0), _u16(0)), _dinf(), aStbl);
    const aMdia = _box('mdia', _mdhd(timescale, totalTicks), _hdlr('soun', 'SoundHandler'), aMinf);
    const aTrak = _box('trak', _tkhd(1, 0x000007, 0x0100, totalTicks), _box('tref', _box('chap', _u32(2))), aMdia);

    const cStbl = _box('stbl',
      _fullbox('stsd', 0, 0, _u32(1), _textSampleEntry()),
      _fullbox('stts', 0, 0, _u32(chapterTicks.length), _u32Array(chapterTicks.flatMap(t => [1, t]))),
      _fullbox('stsc', 0, 0, _u32(1), _u32(1), _u32(chapSamples.length), _u32(1)),
      _fullbox('stsz', 0, 0, _u32(0), _u32(chapSamples.length), _u32Array(chapSamples.map(s => s.length))),
      _fullbox('stco', 0, 0, _u32(1), _u32(chapStart)));
    const cMinf = _box('minf',
      _box('gmhd', _fullbox('gmin', 0, 0, _u16(0), _u16(0), _u16(0), _u16(0), _u16(0), _u16(0))),
      _dinf(), cStbl);
    const cMdia = _box('mdia', _mdhd(timescale, totalTicks), _hdlr('text', 'ChapterHandler'), cMinf);
    const cTrak = _box('trak', _tkhd(2, 0x000001, 0, totalTicks), cMdia);

    const mvhd = _fullbox('mvhd', 0, 0, _u32(0), _u32(0), _u32(timescale), _u32(totalTicks), _u32(0x00010000), _u16(0x0100), _u16(0), _u32(0), _u32(0), _MATRIX, _u32(0), _u32(0), _u32(0), _u32(0), _u32(0), _u32(0), _u32(3));
    const udta = _buildTagUdta(tags);
    const moov = udta ? _box('moov', mvhd, aTrak, cTrak, udta) : _box('moov', mvhd, aTrak, cTrak);

    return concatBytes([ftyp, mdat, moov]);
  }

  function _bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Resolve every chapter's media URL (capped concurrency); null url = failed.
  async function resolveAll(sorted) {
    return mapWithConcurrency(sorted, RESOLVE_CONCURRENCY, async chapter => {
      try { return { chapter, url: await resolveChapterURL(chapter.path) }; }
      catch (e) { console.error('[ICE DL] resolve failed', chapter.title, e); return { chapter, url: null }; }
    });
  }

  // Buffers the whole book in memory before muxing.
  async function mergeBookDownload(sorted, tagCtx, btn) {
    const { rawAuthor, rawBookTitle, total, coverPromise } = tagCtx;
    btn.disabled = true;
    try {
      btn.textContent = `[...] Löse ${total} Kapitel auf…`;
      const resolved = await resolveAll(sorted);
      if (resolved.some(r => !r.url)) { btn.textContent = '[FEHLER] Konnte nicht alle Kapitel auflösen'; return; }

      const chapters = [], titles = [];
      for (let i = 0; i < resolved.length; i++) {
        btn.textContent = `[...] Lade ${i + 1}/${total}…`;
        const buf = await fetchAudioBuffer(resolved[i].url);
        chapters.push(muxParseChapter(buf));
        titles.push(cleanText(resolved[i].chapter.title) || `Kapitel ${resolved[i].chapter.serialNumber}`);
      }

      // Concatenating without re-encoding is only valid if every chapter shares
      // the exact AAC config; bail if they diverge.
      const ref = chapters[0];
      if (!chapters.every(c => c.timescale === ref.timescale && _bytesEqual(c.mp4aBytes, ref.mp4aBytes))) {
        btn.textContent = '[FEHLER] Kapitel haben unterschiedliche Audioformate'; return;
      }

      btn.textContent = '[...] Erstelle Datei…';
      const cover = await coverPromise;
      const tags = { title: cleanText(rawBookTitle), artist: cleanText(rawAuthor), album: cleanText(rawBookTitle), cover: cover && cover.bytes ? cover : null };
      const file = buildMergedM4b(chapters, titles, tags);
      const filename = `${sanitize(rawAuthor)} - ${sanitize(rawBookTitle)}.m4b`;
      triggerBlobDownload(new Blob([file], { type: 'audio/mp4' }), filename);
      btn.textContent = `[OK] ${total} Kapitel zusammengeführt`;
    } catch (e) {
      console.error('[ICE DL] merge failed', e);
      btn.textContent = `[FEHLER] ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------

  const COLORS_YELLOW = {
    panelBg:      '#000000',
    headerBg:     '#000000',
    detailBg:     '#000000',
    accent:       '#ffb000', 
    accentHover:  '#ffd23a',
    accentText:   '#000000',   // text sitting on an amber block
    btnBg:        '#000000',
    btnActiveBg:  '#ffb000',
    muted:        '#8a6200',   // dim amber — secondary text / separators
    textLight:    '#ffb000',   // amber — primary text
  };

  const COLORS_TURQUOISE = {
    panelBg:      '#000000',
    headerBg:     '#000000',
    detailBg:     '#000000',
    accent:       '#43B0B6',  // primary turquoise (balanced, readable)
    accentHover:  '#6FE3DA',  // brighter cyan glow (manually corrected toward green)
    accentText:   '#000000',
    btnBg:        '#000000',
    btnActiveBg:  '#43B0B6',
    muted:        '#186A70',  // dim teal (from dark cluster)
    textLight:    '#43B0B6',
  };

  const COLORS_RED = {
    panelBg:      '#000000',
    headerBg:     '#000000',
    detailBg:     '#000000',
    accent:       '#D01E3A',
    accentHover:  '#FF4A6A',
    accentText:   '#000000',
    btnBg:        '#000000',
    btnActiveBg:  '#D01E3A',
    muted:        '#7A1A2A',
    textLight:    '#D01E3A',
  };

  const PALETTES = [COLORS_YELLOW, COLORS_TURQUOISE, COLORS_RED];
  const COLORS = PALETTES[Math.floor(Math.random() * PALETTES.length)];

  // Convert a hex color to [r, g, b] for use in rgba() strings.
  function hexRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 176, 0];
  }

  // Doto (SIL OFL 1.1, https://fonts.google.com/specimen/Doto), wght=900/ROND=100,
  // full basic-Latin + Latin-Extended charsets (covers German umlauts/ß in author
  // and title text). Self-hosted so the LED-style UI renders without a network
  // fetch or hitting the page's CSP.
  const DOT_MATRIX_FONT_LATIN = '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';
  const DOT_MATRIX_FONT_LATIN_EXT = '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';

  function injectDotMatrixFont() {
    if (document.getElementById('ice-dl-font')) return;
    const style = document.createElement('style');
    style.id = 'ice-dl-font';
    style.textContent = `
      @font-face {
        font-family: 'IceDotMatrix';
        src: url(data:font/woff2;base64,${DOT_MATRIX_FONT_LATIN}) format('woff2');
        font-weight: 900;
        font-display: block;
        unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
      }
      @font-face {
        font-family: 'IceDotMatrix';
        src: url(data:font/woff2;base64,${DOT_MATRIX_FONT_LATIN_EXT}) format('woff2');
        font-weight: 900;
        font-display: block;
        unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
      }
    `;
    document.head.appendChild(style);
  }

  // Inline <option> styles can't express :hover/:checked, which is what the
  // open native popup actually uses for its highlight.
  function injectSelectTheme() {
    if (document.getElementById('ice-dl-select-theme')) return;
    const style = document.createElement('style');
    style.id = 'ice-dl-select-theme';
    style.textContent = `
      #ice-dl-panel select { color-scheme: dark; }
      #ice-dl-panel option:checked,
      #ice-dl-panel option:hover {
        background: ${COLORS.accent} !important;
        color: ${COLORS.accentText} !important;
      }
    `;
    document.head.appendChild(style);
  }

  const DISPLAY_FONT = "'IceDotMatrix', Arial, Helvetica, sans-serif";

  function css(el, styles) {
    Object.assign(el.style, styles);
  }

  // Rendered as a run of dot glyphs, not a CSS border, so it matches the font.
  function dotLine(extraStyles = {}) {
    const line = document.createElement('div');
    line.textContent = '•'.repeat(400);
    line.setAttribute('aria-hidden', 'true');
    css(line, {
      overflow:      'hidden',
      whiteSpace:    'nowrap',
      fontFamily:    DISPLAY_FONT,
      fontSize:      '6px',
      lineHeight:    '1',
      letterSpacing: '0.35em',
      height:        '6px',
      color:         COLORS.accent,
      userSelect:    'none',
      flexShrink:    '0',
      ...extraStyles,
    });
    return line;
  }

  function makeButton(label, styles = {}) {
    const btn = document.createElement('button');
    btn.textContent = label;
    css(btn, {
      padding: '4px 8px',
      border: 'none',
      cursor: 'pointer',
      fontSize: '12px',
      fontFamily: DISPLAY_FONT,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      color: COLORS.textLight,
      background: COLORS.btnBg,
      width: 'auto',
      ...styles,
    });
    return btn;
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  const TABS = {
    audiobooks: { label: 'Hörbücher',    load: listBooks, render: renderBooks },
    podcasts:   { label: 'Podcasts',     load: listPodcasts, render: renderPodcasts },
    magazines:  { label: 'Zeitschriften', load: listMagazines, render: renderMagazines },
  };
  let activeTab = 'audiobooks';

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'ice-dl-panel';
    css(panel, {
      position:    'fixed',
      top:         '20px',
      right:       '20px',
      width:       '360px',
      maxHeight:   '82vh',
      display:     'flex',
      flexDirection: 'column',
      background:  COLORS.panelBg,
      color:       COLORS.textLight,
      fontFamily:  DISPLAY_FONT,
      fontSize:    '13px',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      boxShadow:   `0 0 14px rgba(${hexRgb(COLORS.accent).join(',')},0.18)`,  // faint LED glow
      zIndex:      '2147483647',
      boxSizing:   'border-box',
      lineHeight:  '1.5',
    });

    const content = document.createElement('div');
    css(content, { flex: '1', minHeight: '0', overflowY: 'auto', padding: '12px 14px', boxSizing: 'border-box' });
    panel.appendChild(content);

    const header = document.createElement('div');
    css(header, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' });

    const title = document.createElement('strong');
    title.textContent = 'ICEportal-dl Media Downloader';
    css(title, { fontSize: '15px', letterSpacing: '0.06em' });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'X';
    css(closeBtn, { background: 'none', border: 'none', color: COLORS.textLight, cursor: 'pointer', fontFamily: DISPLAY_FONT, fontSize: '16px', lineHeight: '1', width: 'auto' });
    closeBtn.onclick = () => panel.remove();

    header.appendChild(title);
    header.appendChild(closeBtn);

    const tabs = document.createElement('div');
    tabs.id = 'ice-dl-tabs';
    css(tabs, { display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px 0' });
    Object.keys(TABS).forEach(name => {
      const btn = makeButton(TABS[name].label);
      btn.dataset.tab = name;
      btn.onclick = () => switchTab(name);
      tabs.appendChild(btn);
    });

    const status = document.createElement('div');
    status.id = 'ice-dl-status';
    css(status, { color: COLORS.muted, marginBottom: '10px', fontSize: '12px' });
    status.textContent = 'Wird geladen…';

    const list = document.createElement('div');
    list.id = 'ice-dl-list';

    content.appendChild(header);
    content.appendChild(dotLine({ marginBottom: '2px' }));
    content.appendChild(tabs);
    content.appendChild(dotLine({ marginBottom: '10px' }));
    content.appendChild(status);
    content.appendChild(list);
    document.body.appendChild(panel);
    return panel;
  }

  function updateTabStyles() {
    const tabs = document.getElementById('ice-dl-tabs');
    if (!tabs) return;
    [...tabs.children].forEach(btn => {
      const isActive = btn.dataset.tab === activeTab;
      btn.style.background = isActive ? COLORS.btnActiveBg : COLORS.btnBg;
      btn.style.color = isActive ? COLORS.accentText : COLORS.textLight;
    });
  }

  function setStatus(msg, color = COLORS.muted) {
    const el = document.getElementById('ice-dl-status');
    if (el) { el.textContent = msg; el.style.color = color; }
  }

  async function switchTab(name) {
    if (!TABS[name]) return;
    activeTab = name;
    updateTabStyles();
    const list = document.getElementById('ice-dl-list');
    if (list) list.innerHTML = '';
    setStatus('Wird geladen…');
    try {
      const items = await TABS[name].load();
      const count = items.length;
      setStatus(`${count} ${count !== 1 ? 'Einträge' : 'Eintrag'} verfügbar`, COLORS.accent);
      TABS[name].render(items);
    } catch (e) {
      setStatus(`Laden fehlgeschlagen: ${e.message}`, COLORS.accent);
    }
  }

  // ---------------------------------------------------------------------------
  // Audiobook list rendering
  // ---------------------------------------------------------------------------

  // The portal mixes content-type and duration-bucket ("zeit_") ids; split into
  // independent dropdowns since only one value per axis makes sense. Genre is a
  // separate third axis the portal doesn't model as a filter.
  let selectedTypeFilter = '';
  let selectedDurationFilter = '';
  let selectedGenreFilter = '';
  let selectedPodcastTypeFilter = '';
  let selectedPodcastDurationFilter = '';

  function renderBooks(books) {
    const list = document.getElementById('ice-dl-list');
    if (!list) return;
    list.innerHTML = '';

    const filterBar = buildAudiobookFilterBar(books);
    if (filterBar) list.appendChild(filterBar);

    const itemsContainer = document.createElement('div');
    itemsContainer.id = 'ice-dl-book-items';
    list.appendChild(itemsContainer);

    renderBookItems(books, itemsContainer);
    enrichBooksWithAuthor(books, itemsContainer);
  }

  function buildAudiobookFilterBar(books) {
    if (audiobookFilterDefs.length === 0) return null;

    const durationDefs = audiobookFilterDefs
      .filter(f => f.id.startsWith('zeit_'))
      .map(f => ({ ...f, text: DURATION_LABELS[f.id] || f.text.replace(/^Zeit:\s*/, '') }));
    const typeDefs = audiobookFilterDefs.filter(f => !f.id.startsWith('zeit_'));
    const genreDefs = audiobookGenres.map(g => ({ id: g, text: g }));

    const wrapper = document.createElement('div');
    css(wrapper, { marginBottom: '10px' });

    const topRow = document.createElement('div');
    css(topRow, { display: 'flex', gap: '6px', marginBottom: '6px' });

    const rerender = () => renderBookItems(books, document.getElementById('ice-dl-book-items'));

    topRow.appendChild(buildFilterSelect('Alle Kategorien', typeDefs, selectedTypeFilter, value => {
      selectedTypeFilter = value;
      rerender();
    }));
    topRow.appendChild(buildFilterSelect('Alle Längen', durationDefs, selectedDurationFilter, value => {
      selectedDurationFilter = value;
      rerender();
    }));
    wrapper.appendChild(topRow);

    if (genreDefs.length > 0) {
      const genreRow = document.createElement('div');
      css(genreRow, { display: 'flex' });
      genreRow.appendChild(buildFilterSelect('Alle Genres', genreDefs, selectedGenreFilter, value => {
        selectedGenreFilter = value;
        rerender();
      }));
      wrapper.appendChild(genreRow);
    }

    return wrapper;
  }

  function buildFilterSelect(allLabel, defs, selectedValue, onChange) {
    const select = document.createElement('select');
    css(select, {
      flex:         '1',
      padding:      '4px 22px 4px 6px',   // room for our custom arrow on the right
      border:       `1px solid ${COLORS.accent}`,
      color:        COLORS.accentText,
      fontFamily:   DISPLAY_FONT,
      fontSize:     '12px',
      textTransform: 'uppercase',
      // Strip the native control chrome (white bevel/frame).
      appearance:        'none',
      webkitAppearance:  'none',
      mozAppearance:     'none',
      outline:           'none',
      // appearance:none also removes the native arrow, so draw our own amber ▾.
      backgroundColor:    COLORS.accent,
      backgroundImage:    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23000000'/%3E%3C/svg%3E\")",
      backgroundRepeat:   'no-repeat',
      backgroundPosition: 'right 8px center',
    });

    // <option>s need an explicit font-size or they fall back to a larger UA default.
    const baseOptionStyle     = { fontFamily: DISPLAY_FONT, fontSize: '12px', background: COLORS.btnBg, color: COLORS.textLight };
    const selectedOptionStyle = { fontFamily: DISPLAY_FONT, fontSize: '12px', background: COLORS.accent, color: COLORS.accentText };
    const styleFor = value => value === selectedValue ? selectedOptionStyle : baseOptionStyle;

    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = allLabel;
    css(allOption, styleFor(''));
    select.appendChild(allOption);

    defs.forEach(f => {
      const option = document.createElement('option');
      option.value = f.id;
      option.textContent = f.text;
      css(option, styleFor(f.id));
      select.appendChild(option);
    });

    select.value = selectedValue;
    select.onchange = () => onChange(select.value);
    return select;
  }

  function renderBookItems(books, list) {
    if (!list) return;
    list.innerHTML = '';

    const filtered = books.filter(b =>
      (!selectedTypeFilter || b.filterIds.includes(selectedTypeFilter)) &&
      (!selectedDurationFilter || b.filterIds.includes(selectedDurationFilter)) &&
      (!selectedGenreFilter || b.genre === selectedGenreFilter)
    );

    if (filtered.length === 0) {
      list.textContent = books.length === 0
        ? 'Zurzeit keine Hörbücher verfügbar.'
        : 'Keine Hörbücher entsprechen den gewählten Filtern.';
      return;
    }

    filtered.forEach((book, i) => {
      if (i > 0) list.appendChild(dotLine({ margin: '4px 0' }));

      const wrapper = document.createElement('div');
      css(wrapper, { overflow: 'hidden' });

      const rowHeader = document.createElement('div');
      rowHeader.textContent = bookDisplayTitle(book);
      rowHeader.dataset.slug = book.slug;
      css(rowHeader, {
        padding:      '8px 10px',
        cursor:       'pointer',
        background:   COLORS.headerBg,
        userSelect:   'none',
      });
      rowHeader.title = 'Zum Anzeigen der Kapitel klicken';

      const detail = document.createElement('div');
      css(detail, { display: 'none', padding: '8px 10px', background: COLORS.detailBg });

      rowHeader.onclick = async () => {
        const isOpen = detail.style.display !== 'none';
        detail.style.display = isOpen ? 'none' : 'block';
        if (!isOpen && !detail.dataset.loaded) {
          detail.textContent = 'Kapitel werden geladen…';
          try {
            await renderBookDetail(book, detail);
            detail.dataset.loaded = '1';
          } catch (e) {
            detail.textContent = `Fehler: ${e.message}`;
          }
        }
      };

      wrapper.appendChild(rowHeader);
      wrapper.appendChild(detail);
      list.appendChild(wrapper);
    });
  }

  // Author isn't in the list endpoint; it's fetched per book in the background
  // (see enrichBooksWithAuthor) and the row text updated in place once known.
  function bookDisplayTitle(book) {
    const details = bookDetailsCache.get(book.slug);
    return details && details.author ? `${details.author} – ${book.title}` : book.title;
  }

  async function enrichBooksWithAuthor(books, itemsContainer) {
    const missing = books.filter(b => !bookDetailsCache.has(b.slug));
    await mapWithConcurrency(missing, RESOLVE_CONCURRENCY, async book => {
      try {
        await getBookDetails(book.slug);
        const row = itemsContainer.querySelector(`[data-slug="${CSS.escape(book.slug)}"]`);
        if (row) row.textContent = bookDisplayTitle(book);
      } catch (e) {
        console.error('[ICE DL] author fetch failed', book.slug, e);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Chapter list rendering
  // ---------------------------------------------------------------------------

  async function renderBookDetail(book, container) {
    const details = await getBookDetails(book.slug);
    const total   = details.files.length;
    const author  = sanitize(details.author || 'Unbekannt');
    const bookTitle = sanitize(details.title || book.title);
    // Filenames get the sanitized values; embedded tags keep the real ones.
    const rawAuthor = details.author || 'Unbekannt';
    const rawBookTitle = details.title || book.title;
    // Fetch the cover once per book (best-effort) and reuse it for every chapter.
    const coverPromise = fetchCover(details.picture && details.picture.src);

    container.innerHTML = '';

    const meta = document.createElement('div');
    css(meta, { color: COLORS.muted, marginBottom: '8px', fontSize: '11px' });
    const year = details.releaseYear ? ` · ${details.releaseYear}` : '';
    // Two different API shapes: the book-level `duration` is an ISO 8601 string
    // ("PT8H32M"), while per-chapter `duration` (below) is raw seconds as a number.
    const totalDuration = details.duration ? ` · ${formatDuration(parseISODuration(details.duration))}` : '';
    meta.textContent = `${details.author || ''}${year} · ${total} Kapitel${totalDuration}`;
    container.appendChild(meta);

    const dlAllBtn = makeButton(`Alle ${total} Kapitel herunterladen`, {
      background:   COLORS.accent,
      color:        COLORS.accentText,
      marginBottom: '10px',
      padding:      '5px 10px',
      fontSize:     '12px',
    });
    dlAllBtn.onmouseenter = () => { dlAllBtn.style.background = COLORS.accentHover; };
    dlAllBtn.onmouseleave = () => { dlAllBtn.style.background = COLORS.accent; };
    const sorted = [...details.files].sort((a, b) => a.serialNumber - b.serialNumber);

    const tagCtx = { author, bookTitle, rawAuthor, rawBookTitle, total, coverPromise };
    dlAllBtn.onclick = () => downloadAllTracks(sorted, tagCtx, dlAllBtn);
    container.appendChild(dlAllBtn);

    if (total > 1) {
      const mergeBtn = makeButton(`Als eine Datei zusammenführen (.m4b)`, {
        display:      'block',
        width:        '100%',
        textAlign:    'left',
        marginBottom: '10px',
      });
      mergeBtn.title = `Lädt das ganze Buch als eine .m4b mit Kapitelmarken (puffert alle ${total} Kapitel im Speicher)`;
      mergeBtn.onclick = () => mergeBookDownload(sorted, tagCtx, mergeBtn);
      container.appendChild(mergeBtn);
    }

    sorted.forEach(chapter => {
      const durationLabel = chapter.duration ? ` · ${formatDuration(chapter.duration)}` : '';
      const label = `${pad(chapter.serialNumber, total)}. ${cleanText(chapter.title)}${durationLabel}`;

      const btn = makeButton(label, { display: 'block', width: '100%', textAlign: 'left', marginBottom: '4px' });

      btn.onclick = async () => {
        btn.textContent = `[...] ${label}`;
        btn.disabled = true;
        try {
          const url = await resolveChapterURL(chapter.path);
          const filename = buildFilename(author, bookTitle, chapter.serialNumber, chapter.title, total, extFromUrl(url, 'm4a'));
          const tags = buildTags(rawAuthor, rawBookTitle, chapter, total, await coverPromise);
          await downloadTaggedChapter(url, filename, tags);
          btn.textContent = `[OK] ${label}`;
        } catch (e) {
          btn.textContent = `[FEHLER] ${label}`;
          btn.title = e.message;
          btn.disabled = false;
        }
      };

      container.appendChild(btn);
    });
  }

  // Browsers block bursts of auto-downloads, so space out the triggers.
  const DOWNLOAD_TRIGGER_DELAY_MS = 400;

  async function downloadAllTracks(sorted, tagCtx, triggerBtn) {
    const { author, bookTitle, rawAuthor, rawBookTitle, total, coverPromise } = tagCtx;
    triggerBtn.disabled = true;
    try {
      triggerBtn.textContent = `[...] Löse ${total} Kapitel auf…`;
      const resolved = await resolveAll(sorted);
      const cover = await coverPromise;

      let failed = 0;
      for (let i = 0; i < resolved.length; i++) {
        const { chapter, url } = resolved[i];
        triggerBtn.textContent = `[...] Lade ${i + 1}/${total}…`;
        if (!url) { failed++; continue; }
        const filename = buildFilename(author, bookTitle, chapter.serialNumber, chapter.title, total, extFromUrl(url, 'm4a'));
        const tags = buildTags(rawAuthor, rawBookTitle, chapter, total, cover);
        await downloadTaggedChapter(url, filename, tags);
        await delay(DOWNLOAD_TRIGGER_DELAY_MS);
      }
      triggerBtn.textContent = failed
        ? `[WARNUNG] ${total - failed}/${total} gestartet (${failed} fehlgeschlagen)`
        : `[OK] Alle ${total} gestartet`;
    } finally {
      triggerBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Magazine list rendering
  // ---------------------------------------------------------------------------

  function renderMagazines(magazines) {
    const list = document.getElementById('ice-dl-list');
    if (!list) return;
    list.innerHTML = '';

    if (magazines.length === 0) {
      list.textContent = 'Zurzeit keine kostenlosen Zeitschriften verfügbar.';
      return;
    }

    magazines.forEach((magazine, i) => {
      if (i > 0) list.appendChild(dotLine({ margin: '4px 0' }));

      const wrapper = document.createElement('div');
      css(wrapper, { overflow: 'hidden' });

      const rowHeader = document.createElement('div');
      rowHeader.textContent = magazine.title;
      rowHeader.dataset.href = magazine.href;
      css(rowHeader, {
        padding:      '8px 10px',
        cursor:       'pointer',
        background:   COLORS.headerBg,
        userSelect:   'none',
      });
      rowHeader.title = 'Zum Herunterladen klicken';

      rowHeader.onclick = async () => {
        rowHeader.textContent = `[...] ${magazine.title}`;
        rowHeader.style.pointerEvents = 'none';
        try {
          const details = await getMagazineDetails(magazine.href);
          const url = resolveMagazineURL(details);
          const filename = buildMagazineFilename(magazine.title, details.date, details.fileFormat || extFromUrl(url, 'pdf'));
          triggerDownload(url, filename);
          rowHeader.textContent = `[OK] ${magazine.title}`;
        } catch (e) {
          rowHeader.textContent = `[FEHLER] ${magazine.title}`;
          rowHeader.title = e.message;
          rowHeader.style.pointerEvents = '';
        }
      };

      wrapper.appendChild(rowHeader);
      list.appendChild(wrapper);
    });
  }

  // ---------------------------------------------------------------------------
  // Podcast list rendering
  // ---------------------------------------------------------------------------

  function renderPodcasts(podcasts) {
    const list = document.getElementById('ice-dl-list');
    if (!list) return;
    list.innerHTML = '';

    const filterBar = buildPodcastFilterBar(podcasts);
    if (filterBar) list.appendChild(filterBar);

    const itemsContainer = document.createElement('div');
    itemsContainer.id = 'ice-dl-podcast-items';
    list.appendChild(itemsContainer);

    renderPodcastItems(podcasts, itemsContainer);
  }

  function buildPodcastFilterBar(podcasts) {
    if (podcastFilterDefs.length === 0) return null;

    const durationDefs = podcastFilterDefs
      .filter(f => f.id.startsWith('zeit_'))
      .map(f => ({ ...f, text: DURATION_LABELS[f.id] || f.text.replace(/^Zeit:\s*/, '') }));
    const typeDefs = podcastFilterDefs.filter(f => !f.id.startsWith('zeit_'));

    const wrapper = document.createElement('div');
    css(wrapper, { marginBottom: '10px' });

    const topRow = document.createElement('div');
    css(topRow, { display: 'flex', gap: '6px', marginBottom: '6px' });

    const rerender = () => renderPodcastItems(podcasts, document.getElementById('ice-dl-podcast-items'));

    topRow.appendChild(buildFilterSelect('Alle Kategorien', typeDefs, selectedPodcastTypeFilter, value => {
      selectedPodcastTypeFilter = value;
      rerender();
    }));
    topRow.appendChild(buildFilterSelect('Alle Längen', durationDefs, selectedPodcastDurationFilter, value => {
      selectedPodcastDurationFilter = value;
      rerender();
    }));
    wrapper.appendChild(topRow);

    return wrapper;
  }

  function renderPodcastItems(podcasts, list) {
    if (!list) return;
    list.innerHTML = '';

    const filtered = podcasts.filter(p =>
      (!selectedPodcastTypeFilter || p.filterIds.includes(selectedPodcastTypeFilter)) &&
      (!selectedPodcastDurationFilter || p.filterIds.includes(selectedPodcastDurationFilter))
    );

    if (filtered.length === 0) {
      list.textContent = podcasts.length === 0
        ? 'Zurzeit keine Podcasts verfügbar.'
        : 'Keine Podcasts entsprechen den gewählten Filtern.';
      return;
    }

    filtered.forEach((podcast, i) => {
      if (i > 0) list.appendChild(dotLine({ margin: '4px 0' }));

      const wrapper = document.createElement('div');
      css(wrapper, { overflow: 'hidden' });

      const rowHeader = document.createElement('div');
      rowHeader.textContent = podcast.title;
      rowHeader.dataset.slug = podcast.slug;
      css(rowHeader, {
        padding:      '8px 10px',
        cursor:       'pointer',
        background:   COLORS.headerBg,
        userSelect:   'none',
      });
      rowHeader.title = 'Zum Anzeigen der Folgen klicken';

      const detail = document.createElement('div');
      css(detail, { display: 'none', padding: '8px 10px', background: COLORS.detailBg });

      rowHeader.onclick = async () => {
        const isOpen = detail.style.display !== 'none';
        detail.style.display = isOpen ? 'none' : 'block';
        if (!isOpen && !detail.dataset.loaded) {
          detail.textContent = 'Folgen werden geladen…';
          try {
            await renderPodcastDetail(podcast, detail);
            detail.dataset.loaded = '1';
          } catch (e) {
            detail.textContent = `Fehler: ${e.message}`;
          }
        }
      };

      wrapper.appendChild(rowHeader);
      wrapper.appendChild(detail);
      list.appendChild(wrapper);
    });
  }

  async function renderPodcastDetail(podcast, container) {
    const details = await getPodcastDetails(podcast.slug);
    const episodes = details.episodes;
    const author = sanitize(details.author || 'Unbekannt');
    const total = details.files.length;
    const summedDuration = details.files.reduce((sum, f) => sum + (f.duration || 0), 0);

    container.innerHTML = '';

    const meta = document.createElement('div');
    css(meta, { color: COLORS.muted, marginBottom: '8px', fontSize: '11px' });
    meta.textContent = `${author} · ${episodes} Folgen · ${formatDuration(summedDuration)}`;
    container.appendChild(meta);

    const dlAllBtn = makeButton(`Alle ${total} Folgen herunterladen`, {
      background:   COLORS.accent,
      color:        COLORS.accentText,
      marginBottom: '10px',
      padding:      '5px 10px',
      fontSize:     '12px',
    });
    dlAllBtn.onmouseenter = () => { dlAllBtn.style.background = COLORS.accentHover; };
    dlAllBtn.onmouseleave = () => { dlAllBtn.style.background = COLORS.accent; };
    const sorted = [...details.files].sort((a, b) => b.serialNumber - a.serialNumber);

    dlAllBtn.onclick = () => downloadAllEpisodes(sorted, { podcastTitle: podcast.title }, dlAllBtn);
    container.appendChild(dlAllBtn);

    sorted.forEach(episode => {
      const durationLabel = episode.duration ? ` · ${formatDuration(episode.duration)}` : '';
      const label = `${pad(episode.serialNumber, 9999)}. ${cleanText(episode.title)}${durationLabel} · ${episode.releaseDate}`;

      const btn = makeButton(label, { display: 'block', width: '100%', textAlign: 'left', marginBottom: '4px' });

      btn.onclick = async () => {
        btn.textContent = `[...] ${label}`;
        btn.disabled = true;
        try {
          const url = await resolveChapterURL(episode.path);
          const filename = buildPodcastFilename(podcast.title, episode.serialNumber, episode.title, extFromUrl(url, 'mp3'));
          triggerDownload(url, filename);
          btn.textContent = `[OK] ${label}`;
        } catch (e) {
          btn.textContent = `[FEHLER] ${label}`;
          btn.title = e.message;
          btn.disabled = false;
        }
      };

      container.appendChild(btn);
    });
  }

  async function downloadAllEpisodes(sorted, ctx, triggerBtn) {
    const { podcastTitle } = ctx;
    const total = sorted.length;
    triggerBtn.disabled = true;
    try {
      triggerBtn.textContent = `[...] Löse ${total} Folgen auf…`;
      const resolved = await resolveAll(sorted);

      let failed = 0;
      for (let i = 0; i < resolved.length; i++) {
        const { chapter, url } = resolved[i];
        triggerBtn.textContent = `[...] Lade ${i + 1}/${total}…`;
        if (!url) { failed++; continue; }
        const ext = extFromUrl(url, 'mp3');
        const filename = buildPodcastFilename(podcastTitle, chapter.serialNumber, chapter.title, ext);
        triggerDownload(url, filename);
        await delay(DOWNLOAD_TRIGGER_DELAY_MS);
      }
      triggerBtn.textContent = failed
        ? `[WARNUNG] ${total - failed}/${total} gestartet (${failed} fehlgeschlagen)`
        : `[OK] Alle ${total} gestartet`;
    } finally {
      triggerBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Floating toggle button
  // ---------------------------------------------------------------------------

  function buildToggle() {
    injectDotMatrixFont();
    injectSelectTheme();
    const btn = makeButton('iceportal-dl', {
      position:  'fixed',
      bottom:    '24px',
      right:     '24px',
      padding:   '10px 14px',
      boxShadow: `0 0 14px rgba(${hexRgb(COLORS.accent).join(',')},0.35)`,
      zIndex:    '2147483647',
    });
    btn.title = 'ICEportal-dl MediaDownloader';

    btn.onclick = () => {
      const existing = document.getElementById('ice-dl-panel');
      if (existing) { existing.remove(); return; }

      buildPanel();
      updateTabStyles();
      switchTab(activeTab);
    };

    document.body.appendChild(btn);
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildToggle);
  } else {
    buildToggle();
  }
})();
