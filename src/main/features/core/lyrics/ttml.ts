/**
 * ttml.ts — Apple TTML / iTunes Timed Lyrics parser
 * Location: src/main/features/core/lyrics/ttml.ts
 *
 * Parses Apple-format TTML documents (stored in the LYRICS vorbis comment
 * tag of FLAC files, or in M4A lyric atoms) into the SynchronizedLyricsArray
 * that synchronized-lyrics.tsx consumes — no changes to the display layer.
 *
 * Output type:  SynchronizedLyricsArray = Array<[timeInMs: number, text: string]>
 *
 * ── Apple TTML document structure ───────────────────────────────────────────
 *
 *  <?xml version="1.0" encoding="UTF-8"?>
 *  <tt xmlns="http://www.w3.org/ns/ttml"
 *      xmlns:ttm="http://www.w3.org/ns/ttml#metadata"
 *      xmlns:itunes="http://itunes.apple.com/lyric-ttml-extensions"
 *      xml:lang="en-US">
 *    <head>
 *      <metadata>
 *        <ttm:title>Song Title</ttm:title>
 *        <ttm:agent type="person" xml:id="v1">
 *          <ttm:name type="full">Artist Name</ttm:name>
 *        </ttm:agent>
 *      </metadata>
 *    </head>
 *    <body dur="MM:SS.FFF">
 *      <div begin="MM:SS.FFF" end="MM:SS.FFF" itunes:song-part="Verse">
 *
 *        <!-- Line-by-line: text lives directly inside <p> -->
 *        <p begin="MM:SS.FFF" end="MM:SS.FFF" ttm:agent="v1">City of stars</p>
 *
 *        <!-- Beat-by-beat: <span> children carry word-level timing -->
 *        <p begin="MM:SS.FFF" end="MM:SS.FFF" ttm:agent="v1">
 *          <span begin="MM:SS.FFF" end="MM:SS.FFF">I</span>
 *          <span begin="MM:SS.FFF" end="MM:SS.FFF">don't</span>
 *          <!-- Background vocal container — skip entirely -->
 *          <span ttm:role="x-bg">
 *            <span begin="MM:SS.FFF" end="MM:SS.FFF">ooh</span>
 *          </span>
 *        </p>
 *      </div>
 *    </body>
 *  </tt>
 *
 * ── How TTML enters Feishin ──────────────────────────────────────────────────
 *
 *  SOURCE                            FEISHIN RECEIVES           PARSER NEEDED
 *  FLAC LYRICS vorbis comment        song.lyrics (raw XML)      YES ← primary
 *  M4A lyric atom                    song.lyrics (raw XML)      YES
 *  Navidrome getLyricsBySongId       StructuredLyric[] JSON      No (pre-parsed)
 *  Jellyfin getLyrics                plain text / LRC            No
 *  Internet providers                plain text / LRC            No
 *
 *  Navidrome does not parse TTML itself. When Navidrome scans a FLAC whose
 *  LYRICS vorbis comment contains Apple TTML, it passes the raw XML string
 *  through unchanged as song.lyrics. formatLyrics() in lyrics-api.ts calls
 *  isTTML() first; if true, parseTTML() converts it to SynchronizedLyricsArray.
 *
 * ── Apple spec notes (Apple Video and Audio Asset Guide §TTML File Format) ───
 *
 *  • Time format: SMIL clock-value  [HH:]MM:SS[.FFF]  (§Timing)
 *  • <br> is FORBIDDEN — Apple explicitly forbids it; <p> tags delimit lines
 *  • Beat-by-beat: use <p begin> as line timestamp; concatenate <span> text
 *  • <span ttm:role="x-bg">: background-vocal container — skip for main display
 *  • itunes:song-part on <div>: section annotation — not displayed (per Apple)
 *  • Both begin AND end are required wherever timing is applied (spec rule)
 */

import type { SynchronizedLyricsArray } from '/@/shared/types/domain-types';

// ── Namespace constants ──────────────────────────────────────────────────────

const NS_TTML = 'http://www.w3.org/ns/ttml';
const NS_TTM  = 'http://www.w3.org/ns/ttml#metadata';

/** Apple's ttm:role value that marks a <span> as a background-vocal container. */
const ROLE_BG = 'x-bg';

// ── Time parsing ─────────────────────────────────────────────────────────────

/**
 * Convert an Apple TTML time string to milliseconds.
 *
 * Apple spec (§Timing) defines time as a SMIL clock-value:
 *   "Hours? Minutes Seconds . Fraction up to 3 digits?"
 *
 * Accepted forms:
 *   MM:SS[.FFF]      "00:09.327"  →   9 327 ms   ← primary Apple format
 *   HH:MM:SS[.FFF]   "00:01:05"   →  65 000 ms
 *   <n>s             "9.327s"     →   9 327 ms
 *   <n>ms            "9327ms"     →   9 327 ms
 *
 * Returns null when the string cannot be parsed; callers skip that element.
 */
export function parseTTMLTime(timeStr: string): number | null {
    if (!timeStr) return null;
    const t = timeStr.trim();

    // Explicit millisecond suffix  "9327ms"
    const msMatch = t.match(/^(\d+(?:\.\d+)?)ms$/i);
    if (msMatch) return Math.round(parseFloat(msMatch[1]));

    // Explicit second suffix  "9.327s"
    const sMatch = t.match(/^(\d+(?:\.\d+)?)s$/i);
    if (sMatch) return Math.round(parseFloat(sMatch[1]) * 1000);

    // SMIL clock-value — branch by colon count for clarity
    const parts = t.split(':');

    if (parts.length === 2) {
        // MM:SS[.FFF]  — primary Apple TTML form
        const minutes = parseInt(parts[0], 10);
        const seconds = parseFloat(parts[1]);
        if (isNaN(minutes) || isNaN(seconds)) return null;
        return Math.round((minutes * 60 + seconds) * 1000);
    }

    if (parts.length === 3) {
        // HH:MM:SS[.FFF]
        const hours   = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        const seconds = parseFloat(parts[2]);
        if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) return null;
        return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
    }

    return null;
}

// ── XML helper ───────────────────────────────────────────────────────────────

/**
 * Parse an XML string into a Document.
 *
 * Electron renderer process: DOMParser (always available — standard browser API).
 * Electron main process:     @xmldom/xmldom fallback. The require() is guarded
 *                            by /* @vite-ignore * / so the renderer bundle does
 *                            not attempt to include a Node.js module. In the
 *                            renderer this branch is dead code because
 *                            typeof DOMParser !== 'undefined' is always true.
 */
function parseXml(xmlString: string): Document | null {
    try {
        if (typeof DOMParser !== 'undefined') {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlString, 'application/xml');
            if (doc.querySelector('parsererror')) {
                console.error(
                    '[TTML] XML parse error:',
                    doc.querySelector('parsererror')?.textContent?.slice(0, 200),
                );
                return null;
            }
            return doc;
        }
        // Main-process fallback. Cast to `any` because `typeof DOMParser` is
        // `never` in tsconfig.node.json (no DOM lib), which made the previous
        // typed cast produce a non-constructable `never` type.
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
        const xmldom = require(/* @vite-ignore */ '@xmldom/xmldom') as any;
        return new xmldom.DOMParser().parseFromString(xmlString, 'application/xml') as Document;
    } catch (err) {
        console.error('[TTML] Failed to parse XML:', err);
        return null;
    }
}

// ── Attribute helpers ────────────────────────────────────────────────────────

/**
 * Returns true when an element carries the given ttm:role value.
 * Tries the namespaced form first, then the prefixed plain form — handles
 * documents where the ttm prefix resolves differently.
 */
function hasRole(el: Element, role: string): boolean {
    return (
        el.getAttributeNS(NS_TTM, 'role') === role ||
        el.getAttribute('ttm:role') === role
    );
}

// ── Text extraction ──────────────────────────────────────────────────────────

/**
 * Extract the displayable lyric text from a single <p> element.
 *
 * Apple TTML rules applied:
 *  - No <br> handling — Apple spec explicitly forbids <br>; <p> delimits lines.
 *  - Direct text nodes inside <p>   → line-by-line mode.
 *  - Timed <span> children          → beat-by-beat mode; text concatenated.
 *  - <span ttm:role="x-bg">         → background-vocal container; entire
 *    subtree is skipped. Apple Music renders these on a separate visual layer
 *    that Feishin does not yet support.
 *  - Nested <span> inside non-bg    → included recursively.
 */
function extractLineText(p: Element): string {
    const tokens: string[] = [];

    function walk(node: Node): void {
        if (node.nodeType === 3 /* TEXT_NODE */) {
            const t = (node.textContent ?? '').replace(/\s+/g, ' ');
            if (t.trim()) tokens.push(t);
        } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
            const el = node as Element;
            if (el.localName.toLowerCase() === 'span' && hasRole(el, ROLE_BG)) {
                return; // skip entire background-vocal subtree
            }
            Array.from(el.childNodes).forEach(walk);
        }
    }

    Array.from(p.childNodes).forEach(walk);
    return tokens.join('').replace(/\s+/g, ' ').trim();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a TTML document string into a SynchronizedLyricsArray.
 *
 * Each timed <p begin="…"> inside <body> becomes one [timeMs, text] entry.
 * For beat-by-beat documents, <p begin> gives the line activation time and
 * all <span> text is concatenated (Feishin supports line-level sync only).
 *
 * Returns null when:
 *  - The input is not valid XML.
 *  - No <p> elements with a parseable begin attribute exist.
 * Callers (formatLyrics) fall through to unsynchronised display on null.
 */
export function parseTTML(ttmlString: string): SynchronizedLyricsArray | null {
    const doc = parseXml(ttmlString);
    if (!doc) return null;

    // Namespace-aware triple lookup — survives minimal / mis-namespaced documents
    const body =
        doc.getElementsByTagNameNS(NS_TTML, 'body')[0] ??
        doc.getElementsByTagNameNS('*', 'body')[0] ??
        doc.getElementsByTagName('body')[0];

    if (!body) {
        console.warn('[TTML] No <body> element found.');
        return null;
    }

    const paragraphs = Array.from(body.getElementsByTagName('p'));
    if (paragraphs.length === 0) {
        console.warn('[TTML] No <p> elements found.');
        return null;
    }

    const result: SynchronizedLyricsArray = [];

    for (const p of paragraphs) {
        const beginAttr = p.getAttribute('begin');
        if (!beginAttr) continue; // untimed paragraph — skip

        const timeMs = parseTTMLTime(beginAttr);
        if (timeMs === null) {
            console.warn(`[TTML] Unparseable begin="${beginAttr}" — skipping line.`);
            continue;
        }

        const text = extractLineText(p);
        if (!text) continue; // blank / whitespace-only

        result.push([timeMs, text]);
    }

    if (result.length === 0) return null;

    // Sort ascending — TTML is usually pre-ordered, but spec does not mandate it
    result.sort((a, b) => a[0] - b[0]);
    return result;
}

/**
 * Fast heuristic: returns true when the string looks like an Apple TTML document.
 *
 * Scans only the first 512 characters to avoid overhead on large strings.
 * Called by formatLyrics() before any XML parsing cost is incurred.
 *
 * Checks for:
 *  - TTML namespace URI          — present on every valid TTML root element
 *  - Apple itunes extension URI  — unique to Apple TTML lyrics files
 *  - XML declaration + <tt …>   — fallback for loosely-namespaced documents
 */
export function isTTML(content: string): boolean {
    const head = content.trimStart().slice(0, 512);
    return (
        head.includes('http://www.w3.org/ns/ttml') ||
        head.includes('http://itunes.apple.com/lyric-ttml-extensions') ||
        /^<\?xml[^>]*\?>[\s\S]{0,200}<tt[\s>]/m.test(head)
    );
}
