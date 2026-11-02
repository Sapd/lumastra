// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Logger } from '$lib/server/utils/logger.js';
import { resolveSafePublicUrl } from '$lib/server/utils/ssrf-guard.js';
import { config } from '$lib/server/config.js';
import { redactLiveTvUrl, redactLiveTvUrlsInText } from '$lib/shared/livetv-url-redaction.js';

const logger = Logger.for('M3uParser');

// ── Types ──────────────────────────────────────────────────────────────

/** Parsed channel data from M3U Plus format before database persistence */
export interface M3uChannel {
    /** tvg-id attribute (for EPG matching in Story 2.5) */
    tvgId: string | undefined;
    /** tvg-name attribute */
    tvgName: string | undefined;
    /** Display name from EXTINF line (after last comma) */
    name: string;
    /** tvg-logo attribute */
    logoUrl: string | undefined;
    /** group-title attribute (raw, normalization in Story 2.4) */
    groupTitle: string | undefined;
    /** URL line following EXTINF */
    streamUrl: string;
    /** Extracted from tvg-id suffix: "Nordwelle.de" → "de", "OSK1.at" → "at" */
    countryCode: string | undefined;
    /** Any additional EXTINF attributes not explicitly parsed */
    extras: Record<string, string>;
}

/** Result of parsing an M3U file — shared contract for import operations */
export interface ImportResult {
    imported: number;
    skipped: number;
    channels: M3uChannel[];
    errors: Array<{ line: number; content: string; reason: string }>;
    warnings: Array<{ line: number; field: string; message: string }>;
}

// ── Helpers ────────────────────────────────────────────────────────────

const KNOWN_ATTRS = new Set(['tvg-id', 'tvg-name', 'tvg-logo', 'group-title']);
// The key is bounded: an unbounded `[\w-]+` retried the whole word run from every
// start position, so one 160 KB `#EXTINF` line with no `="` cost seconds.
const ATTR_REGEX = /([\w-]{1,64})="([^"]*)"/g;

/**
 * A provider is untrusted and the playlist is re-fetched on a schedule, so every
 * dimension of the input is bounded: lines are skipped past this length (a real
 * EXTINF or URL line is a few KiB at most), display names are cut, and the
 * channel count stops where no real playlist reaches.
 */
const MAX_LINE_LENGTH = 32 * 1024;
const MAX_NAME_LENGTH = 256;
/** Xtream `m3u_plus` playlists of a million entries exist; nothing real goes past this. */
const MAX_CHANNELS = 1_000_000;
/** Stored warnings: callers show the first few dozen, so a huge list need not be held whole. */
const MAX_STORED_WARNINGS = 100_000;

/** Example ids named in the duplicate tvg-id summary warning. */
const DUPLICATE_TVG_ID_EXAMPLES = 5;
/** Longest line echoed back in an error entry. */
const MAX_ERROR_CONTENT = 200;

/** NUL and other control characters: Postgres rejects 0x00 and fails the whole import. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanValue(value: string): string {
    return value.replace(CONTROL_CHARS, '');
}

/**
 * Extract a 2-3 letter country code from tvg-id suffix.
 * "Nordwelle.de" → "de", hash IDs → undefined
 */
function extractCountryCode(tvgId: string | undefined): string | undefined {
    if (!tvgId) return undefined;
    // Reject hash-like tvg-ids (16+ hex chars)
    if (/^[0-9a-f]{16,}$/i.test(tvgId)) return undefined;
    const match = tvgId.match(/\.([a-z]{2})$/i);
    if (!match) return undefined;
    return match[1].toLowerCase();
}

/** Parse EXTINF attributes from a line like: #EXTINF:-1 tvg-id="X" tvg-name="Y",...,Name */
function parseExtinfLine(line: string): {
    attrs: Record<string, string>;
    name: string;
    extras: Record<string, string>;
} | null {
    // Find the separator comma between attributes and display name.
    // Must handle commas inside quoted attribute values (e.g., group-title="Sports, Premium")
    // by masking quoted strings with same-length placeholders to preserve character positions.
    const withoutQuotes = line.replace(/"[^"]*"/g, (m) => '"' + 'x'.repeat(m.length - 2) + '"');
    const lastCommaIdx = withoutQuotes.lastIndexOf(',');
    if (lastCommaIdx === -1) return null;

    const name = cleanValue(line.slice(lastCommaIdx + 1).trim()).slice(0, MAX_NAME_LENGTH);

    const attrs: Record<string, string> = {};
    const extras: Record<string, string> = {};

    // Reset regex lastIndex before use
    ATTR_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATTR_REGEX.exec(line)) !== null) {
        const key = match[1];
        const value = cleanValue(match[2]);
        if (KNOWN_ATTRS.has(key)) {
            attrs[key] = value;
        } else {
            extras[key] = value;
        }
    }

    return { attrs, name, extras };
}

// ── Main Parser ────────────────────────────────────────────────────────

/** Parse an M3U Plus format string into structured channel data */
export function parseM3u(content: string, opts: { maxChannels?: number } = {}): ImportResult {
    const maxChannels = opts.maxChannels ?? MAX_CHANNELS;
    const result: ImportResult = {
        imported: 0,
        skipped: 0,
        channels: [],
        errors: [],
        warnings: [],
    };

    if (!content) return result;

    const seenTvgIds = new Set<string>();
    // A provider playlist can repeat thousands of tvg-ids (one per quality or
    // country feed): one summary warning instead of one per channel.
    let duplicateTvgIds = 0;
    let firstDuplicateLine = 0;
    const duplicateIds = new Set<string>();
    const pushWarning = (w: ImportResult['warnings'][number]): void => {
        if (result.warnings.length < MAX_STORED_WARNINGS) result.warnings.push(w);
    };

    // Normalize: strip BOM, normalize line endings
    let normalized = content;
    if (normalized.charCodeAt(0) === 0xfeff) {
        normalized = normalized.slice(1);
    }
    normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const lines = normalized.split('\n');
    let pendingExtinf: { line: string; lineNumber: number } | null = null;
    let headerSeen = false;

    for (let i = 0; i < lines.length; i++) {
        const lineNumber = i + 1;
        const line = lines[i].trim();

        // Skip empty lines
        if (line === '') continue;

        // Handle #EXTM3U header (first: its url-tvg list can be longer than any entry line)
        if (line.startsWith('#EXTM3U')) {
            headerSeen = true;
            continue;
        }

        // Longer than any real line: not scanned for attributes. An EXTINF line is
        // reported below (after the pending entry is settled); a URL line drops the
        // entry it belongs to; anything else (comments, directives) is just skipped.
        if (line.length > MAX_LINE_LENGTH && !line.startsWith('#EXTINF:')) {
            if (!line.startsWith('#') && pendingExtinf) {
                result.errors.push({
                    line: lineNumber,
                    content: line.slice(0, MAX_ERROR_CONTENT),
                    reason: 'Line too long',
                });
                result.skipped++;
                pendingExtinf = null;
            }
            continue;
        }

        // Skip known non-channel #EXT tags
        if (
            line.startsWith('#EXT-X-') ||
            line.startsWith('#EXTVLCOPT') ||
            line.startsWith('#EXTGRP') ||
            line.startsWith('#KODIPROP')
        ) {
            continue;
        }

        // Handle EXTINF lines
        if (line.startsWith('#EXTINF:')) {
            // If we already have a pending EXTINF, the previous one had no URL
            if (pendingExtinf) {
                result.errors.push({
                    line: pendingExtinf.lineNumber,
                    content: pendingExtinf.line,
                    reason: 'Missing stream URL after EXTINF',
                });
                logger.warn('M3U parse error', {
                    line: pendingExtinf.lineNumber,
                    content: pendingExtinf.line,
                    error: 'Missing stream URL after EXTINF',
                });
                result.skipped++;
            }
            if (line.length > MAX_LINE_LENGTH) {
                result.errors.push({
                    line: lineNumber,
                    content: line.slice(0, MAX_ERROR_CONTENT),
                    reason: 'Line too long',
                });
                result.skipped++;
                pendingExtinf = null;
                continue;
            }
            pendingExtinf = { line, lineNumber };
            continue;
        }

        // Skip other comment/directive lines
        if (line.startsWith('#')) {
            continue;
        }

        // This is a URL line
        if (pendingExtinf) {
            if (result.channels.length >= maxChannels) {
                result.errors.push({
                    line: lineNumber,
                    content: line.slice(0, MAX_ERROR_CONTENT),
                    reason: `Channel limit of ${maxChannels} reached; the rest of the playlist is ignored`,
                });
                logger.warn('M3U channel limit reached', { limit: maxChannels });
                result.skipped++;
                pendingExtinf = null;
                break;
            }
            const parsed = parseExtinfLine(pendingExtinf.line);
            if (!parsed) {
                result.errors.push({
                    line: pendingExtinf.lineNumber,
                    content: pendingExtinf.line,
                    reason: 'Malformed EXTINF line (no display name found)',
                });
                logger.warn('M3U parse error', {
                    line: pendingExtinf.lineNumber,
                    content: pendingExtinf.line,
                    error: 'Malformed EXTINF line (no display name found)',
                });
                result.skipped++;
                pendingExtinf = null;
                continue;
            }

            const channelName = parsed.name;

            // Empty channel name
            if (!channelName) {
                result.errors.push({
                    line: pendingExtinf.lineNumber,
                    content: pendingExtinf.line,
                    reason: 'Empty channel name',
                });
                logger.warn('M3U parse error', {
                    line: pendingExtinf.lineNumber,
                    content: pendingExtinf.line,
                    error: 'Empty channel name',
                });
                result.skipped++;
                pendingExtinf = null;
                continue;
            }

            const tvgId = parsed.attrs['tvg-id'] || undefined;
            const tvgName = parsed.attrs['tvg-name'] || undefined;
            // Only a web address is a logo; providers also leak serialised
            // values ("s:1:/images/….png") that no fetch can resolve.
            const rawLogo = parsed.attrs['tvg-logo']?.trim();
            const logoUrl = rawLogo && /^https?:\/\//i.test(rawLogo) ? rawLogo : undefined;
            const groupTitle = parsed.attrs['group-title'] || undefined;

            // Generate warnings for missing fields
            if (!tvgId) {
                pushWarning({
                    line: pendingExtinf.lineNumber,
                    field: 'tvg-id',
                    message: `Channel "${channelName}" missing tvg-id (needed for EPG matching)`,
                });
            }
            if (!logoUrl) {
                pushWarning({
                    line: pendingExtinf.lineNumber,
                    field: 'tvg-logo',
                    message: `Channel "${channelName}" missing tvg-logo`,
                });
            }
            if (!groupTitle) {
                pushWarning({
                    line: pendingExtinf.lineNumber,
                    field: 'group-title',
                    message: `Channel "${channelName}" missing group-title`,
                });
            }

            // Count duplicate tvg-id values (summarised after the loop)
            if (tvgId && seenTvgIds.has(tvgId)) {
                if (duplicateTvgIds === 0) firstDuplicateLine = pendingExtinf.lineNumber;
                duplicateTvgIds++;
                duplicateIds.add(tvgId);
            }
            if (tvgId) seenTvgIds.add(tvgId);

            const allowedSchemes = ['http:', 'https:', 'rtsp:', 'rtmp:'];
            try {
                const u = new URL(line);
                if (!allowedSchemes.includes(u.protocol)) {
                    result.errors.push({
                        line: lineNumber,
                        content: line,
                        reason: `Disallowed URL scheme: ${u.protocol}`,
                    });
                    result.skipped++;
                    pendingExtinf = null;
                    continue;
                }
            } catch {
                result.errors.push({
                    line: lineNumber,
                    content: line,
                    reason: 'Invalid stream URL',
                });
                result.skipped++;
                pendingExtinf = null;
                continue;
            }

            const channel: M3uChannel = {
                tvgId,
                tvgName,
                name: channelName,
                logoUrl,
                groupTitle,
                streamUrl: line,
                countryCode: extractCountryCode(tvgId),
                extras: parsed.extras,
            };

            result.channels.push(channel);
            result.imported++;
            pendingExtinf = null;
        }
        // Orphan URL (no preceding EXTINF) — silently skip
    }

    // Handle EXTINF at EOF with no URL
    if (pendingExtinf) {
        result.errors.push({
            line: pendingExtinf.lineNumber,
            content: pendingExtinf.line,
            reason: 'Missing stream URL after EXTINF',
        });
        logger.warn('M3U parse error', {
            line: pendingExtinf.lineNumber,
            content: pendingExtinf.line,
            error: 'Missing stream URL after EXTINF',
        });
        result.skipped++;
    }

    if (duplicateTvgIds > 0) {
        const examples = [...duplicateIds].slice(0, DUPLICATE_TVG_ID_EXAMPLES);
        const more = duplicateIds.size > examples.length ? ', …' : '';
        // First, so the import summary's warning cap never hides it.
        result.warnings.unshift({
            line: firstDuplicateLine,
            field: 'tvg-id',
            message:
                `Duplicate tvg-id: ${duplicateTvgIds} channel${duplicateTvgIds === 1 ? '' : 's'} ` +
                `repeat ${duplicateIds.size === 1 ? 'a tvg-id' : `${duplicateIds.size} tvg-ids`} ` +
                `of an earlier channel, all imported (e.g. ${examples.map((id) => `"${id}"`).join(', ')}${more})`,
        });
        logger.debug('M3U duplicate tvg-ids', {
            channels: duplicateTvgIds,
            ids: [...duplicateIds],
        });
    }

    // Warn if header missing (not an error — many real files omit it)
    if (!headerSeen && lines.length > 0) {
        result.warnings.push({
            line: 1,
            field: 'header',
            message: 'Missing #EXTM3U header',
        });
    }

    return result;
}

/**
 * Parse an M3U Plus format string and validate every channel stream URL
 * against the SSRF guard. Channels whose URL resolves to a private or
 * internal address are removed from the result and counted as skipped.
 *
 * Use this in preference to `parseM3u` whenever the content comes from an
 * untrusted external source (e.g. a user-supplied M3U provider URL).
 */
/**
 * Apply Live TV's SSRF policy to one channel's stream URL. Throws when the URL
 * may not be used, so the caller can log and drop that channel.
 *
 * `LIVETV_ALLOW_PRIVATE_URLS` is honoured by every other Live TV network path —
 * the playlist fetch (`fetch-source.ts`), the Xtream and HDHomeRun clients, and
 * playback itself (`standalone-livetv-provider.ts`). This check used to
 * hard-code a public-only guard, which made the flag a no-op for M3U sources:
 * the playlist fetched fine, then EVERY channel in it was dropped here and the
 * import died with "M3U parsing produced zero channels" — an error pointing at
 * the parser rather than at the policy that actually rejected the channels.
 * A LAN restreamer was therefore impossible to import even though playback
 * would have streamed from it happily.
 *
 * The public-only default is unchanged; only an operator who explicitly opted
 * in gets private addresses. `resolveSafePublicUrl` defaults to public-only;
 * Live TV channel logos also opt in under this flag, while other artwork,
 * the plugin installer and ICY metadata retain the strict default.
 */
async function assertStreamUrlAllowed(streamUrl: string): Promise<void> {
    if (!config.LIVETV_ALLOW_PRIVATE_URLS) {
        await resolveSafePublicUrl(new URL(streamUrl));
        return;
    }
    // Opted in: the URL must still parse, but a private resolution is allowed.
    // Deliberately NOT routed through url-validator, whose allowlist is
    // http/https only — parseM3u also accepts rtsp: and rtmp:, and narrowing
    // the scheme set here would make RTSP/RTMP sources silently vanish.
    new URL(streamUrl);
}

export async function parseM3uAsync(content: string): Promise<ImportResult> {
    const result = parseM3u(content);

    const safeChannels: M3uChannel[] = [];
    for (const channel of result.channels) {
        try {
            await assertStreamUrlAllowed(channel.streamUrl);
            safeChannels.push(channel);
        } catch (err) {
            logger.warn('M3U channel skipped: stream URL rejected by SSRF policy', {
                channel: channel.name,
                streamUrl: redactLiveTvUrl(channel.streamUrl),
                reason: redactLiveTvUrlsInText(err instanceof Error ? err.message : String(err)),
                allowPrivateUrls: config.LIVETV_ALLOW_PRIVATE_URLS,
            });
            result.skipped++;
            result.imported--;
        }
    }

    result.channels = safeChannels;
    return result;
}
