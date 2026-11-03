// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AniDB metadata provider.
 *
 * Anime-specific provider activated for library paths with provider='anidb'.
 * Uses the static title list XML for search (cached 24h, no per-request rate
 * limit) and the AniDB HTTP API for detail lookups.
 *
 * Field-authority defaults (priority, fieldAuthorities, cacheTtlHours) are
 * declared in `metadata` below; the runtime derives field authority via
 * `buildFieldAuthorityConfigFromDefinitions()`.
 *
 * AniDB rate limit: 1 req / 2s = 30 / min → rateLimit: { rps: 0.5 }.
 */

import { defineProvider } from '@sapd/lumastra-plugin-sdk';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';
import type {
    MetadataCandidate,
    MediaMetadata,
    EpisodeMetadata,
} from '../../../../providers/types.js';
import { registry } from '../../../registry.js';
import {
    gunzipBounded,
    readBoundedResponseBytes,
    readBoundedResponseText,
} from '$lib/server/utils/bounded-response.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TITLE_LIST_URL = 'https://anidb.net/api/anime-titles.xml.gz';
const TITLE_LIST_CACHE_KEY = 'anidb:title-list:v1';
const TITLE_LIST_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DETAIL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const API_BASE_URL = 'http://api.anidb.net:9001/httpapi';

// The title list is about 4 MiB compressed / 40 MiB of XML; the API answer for one
// anime is a few hundred KB. The detail API is plain http, so an on-path attacker
// can answer it, and a gzip bomb is a few hundred KB: every body is read bounded.
const MAX_TITLE_LIST_GZ_BYTES = 32 * 1024 * 1024;
const MAX_TITLE_LIST_XML_BYTES = 128 * 1024 * 1024;
const MAX_DETAIL_XML_BYTES = 4 * 1024 * 1024;

// Rate limiting (1 req / 2s = 0.5 rps) is enforced by the host via the
// `rateLimit: { rps: 0.5 }` declaration on the provider manifest below.
// `buildHttpClient` consults a process-singleton token bucket keyed by
// provider id before every request, so this module no longer needs its
// own `enforceRateLimit` / `lastApiCallAt` state (deleted 2026-05-17).

// ---------------------------------------------------------------------------
// Param / result shapes
// ---------------------------------------------------------------------------

export interface AnidbSearchParams {
    type: 'tv';
    query: string;
    year?: number;
}

export type AnidbItem = MetadataCandidate | MediaMetadata | EpisodeMetadata;

// ---------------------------------------------------------------------------
// Internal XML types
// ---------------------------------------------------------------------------

interface AnidbTitle {
    lang: string;
    type: string;
    text: string;
}

interface AnidbTitleEntry {
    aid: string;
    titles: AnidbTitle[];
}

interface AnidbParseResult {
    metadata: MediaMetadata;
    episodes: EpisodeMetadata[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeXmlEntities(s: string): string {
    // `&amp;` last: decoding it first would turn `&amp;lt;` into `<` (double decode).
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&');
}

function titleSimilarity(query: string, candidate: string): number {
    const normalize = (s: string): string[] =>
        s
            .toLowerCase()
            .replace(/[^\w\s]/g, '')
            .split(/\s+/)
            .filter(Boolean);

    const qWords = new Set(normalize(query));
    const cWords = new Set(normalize(candidate));

    if (qWords.size === 0 || cWords.size === 0) return 0;

    if (query.toLowerCase().trim() === candidate.toLowerCase().trim()) return 1.0;

    const ql = query.toLowerCase();
    const cl = candidate.toLowerCase();
    if (ql === cl) return 1.0;
    if (cl.includes(ql) || ql.includes(cl)) return 0.9;

    const intersection = [...qWords].filter((w) => cWords.has(w)).length;
    const union = new Set([...qWords, ...cWords]).size;
    return intersection / union;
}

const ANIME_OPEN = /<anime aid="\d+">/y;
const EPISODE_OPEN = /<episode id="(\d+)">/y;

interface XmlBlock {
    open: RegExpExecArray;
    /** From the opening tag through the closing tag. */
    whole: string;
    /** Between the opening and closing tags. */
    inner: string;
}

/**
 * `<tag ...>...</tag>` blocks, found with indexOf: the lazy-regex form rescanned
 * to the end of the document from every unterminated opener. A missing closer
 * ends the scan, since no later opener can have one either.
 */
function* scanBlocks(
    xml: string,
    openMarker: string,
    openRe: RegExp,
    closeMarker: string,
): Generator<XmlBlock> {
    let pos = 0;
    for (;;) {
        const start = xml.indexOf(openMarker, pos);
        if (start === -1) return;
        openRe.lastIndex = start;
        const open = openRe.exec(xml);
        if (!open) {
            pos = start + openMarker.length;
            continue;
        }
        const innerStart = start + open[0].length;
        const close = xml.indexOf(closeMarker, innerStart);
        if (close === -1) return;
        const end = close + closeMarker.length;
        yield { open, whole: xml.slice(start, end), inner: xml.slice(innerStart, close) };
        pos = end;
    }
}

function parseTitleListXml(xml: string): AnidbTitleEntry[] {
    const entries: AnidbTitleEntry[] = [];
    for (const { whole: block } of scanBlocks(xml, '<anime aid="', ANIME_OPEN, '</anime>')) {
        const aidMatch = block.match(/aid="(\d+)"/);
        if (!aidMatch) continue;
        const aid = aidMatch[1];

        const titleMatches = [
            ...block.matchAll(/<title xml:lang="([^"]+)" type="([^"]+)">([^<]+)<\/title>/g),
        ];
        const titles: AnidbTitle[] = titleMatches.map((m) => ({
            lang: m[1],
            type: m[2],
            text: decodeXmlEntities(m[3]),
        }));

        if (titles.length > 0) {
            entries.push({ aid, titles });
        }
    }

    return entries;
}

function parseAnimeDetailXml(xml: string, aid: string): AnidbParseResult {
    const extractFirst = (tag: string): string | undefined => {
        const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)<\\/${tag}>`));
        return m?.[1]?.trim();
    };

    const titleBlocks = [
        ...xml.matchAll(/<title xml:lang="([^"]+)" type="([^"]+)">([^<]+)<\/title>/g),
    ];
    const enTitle = titleBlocks.find((m) => m[1] === 'en' && m[2] === 'official')?.[3];
    const mainTitle = titleBlocks.find((m) => m[2] === 'main')?.[3];
    const title = decodeXmlEntities(enTitle ?? mainTitle ?? '');

    const startdate = extractFirst('startdate');
    const year = startdate ? parseInt(startdate.slice(0, 4), 10) : undefined;
    const overview = extractFirst('description');

    const tagsBlock = scanBlocks(xml, '<tags>', /<tags>/y, '</tags>').next().value?.inner ?? '';
    const tagMatches = [...tagsBlock.matchAll(/<name>([^<]+)<\/name>/g)];
    const genres = tagMatches.map((m) => m[1]);

    const episodeBlocks = [...scanBlocks(xml, '<episode id="', EPISODE_OPEN, '</episode>')].map(
        (b) => [b.whole, b.open[1], b.inner] as const,
    );
    const episodes: EpisodeMetadata[] = [];

    for (const [, epId, block] of episodeBlocks) {
        const epnoMatch = block.match(/<epno type="(\d+)">(\d+)<\/epno>/);
        if (!epnoMatch || epnoMatch[1] !== '1') continue;

        const epNum = parseInt(epnoMatch[2], 10);
        const epTitleMatch = block.match(/<title xml:lang="en">([^<]+)<\/title>/);
        const airdateMatch = block.match(/<airdate>([^<]+)<\/airdate>/);
        const runtimeMatch = block.match(/<length>(\d+)<\/length>/);

        episodes.push({
            seriesExternalId: aid,
            season: 1,
            episode: epNum,
            externalId: epId,
            title: epTitleMatch?.[1],
            airDate: airdateMatch?.[1],
            runtime: runtimeMatch ? parseInt(runtimeMatch[1], 10) : undefined,
        });
    }

    episodes.sort((a, b) => a.episode - b.episode);

    const metadata: MediaMetadata = {
        title,
        overview,
        year: year !== undefined && !isNaN(year) ? year : undefined,
        releaseDate: startdate,
        genres: genres.length > 0 ? genres : undefined,
        externalIds: { anidb: aid },
    };

    return { metadata, episodes };
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

async function fetchTitleList(ctx: PluginContext): Promise<AnidbTitleEntry[]> {
    const cached = await ctx.cache!.get<AnidbTitleEntry[]>(TITLE_LIST_CACHE_KEY);
    if (cached) return cached;

    ctx.logger.info('Fetching AniDB title list...');
    const res = await ctx.http!.get(TITLE_LIST_URL);
    if (!res.ok) {
        // A failed fetch of the static title list is a network/server
        // outage, never a genuinely empty list — returning [] here made an
        // AniDB outage indistinguishable from "no matches" in search(),
        // which has no catch of its own and previously just got an empty
        // result set back. Throw so the outage propagates to the caller.
        ctx.logger.warn('AniDB title list fetch failed', {
            status: res.status,
        });
        throw new Error(`AniDB title list fetch failed: ${res.status} ${res.statusText}`);
    }

    // gunzip/parse failures are not caught here — they propagate as a throw
    // automatically, same intent as the `!res.ok` branch above.
    const compressed = await readBoundedResponseBytes(res, MAX_TITLE_LIST_GZ_BYTES);
    const xml = (await gunzipBounded(compressed, MAX_TITLE_LIST_XML_BYTES)).toString('utf-8');
    const entries = parseTitleListXml(xml);

    await ctx.cache!.set(TITLE_LIST_CACHE_KEY, entries, TITLE_LIST_TTL_MS);
    ctx.logger.info(`AniDB title list cached (${entries.length} entries)`);
    return entries;
}

async function fetchAnimeDetail(
    ctx: PluginContext,
    aid: string,
    clientName: string,
    clientVer: string,
): Promise<AnidbParseResult | null> {
    const cacheKey = `anidb:anime:${aid}:v1`;
    const cached = await ctx.cache!.get<AnidbParseResult>(cacheKey);
    if (cached) return cached;

    // Host enforces the 0.5 rps budget inside ctx.http.get; no
    // module-level throttle needed.

    const query = new URLSearchParams({
        client: clientName,
        clientver: clientVer,
        protover: '1',
        request: 'anime',
        aid,
    });

    const res = await ctx.http!.get(`${API_BASE_URL}?${query.toString()}`);
    if (!res.ok) {
        // HTTP-level failure (network/5xx/429) — an outage, not "no data
        // for this aid". Throw so it propagates out of detail() (already
        // uncaught there) AND out of childList() (also uncaught), instead
        // of being folded into the same null the documented
        // genuinely-no-data path below returns. childList()'s `?? []`
        // fallback previously made an outage indistinguishable from "this
        // anime really has no episodes".
        ctx.logger.warn('AniDB API request failed', {
            aid,
            status: res.status,
        });
        throw new Error(`AniDB API request failed: ${res.status} ${res.statusText} (aid=${aid})`);
    }

    const xml = await readBoundedResponseText(res, MAX_DETAIL_XML_BYTES);
    if (xml.includes('<error')) {
        // AniDB answered authoritatively with an <error> body for this
        // specific aid (documented "no data for this id" contract) — unlike
        // the HTTP failure above, the server responded; keep this as null,
        // not a throw.
        ctx.logger.warn('AniDB API error for anime', {
            aid,
            xml: xml.slice(0, 200),
        });
        return null;
    }

    const result = parseAnimeDetailXml(xml, aid);
    await ctx.cache!.set(cacheKey, result, DETAIL_CACHE_TTL_MS);
    return result;
}

async function resolveCredentials(
    ctx: PluginContext,
): Promise<{ clientName: string; clientVer: string }> {
    // Unified resolution: plugin_settings (admin UI target) → plugin_secrets →
    // config/plugins/anidb.json / env. See resolveAnidbClient for the order.
    const { resolveAnidbClient } =
        await import('$lib/server/providers/implementations/anidb/config-loader.js');
    return resolveAnidbClient(ctx.sql);
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

export const anidbProvider = defineProvider<AnidbSearchParams, AnidbItem>({
    id: 'anidb-metadata-provider',
    name: 'AniDB',
    version: '1.0.0',

    capabilities: { http: true, cache: true },

    rateLimit: { rps: 0.5 }, // 1 per 2s

    metadata: {
        priority: 60,
    },

    settings: {
        fields: [
            {
                key: 'ANIDB_CLIENT',
                type: 'string',
                label: 'Client Name',
                description:
                    'Your registered AniDB client name. Register at https://anidb.net/software/add',
                default: '',
            },
            {
                key: 'ANIDB_CLIENT_VER',
                type: 'string',
                label: 'Client Version',
                description: 'Your registered AniDB client version (integer ≥ 1)',
                default: '1',
            },
        ],
    },

    async isConfigured(ctx): Promise<boolean> {
        try {
            const { clientName } = await resolveCredentials(ctx);
            return clientName.length > 0;
        } catch {
            return false;
        }
    },

    async search(ctx, params): Promise<MetadataCandidate[]> {
        const { clientName } = await resolveCredentials(ctx);
        if (!clientName) return [];

        const entries = await fetchTitleList(ctx);
        const results: MetadataCandidate[] = [];

        for (const entry of entries) {
            const bestScore = Math.max(
                ...entry.titles.map((t) => titleSimilarity(params.query, t.text)),
            );
            if (bestScore >= 0.3) {
                const primaryTitle =
                    entry.titles.find((t) => t.lang === 'en' && t.type === 'official') ??
                    entry.titles.find((t) => t.type === 'main') ??
                    entry.titles[0];
                results.push({
                    externalId: entry.aid,
                    provider: 'anidb',
                    title: primaryTitle?.text ?? '',
                    year: undefined,
                    mediaType: 'tv',
                    confidence: bestScore,
                });
            }
        }

        return results.sort((a, b) => b.confidence - a.confidence).slice(0, 10);
    },

    async detail(ctx, id): Promise<MediaMetadata> {
        const { clientName, clientVer } = await resolveCredentials(ctx);
        if (!clientName) {
            throw new Error(`AniDB not configured — cannot fetch detail for aid=${id}`);
        }

        const result = await fetchAnimeDetail(ctx, id, clientName, clientVer);
        if (!result) {
            throw new Error(`AniDB returned no data for aid=${id}`);
        }

        return result.metadata;
    },

    async childList(ctx, parentId): Promise<EpisodeMetadata[]> {
        const { clientName, clientVer } = await resolveCredentials(ctx);
        if (!clientName) return [];

        const result = await fetchAnimeDetail(ctx, parentId, clientName, clientVer);
        return result?.episodes ?? [];
    },
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerProvider(anidbProvider);
