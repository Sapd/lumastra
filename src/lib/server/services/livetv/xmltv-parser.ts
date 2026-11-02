// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('XmltvParser');

// ── Types ──────────────────────────────────────────────────────────────

/** Parsed channel data from XMLTV format */
export interface XmltvChannel {
    /** channel id attribute (for EPG matching) */
    id: string;
    /** <display-name> text content */
    displayName: string;
    /** <icon src="..."> if present */
    iconUrl: string | undefined;
}

/** Parsed programme data from XMLTV format */
export interface XmltvProgram {
    /** programme channel attribute */
    channelId: string;
    /** <title> text content */
    title: string;
    /** <desc> text content (undefined if missing/empty) */
    description: string | undefined;
    /** ISO 8601 with timezone: "2026-03-09T05:15:00+01:00" */
    startTime: string;
    /** ISO 8601 with timezone: "2026-03-09T05:45:00+01:00" */
    endTime: string;
    /** <category> elements (multiple per programme, empty array if none) */
    genres: string[];
    /** <rating><value>...</value></rating> (undefined if missing) */
    officialRating: string | undefined;
}

/**
 * Routine guide noise the importer reports as notes instead of warnings. Set
 * only on the warnings it routes; everything else is an operator-visible warning.
 */
export type XmltvWarningKind =
    'duplicate-channel-id' | 'description-truncated' | 'zero-duration' | 'inverted-range';

/** Result of parsing an XMLTV file */
export interface XmltvImportResult {
    channels: XmltvChannel[];
    programs: XmltvProgram[];
    channelCount: number;
    programCount: number;
    skipped: number;
    errors: Array<{ line?: number; element: string; reason: string }>;
    warnings: Array<{ element: string; field: string; message: string; kind?: XmltvWarningKind }>;
}

// ── Constants ──────────────────────────────────────────────────────────

/**
 * Maximum input size (100 MiB). The XMLTV fetch ceiling (`XMLTV_MAX_FETCH_BYTES`
 * in fetch-source.ts) is the same number, so a body the fetch accepts is never
 * rejected here.
 */
export const MAX_INPUT_SIZE = 100 * 1024 * 1024;

/** Maximum description length — truncate to prevent DB bloat */
const MAX_DESCRIPTION_LENGTH = 5000;

/** Maximum title length — reject absurdly long titles */
const MAX_TITLE_LENGTH = 500;

/** Maximum channel display name length */
const MAX_DISPLAY_NAME_LENGTH = 500;

/**
 * A real <programme> or <channel> element is a few KB. A larger one is skipped
 * unread: its fields are extracted with regexes, and a provider is untrusted.
 */
const MAX_ELEMENT_BODY = 64 * 1024;

/** Elements kept per document; no real guide is anywhere near either. */
const MAX_CHANNELS = 100_000;
const MAX_PROGRAMMES = 2_000_000;

// ── Regex patterns ─────────────────────────────────────────────────────

// Opening tags are matched sticky at a position found with indexOf, and the
// element body runs to the next closing tag found with indexOf (see
// scanElements): a lazy `[\s\S]*?` retried from every opener made unterminated
// openers quadratic. The attribute spans are bounded for the same reason.
const CHANNEL_OPEN = /<channel\s+id="([^"]{0,1024})">/y;
const PROGRAMME_OPEN = /<programme\s+([^>]{0,4096})>/y;
const DISPLAY_NAME_REGEX = /<display-name>([^<]*)<\/display-name>/;
const ICON_REGEX = /<icon\s[^>]*src="([^"]*)"[^>]*>/;
const TITLE_REGEX = /<title>([^<]*)<\/title>/;
const DESC_REGEX = /<desc>([\s\S]*?)<\/desc>/;
const CATEGORY_REGEX = /<category>([^<]*)<\/category>/g;
const ATTR_REGEX = /([\w-]{1,64})="([^"]*)"/g;

/** NUL and other control characters: Postgres rejects 0x00 and fails the whole import. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function cleanValue(value: string): string {
    return value.replace(CONTROL_CHARS, '');
}

// ── Exported helpers ───────────────────────────────────────────────────

/**
 * Decode standard XML entities. Required for regex-based parsing
 * since no SAX parser handles it automatically.
 */
export function decodeXmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, codeStr) => {
            const code = Number(codeStr);
            if (code > 0x10ffff) return '';
            return String.fromCodePoint(code);
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
            const code = parseInt(hex as string, 16);
            if (code > 0x10ffff) return '';
            return String.fromCodePoint(code);
        });
}

/**
 * Parse XMLTV time format to ISO 8601 string.
 * Exported for reuse by Story 2.9 (scheduled refresh timestamp diffing).
 *
 * @param timeStr - XMLTV time: "YYYYMMDDHHMMSS +HHMM" or "YYYYMMDDHHMMSS"
 * @returns ISO 8601 string or undefined if unparseable
 */
export function parseXmltvTime(timeStr: string): string | undefined {
    if (!timeStr || !timeStr.trim()) return undefined;
    const match = timeStr
        .trim()
        .match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(?:(\d{2}))?)?\s*([+-]\d{4})?$/);
    if (!match) return undefined;
    const [, year, month, day, hourRaw, minuteRaw, secondRaw, tz] = match;
    const hour = hourRaw ?? '00';
    const minute = minuteRaw ?? '00';
    const second = secondRaw ?? '00';
    const tzFormatted = tz
        ? `${tz.slice(0, 3)}:${tz.slice(3)}` // "+0100" → "+01:00"
        : 'Z'; // no timezone → UTC
    return `${year}-${month}-${day}T${hour}:${minute}:${second}${tzFormatted}`;
}

// ── Main parser ────────────────────────────────────────────────────────

/**
 * Strip XML/DTD entity declarations to prevent entity expansion attacks
 * (billion laughs / XML bomb). Since we use regex parsing, custom entities
 * would not be expanded anyway, but strip them defensively.
 */
function stripEntityDeclarations(content: string): string {
    // Remove inline DTD with entity declarations: <!DOCTYPE tv [ <!ENTITY ... > ]>
    // (a plain `<!DOCTYPE tv>` without a subset stays). Walks with indexOf: the
    // regex form retried a lazy scan to the end of the input from every opener.
    const parts: string[] = [];
    let copiedTo = 0;
    let pos = 0;
    // -2 = not looked up yet, -1 = none left. Cached so a run of `<!DOCTYPE x>`
    // without a subset does not rescan to the end of the input for each one.
    let bracket = -2;
    let tagEnd = -2;
    for (;;) {
        const start = content.indexOf('<!DOCTYPE', pos);
        if (start === -1) break;
        const from = start + '<!DOCTYPE'.length;
        if (bracket !== -1 && bracket < from) bracket = content.indexOf('[', from);
        if (bracket === -1) break;
        if (tagEnd !== -1 && tagEnd < from) tagEnd = content.indexOf('>', from);
        if (tagEnd !== -1 && tagEnd < bracket) {
            pos = from;
            continue;
        }
        const close = content.indexOf(']>', bracket);
        // No `]>` anywhere after this subset opens: none can follow either.
        if (close === -1) break;
        parts.push(content.slice(copiedTo, start));
        copiedTo = close + 2;
        pos = copiedTo;
    }
    if (copiedTo === 0) return content;
    parts.push(content.slice(copiedTo));
    return parts.join('');
}

/**
 * Remove `<...>` spans. `/<[^>]*>/g` retried a scan to the end of the text from
 * every `<`, quadratic on the `&lt;` run a provider can decode into one.
 */
function stripTags(text: string): string {
    if (text.indexOf('<') === -1) return text;
    let out = '';
    let pos = 0;
    for (;;) {
        const open = text.indexOf('<', pos);
        if (open === -1) break;
        const close = text.indexOf('>', open + 1);
        // No `>` left: nothing after this point is a tag.
        if (close === -1) break;
        out += text.slice(pos, open);
        pos = close + 1;
    }
    return out + text.slice(pos);
}

/**
 * The first `<value>` of a `<rating>` block. Linear: the former
 * `<rating>[\s\S]*?<value>([^<]*)</value>[\s\S]*?</rating>` was cubic on
 * repeated `<rating><value>x</value>` inside one programme.
 */
function findRatingValue(body: string): string | undefined {
    const ratingStart = body.indexOf('<rating>');
    if (ratingStart === -1) return undefined;
    const ratingEnd = body.lastIndexOf('</rating>');
    let valueStart = body.indexOf('<value>', ratingStart);
    while (valueStart !== -1) {
        const textStart = valueStart + '<value>'.length;
        const lt = body.indexOf('<', textStart);
        if (lt === -1) return undefined;
        if (body.startsWith('</value>', lt)) {
            const afterValue = lt + '</value>'.length;
            // `</rating>` must follow the value.
            if (ratingEnd >= afterValue) return body.slice(textStart, lt);
            return undefined;
        }
        valueStart = body.indexOf('<value>', textStart);
    }
    return undefined;
}

interface ScannedElement {
    open: RegExpExecArray;
    /** The text between the tags, or null when it is larger than MAX_ELEMENT_BODY. */
    body: string | null;
}

/**
 * Walk `<tag ...>...</tag>` elements with indexOf. A closing tag that is missing
 * ends the scan: no later opener can have one either.
 */
function* scanElements(content: string, tag: string, openRe: RegExp): Generator<ScannedElement> {
    const openMarker = `<${tag}`;
    const closeMarker = `</${tag}>`;
    let pos = 0;
    for (;;) {
        const start = content.indexOf(openMarker, pos);
        if (start === -1) return;
        openRe.lastIndex = start;
        const open = openRe.exec(content);
        if (!open) {
            pos = start + openMarker.length;
            continue;
        }
        const bodyStart = start + open[0].length;
        const close = content.indexOf(closeMarker, bodyStart);
        if (close === -1) return;
        yield {
            open,
            body: close - bodyStart > MAX_ELEMENT_BODY ? null : content.slice(bodyStart, close),
        };
        pos = close + closeMarker.length;
    }
}

/**
 * Sanitize a text value extracted from XML.
 * Strips HTML tags, control characters, and limits length.
 * All XMLTV input is untrusted — a malicious provider could inject
 * HTML/script tags in titles or descriptions.
 */
function sanitizeText(
    text: string,
    maxLength: number,
    opts?: { preserveParagraphs?: boolean },
): string {
    // Strip HTML tags (prevents XSS if values reach frontend)
    const noHtml = stripTags(text);
    // Strip control characters (except newline, tab, carriage return)
    // eslint-disable-next-line no-control-regex
    const cleaned = noHtml.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    let normalized: string;
    if (opts?.preserveParagraphs) {
        // Normalize line endings, preserve double-newlines as paragraph breaks
        normalized = cleaned
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[^\S\n]+/g, ' ')
            .trim();
    } else {
        // Collapse all whitespace into single space (titles, display names)
        normalized = cleaned.replace(/\s+/g, ' ').trim();
    }
    return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

/**
 * Parse XMLTV content and extract channels and programmes.
 * Uses regex-based parsing — no external XML library required.
 * XMLTV has a flat, predictable structure that makes this safe.
 *
 * Security: All input is treated as untrusted. Entity declarations are stripped,
 * text values are sanitized and length-limited, and input size is capped.
 */
export function parseXmltv(content: string): XmltvImportResult {
    const channels: XmltvChannel[] = [];
    const programs: XmltvProgram[] = [];
    const errors: XmltvImportResult['errors'] = [];
    const warnings: XmltvImportResult['warnings'] = [];
    let skipped = 0;

    if (!content || !content.trim()) {
        return {
            channels,
            programs,
            channelCount: 0,
            programCount: 0,
            skipped: 0,
            errors,
            warnings,
        };
    }

    // Security: reject oversized input to prevent DoS
    if (content.length > MAX_INPUT_SIZE) {
        errors.push({
            element: 'document',
            reason: `Input too large: ${(content.length / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_INPUT_SIZE / 1024 / 1024}MB limit`,
        });
        logger.error(
            `XMLTV input rejected: ${(content.length / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_INPUT_SIZE / 1024 / 1024}MB limit`,
        );
        return {
            channels,
            programs,
            channelCount: 0,
            programCount: 0,
            skipped: 0,
            errors,
            warnings,
        };
    }

    // Security: strip entity declarations to prevent XML bomb attacks
    const safeContent = stripEntityDeclarations(content);

    const channelIds = new Set<string>();

    // ── Parse channels ─────────────────────────────────────────────

    for (const element of scanElements(safeContent, 'channel', CHANNEL_OPEN)) {
        if (channelIds.size >= MAX_CHANNELS) {
            errors.push({
                element: 'document',
                reason: `Channel limit of ${MAX_CHANNELS} reached; the remaining channels are ignored`,
            });
            break;
        }
        const id = cleanValue(element.open[1]);
        const body = element.body;
        if (body === null) {
            errors.push({ element: 'channel', reason: 'Channel element too large' });
            skipped++;
            continue;
        }

        const displayNameMatch = body.match(DISPLAY_NAME_REGEX);
        if (!displayNameMatch || !displayNameMatch[1].trim()) {
            errors.push({
                element: 'channel',
                reason: `Channel missing <display-name>${id ? ` (id="${id}")` : ''}`,
            });
            logger.warn('XMLTV parse error', {
                element: 'channel',
                id,
                error: 'Missing <display-name>',
            });
            skipped++;
            continue;
        }

        const displayName = sanitizeText(
            decodeXmlEntities(displayNameMatch[1]),
            MAX_DISPLAY_NAME_LENGTH,
        );
        const iconMatch = body.match(ICON_REGEX);
        const iconUrl = iconMatch ? cleanValue(decodeXmlEntities(iconMatch[1])) : undefined;

        if (id === '') {
            // Auto-generate an ID from display name so this channel can still
            // participate in EPG matching (fuzzy name-based)
            const slug = displayName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/(^-|-$)/g, '');
            if (!slug) {
                warnings.push({
                    element: 'channel',
                    field: 'id',
                    message: `Channel with empty ID and unusable display name: "${displayName}"`,
                });
                continue;
            }
            const generated = `_auto:${slug}`;
            if (!channelIds.has(generated)) {
                channelIds.add(generated);
                channels.push({ id: generated, displayName, iconUrl });
            } else {
                warnings.push({
                    element: 'channel',
                    field: 'id',
                    message: `Duplicate auto-generated ID for empty-ID channel: "${displayName}"`,
                });
            }
            // Skip the normal push below
            continue;
        } else if (channelIds.has(id)) {
            warnings.push({
                element: 'channel',
                field: 'id',
                kind: 'duplicate-channel-id',
                message: `Duplicate channel ID: "${id}" (displayName="${displayName}")`,
            });
        }

        channelIds.add(id);
        channels.push({ id, displayName, iconUrl });
    }

    // ── Parse programmes ───────────────────────────────────────────

    let seenProgrammes = 0;
    for (const element of scanElements(safeContent, 'programme', PROGRAMME_OPEN)) {
        if (++seenProgrammes > MAX_PROGRAMMES) {
            errors.push({
                element: 'document',
                reason: `Programme limit of ${MAX_PROGRAMMES} reached; the remaining programmes are ignored`,
            });
            break;
        }
        const attrStr = element.open[1];
        const body = element.body;
        if (body === null) {
            errors.push({ element: 'programme', reason: 'Programme element too large' });
            skipped++;
            continue;
        }

        // Extract attributes
        const attrs: Record<string, string> = {};
        let attrM: RegExpExecArray | null;
        ATTR_REGEX.lastIndex = 0;
        while ((attrM = ATTR_REGEX.exec(attrStr)) !== null) {
            attrs[attrM[1]] = cleanValue(attrM[2]);
        }

        const channelId = attrs['channel'];
        const startRaw = attrs['start'];
        const stopRaw = attrs['stop'];

        // Validate required attributes
        if (!channelId) {
            errors.push({
                element: 'programme',
                reason: 'Missing channel attribute',
            });
            logger.warn('XMLTV parse error', {
                element: 'programme',
                error: 'Missing channel attribute',
            });
            skipped++;
            continue;
        }

        if (!startRaw) {
            errors.push({
                element: 'programme',
                reason: `Missing start attribute (channel="${channelId}")`,
            });
            logger.warn('XMLTV parse error', {
                element: 'programme',
                channel: channelId,
                error: 'Missing start attribute',
            });
            skipped++;
            continue;
        }

        if (!stopRaw) {
            errors.push({
                element: 'programme',
                reason: `Missing stop attribute (channel="${channelId}")`,
            });
            logger.warn('XMLTV parse error', {
                element: 'programme',
                channel: channelId,
                error: 'Missing stop attribute',
            });
            skipped++;
            continue;
        }

        // Parse times
        const startTime = parseXmltvTime(startRaw);
        if (!startTime) {
            errors.push({
                element: 'programme',
                reason: `Invalid start time "${startRaw}" (channel="${channelId}")`,
            });
            logger.warn('XMLTV parse error', {
                element: 'programme',
                channel: channelId,
                error: `Invalid start time: ${startRaw}`,
            });
            skipped++;
            continue;
        }

        const noTzStart = !startRaw.trim().match(/[+-]\d{4}$/);
        if (noTzStart) {
            warnings.push({
                element: 'programme',
                field: 'start',
                message: `Time without timezone: "${startRaw}" (channel="${channelId}") — assumed UTC`,
            });
        }

        const endTime = parseXmltvTime(stopRaw);
        if (!endTime) {
            errors.push({
                element: 'programme',
                reason: `Invalid stop time "${stopRaw}" (channel="${channelId}")`,
            });
            logger.warn('XMLTV parse error', {
                element: 'programme',
                channel: channelId,
                error: `Invalid stop time: ${stopRaw}`,
            });
            skipped++;
            continue;
        }

        const noTzStop = !stopRaw.trim().match(/[+-]\d{4}$/);
        if (noTzStop) {
            warnings.push({
                element: 'programme',
                field: 'stop',
                message: `Time without timezone: "${stopRaw}" (channel="${channelId}") — assumed UTC`,
            });
        }

        // Extract title
        const titleMatch = body.match(TITLE_REGEX);
        if (!titleMatch || !titleMatch[1].trim()) {
            errors.push({
                element: 'programme',
                reason: `Missing or empty <title> (channel="${channelId}", start="${startRaw}")`,
            });
            logger.warn('XMLTV parse error', {
                element: 'programme',
                channel: channelId,
                start: startRaw,
                error: 'Missing or empty <title>',
            });
            skipped++;
            continue;
        }

        const title = sanitizeText(decodeXmlEntities(titleMatch[1]), MAX_TITLE_LENGTH);

        // Extract description (optional)
        const descMatch = body.match(DESC_REGEX);
        let description: string | undefined;
        if (descMatch && descMatch[1].trim()) {
            const rawDesc = decodeXmlEntities(descMatch[1]);
            const cleanDesc = sanitizeText(
                rawDesc,
                MAX_DESCRIPTION_LENGTH + 1, // +1 to detect truncation
                { preserveParagraphs: true },
            );
            if (cleanDesc.length > MAX_DESCRIPTION_LENGTH) {
                warnings.push({
                    element: 'programme',
                    field: 'description',
                    kind: 'description-truncated',
                    message: `Description truncated to ${MAX_DESCRIPTION_LENGTH} chars (channel="${channelId}", title="${title}")`,
                });
                description = cleanDesc.slice(0, MAX_DESCRIPTION_LENGTH);
            } else if (cleanDesc) {
                description = cleanDesc;
            }
        }

        // Extract genres from <category> elements
        const genres: string[] = [];
        let catMatch: RegExpExecArray | null;
        CATEGORY_REGEX.lastIndex = 0;
        while ((catMatch = CATEGORY_REGEX.exec(body)) !== null) {
            const genre = cleanValue(decodeXmlEntities(catMatch[1].trim()));
            if (genre) {
                genres.push(genre);
            }
        }

        // Extract official rating
        let officialRating: string | undefined;
        const ratingRaw = findRatingValue(body);
        if (ratingRaw && ratingRaw.trim()) {
            officialRating = cleanValue(decodeXmlEntities(ratingRaw.trim()));
        }

        // Warn if channel ID not in channel list
        if (!channelIds.has(channelId)) {
            warnings.push({
                element: 'programme',
                field: 'channel',
                message: `Programme references unknown channel "${channelId}" (title="${title}")`,
            });
        }

        // Warn on temporal anomalies (start >= stop)
        // Compare via epoch ms to handle different timezone offsets correctly
        const startMs = new Date(startTime).getTime();
        const endMs = new Date(endTime).getTime();
        if (isNaN(startMs) || isNaN(endMs)) {
            warnings.push({
                element: 'programme',
                field: 'time',
                message: `Programme has unparseable time after ISO conversion: start="${startTime}" stop="${endTime}" (channel="${channelId}", title="${title}")`,
            });
            skipped++;
            continue;
        }
        if (startMs >= endMs) {
            const kind: XmltvWarningKind = startMs === endMs ? 'zero-duration' : 'inverted-range';
            const anomalyType = kind === 'zero-duration' ? 'zero-duration' : 'inverted';
            warnings.push({
                element: 'programme',
                field: 'time',
                kind,
                message: `Programme has ${anomalyType} time range: start="${startRaw}" stop="${stopRaw}" (channel="${channelId}", title="${title}")`,
            });
            skipped++;
            continue;
        }

        programs.push({
            channelId,
            title,
            description,
            startTime,
            endTime,
            genres,
            officialRating,
        });
    }

    return {
        channels,
        programs,
        channelCount: channels.length,
        programCount: programs.length,
        skipped,
        errors,
        warnings,
    };
}
