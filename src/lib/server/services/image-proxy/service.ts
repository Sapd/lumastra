// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image Proxy Service
 *
 * Centralized service for all image handling operations.
 * Coordinates multiple providers (TMDB, Jellyfin, etc.) and handles caching.
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import { deriveImageProvider } from '$lib/shared/image-provenance.js';
import { AVATAR_SIZE_TO_WIDTH, restrictImageOptions } from '$lib/server/utils/image-params';
import {
    ImageWorkBudgetExceededError,
    hasImageWorkBudget,
    requireImageProviderBudget,
} from './work-budget';
import type postgres from 'postgres';
import { LRUCache, standaloneCacheRegistry } from '$lib/server/cache';
import { createHash } from 'node:crypto';
import { Logger } from '$lib/server/utils/logger';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import {
    discardResponseBody,
    readBoundedResponseBytes,
    readBoundedResponseJson,
} from '$lib/server/utils/bounded-response.js';

/** Upstream artwork (covers, avatars, TMDB images): far above any real image. */
const MAX_UPSTREAM_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_UPSTREAM_JSON_BYTES = 4 * 1024 * 1024;
import { isProviderImagePath } from '$lib/server/utils/provider-image-path.js';
import {
    getSelectedImageCandidate,
    registerPersonImageCandidate,
    getSuppressedImageProviders,
} from '$lib/server/database/queries/image-candidates.queries.js';
import {
    resolveSelectedImageCandidate,
    type SelectedImageCandidate,
} from '../image-descriptor/selected.js';
import { getImageDescriptorOwners } from '$lib/server/database/queries/image-descriptor.queries.js';
import { resolveImageSpecsForOwner } from '../image-descriptor/resolver.js';
import { getImageMetadata } from '$lib/server/database/queries/catalog-operations.queries';
import { findMediaIdByProviderExternalId } from '$lib/server/database/queries/external-ids.queries.js';
import {
    getLocalArtwork,
    getLegacyLocalArtwork,
    getOwnLocalArtwork,
    getLocalArtworkInheritedBatch,
} from '$lib/server/database/queries/media-artwork.queries.js';
import { TmdbImageProvider } from './providers/tmdb.provider';
import { LogoLegibilityResolver } from './logo-legibility';
import { tmdbApi } from '$lib/server/providers/implementations/tmdb/index.js';
import { tmdbAuthorizedRequest } from '$lib/server/providers/implementations/tmdb/auth.js';
import { JellyfinImageProvider, JellyfinUnavailableError } from './providers/jellyfin.provider';
import { AudiobookshelfImageProvider } from './providers/audiobookshelf.provider';
import { isAbsoluteUrl } from './providers/generic-url.provider';
import { ImageCache } from './cache';
import { runPerf, timePhase } from './perf-context';
import { config, features } from '$lib/server/config';
import { audiobookshelfClient } from '$lib/server/audiobookshelf';
import {
    proxyArrImage,
    getWebPOptions,
    resizeForPreset,
    transcodeToFormat,
} from '$lib/server/utils/image-proxy';
import { sizeCacheToken, qualityCacheToken } from '$lib/server/utils/image-params';
import {
    isPathWithinMediaStore,
    findResolvedMediaStoreRoot,
    isPathWithin,
} from '$lib/server/utils/media-path-resolver.js';
import { operationMode } from '$lib/server/operation-mode.js';
import { isEpisode, isMusicType, isAlbum } from '$lib/server/utils/media-types.js';
import { resolveJellyfinUserId } from '$lib/server/services/jellyfin-user-id-resolver.js';
import {
    canCallJellyfin,
    isJellyfinSyncEnabled,
    JELLYFIN_DIRECT_FETCH_TIMEOUT_MS,
    recordJellyfinTransportFailure,
    recordJellyfinTransportSuccess,
} from '$lib/server/jellyfin/runtime-gate.js';
import {
    getUserByUsername,
    getUserById,
    getUserAvatar,
    getUserAvatarVersion,
} from '$lib/server/database/queries/users.queries.js';
import { imageProxyCacheOpsTotal } from '$lib/server/tasks/metrics.js';
import { isRecord } from '$lib/utils/data-extraction';
import sharp from '$lib/server/services/image-proxy/image-sharp';
import { resolveContainedFile, readContainedFile } from '$lib/server/utils/contained-fs.js';
import * as path from 'node:path';
import type {
    ImageType,
    ImageResponse,
    ImageOptions,
    ImageSize,
    MediaType,
    ProviderImageRequest,
    ImageProviderType,
} from './types';
import { imageResponse } from './response';
import { KAVITA_TYPE_CONFIG, DEFAULT_IMAGE_PROVIDER_PRIORITY } from './types';
import type { ImageMetadataRow } from '$lib/server/database/queries/catalog-operations.queries';
import { computeBlurHash } from '$lib/server/utils/blurhash';
import { getLiveTvUpstreamDispatcher } from '../livetv/upstream-proxy.js';
import { resolveMediaIdByProvider as _resolveMediaIdByProvider } from '$lib/server/database/queries/resolvers/media-id.resolver.js';
import { resolveSafePublicUrl, pinnedFetch } from '$lib/server/utils/ssrf-guard.js';
import { peekCacheRecord } from '$lib/server/services/radio-metadata';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';
const logger = Logger.for('ImageProxyService');

/** File-based cache for fetched custom poster URLs (external images) */
const CUSTOM_URL_CACHE_DIR = path.join(process.cwd(), '.cache', 'custom-url');
const CUSTOM_URL_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
};

/** Valid TMDB person image sizes */
const VALID_PERSON_SIZES = ['w45', 'w185', 'h632', 'original'];

/** GUID patterns to detect Jellyfin user IDs (with or without dashes) */
const GUID_WITH_DASHES = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUID_WITHOUT_DASHES = /^[0-9a-f]{32}$/i;

function isGuid(value: string): boolean {
    return GUID_WITH_DASHES.test(value) || GUID_WITHOUT_DASHES.test(value);
}

/**
 * Sniff the actual image content type from the first few bytes of a buffer.
 * Used when the upstream Content-Type header is missing/wrong and the URL
 * extension can't be trusted (M3U logos commonly serve PNG from .jpg URLs).
 * Unknown bodies are not images. BMP and ICO are unsupported; TIFF is decoded by Sharp.
 */
function sniffImageContentType(buffer: Buffer): string | null {
    if (buffer.length >= 12) {
        // RIFF....WEBP
        if (
            buffer[0] === 0x52 &&
            buffer[1] === 0x49 &&
            buffer[2] === 0x46 &&
            buffer[3] === 0x46 &&
            buffer[8] === 0x57 &&
            buffer[9] === 0x45 &&
            buffer[10] === 0x42 &&
            buffer[11] === 0x50
        ) {
            return 'image/webp';
        }
    }
    if (buffer.length >= 8) {
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
            return 'image/png';
        }
        // GIF87a / GIF89a
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
            return 'image/gif';
        }
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    // AVIF/HEIF: ISOBMFF `ftyp` box at offset 4, major brand at offset 8.
    // Sharp's .avif() output always starts with a box-size (4 bytes) + 'ftyp'
    // + a major brand of 'avif' (still image) or 'avis' (image sequence).
    // Without this branch, every genuinely AVIF-encoded buffer fell through
    // to the default JPEG return below — the bytes served were correct AVIF,
    // but the Content-Type header lied and said image/jpeg (confirmed on
    // prod: 200 OK, x-cache HIT, real `ftypavif` bytes, header said
    // image/jpeg), which is what made AVIF negotiation look broken from the
    // outside for local-artwork, audiobook-cover and generic-URL responses
    // (the three callers of this function).
    if (
        buffer.length >= 12 &&
        buffer[4] === 0x66 &&
        buffer[5] === 0x74 &&
        buffer[6] === 0x79 &&
        buffer[7] === 0x70
    ) {
        const isAvifBrand = (brand: string): boolean => brand === 'avif' || brand === 'avis';
        const majorBrand = buffer.toString('ascii', 8, 12);
        if (isAvifBrand(majorBrand)) {
            return 'image/avif';
        }
        // `mif1` (still HEIF/AVIF image) and `msf1` (image sequence) are generic
        // ISOBMFF wrapper brands — HEIC uses the exact same wrapper, so the major
        // brand alone doesn't commit to a codec. The codec lives in the
        // compatible-brands list, 4-byte entries starting at offset 16. Bound the
        // scan by BOTH the box's own declared size (offset 0, big-endian) and the
        // actual buffer length, so a truncated or adversarial box can't walk past
        // either. Only report AVIF when `avif`/`avis` genuinely appears in that
        // list — a `mif1` box whose compatible brands are all HEIC (`heic`,
        // `heix`, ...) must NOT be mislabeled as AVIF.
        if (majorBrand === 'mif1' || majorBrand === 'msf1') {
            const boxSize = buffer.readUInt32BE(0);
            const scanEnd = Math.min(boxSize > 0 ? boxSize : buffer.length, buffer.length);
            for (let offset = 16; offset + 4 <= scanEnd; offset += 4) {
                if (isAvifBrand(buffer.toString('ascii', offset, offset + 4))) {
                    return 'image/avif';
                }
            }
        }
    }
    // TIFF (little/big endian). BMP and ICO have no decoder in this pipeline.
    if (
        buffer.length >= 4 &&
        (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0])) ||
            buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0, 0x2a])))
    )
        return 'image/tiff';
    // SVG (text-based); require an actual svg root rather than arbitrary XML.
    if (buffer.length >= 5) {
        const head = buffer.subarray(0, 1024).toString('utf8').trimStart();
        if (
            /^(?:(?:<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE\s+svg(?:\s[^>]*?)?>)\s*)*<svg(?:\s|\/?>)/i.test(
                head,
            )
        ) {
            return 'image/svg+xml';
        }
    }
    return null;
}

/**
 * Thrown out of the custom-URL fetcher once a failure is recorded (and while it
 * is still backing off): the cache may stand an expired copy in for it.
 */
class CustomUrlBackoff extends Error {}
/**
 * Same, for an upstream that says the image is gone (404/410) or a redirect the
 * SSRF guard refuses: no stale copy, a removed logo has to disappear.
 */
class CustomUrlGone extends Error {}
/** A 404/410 or a refused redirect inside the fetcher; becomes CustomUrlGone once recorded. */
class CustomUrlRefused extends Error {}

/**
 * The item a legacy Jellyfin image id (32 hex digits, no dashes) maps to through
 * the external_ids rows Jellyfin sync keeps, or null. `getImageByCatalogId`
 * serves that item's artwork, so a caller that gates access must gate this id
 * too: the raw Jellyfin id is not a media_items row, and the access check passes
 * an unknown id.
 */
export async function lookupLegacyJellyfinImageMediaId(
    sql: postgres.Sql,
    id: string,
): Promise<string | null> {
    if (!/^[0-9a-f]{32}$/i.test(id)) return null;
    const [row] = await sql<{ media_id: string }[]>`
        SELECT media_id FROM external_ids
        WHERE provider = 'jellyfin' AND external_id = ${id}
        LIMIT 1
    `;
    return row ? String(row.media_id) : null;
}

class AudiobookCoverNotFoundError extends Error {}

export class ImageProxyService {
    private tmdbProvider: TmdbImageProvider;
    private logoLegibility: LogoLegibilityResolver;
    private jellyfinProvider: JellyfinImageProvider;
    private customUrlCache: ImageCache;
    private audiobookCache: ImageCache;
    private audiobookMissCache = new LRUCache<true>({
        maxSize: 1000,
        defaultTTL: 30_000,
        namespace: 'v1:audiobook-cover-miss',
    });
    /** Revision-keyed, disk-cached AudiobookShelf covers (see the provider). */
    private audiobookshelfProvider: AudiobookshelfImageProvider;
    private arrCache: ImageCache;
    private personCache: ImageCache;
    private kavitaCache: ImageCache;
    private avatarCache: ImageCache;
    private localArtworkOutputCache: ImageCache;

    /** In-memory cache for TMDB person details (profile_path + name) */
    private personDetailsCache = new Map<
        string,
        { profilePath: string | null; name: string; cachedAt: number }
    >();
    private readonly maxPersonCacheSize = 1000;
    private readonly personMemoryCacheTtl = 24 * 60 * 60 * 1000; // 24 hours

    /** Rate limiting for TMDB person API calls */
    private lastPersonRequestTime = 0;
    private readonly minPersonRequestInterval = 100; // ms

    /** In-memory cache for username → Jellyfin GUID resolution (permanent) */
    private usernameToGuidCache = new Map<string, string>();

    /**
     * Single-flight map: collapses concurrent requests for the same image
     * (same entry method + same inputs) onto a single underlying fetch.
     * Without this, N parallel page loads for an uncached poster trigger N
     * upstream fetches against TMDB / Jellyfin / external URLs. The
     * disk-cache layer (`ImageCache.getCachedOrFetch`) already dedupes at
     * its level, but the TMDB pre-generate path and the local artwork
     * reader bypass it, so we dedupe at the service entry instead.
     */
    private inFlight = new Map<string, Promise<ImageResponse | null>>();

    /**
     * In-process L1 caches for `getImageMetadata` and `getLocalArtwork`.
     * Both run on every catalog hit; the metadata query is a recursive CTE
     * walking up to 3 ancestor levels (~30-100 ms warm, more under load),
     * and the local-artwork lookup is hot because it's the first provider
     * in the priority chain.
     *
     * TTLs are tiered by entry polarity: POSITIVE rows (artwork/metadata
     * exists) are stable — a path change goes through invalidateCatalogImage
     * on this instance, and cross-replica drift only means serving the old
     * (still valid) image briefly — so they live L1_POSITIVE_TTL (10 min).
     * NEGATIVE entries (no artwork yet) flip the moment a scan extracts a
     * still, and other replicas only learn via TTL, so they keep the short
     * 60 s default to make new artwork appear promptly.
     *
     * Negative-result handling: we use a sentinel symbol to distinguish a
     * cached null (item exists, no metadata) from a cache miss. A naive
     * `has()`-then-`get()` pattern races against TTL expiry and could
     * return null after `has()` returned true — masking real DB queries as
     * cached-null hits. Single `get()` + sentinel disambiguation avoids it.
     */
    private static readonly METADATA_NULL = Symbol('metadata-null');
    /**
     * TTL for POSITIVE metadata/artwork/stat entries; negatives use the 60 s
     * default. 5 minutes is the cross-PROCESS staleness bound: the scanner /
     * reconciliation callers of invalidateCatalogImage run in the worker
     * container, whose purge can't reach a web replica's in-process caches —
     * a web replica only converges via this TTL after a frame is re-extracted
     * or artwork re-uploaded. Don't raise it without a cross-instance
     * invalidation signal (event_outbox) to pair it with.
     */
    private static readonly L1_POSITIVE_TTL = 5 * 60 * 1000;
    private imageMetadataCache = new LRUCache<
        ImageMetadataRow | typeof ImageProxyService.METADATA_NULL
    >({
        maxSize: 5000,
        defaultTTL: 60 * 1000,
        namespace: 'image-metadata',
    });
    private localArtworkCache = new LRUCache<
        { file_path?: string | null } | typeof ImageProxyService.METADATA_NULL
    >({
        maxSize: 5000,
        defaultTTL: 60 * 1000,
        namespace: 'local-artwork',
    });

    /**
     * Upstream failures of `fetchCustomUrl`, url → time the next attempt may
     * go out. Live TV channel logos are the main producer: when an IPTV
     * source dies, every guide/grid render asks for dozens of logos on a host
     * that no longer answers, and each one used to go upstream again and log
     * a warning — ~1,000 requests a day on prod for one dead source.
     */
    private static readonly CUSTOM_URL_RETRY_MS = 60 * 60 * 1000;
    private static readonly CUSTOM_URL_FAILURES_MAX = 5000;
    /** Largest logo/poster body fetched from a provider-chosen URL. */
    private static readonly CUSTOM_URL_MAX_BYTES = 10 * 1024 * 1024;
    private readonly customUrlFailures = new Map<string, { retryAt: number; gone: boolean }>();

    /**
     * In-process LRU for composite-key → internal UUID resolution.
     *
     * The composite-key mapping (provider:externalId:mediaType → media_items.id) is
     * stable: a row's external ID never changes after ingest. Cache it so the access
     * gate on poster-grid pages doesn't hammer the DB with N identical lookups on
     * first paint. Sentinel NULL encodes "not in library" so repeated misses don't
     * re-query either. 30-minute TTL gives catalog reconciliation time to propagate.
     */
    private static readonly PROVIDER_ID_NULL = Symbol('provider-id-null');
    private providerIdCache = new LRUCache<string | typeof ImageProxyService.PROVIDER_ID_NULL>({
        maxSize: 2000,
        defaultTTL: 30 * 60 * 1000,
        namespace: 'provider-id-resolver',
    });

    /**
     * Negative cache for `getUserAvatar`: users that resolved to no avatar at all.
     *
     * Only POSITIVE results were ever cached, so a user with no custom upload, no
     * Jellyfin picture and no Gravatar re-ran the Jellyfin HTTP fetch AND the
     * Gravatar HTTPS fetch on every single request. /admin/users draws one avatar
     * per row (UserTable.svelte), so a page of N avatar-less users cost N upstream
     * fetch pairs per page view — each Gravatar attempt carrying a 10 s timeout.
     *
     * Keyed by the resolved username ALONE, unlike the disk-cache keys, which are
     * per quality/width variant: "this user has no avatar anywhere" is a property
     * of the user, not of the derivative that was asked for. The key is case-folded
     * (see `avatarMissKey`) so `invalidateAvatarCache` clears it whatever spelling
     * the caller used.
     */
    private static readonly AVATAR_MISS_CONFIRMED_TTL = 10 * 60 * 1000;
    /**
     * TTLs, and why the two are not the same number.
     *
     * CONFIRMED (10 min) means every source we consulted answered, and answered
     * "no": no avatar row, Jellyfin 404, no email on file, or Gravatar 404 (we
     * request `d=404`). A stored avatar (upload or IdP copy) never waits on this
     * entry — it is looked up in the DB before the entry is consulted, so an
     * upload on any replica shows at once — so the TTL is only the bound for
     * changes made OUT of band (a Gravatar registered at gravatar.com, a picture
     * set in Jellyfin's own UI). 10 minutes keeps that window
     * short enough to feel live while still collapsing a page view to one probe
     * per user.
     *
     * TRANSIENT (15 s) means we never actually got an answer — a DB error, a
     * Jellyfin timeout/5xx, an SSRF-guard refusal, a Gravatar network failure.
     * Caching THAT for 10 minutes would let a 2-second Jellyfin blip blank every
     * avatar in the app for ten minutes, and the browser would cache the 404 on
     * top of that. 15 s still collapses a fetch storm ~40x during an outage while
     * recovering within one page refresh — the same trade, for the same reason, as
     * STAT_NEGATIVE_TTL above.
     */
    private static readonly AVATAR_MISS_TRANSIENT_TTL = 15 * 1000;
    /**
     * Returned by an avatar source that could not be reached, as distinct from
     * one that was reached and had nothing. Follows the sentinel-symbol idiom the
     * caches above use, so `null` keeps meaning exactly "no avatar here".
     */
    private static readonly AVATAR_SOURCE_UNAVAILABLE = Symbol('avatar-source-unavailable');
    private avatarMissCache = new LRUCache<'confirmed' | 'transient'>({
        maxSize: 5000,
        defaultTTL: ImageProxyService.AVATAR_MISS_CONFIRMED_TTL,
        namespace: 'avatar-miss',
    });

    constructor(private sql: postgres.Sql) {
        this.tmdbProvider = new TmdbImageProvider(sql);
        this.logoLegibility = new LogoLegibilityResolver(async (id, kind) => {
            await requireImageProviderBudget();
            return tmdbApi.getLogos(id, kind);
        });
        this.jellyfinProvider = new JellyfinImageProvider();
        this.audiobookshelfProvider = new AudiobookshelfImageProvider();
        // staleIfError: Deezer's CDN refuses prod's egress IP with 403 for a
        // quarter of an hour at a time; an expired artist poster beats a placeholder.
        this.customUrlCache = new ImageCache({
            directory: CUSTOM_URL_CACHE_DIR,
            ttl: CUSTOM_URL_CACHE_TTL,
            staleIfError: (err) => !(err instanceof CustomUrlGone),
        });
        this.audiobookCache = new ImageCache({
            directory: path.join(process.cwd(), '.cache', 'audiobook'),
            ttl: 30 * 24 * 60 * 60 * 1000, // 30 days
        });
        this.arrCache = new ImageCache({
            directory: path.join(process.cwd(), '.cache', 'arr-images'),
            ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
        });
        this.personCache = new ImageCache({
            directory: path.join(process.cwd(), '.cache', 'tmdb-persons'),
            ttl: 30 * 24 * 60 * 60 * 1000, // 30 days
        });
        this.kavitaCache = new ImageCache({
            directory: path.join(process.cwd(), '.cache', 'kavita'),
            ttl: 14 * 24 * 60 * 60 * 1000, // 14 days
        });
        this.avatarCache = new ImageCache({
            directory: path.join(process.cwd(), '.cache', 'user-avatars'),
            ttl: 2 * 24 * 60 * 60 * 1000, // 48 hours
        });
        // Disk cache for tryLocalArtwork output. Without this every request
        // for admin-uploaded artwork ran Sharp end-to-end (50–300 ms for
        // AVIF), which dominated the request even when the source file
        // hadn't changed in months. Cache key includes file mtime so an
        // admin re-upload changes the key, leaving the old encoded buffer
        // to age out via TTL or the size-budget pass.
        this.localArtworkOutputCache = new ImageCache({
            directory: path.join(process.cwd(), '.cache', 'local-artwork'),
            ttl: 30 * 24 * 60 * 60 * 1000, // 30 days
        });

        // Register the L1 caches so they appear in /admin/developer/cache and operators
        // can see hit-rate trends. register() is idempotent — duplicate
        // names silently no-op — so no try/catch is needed; if it ever
        // throws that's a bug we want to surface, not swallow.
        standaloneCacheRegistry.register({
            name: 'image-metadata-l1',
            description: 'In-process cache for getImageMetadata (recursive CTE)',
            category: 'media',
            cache: this.imageMetadataCache,
        });
        standaloneCacheRegistry.register({
            name: 'local-artwork-l1',
            description: 'In-process cache for getLocalArtwork lookups',
            category: 'media',
            cache: this.localArtworkCache,
        });
        standaloneCacheRegistry.register({
            name: 'provider-id-resolver-l1',
            description: 'In-process cache for composite-key → internal UUID resolution',
            category: 'media',
            cache: this.providerIdCache,
        });
        standaloneCacheRegistry.register({
            name: 'avatar-miss-l1',
            description: 'In-process negative cache for users with no avatar (Jellyfin/Gravatar)',
            category: 'media',
            cache: this.avatarMissCache,
        });
    }

    /** Cached wrapper around getImageMetadata.
     *  Single get() + sentinel disambiguation: returning null from get()
     *  unambiguously means "miss" (the LRU returns null on absence AND on
     *  expired entries). The METADATA_NULL sentinel encodes "cached null"
     *  separately so we don't re-query just because the row legitimately
     *  came back empty. */
    private async cachedGetImageMetadata(
        uuid: string,
        type: ImageType,
    ): Promise<ImageMetadataRow | null> {
        const key = `${uuid}:${type}`;
        const cached = this.imageMetadataCache.get(key);
        if (cached !== null) {
            return cached === ImageProxyService.METADATA_NULL ? null : cached;
        }
        const row = await getImageMetadata(this.sql, uuid, type);
        this.imageMetadataCache.set(
            key,
            row ?? ImageProxyService.METADATA_NULL,
            row ? ImageProxyService.L1_POSITIVE_TTL : undefined,
        );
        return row;
    }

    /** Cached wrapper around getLocalArtwork. Same sentinel pattern as
     *  cachedGetImageMetadata; negative results are common (most items
     *  have no admin-uploaded artwork) and cheap to remember. */
    private async cachedGetLocalArtwork(
        uuid: string,
        type: 'poster' | 'backdrop' | 'logo' | 'thumb',
    ): Promise<{ file_path?: string | null } | null> {
        const key = `${uuid}:${type}`;
        const cached = this.localArtworkCache.get(key);
        if (cached !== null) {
            return cached === ImageProxyService.METADATA_NULL ? null : cached;
        }
        const row = await getLocalArtwork(this.sql, uuid, type);
        this.localArtworkCache.set(
            key,
            row ?? ImageProxyService.METADATA_NULL,
            row ? ImageProxyService.L1_POSITIVE_TTL : undefined,
        );
        return row;
    }

    /**
     * Batch-warm the local-artwork L1 cache for a set of sibling items
     * (typically all episodes of a season, whose thumb requests arrive as a
     * burst right after the episode list renders).
     *
     * On a cold cache each of those requests runs its own recursive
     * parent-walk CTE — twice for episodes, via the thumb→backdrop fallback —
     * so a 20-episode season costs up to ~40 concurrent CTEs. This primes
     * `${uuid}:thumb` and `${uuid}:backdrop` entries (positive AND negative)
     * from a single batched query that replicates getLocalArtwork's
     * nearest-ancestor-first pick. Failures are swallowed: warming is an
     * optimization, never a correctness dependency.
     */
    async warmLocalArtworkCache(mediaItemIds: string[]): Promise<void> {
        if (mediaItemIds.length === 0) return;
        try {
            const rows = await getLocalArtworkInheritedBatch(this.sql, mediaItemIds, [
                'thumb',
                'backdrop',
            ]);
            const winners = new Map<string, string>();
            for (const row of rows) {
                // Rows arrive ordered by (origin, type, depth) — first one wins,
                // matching getLocalArtwork's ORDER BY depth LIMIT 1.
                const key = `${row.origin_id}:${row.artwork_type}`;
                if (!winners.has(key) && row.file_path) winners.set(key, row.file_path);
            }
            for (const id of mediaItemIds) {
                for (const type of ['thumb', 'backdrop'] as const) {
                    const key = `${id}:${type}`;
                    const filePath = winners.get(key);
                    this.localArtworkCache.set(
                        key,
                        filePath ? { file_path: filePath } : ImageProxyService.METADATA_NULL,
                        filePath ? ImageProxyService.L1_POSITIVE_TTL : undefined,
                    );
                }
            }
        } catch (error) {
            logger.debug('warmLocalArtworkCache failed (non-fatal)', {
                count: mediaItemIds.length,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Cached wrapper around resolveMediaIdByProvider.
     *
     * Composite-key → internal UUID resolution is an uncached DB lookup that fires
     * on every composite-key image hit BEFORE the access check. A poster grid
     * triggers N identical lookups on first paint. This cache collapses them to a
     * single DB round-trip per key per 30-minute window. Null results (not in
     * library) are also cached via the sentinel to suppress repeated misses.
     */
    async cachedResolveMediaIdByProvider(
        provider: string,
        externalId: string,
        /**
         * Passed through to resolveMediaIdByProvider, which matches it verbatim
         * against external_ids.media_type — a column holding episode/season rows.
         */
        mediaType?: string,
    ): Promise<string | null> {
        const key = `${provider}:${externalId}:${mediaType ?? ''}`;
        const cached = this.providerIdCache.get(key);
        if (cached !== null) {
            return cached === ImageProxyService.PROVIDER_ID_NULL ? null : cached;
        }
        const resolved = await _resolveMediaIdByProvider(this.sql, provider, externalId, mediaType);
        this.providerIdCache.set(key, resolved ?? ImageProxyService.PROVIDER_ID_NULL);
        return resolved;
    }

    /**
     * Get image by catalog UUID with configurable provider fallback chain.
     *
     * Provider order is controlled by the IMAGE_PROVIDER_PRIORITY config setting.
     * Default: local → tmdb → custom (Jellyfin is watch-sync only and not in the
     * default chain; operators can add it back via config).
     */
    async getImageByCatalogId(
        uuid: string,
        type: ImageType,
        options: ImageOptions = {},
    ): Promise<ImageResponse | null> {
        options = restrictImageOptions(options);
        return this.dedupe(
            this.dedupeKey(
                'catalog',
                uuid,
                type,
                options.size,
                options.format,
                options.quality,
                options.maxWidth,
                options.maxHeight,
                options.path,
                options.rawSize,
                options.allowUnmappedJellyfinFetch === true ? 'jf-unmapped' : undefined,
                options.inherit,
                options.index,
                options.revision,
            ),
            () => this._getImageByCatalogIdImpl(uuid, type, options),
        );
    }

    private async _getImageByCatalogIdImpl(
        uuid: string,
        type: ImageType,
        options: ImageOptions,
    ): Promise<ImageResponse | null> {
        // Per-request phase timer. Logs `Image catalog timing` on slow paths
        // (>= 200 ms) or any cache MISS so we can see *where* a cold request
        // spent its time without flooding logs on warm hits.
        const startedAt = performance.now();
        let winner: ImageProviderType | 'jellyfin-fallback' | 'audiobookshelf' | null = null;
        let cacheStatus: string | undefined;
        let returnedBytes = 0;
        const { result, context } = runPerf(async () => {
            try {
                let row = await timePhase('metadata', () =>
                    options.inherit === 'none'
                        ? getImageMetadata(this.sql, uuid, type, 'none')
                        : this.cachedGetImageMetadata(uuid, type),
                );

                // Jellyfin IDs are 32 hex chars without dashes — they pass isUuid()
                // but don't match media_items.id. Such an id (an image URL an
                // older client cached) is mapped through the external_ids rows
                // Jellyfin sync keeps — a database lookup only, empty on a
                // standalone install. An unmapped one is fetched from the Jellyfin
                // server below only for an admin caller that opts in
                // (`allowUnmappedJellyfinFetch`) and only while Jellyfin is usable
                // (sync on, connected, breaker closed): it has no Lumastra item to
                // gate, and the Jellyfin server may hold items Lumastra hides.
                const looksLikeJellyfinId = !row && /^[0-9a-f]{32}$/i.test(uuid);

                // Fallback: resolve the Jellyfin item id via external_ids to the
                // internal UUID so the normal provider chain can serve it.
                let resolvedUuid = uuid;
                if (looksLikeJellyfinId) {
                    const resolved = await timePhase('metadata.jellyfin-fallback', () =>
                        lookupLegacyJellyfinImageMediaId(this.sql, uuid),
                    );
                    if (resolved) {
                        resolvedUuid = resolved;
                        row = await timePhase('metadata.resolved', () =>
                            options.inherit === 'none'
                                ? getImageMetadata(this.sql, resolvedUuid, type, 'none')
                                : this.cachedGetImageMetadata(resolvedUuid, type),
                        );
                    }
                }

                // Match the ImageSet chain before invoking any provider: inherited metadata
                // can otherwise make an artist URL look like the album's own cover.
                // The owner lookup is fresh, so a newly added real cover wins immediately.
                if (
                    options.inherit !== 'none' &&
                    isAlbum(row?.media_type) &&
                    (type === 'poster' || type === 'primary')
                ) {
                    const rows = await getImageDescriptorOwners(this.sql, [resolvedUuid]);
                    const owners = new Map(rows.map((owner) => [owner.id, owner]));
                    const own = owners.get(resolvedUuid);
                    const spec = own
                        ? resolveImageSpecsForOwner(own, owners, options).primary
                        : undefined;
                    if (!spec) return null;
                    // Own-only prevents a second inheritance walk, including for VA albums,
                    // and keeps all cached bytes and blurhash writes attached to their owner.
                    return this.getImageByCatalogId(spec.ownerId, 'poster', {
                        ...options,
                        inherit: 'none',
                    });
                }

                if (row) {
                    const candidate = await resolveSelectedImageCandidate(
                        this.sql,
                        resolvedUuid,
                        type,
                        options.inherit,
                        options.index,
                    );
                    const selected = candidate
                        ? await this.serveImageCandidate(candidate, type, options, row)
                        : null;
                    if (selected) {
                        cacheStatus = selected.cacheStatus;
                        returnedBytes = selected.buffer.length;
                    }
                    if (selected && candidate) {
                        // Bind entitlement to the identity that produced these bytes,
                        // not a descriptor queried independently after the fetch.
                        const current = candidate.contentRevision
                            ? await resolveSelectedImageCandidate(
                                  this.sql,
                                  resolvedUuid,
                                  type,
                                  options.inherit,
                                  options.index,
                              )
                            : null;
                        return {
                            ...selected,
                            servedRevision:
                                selected.servedRevision === candidate.contentRevision &&
                                current?.contentRevision === candidate.contentRevision
                                    ? candidate.contentRevision
                                    : undefined,
                            provenance: {
                                provider: candidate.provider,
                                providerRef: candidate.provider_ref,
                            },
                        };
                    }
                    if (candidate) {
                        if (candidate.locked)
                            logger.warn('Locked image selection could not be served', {
                                uuid: resolvedUuid,
                                type,
                                candidateId: candidate.id,
                                provider: candidate.provider,
                            });
                        return null;
                    }
                    // Discover legacy artwork only when there is no elected identity.
                    const byteType =
                        type === 'primary' ? 'poster' : type === 'still' ? 'thumb' : type;
                    const suppressed = await getSuppressedImageProviders(
                        this.sql,
                        resolvedUuid,
                        byteType,
                    );
                    if (
                        byteType === 'poster' &&
                        row.audiobookshelf_id &&
                        !suppressed.includes('audiobookshelf')
                    ) {
                        const cover = await this.audiobookshelfProvider.getCover({
                            itemId: row.audiobookshelf_id,
                            revision: Number(row.audiobookshelf_revision) || null,
                            options,
                        });
                        if (cover) return cover;
                    }
                    const fallbackRow = { ...row };
                    for (const key of [
                        'poster_path',
                        'backdrop_path',
                        'logo_path',
                        'still_path',
                        'custom_poster_url',
                        'custom_thumb_url',
                        'custom_backdrop_url',
                        'custom_logo_url',
                    ] as const) {
                        const url = fallbackRow[key];
                        if (url && suppressed.includes(deriveImageProvider(url)))
                            fallbackRow[key] = null;
                    }
                    for (const provider of this.getProviderPriority(
                        byteType,
                        row.media_type ?? undefined,
                    )) {
                        if (suppressed.includes(provider)) continue;
                        const fallback = await this.tryProvider(
                            provider,
                            resolvedUuid,
                            byteType,
                            options,
                            fallbackRow,
                        );
                        if (fallback) {
                            winner = provider;
                            cacheStatus = fallback.cacheStatus;
                            returnedBytes = fallback.buffer.length;
                            this.maybeSaveBlurhash(resolvedUuid, byteType, fallback.buffer).catch(
                                () => {},
                            );
                            return fallback;
                        }
                    }
                }

                // Last resort: if the ID is a Jellyfin UUID and no DB match was found
                // (e.g. item not yet synced), fetch directly from the Jellyfin
                // server — only while Jellyfin sync may call out.
                if (
                    looksLikeJellyfinId &&
                    options.inherit !== 'none' &&
                    !row &&
                    options.allowUnmappedJellyfinFetch === true &&
                    canCallJellyfin()
                ) {
                    const jellyfinResult = await timePhase('provider.jellyfin-direct', () =>
                        this.getJellyfinImage(uuid, type, options),
                    );
                    if (jellyfinResult) {
                        winner = 'jellyfin-fallback';
                        cacheStatus = jellyfinResult.cacheStatus;
                        returnedBytes = jellyfinResult.buffer.length;
                        return jellyfinResult;
                    }
                }

                logger.debug('Image not found via any provider', {
                    uuid,
                    resolvedUuid: resolvedUuid !== uuid ? resolvedUuid : undefined,
                    type,
                });
                return null;
            } catch (error) {
                logger.error('Failed to fetch catalog image', error as Error, {
                    uuid,
                    type,
                });
                return null;
            }
        });

        const finalResult = await result;
        const totalMs = Math.round(performance.now() - startedAt);
        if (cacheStatus !== undefined) {
            imageProxyCacheOpsTotal.inc({
                result: cacheStatus === 'HIT' ? 'hit' : cacheStatus === 'STALE' ? 'stale' : 'miss',
            });
        }
        if (totalMs >= 200 || cacheStatus === 'MISS') {
            logger.info('Image catalog timing', {
                uuid,
                type,
                size: options.size,
                format: options.format,
                totalMs,
                winner,
                cacheStatus,
                bytes: returnedBytes,
                phases: context.phases,
            });
        }
        return finalResult;
    }

    private async fetchCandidateUrl(
        url: string,
        options: ImageOptions,
        useUpstreamProxy = false,
        contentRevision?: string,
        proveRevision = false,
    ): Promise<ImageResponse | null> {
        const result = await this.fetchCustomUrl(
            url,
            options.size,
            options.format,
            useUpstreamProxy,
            options.rawSize?.startsWith('w')
                ? Number(options.rawSize.slice(1))
                : options.maxWidth
                  ? Number(options.maxWidth)
                  : undefined,
            options.quality,
            contentRevision,
        );
        return result
            ? {
                  ...result,
                  servedRevision:
                      proveRevision && result.cacheStatus !== 'STALE' ? contentRevision : undefined,
              }
            : null;
    }

    /** Try the elected identity locally and remotely before legacy provider discovery. */
    async serveImageCandidate(
        candidate: SelectedImageCandidate,
        type: ImageType,
        options: ImageOptions = {},
        row?: ImageMetadataRow | null,
    ): Promise<ImageResponse | null> {
        if (candidate.file_path) {
            const local = await this.tryLocalArtwork(
                candidate.media_item_id ?? candidate.id,
                candidate.artwork_type,
                options,
                row,
                candidate,
            );
            if (local) return local;
        }
        if (candidate.provider === 'jellyfin') {
            const owner = /^[0-9a-f]{32}$/i.test(candidate.provider_ref)
                ? null
                : candidate.media_item_id
                  ? await this.cachedGetImageMetadata(
                        candidate.media_item_id,
                        candidate.artwork_type,
                    )
                  : row;
            const id = /^[0-9a-f]{32}$/i.test(candidate.provider_ref)
                ? candidate.provider_ref
                : owner?.jellyfin_id;
            return id ? this.getJellyfinImage(id, type, options) : null;
        }
        if (candidate.provider === 'audiobookshelf') {
            // The ABS URL/identity stays fixed when its bytes change. The
            // descriptor reads the current version, so serving through an older
            // metadata-cache entry would cache old bytes under that NEW version.
            const current =
                candidate.media_item_id && options.inherit !== 'none'
                    ? await getImageMetadata(this.sql, candidate.media_item_id, type, 'none')
                    : row;
            if (!current?.audiobookshelf_id) return null;
            const result = await this.audiobookshelfProvider.getCover({
                itemId: current.audiobookshelf_id,
                revision: Number(current.audiobookshelf_revision) || null,
                contentRevision: candidate.contentRevision,
                options,
            });
            return result
                ? {
                      ...result,
                      servedRevision:
                          !candidate.file_path &&
                          candidate.absCoverUpdatedAt != null &&
                          Number(candidate.absCoverUpdatedAt) ===
                              Number(current.audiobookshelf_revision) &&
                          result.cacheStatus !== 'STALE'
                              ? candidate.contentRevision
                              : undefined,
                  }
                : null;
        }
        // URL uploads and enrichment retain the HTTP identity here while remote_url
        // records a writer marker such as admin:url or album-enrichment.
        if (/^https?:\/\//i.test(candidate.provider_ref)) {
            const recovered = await this.fetchCandidateUrl(
                candidate.provider_ref,
                options,
                row?.media_type === 'tvchannel',
                candidate.contentRevision,
                // Literal HTTP identities can change bytes without a catalog write.
                // Their canonical revision partitions cache entries, but proves no bytes.
            );
            if (recovered) return recovered;
            if (candidate.remote_url === candidate.provider_ref) return null;
        }
        if (candidate.remote_url && /^https?:\/\//i.test(candidate.remote_url)) {
            return this.fetchCandidateUrl(
                candidate.remote_url,
                options,
                row?.media_type === 'tvchannel',
                candidate.contentRevision,
            );
        }
        if (candidate.provider === 'tmdb' && isProviderImagePath(candidate.provider_ref)) {
            return this.fetchCandidateUrl(
                `https://image.tmdb.org/t/p/original${candidate.provider_ref}`,
                options,
                row?.media_type === 'tvchannel',
                candidate.contentRevision,
                !candidate.file_path,
            );
        }
        return null;
    }

    /**
     * Dispatch to the appropriate provider for catalog image resolution.
     */
    private async tryProvider(
        provider: ImageProviderType,
        uuid: string,
        type: ImageType,
        options: ImageOptions,
        row: ImageMetadataRow | null,
    ): Promise<ImageResponse | null> {
        switch (provider) {
            case 'local': {
                const local = await this.tryLocalArtwork(uuid, type, options, row);
                if (local) return local;
                const slot = type === 'primary' ? 'poster' : type === 'still' ? 'thumb' : type;
                const legacy = await getLegacyLocalArtwork(
                    this.sql,
                    uuid,
                    slot,
                    options.inherit !== 'none',
                );
                return legacy ? this.tryLocalArtwork(uuid, slot, options, row, legacy) : null;
            }
            case 'generic':
                return this.tryGenericUrl(row, type, options);
            case 'tmdb':
                return this.tryTmdb(row, type, options, uuid);
            case 'jellyfin':
                return this.tryJellyfin(row, type, options);
            case 'custom': {
                const ownUrl =
                    type === 'poster' || type === 'primary'
                        ? row?.custom_poster_url
                        : type === 'backdrop'
                          ? row?.custom_backdrop_url
                          : type === 'logo'
                            ? row?.custom_logo_url
                            : type === 'thumb' || type === 'still'
                              ? row?.custom_thumb_url
                              : null;
                const url = ownUrl ?? (options.inherit === 'none' ? null : row?.custom_poster_url);
                if (!row || !url) return null;
                return this.tryCustomUrl({ ...row, custom_poster_url: url }, options);
            }
            default:
                return null;
        }
    }

    /**
     * Try loading locally stored artwork files (poster, backdrop, logo, thumb).
     *
     * Episode thumb fallback: episodes store ffmpeg-extracted frames as
     * artwork_type='backdrop' (source 'local'). When type='thumb' and no
     * local thumb row exists, fall back to the local backdrop row so the
     * extracted frame is served instead of going to TMDB.
     */
    private async tryLocalArtwork(
        uuid: string,
        type: ImageType,
        options: ImageOptions,
        row?: ImageMetadataRow | null,
        selectedCandidate?: SelectedImageCandidate,
    ): Promise<ImageResponse | null> {
        const localArtworkTypes = new Set([
            'poster',
            'backdrop',
            'logo',
            'thumb',
            'still',
            'banner',
        ]);
        if (options.inherit === 'none' && type === 'primary') {
            return this.tryLocalArtwork(uuid, 'poster', options, row);
        }
        if (!localArtworkTypes.has(type)) return null;

        // 'still' is the provider's name for an episode frame; 'thumb' is ours.
        // tryTmdb already treats them as one thing (both resolve to still_path
        // for an episode) — this layer did not, and 'still' was missing from the
        // set above entirely. So an episode whose frame had been extracted locally
        // served it on 'thumb' and fell through to the placeholder on 'still' —
        // and 'still' is the role the API advertises to clients, which is what the
        // iOS app requests. It deliberately does NOT fall back to the episode
        // poster, because that resolves to the series poster and gives every
        // episode the same picture.
        const localType = type === 'still' ? 'thumb' : type;

        const artworkType = localType as 'poster' | 'backdrop' | 'logo' | 'thumb';
        let localRow =
            selectedCandidate ??
            (options.inherit === 'none'
                ? await getOwnLocalArtwork(this.sql, uuid, artworkType)
                : await this.cachedGetLocalArtwork(uuid, artworkType));

        // Episode-specific fallback: if no local thumb exists but the item is
        // an episode, try the episode's OWN local backdrop row (the ffmpeg-
        // extracted frame). It must belong to the episode itself — the backdrop
        // lookup inherits up the parent chain, so an ancestor's backdrop (e.g. a
        // series-root backdrop.jpg sidecar) would otherwise be served as EVERY
        // episode's identical thumb, masking each episode's real TMDB still.
        if (!localRow?.file_path && localType === 'thumb' && isEpisode(row?.media_type ?? '')) {
            // OWN-row lookup (not the inheriting cachedGetLocalArtwork): the
            // extracted frame belongs to the episode itself. Using the inheriting
            // walk here would serve an ancestor's backdrop (e.g. a series-root
            // backdrop.jpg sidecar) as every episode's identical thumb, masking
            // each episode's real TMDB still.
            const ownBackdrop = await getOwnLocalArtwork(this.sql, uuid, 'backdrop');
            if (ownBackdrop?.file_path) {
                localRow = ownBackdrop;
            }
        }

        if (!localRow?.file_path) return null;
        const filePath = localRow.file_path;

        // Servable if the file is under a library root OR under the app's own
        // managed extraction directory (BASE_PATH/image-sync). The latter is
        // where ffmpeg-extracted episode frames land when artwork storage is
        // configured as 'config-dir' (the default) — that directory is
        // app-controlled, not attacker-influenced, so serving from it is safe.
        // Without this, every centrally-stored extracted frame is blocked and
        // episodes silently fall back to (often wrong) provider stills.
        const extractedFramesDir = path.join(config.BASE_PATH || '/tmp', 'image-sync');
        // Music cover art the scanner/enrichment writes under the central config dir
        // ({BASE_PATH||/config}/metadata/music/{album-covers,artist-images}) when the
        // track folder is shared or the cover came from Cover Art Archive. App-controlled
        // (not attacker-influenced), same trust rationale as the extracted-frames dir.
        // NB: this base defaults to /config (matching albumCoverMetadataPath), NOT /tmp.
        const musicMetadataDir = path.join(config.BASE_PATH || '/config', 'metadata', 'music');
        // isPathWithinMediaStore, not isPathWithinLibraryRoots: artwork the
        // image-sync task downloads is written to `<BASE_PATH>/.metadata/<id>/`
        // (media-image-storage.service.ts), which is deliberately OUTSIDE every
        // library root so the scanner never walks it. Checking library roots
        // alone therefore blocked every centrally-stored poster/backdrop and the
        // item fell through to the placeholder — indistinguishable, from the
        // outside, from "this item has no artwork".
        const isServable = async (candidate: string): Promise<boolean> =>
            (await isPathWithinMediaStore(this.sql, candidate)) ||
            isPathWithin(candidate, extractedFramesDir) ||
            isPathWithin(candidate, musicMetadataDir);
        const servable = await isServable(filePath);
        if (!servable) {
            logger.warn('Local artwork path is outside library roots and managed dirs — blocked', {
                uuid,
                type,
                filePath,
            });
            return null;
        }

        try {
            // Resolve directory links too: the lexical allowlist alone lets a
            // sidecar (or its parent) redirect the read outside the artwork stores.
            // The generic parent resolver permits nonsensitive media mounts, so
            // artwork must recheck its stricter roots on the resolved path.
            const resolvedPath = await resolveContainedFile(
                filePath,
                [extractedFramesDir, musicMetadataDir],
                { parents: true },
            );
            const artworkRoot = resolvedPath
                ? await findResolvedMediaStoreRoot(this.sql, resolvedPath, [
                      extractedFramesDir,
                      musicMetadataDir,
                  ])
                : null;
            if (!resolvedPath || !artworkRoot) return null;

            // Honor the negotiated format so AVIF-capable clients get AVIF
            // for custom-uploaded artwork too. Map ImageFormat → encoder
            // format; logos that explicitly want PNG keep their alpha.
            const encodeFormat: 'webp' | 'avif' | 'jpeg' | 'png' =
                options.format === 'avif'
                    ? 'avif'
                    : options.format === 'jpg'
                      ? 'jpeg'
                      : options.format === 'png'
                        ? 'png'
                        : 'webp';

            // Read the exact opened bytes even on encoded-cache hits. NFS metadata
            // and another replica's stat cache cannot certify unchanged content.
            const original = await timePhase('local.read', () =>
                readContainedFile(resolvedPath, {
                    extraRoots: [extractedFramesDir, musicMetadataDir],
                    validateOpenedFile: (actualPath) => isPathWithin(actualPath, artworkRoot),
                }),
            );
            const measuredHash = createHash('sha256').update(original).digest('hex');
            // Cache key uses the EFFECTIVE (snapped) size + quality tokens — NOT
            // raw width/quality. Two near-preset widths arrive here already
            // snapped to the same `size`, so they collapse onto one entry; a
            // custom/exact width arrives as maxWidth → 'w<N>', a distinct entry.
            const sizeKey = sizeCacheToken(options);
            const qualityKey = qualityCacheToken(options.quality);
            const customWidth = options.maxWidth
                ? Number.parseInt(options.maxWidth, 10)
                : undefined;
            const cacheKey =
                createHash('sha256')
                    .update(
                        `${uuid}:${type}:${sizeKey}:${qualityKey}:${encodeFormat}:${measuredHash}:${resolvedPath}${options.inherit === 'none' ? `:own:${resolvedPath}` : ''}`,
                    )
                    .digest('hex') + `.${encodeFormat}`;

            const { buffer, wasHit } = await this.localArtworkOutputCache.getCachedOrFetch(
                cacheKey,
                async () => {
                    const ext = path.extname(filePath).toLowerCase();
                    const originalContentType = EXT_TO_CONTENT_TYPE[ext] ?? 'image/jpeg';
                    // Custom width (snapped-miss / exact) → resize to that width.
                    // Preset sizes (thumb/medium/card) resize+encode in one pass.
                    // size=full or unset transcodes without resizing so full-size
                    // local artwork still respects the format request.
                    // `options.size` is typed as `ImageSize`, which doesn't declare a
                    // 'custom' member — but `resolveEffectiveImageOptions` does stamp a
                    // 'custom' sentinel onto it (via a cast) for snapped/exact custom
                    // widths, so the runtime value can legitimately be 'custom' here.
                    const effectiveSize = options.size as ImageSize | 'custom' | undefined;
                    const hasResizeTarget =
                        customWidth !== undefined ||
                        (effectiveSize && effectiveSize !== 'full' && effectiveSize !== 'custom');
                    const transformed = await timePhase(`local.encode.${encodeFormat}`, () =>
                        !hasResizeTarget
                            ? transcodeToFormat(original, originalContentType, encodeFormat)
                            : resizeForPreset(
                                  original,
                                  originalContentType,
                                  options.size,
                                  encodeFormat,
                                  customWidth,
                                  options.quality,
                              ),
                    );
                    return transformed.buffer;
                },
                { encode: true },
            );

            // Sniff the cached buffer rather than trust encodeFormat —
            // resizeForPreset/transcodeToFormat may have fallen back
            // (e.g. AVIF→WebP→JPEG) and the actual bytes win.
            const contentType = sniffImageContentType(buffer);
            if (!contentType) return null;

            return {
                buffer,
                contentType,
                // 24h fresh + 7d stale-while-revalidate. With the disk
                // cache hot, repeat hits still read/hash source bytes (including
                // NFS I/O) to verify identity, but avoid a full Sharp encode.
                cacheControl: 'public, max-age=86400, stale-while-revalidate=604800',
                cacheStatus: wasHit ? 'HIT' : 'MISS',
                servedRevision:
                    selectedCandidate?.local_content_hash === measuredHash
                        ? selectedCandidate.contentRevision
                        : undefined,
            };
        } catch {
            logger.debug('Local artwork file missing, falling back to provider', {
                uuid,
                type,
                filePath: localRow.file_path,
            });
            return null;
        }
    }

    /**
     * Try TMDB image resolution: fast path (stored poster/backdrop path) then API fallback.
     */
    private async tryTmdb(
        row: ImageMetadataRow | null,
        type: ImageType,
        options: ImageOptions,
        catalogId?: string,
    ): Promise<ImageResponse | null> {
        if (!row) return null;
        const tmdbId = row.primary_provider === 'tmdb' ? row.primary_ext_id : row.tmdb_id;
        if (!tmdbId) return null;

        const originMediaType = (row.media_type ?? 'movie') as MediaType;
        const metadataMediaType = (row.metadata_media_type ??
            row.media_type ??
            'movie') as MediaType;
        const mediaType =
            (type === 'thumb' || type === 'still') && originMediaType === 'episode'
                ? originMediaType
                : type === 'poster' && originMediaType === 'season'
                  ? originMediaType
                  : metadataMediaType;
        const imagePath =
            type === 'poster' || (options.inherit === 'none' && type === 'primary')
                ? row.poster_path
                : type === 'backdrop'
                  ? row.backdrop_path
                  : type === 'logo'
                    ? row.logo_path
                    : options.inherit === 'none' && (type === 'thumb' || type === 'still')
                      ? row.still_path
                      : null;

        // A dark stored logo is swapped for a light same-language TMDB variant
        // when one exists (see logo-legibility.ts).
        const servedPath =
            type === 'logo' && imagePath
                ? await this.logoLegibility.resolve(tmdbId, metadataMediaType, imagePath)
                : imagePath;

        // Fast path: use stored path directly to skip API lookup
        // Season metadata can inherit a series poster from its parent; avoid
        // materializing that inherited series poster as season-local artwork.
        const canUseDirectPath = !(
            type === 'poster' &&
            originMediaType === 'season' &&
            row.metadata_source_id !== catalogId
        );
        if (servedPath && canUseDirectPath) {
            const directOptions = catalogId
                ? { ...options, path: servedPath, catalogId }
                : { ...options, path: servedPath };
            return await this.getTmdbImage(tmdbId, mediaType, type, directOptions);
        }

        if (options.inherit === 'none') return null;

        // API fallback: let TMDB provider look up the path
        const providerOptions = catalogId ? { ...options, catalogId } : options;
        return await this.getTmdbImage(tmdbId, mediaType, type, providerOptions);
    }

    /**
     * Try Jellyfin image resolution if a Jellyfin ID is available.
     */
    private async tryJellyfin(
        row: ImageMetadataRow | null,
        type: ImageType,
        options: ImageOptions,
    ): Promise<ImageResponse | null> {
        if (!row?.jellyfin_id) return null;
        return await this.getJellyfinImage(row.jellyfin_id, type, options);
    }

    /**
     * Try serving an absolute-URL art path from a non-TMDB provider.
     *
     * Provider metadata rows from non-TMDB sources (e.g. faketvdb, tvdb)
     * may store fully-qualified http(s) URLs in the neutral artwork block
     * (`artwork->>'poster'`, `artwork->>'backdrop'`, etc.) which surfaces
     * in `ImageMetadataRow` via the COALESCE in `getImageMetadata`. TMDB-style
     * paths start with "/" and are relative to image.tmdb.org; absolute URLs
     * must be served directly without prepending the TMDB CDN template.
     *
     * Delegates to `fetchCustomUrl` so SSRF protection, disk caching, and
     * format conversion all apply without duplication.
     */
    private async tryGenericUrl(
        row: ImageMetadataRow | null,
        type: ImageType,
        options: ImageOptions,
    ): Promise<ImageResponse | null> {
        if (!row) return null;
        const artPath =
            type === 'poster' || (options.inherit === 'none' && type === 'primary')
                ? row.poster_path
                : type === 'backdrop'
                  ? row.backdrop_path
                  : type === 'logo'
                    ? row.logo_path
                    : type === 'still' || type === 'thumb'
                      ? row.still_path
                      : null;
        if (!isAbsoluteUrl(artPath)) return null;
        return this.fetchCustomUrl(
            artPath,
            options.size,
            options.format,
            false,
            options.maxWidth ? Number.parseInt(options.maxWidth, 10) : undefined,
            options.quality,
        );
    }

    /**
     * Try custom poster URL (external URL, e.g. LiveTV channel logos).
     */
    private async tryCustomUrl(
        row: ImageMetadataRow | null,
        options: ImageOptions,
    ): Promise<ImageResponse | null> {
        if (!row?.custom_poster_url) return null;
        // LiveTV channel logos (tvchannel rows) route through the upstream proxy
        // for IP hiding; all other custom posters stay direct.
        const useUpstreamProxy = row.media_type === 'tvchannel';
        return await this.fetchCustomUrl(
            row.custom_poster_url,
            options.size,
            options.format,
            useUpstreamProxy,
            options.maxWidth ? Number.parseInt(options.maxWidth, 10) : undefined,
            options.quality,
        );
    }

    /**
     * Get the configured provider priority order, validated against known types.
     */
    private getProviderPriority(type?: ImageType, mediaType?: string): ImageProviderType[] {
        const validProviders = new Set<string>(['local', 'generic', 'tmdb', 'jellyfin', 'custom']);
        const parse = (raw: string[]): ImageProviderType[] | null => {
            if (!raw || raw.length === 0) return null;
            const filtered = raw.filter((p): p is ImageProviderType => validProviders.has(p));
            return filtered.length > 0 ? filtered : null;
        };

        if (type === 'thumb' && isEpisode(mediaType)) {
            const override = config.IMAGE_PROVIDER_PRIORITY_EPISODE_THUMB;
            if (override) {
                const parsed = parse(override);
                if (parsed) return parsed;
            }
        }

        // Music (album/artist/track) is a fully separate subsystem — no TMDB and no
        // Jellyfin art. Its cover is stored LOCALLY (a media_artwork row + file on disk:
        // alongside the track in the library, or under the central metadata dir), with
        // custom_poster_url pointing at the internal /api/image/custom/{id}/poster route.
        // So serve `local` FIRST (reads media_artwork directly); `custom` is the fallback
        // for the rare album whose only art is an external Cover Art Archive URL.
        if (isMusicType(mediaType)) {
            const override = config.IMAGE_PROVIDER_PRIORITY_MUSIC;
            if (override) {
                const parsed = parse(override);
                if (parsed) return parsed;
            }
            return ['local', 'custom'];
        }

        const raw = config.IMAGE_PROVIDER_PRIORITY;
        if (Array.isArray(raw)) {
            const parsed = parse(raw);
            if (parsed) return parsed;
        }
        return DEFAULT_IMAGE_PROVIDER_PRIORITY;
    }

    /**
     * Single-flight wrapper. Concurrent callers with the same `key` await
     * one underlying fetch; the entry is removed once that fetch settles
     * (success or failure) so the next request triggers a fresh fetch.
     * Failures are NOT cached — only the pending promise is shared.
     */
    private async dedupe(
        key: string,
        fetcher: () => Promise<ImageResponse | null>,
    ): Promise<ImageResponse | null> {
        // Request admission is below the disk-cache read. Do not put a caller's
        // budget checks inside a cross-user service-level single-flight.
        if (hasImageWorkBudget()) return fetcher();
        const existing = this.inFlight.get(key);
        if (existing) return existing;
        const promise = (async () => {
            try {
                return await fetcher();
            } finally {
                this.inFlight.delete(key);
            }
        })();
        this.inFlight.set(key, promise);
        return promise;
    }

    /**
     * Compose a deterministic dedup key from a label + ordered parts.
     *
     * Uses a sentinel for undefined so that `(uuid, 'poster', undefined)` and
     * `(uuid, 'poster', '')` don't collide — otherwise two distinct option
     * sets could share an in-flight promise and one caller would receive the
     * other's buffer.
     */
    private dedupeKey(label: string, ...parts: (string | number | undefined)[]): string {
        return `${label}:${parts.map((p) => (p === undefined ? '∅' : String(p))).join('|')}`;
    }

    /**
     * Get TMDB image
     */
    async getTmdbImage(
        tmdbId: string,
        mediaType: MediaType,
        type: ImageType,
        options: ImageOptions = {},
    ): Promise<ImageResponse | null> {
        options = restrictImageOptions(options);
        return this.dedupe(
            this.dedupeKey(
                'tmdb',
                tmdbId,
                mediaType,
                type,
                options.size,
                options.format,
                options.quality,
                options.path,
                options.rawSize,
                options.catalogId,
            ),
            async () => {
                try {
                    const request: ProviderImageRequest = {
                        providerId: tmdbId,
                        type,
                        mediaType,
                        options,
                    };
                    return await this.tmdbProvider.getImage(request);
                } catch (error) {
                    logger.error('TMDB image fetch failed', error as Error, {
                        tmdbId,
                        mediaType,
                        type,
                    });
                    return null;
                }
            },
        );
    }

    /**
     * Get Jellyfin image
     */
    async getJellyfinImage(
        itemId: string,
        type: ImageType,
        options: ImageOptions = {},
    ): Promise<ImageResponse | null> {
        options = restrictImageOptions(options);
        return this.dedupe(
            this.dedupeKey(
                'jellyfin',
                itemId,
                type,
                options.size,
                options.format,
                options.quality,
                options.maxWidth,
                options.maxHeight,
                options.inherit,
            ),
            async () => {
                try {
                    const request: ProviderImageRequest = {
                        providerId: itemId,
                        type,
                        options,
                    };
                    return await this.jellyfinProvider.getImage(request);
                } catch (error) {
                    if (error instanceof JellyfinUnavailableError) return null;
                    logger.error('Jellyfin image fetch failed', error as Error, {
                        itemId,
                        type,
                    });
                    return null;
                }
            },
        );
    }

    /**
     * Proxy an image referenced by a station's now-playing metadata (DJ avatar,
     * show artwork, up-next cover). Reads the raw upstream URL from the Valkey
     * now-playing cache record, SSRF-guards, fetches, and returns an image
     * response. Returns null when no URL is cached or upstream is not an image.
     */
    async getRadioMetadataImage(
        stationId: string,
        role: 'dj' | 'show' | 'up-next',
    ): Promise<{
        buffer: ArrayBuffer;
        contentType: string;
        cacheControl: string;
    } | null> {
        const record = await peekCacheRecord(stationId);
        if (!record || !record._imageUrls) return null;
        const roleKey = role === 'up-next' ? 'upNext' : role;
        const upstream = record._imageUrls[roleKey];
        if (!upstream) return null;

        let parsed: URL;
        try {
            parsed = new URL(upstream);
        } catch {
            return null;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MiB
        const ALLOWED_IMAGE_TYPES = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp',
            // image/svg+xml intentionally excluded — can embed <script>
        ];
        try {
            // Manually follow redirects so each hop re-resolves DNS and pins the
            // fetch to the resolved IP (closes the DNS-rebinding TOCTOU window
            // between the SSRF check and the actual connection).
            let current = parsed;
            let res: Response | null = null;
            for (let hop = 0; hop <= 3; hop++) {
                const safe = await resolveSafePublicUrl(current);
                res = await pinnedFetch(safe, {
                    method: 'GET',
                    signal: controller.signal,
                    redirect: 'manual',
                });
                if (res.status >= 300 && res.status < 400) {
                    const loc = res.headers.get('location');
                    if (!loc) return null;
                    let next: URL;
                    try {
                        next = new URL(loc, current);
                    } catch {
                        return null;
                    }
                    if (next.protocol !== 'http:' && next.protocol !== 'https:') return null;
                    current = next;
                    // Drop the hop's body unread: it is the station's to size.
                    discardResponseBody(res);
                    continue;
                }
                break;
            }
            if (!res || !res.ok) return null;
            const ct = (res.headers.get('content-type') ?? '').toLowerCase();
            if (!ALLOWED_IMAGE_TYPES.some((t) => ct.startsWith(t))) return null;

            const cl = res.headers.get('content-length');
            if (cl && Number(cl) > MAX_IMAGE_BYTES) return null;
            // Streamed with the cap: no Content-Length (or a false one) used to
            // mean the whole body was buffered before this size check.
            const bytes = await readBoundedResponseBytes(res, MAX_IMAGE_BYTES);
            const buffer = bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer;
            return {
                buffer,
                contentType: ct,
                cacheControl: 'public, max-age=300',
            };
        } catch (err) {
            logger.warn('Radio metadata image proxy failed', {
                stationId,
                role,
                error: (err as Error).message,
            });
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Get Audiobookshelf image. Honors the negotiated output format and
     * size, so audiobook covers participate in the AVIF/WebP rollout
     * instead of always being served as the upstream JPEG. Cache key
     * includes size and format so each variant gets its own slot.
     */
    async getAudiobookImage(
        bookId: string,
        options: ImageOptions = {},
    ): Promise<ImageResponse | null> {
        const missKey = JSON.stringify([config.AUDIOURL, bookId]);
        if (this.audiobookMissCache.get(missKey)) return null;
        try {
            // Existence only: authorization remains in the calling route. Check
            // before the image cache so a removed item cannot serve an old cover.
            const mediaId = await findMediaIdByProviderExternalId(this.sql, {
                provider: 'audiobookshelf',
                externalId: bookId,
                mediaType: 'audiobook',
            });
            if (!mediaId) {
                this.audiobookMissCache.set(missKey, true);
                logger.debug('Audiobook image item not found', { bookId });
                return null;
            }
            const size = options.size ?? 'full';
            const encodeFormat: 'webp' | 'avif' | 'jpeg' | 'png' =
                options.format === 'avif'
                    ? 'avif'
                    : options.format === 'jpg'
                      ? 'jpeg'
                      : options.format === 'png'
                        ? 'png'
                        : 'webp';
            const cacheKey = `audiobook-${bookId}-${size}-${encodeFormat}`;
            const { buffer, wasHit } = await this.audiobookCache.getCachedOrFetch(
                cacheKey,
                async () => {
                    await requireImageProviderBudget();
                    const response = await audiobookshelfClient.getBookImage(bookId);
                    if (!response.ok) {
                        discardResponseBody(response);
                        if (response.status === 404) {
                            this.audiobookMissCache.set(missKey, true);
                            throw new AudiobookCoverNotFoundError();
                        }
                        throw new Error(`Audiobookshelf returned ${response.status}`);
                    }
                    const upstream = await readBoundedResponseBytes(
                        response,
                        MAX_UPSTREAM_IMAGE_BYTES,
                    );
                    const upstreamType = response.headers.get('content-type') ?? 'image/jpeg';
                    // Resize+encode for preset sizes; for size=full
                    // transcode without resizing so AVIF clients still
                    // get AVIF for full-size audiobook covers.
                    const result =
                        size === 'full'
                            ? await transcodeToFormat(upstream, upstreamType, encodeFormat)
                            : await resizeForPreset(upstream, upstreamType, size, encodeFormat);
                    return result.buffer;
                },
                { provider: true, encode: true },
            );

            // Always sniff the cached buffer — resizeForPreset may have
            // returned the original (size=full) or fallen back through the
            // encoder chain; the bytes never lie.
            const contentType = sniffImageContentType(buffer);
            if (!contentType) return null;
            return {
                buffer,
                contentType,
                cacheControl: 'public, max-age=5184000', // 2 months
                cacheStatus: wasHit ? 'HIT' : 'MISS',
            };
        } catch (error) {
            if (error instanceof AudiobookCoverNotFoundError) {
                logger.debug('Audiobook image not found', { bookId });
                return null;
            }
            logger.error('Audiobook image fetch failed', error as Error, {
                bookId,
            });
            return null;
        }
    }

    /**
     * Get Sonarr/Radarr image via proxyArrImage utility
     */
    async getArrImage(
        provider: 'sonarr' | 'radarr',
        itemId: string,
        type: string,
        url?: URL,
        request?: Request,
    ): Promise<Response> {
        const serviceUrl = provider === 'sonarr' ? config.SONARRURL : config.RADARRURL;
        const apiKey = provider === 'sonarr' ? config.SONARRAPIKEY : config.RADARRAPIKEY;

        if (!serviceUrl || !apiKey) {
            return new Response(`${provider === 'sonarr' ? 'Sonarr' : 'Radarr'} not configured`, {
                status: 503,
            });
        }

        // Try cache first
        const useWebP = config.IMAGE_WEBP_ENABLED;
        const cacheKey = `${provider}-${itemId}-${type}.${useWebP ? 'webp' : 'jpg'}`;
        const contentType = useWebP ? 'image/webp' : 'image/jpeg';
        try {
            const cached = await this.arrCache.read(cacheKey);
            if (cached) {
                return imageResponse(
                    {
                        buffer: cached,
                        contentType,
                        cacheControl: 'public, max-age=86400',
                        cacheStatus: 'HIT',
                    },
                    request,
                );
            }
        } catch {
            // Cache miss, continue to fetch
        }

        // Fetch from upstream
        await requireImageProviderBudget();
        const result = await proxyArrImage(
            itemId,
            type,
            {
                serviceUrl,
                apiKey,
                serviceName: provider === 'sonarr' ? 'Sonarr' : 'Radarr',
            },
            url,
        );

        // Cache the response body if successful; route through imageResponse so
        // the caller gets ETag + 304 + stale-while-revalidate on this first fetch too.
        if (result.ok) {
            let buffer: Buffer;
            try {
                buffer = Buffer.from(await result.clone().arrayBuffer());
            } catch {
                // Upstream body truncated/aborted mid-read — pass the raw response
                // through (we only consumed the clone, so `result` is still
                // readable) instead of throwing a 500.
                return result;
            }
            this.arrCache.write(cacheKey, buffer).catch(() => {});
            const upstreamContentType = result.headers.get('content-type') ?? contentType;
            return imageResponse(
                {
                    buffer,
                    contentType: upstreamContentType,
                    cacheControl: 'public, max-age=86400',
                    cacheStatus: 'MISS',
                },
                request,
            );
        }

        return result;
    }

    /**
     * Fetch and cache an image from an arbitrary external URL.
     * Used for custom_poster_url (e.g. LiveTV channel logos from M3U playlists).
     * The browser never sees the external URL — we proxy and cache it server-side.
     *
     * When `size` is set to a known preset, the cached entry stores the
     * resized WebP variant; each variant has its own cache key so they coexist.
     *
     * SECURITY: the URL comes from `media_items.custom_poster_url`, which is
     * populated from M3U playlist ingest and other external feeds — i.e.,
     * attacker-influenceable. Without an SSRF guard the fetcher would happily
     * pull from `http://169.254.169.254/...` or `http://localhost:5432/...`.
     * `resolveSafePublicUrl` resolves the host and rejects RFC1918 / loopback /
     * link-local / IPv6-equivalents; `pinnedFetch` then pins the actual
     * connection to the resolved IP so DNS can't be re-queried (and rebound to
     * a private address) between the check and the connection. Through the
     * LiveTV upstream proxy the proxy dials the target itself, so only the
     * per-hop check applies there.
     */
    async fetchCustomUrl(
        url: string,
        size?: string,
        format?: string,
        useUpstreamProxy = false,
        /** Custom/exact width (px) — overrides the preset width when set. */
        customWidth?: number,
        /** Explicit encode quality — honored on custom/exact derivatives. */
        quality?: number,
        /** Elected candidate cache namespace; independent of a requested v/tag. */
        contentRevision?: string,
    ): Promise<ImageResponse | null> {
        try {
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                return null;
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return null;
            }
            const failure = this.customUrlFailures.get(url);
            // A negative hit must skip DNS as well as HTTP. Keep disk-cache
            // handling below so transient failures can still serve stale bytes.
            if (!failure || Date.now() >= failure.retryAt) {
                try {
                    // custom_poster_url is populated by LiveTV M3U ingest, and an
                    // operator running a LAN IPTV provider serves channel logos from
                    // that same LAN. LIVETV_ALLOW_PRIVATE_URLS is their explicit
                    // opt-in, and the import and playback paths already honour it —
                    // without it here the channels import fine and then every logo
                    // silently falls back to the placeholder, which reads as "the
                    // artwork is missing" rather than "the fetch was refused".
                    //
                    // This widens an SSRF guard, so keep the shape of that decision
                    // clear: it is off by default, it only lifts the private-range
                    // rejection (DNS is still resolved and pinnedFetch still pins
                    // the connection against rebinding), and it is bounded to
                    // the one flag an operator sets deliberately.
                    await resolveSafePublicUrl(parsed, {
                        allowPrivate: useUpstreamProxy && config.LIVETV_ALLOW_PRIVATE_URLS,
                    });
                } catch (err) {
                    if (err instanceof Error && err.name === 'PrivateAddressError') {
                        logger.warn('Refusing to fetch custom URL: SSRF guard tripped', {
                            url,
                            reason: err.message,
                            allowPrivateUrls: useUpstreamProxy && config.LIVETV_ALLOW_PRIVATE_URLS,
                        });
                        return null;
                    }
                    // DNS resolution failure is an upstream outage, not an SSRF
                    // refusal. Record it before entering the cache fetcher so
                    // repeats (and other size variants) skip DNS for an hour.
                    this.recordCustomUrlFailure(url, err, false);
                }
            }

            // Cache key includes the EFFECTIVE size token (preset name OR
            // 'w<N>' for a custom/exact width), the effective quality, and the
            // format so AVIF/WebP and each bounded/custom width variant of the
            // same external URL coexist. Raw width never leaks in: a snapped
            // width already arrived as a preset `size`, a custom width as
            // `customWidth` → 'w<N>'.
            const sizeToken = customWidth !== undefined ? `w${customWidth}` : (size ?? '');
            const variantSuffix = `:v2:${useUpstreamProxy ? 'channel' : 'public'}:${sizeToken}:${quality ?? ''}:${format ?? ''}`;
            const cacheKey = createHash('sha256')
                .update(
                    url + variantSuffix + (contentRevision ? `:revision:${contentRevision}` : ''),
                )
                .digest('hex');
            // Map ImageFormat → encoder format for resizeForPreset. Honor
            // explicit jpg/png requests; default to webp otherwise.
            const encodeFormat: 'webp' | 'avif' | 'jpeg' | 'png' =
                format === 'avif'
                    ? 'avif'
                    : format === 'jpg'
                      ? 'jpeg'
                      : format === 'png'
                        ? 'png'
                        : 'webp';

            const { buffer, wasHit, stale } = await this.customUrlCache.getCachedOrFetch(
                cacheKey,
                async () => {
                    const failure = this.customUrlFailures.get(url);
                    if (failure !== undefined && Date.now() < failure.retryAt) {
                        throw failure.gone ? new CustomUrlGone() : new CustomUrlBackoff();
                    }
                    await requireImageProviderBudget();
                    // Record the failure here, not in the outer catch: when the
                    // cache serves a stale copy instead, that catch never runs, and
                    // every request would go upstream again with no backoff or log.
                    try {
                        // Manually follow redirects so each hop re-resolves DNS and
                        // pins the fetch to the resolved IP (closes the
                        // DNS-rebinding TOCTOU window between the SSRF check and
                        // the actual connection). Without this a public 302 →
                        // http://localhost / 169.254.169.254 would bypass the
                        // up-front guard since undici's default redirect mode
                        // follows automatically, and even a manual re-check of the
                        // hostname alone would leave a window where DNS is
                        // re-queried at fetch time.
                        let current = parsed;
                        let response: Response | null = null;
                        const dispatcher = useUpstreamProxy
                            ? getLiveTvUpstreamDispatcher()
                            : undefined;
                        for (let hop = 0; hop <= 3; hop++) {
                            // Same opt-in as the up-front guard above. Without it the
                            // pre-check passed and THIS re-check rejected, so a LAN
                            // logo failed with the SSRF message under a flag that is
                            // supposed to permit exactly that.
                            const safe = await resolveSafePublicUrl(current, {
                                allowPrivate: useUpstreamProxy && config.LIVETV_ALLOW_PRIVATE_URLS,
                            }).catch((err: unknown) => {
                                // A transient DNS failure is not a refusal: it keeps the stale copy.
                                // By name: several tests mock ssrf-guard without its error classes.
                                throw err instanceof Error && err.name === 'PrivateAddressError'
                                    ? new CustomUrlRefused(err.message)
                                    : err;
                            });
                            // With the upstream proxy the proxy dials the target (and
                            // gets the real hostname, so vhosts route); otherwise the
                            // connection is pinned to the vetted IP.
                            response = await pinnedFetch(safe, {
                                method: 'GET',
                                signal: AbortSignal.timeout(10_000),
                                headers: { 'User-Agent': 'Lumastra/1.0' },
                                redirect: 'manual',
                                dispatcher,
                            });
                            if (response.status >= 300 && response.status < 400) {
                                const loc = response.headers.get('location');
                                if (!loc) {
                                    throw new Error(
                                        `redirect without Location header from ${current.toString()}`,
                                    );
                                }
                                let next: URL;
                                try {
                                    next = new URL(loc, current);
                                } catch {
                                    throw new Error(`invalid redirect target ${loc}`);
                                }
                                if (next.protocol !== 'http:' && next.protocol !== 'https:') {
                                    throw new Error(`non-http(s) redirect target ${next.protocol}`);
                                }
                                current = next;
                                // Drop the hop's body unread: its size is the provider's choice.
                                discardResponseBody(response);
                                continue;
                            }
                            break;
                        }
                        if (!response || !response.ok) {
                            // Which layer refused (CDN edge or origin) is the first
                            // question when a provider starts answering 403.
                            const server = response?.headers.get('server');
                            if (response) discardResponseBody(response);
                            const message =
                                `HTTP ${response?.status ?? 'no response'} fetching ${url}` +
                                (server ? ` (server: ${server})` : '');
                            throw response && (response.status === 404 || response.status === 410)
                                ? new CustomUrlRefused(message)
                                : new Error(message);
                        }
                        // The URL is a channel/program logo that the M3U or XMLTV provider
                        // chose: read it with a cap (a throw lands in the failure backoff).
                        const original = await readBoundedResponseBytes(
                            response,
                            ImageProxyService.CUSTOM_URL_MAX_BYTES,
                        );
                        // A MIME header or a recognizable signature alone cannot prove
                        // this is an image. Validate before encoding can return the original.
                        const originalType = sniffImageContentType(original);
                        if (!originalType) throw new CustomUrlRefused('Unsupported image body');
                        try {
                            await sharp(original).metadata();
                        } catch {
                            throw new CustomUrlRefused('Invalid image body');
                        }
                        this.customUrlFailures.delete(url);
                        // Pass the upstream Content-Type when present so the
                        // resize path can decide format intelligently rather
                        // than guessing from the URL extension.
                        const upstreamType = response.headers.get('content-type') ?? undefined;
                        const resized = await resizeForPreset(
                            original,
                            upstreamType ?? 'application/octet-stream',
                            size,
                            encodeFormat,
                            customWidth,
                            quality,
                        );
                        // The cache rejects an empty buffer outside this try, where
                        // the failure would go unrecorded.
                        if (resized.buffer.length === 0) throw new Error('empty image');
                        return resized.buffer;
                    } catch (err) {
                        const gone = err instanceof CustomUrlRefused;
                        this.recordCustomUrlFailure(url, err, gone);
                        if (!gone) throw new CustomUrlBackoff();
                        // Drop the expired copy too: the failure map is per process, so
                        // another pod or a restart would otherwise serve it again.
                        await this.customUrlCache.delete(cacheKey);
                        throw new CustomUrlGone();
                    }
                },
                { provider: true, encode: true },
            );

            // Always sniff magic bytes — the cached buffer can be:
            //   - WebP if resizeForPreset succeeded
            //   - JPEG if WebP encoding failed and resizeForPreset fell back
            //   - upstream original (any image type) for size=full / undefined
            // Hard-coding `image/webp` for resized presets would lie when the
            // JPEG fallback fired, breaking the image in the browser.
            const contentType = sniffImageContentType(buffer);
            if (!contentType) return null;

            return {
                buffer,
                contentType,
                // A stale copy stands in until the upstream answers again: keep
                // browsers to the failure backoff, not the full week.
                cacheControl: stale ? 'public, max-age=600' : 'public, max-age=604800',
                cacheStatus: stale ? 'STALE' : wasHit ? 'HIT' : 'MISS',
            };
        } catch (error) {
            if (error instanceof ImageWorkBudgetExceededError) throw error;
            // Already recorded inside the fetcher.
            if (error instanceof CustomUrlBackoff || error instanceof CustomUrlGone) return null;
            this.recordCustomUrlFailure(url, error, false);
            return null;
        }
    }

    /** Start (or restart) a custom URL's failure backoff; warn once per failing URL. */
    private recordCustomUrlFailure(url: string, error: unknown, gone: boolean): void {
        // While it stays down the repeats are debug.
        const repeat = this.customUrlFailures.has(url);
        this.customUrlFailures.delete(url);
        if (this.customUrlFailures.size >= ImageProxyService.CUSTOM_URL_FAILURES_MAX) {
            const oldest = this.customUrlFailures.keys().next().value;
            if (oldest !== undefined) this.customUrlFailures.delete(oldest);
        }
        this.customUrlFailures.set(url, {
            retryAt: Date.now() + ImageProxyService.CUSTOM_URL_RETRY_MS,
            gone,
        });
        const context = {
            url,
            error: error instanceof Error ? error.message : String(error),
        };
        if (repeat) logger.debug('Failed to fetch custom URL image', context);
        else logger.warn('Failed to fetch custom URL image', context);
    }

    /**
     * Get image by composite key (provider:id:mediaType)
     *
     * Example: tmdb:550:movie
     */
    async getImageByCompositeKey(
        compositeKey: string,
        type: ImageType,
        options: ImageOptions = {},
    ): Promise<ImageResponse | null> {
        const parts = compositeKey.split(':');
        if (parts.length !== 3) {
            throw new Error('Invalid composite key format. Expected provider:id:mediaType');
        }

        const [provider, id, mediaType] = parts;

        if (options.inherit === 'none') {
            const resolvedId = await this.cachedResolveMediaIdByProvider(
                provider,
                id,
                mediaType === 'movie' || mediaType === 'tv' ? mediaType : undefined,
            );
            return resolvedId ? this.getImageByCatalogId(resolvedId, type, options) : null;
        }

        if (provider === 'tmdb') {
            return await this.getTmdbImage(id, mediaType as MediaType, type, options);
        } else if (provider === 'jellyfin') {
            // A `jellyfin:` key is fetched from the Jellyfin server. Callers gate it
            // by resolving the key with its media type, which a wrong type escapes
            // (and an unmapped id has no item to gate at all), so only an admin
            // caller that opts in gets one; everyone else the placeholder.
            if (options.allowUnmappedJellyfinFetch !== true) return null;
            return await this.getJellyfinImage(id, type, options);
        }

        // Unknown provider: resolve to an internal UUID via the external_ids
        // table and delegate to the full provider priority chain.  This lets
        // any provider whose IDs land in external_ids (e.g. tvdb, imdb) serve
        // images without requiring a hard-coded branch here.
        const resolvedId = await this.cachedResolveMediaIdByProvider(
            provider,
            id,
            mediaType === 'movie' || mediaType === 'tv' ? mediaType : undefined,
        );
        if (resolvedId) {
            return await this.getImageByCatalogId(resolvedId, type, options);
        }

        logger.debug('getImageByCompositeKey: no internal UUID for unknown provider', {
            compositeKey,
            provider,
        });
        return null;
    }

    /**
     * Rate-limited fetch for TMDB person API calls
     */
    private async rateLimitedFetch(
        url: string,
        options: RequestInit = {},
    ): Promise<globalThis.Response> {
        await requireImageProviderBudget();
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastPersonRequestTime;

        if (timeSinceLastRequest < this.minPersonRequestInterval) {
            await new Promise((resolve) =>
                setTimeout(resolve, this.minPersonRequestInterval - timeSinceLastRequest),
            );
        }

        this.lastPersonRequestTime = Date.now();
        // C22 fix-plan finding scope: every caller of this helper targets a
        // fixed, non-admin-configurable public host (api.themoviedb.org) —
        // see docs/dev/eslint-exceptions.md.
        return trackExternalCall(url, () => fetchWithTimeout(url, options, 10_000));
    }

    /**
     * Get person profile image (TMDB)
     *
     * Fetches person details from TMDB to get profile_path, then fetches
     * and caches the image with optional WebP conversion.
     *
     * @param personId - TMDB person ID (numeric string)
     * @param options - Image options (rawSize for TMDB size like 'w185', quality)
     */
    async getPersonImage(
        personId: string,
        options: ImageOptions = {},
    ): Promise<ImageResponse | null> {
        options = restrictImageOptions(options);
        const stored = await getSelectedImageCandidate(this.sql, `tmdb:${personId}`, 'poster');
        if (stored) {
            const selected = await this.serveImageCandidate(stored, 'poster', options);
            if (selected) return selected;
            if (stored.locked)
                logger.warn('Locked image selection could not be served', {
                    personRef: `tmdb:${personId}`,
                    candidateId: stored.id,
                    provider: stored.provider,
                });
            return null;
        }
        if (
            (await getSuppressedImageProviders(this.sql, `tmdb:${personId}`, 'poster')).includes(
                'tmdb',
            )
        )
            return null;
        const TMDB_API_KEY = config.TMDB_API_KEY;
        if (!TMDB_API_KEY) {
            // Benign, static config state (e.g. a music-only or Jellyfin-native
            // install with no TMDB key) — this fires per person-image request,
            // so ERROR would flood the log. Skip quietly at debug.
            logger.debug('TMDB person image requested but TMDB_API_KEY is not set — skipping');
            return null;
        }

        const numericId = Number.parseInt(personId, 10);
        if (Number.isNaN(numericId) || numericId <= 0) {
            return null;
        }

        const imageSize =
            options.rawSize && VALID_PERSON_SIZES.includes(options.rawSize)
                ? options.rawSize
                : 'w185';

        // Check in-memory cache for person details
        const memoryCacheKey = `person-${numericId}`;
        const cached = this.personDetailsCache.get(memoryCacheKey);
        let profilePath: string | null = null;

        if (cached && Date.now() - cached.cachedAt < this.personMemoryCacheTtl) {
            profilePath = cached.profilePath;
        } else {
            const detailsRequest = tmdbAuthorizedRequest(
                `https://api.themoviedb.org/3/person/${numericId}`,
                TMDB_API_KEY,
                { 'Content-Type': 'application/json' },
            );
            const detailsResponse = await this.rateLimitedFetch(detailsRequest.url, {
                headers: detailsRequest.headers,
            });

            if (!detailsResponse.ok) {
                if (detailsResponse.status === 429) {
                    throw new PersonRateLimitError();
                }
                return null;
            }

            const details: unknown = await readBoundedResponseJson(
                detailsResponse,
                MAX_UPSTREAM_JSON_BYTES,
            );
            profilePath =
                isRecord(details) && typeof details.profile_path === 'string'
                    ? details.profile_path
                    : null;
            const name =
                isRecord(details) && typeof details.name === 'string' ? details.name : 'Unknown';

            // FIFO eviction (oldest insertion evicted first)
            if (this.personDetailsCache.size >= this.maxPersonCacheSize) {
                const oldestKey = this.personDetailsCache.keys().next().value;
                if (oldestKey !== undefined) this.personDetailsCache.delete(oldestKey);
            }
            this.personDetailsCache.set(memoryCacheKey, {
                profilePath,
                name,
                cachedAt: Date.now(),
            });
        }

        if (!profilePath) {
            return null;
        }
        await registerPersonImageCandidate(this.sql, personId, profilePath);

        const useWebP = config.IMAGE_WEBP_ENABLED;
        const imageFormat = useWebP ? 'webp' : 'jpg';
        const contentType = useWebP ? 'image/webp' : 'image/jpeg';
        const quality = options.quality ?? config.IMAGE_THUMB_QUALITY;

        const cacheKey = `person-${numericId}-${imageSize}-q${quality}.${imageFormat}`;

        const { buffer, wasHit } = await this.personCache.getCachedOrFetch(
            cacheKey,
            async () => {
                const imageUrl = `https://image.tmdb.org/t/p/${imageSize}${profilePath}`;
                const fetchedImage = await this.rateLimitedFetch(imageUrl);

                if (!fetchedImage.ok) {
                    throw new Error(`Image fetch failed: ${fetchedImage.status}`);
                }

                const originalBuffer = await readBoundedResponseBytes(
                    fetchedImage,
                    MAX_UPSTREAM_IMAGE_BYTES,
                );

                if (useWebP) {
                    try {
                        return await sharp(originalBuffer).webp(getWebPOptions(quality)).toBuffer();
                    } catch (convertError) {
                        logger.warn(
                            'Failed to convert to WebP, using original',
                            { personId: numericId },
                            convertError as Error,
                        );
                    }
                }

                return originalBuffer;
            },
            { provider: true, encode: true },
        );

        return {
            buffer,
            contentType,
            cacheControl: 'public, max-age=2592000', // 30 days
            cacheStatus: wasHit ? 'HIT' : 'MISS',
        };
    }

    /**
     * Get Kavita cover image
     *
     * Proxies cover images from Kavita server with optional WebP conversion.
     *
     * @param kavitaType - Kavita image type (series, collection, readinglist, person, volume, chapter)
     * @param id - Kavita item ID (numeric string)
     * @param options - Image options (quality)
     */
    async getKavitaImage(
        kavitaType: string,
        id: string,
        options: ImageOptions = {},
    ): Promise<ImageResponse | null> {
        options = restrictImageOptions(options);
        if (!features.kavita) {
            return null;
        }

        const typeConfig = KAVITA_TYPE_CONFIG[kavitaType];
        if (!typeConfig) {
            return null;
        }

        const numericId = Number.parseInt(id, 10);
        if (Number.isNaN(numericId)) {
            return null;
        }

        const useWebP = config.IMAGE_WEBP_ENABLED;
        const imageFormat = useWebP ? 'webp' : 'jpg';
        const quality = options.quality ?? config.IMAGE_THUMB_QUALITY;

        const cacheKey = `kavita-${kavitaType}-${numericId}-q${quality}.${imageFormat}`;

        const { buffer, wasHit } = await this.kavitaCache.getCachedOrFetch(
            cacheKey,
            async () => {
                const baseUrl = config.KAVITAURL.replace(/\/$/, '');
                const apiKey = config.KAVITAAPIKEY;
                const imageUrl = `${baseUrl}/api/Image/${typeConfig.endpoint}?${typeConfig.param}=${numericId}&apiKey=${apiKey}`;

                // Routed through the same-origin-only redirect guard (C22
                // fix-plan finding) — KAVITAURL is admin-configured and the API
                // key rides in the query string.
                await requireImageProviderBudget();
                const response = await fetchWithTimeout(imageUrl, {}, 10_000);
                if (!response.ok) {
                    throw new Error(`Kavita image fetch failed: ${response.status}`);
                }

                const originalBuffer = await readBoundedResponseBytes(
                    response,
                    MAX_UPSTREAM_IMAGE_BYTES,
                );

                if (useWebP) {
                    try {
                        return await sharp(originalBuffer).webp(getWebPOptions(quality)).toBuffer();
                    } catch (convertError) {
                        logger.warn(
                            'Failed to convert to WebP, using original',
                            { kavitaType, id },
                            convertError as Error,
                        );
                    }
                }

                return originalBuffer;
            },
            { provider: true, encode: true },
        );

        const contentType = useWebP ? 'image/webp' : 'image/jpeg';

        return {
            buffer,
            contentType,
            cacheControl: 'public, max-age=2592000', // 30 days
            cacheStatus: wasHit ? 'HIT' : 'MISS',
        };
    }

    /**
     * Resolve a userId or username to a Jellyfin GUID via the shared
     * Valkey-cached resolver. Mirrors the result into a local username→GUID
     * map so the GUID→username reverse lookup used for Gravatar fallback
     * stays cheap.
     */
    private async resolveUserId(userIdOrName: string): Promise<string | null> {
        if (isGuid(userIdOrName)) {
            return userIdOrName;
        }

        const userId = await resolveJellyfinUserId(userIdOrName);
        if (!userId) {
            logger.warn('Could not find Jellyfin user for username', {
                username: userIdOrName,
            });
            return null;
        }
        this.usernameToGuidCache.set(userIdOrName.toLowerCase(), userId);
        return userId;
    }

    /**
     * Which stored avatar the user has and its version, without the bytes —
     * see `getUserAvatarVersion`. Same handle and error contract as
     * `fetchCustomAvatarBuffer`: AVATAR_SOURCE_UNAVAILABLE on a DB failure.
     */
    private async fetchStoredAvatarVersion(
        userIdOrName: string,
    ): Promise<
        | { source: 'upload' | 'idp'; version: string | null }
        | null
        | typeof ImageProxyService.AVATAR_SOURCE_UNAVAILABLE
    > {
        try {
            return await getUserAvatarVersion(this.sql, userIdOrName, {
                includeIdp: config.AUTH_OIDC_SYNC_AVATAR,
            });
        } catch (error) {
            logger.warn(
                'Failed to check custom avatar in database',
                { userIdOrName },
                error as Error,
            );
            return ImageProxyService.AVATAR_SOURCE_UNAVAILABLE;
        }
    }

    /**
     * Fetch a user's stored avatar from the database: the upload, else the
     * picture synced from the OIDC provider (when AUTH_OIDC_SYNC_AVATAR is on).
     *
     * Uses the instance's injected `this.sql` handle so task-pool callers
     * (e.g. provider-artwork-materialization) stay on the task pool rather
     * than silently falling back to the web pool.
     *
     * Returns AVATAR_SOURCE_UNAVAILABLE on a DB failure — the row may well
     * exist, we just couldn't read it, and the negative cache must not treat
     * that as "this user has no avatar".
     */
    private async fetchCustomAvatarBuffer(
        userIdOrName: string,
        _useWebP: boolean,
        _quality: number,
    ): Promise<
        | { buffer: Buffer; contentType: string; source: 'upload' | 'idp'; version: string | null }
        | null
        | typeof ImageProxyService.AVATAR_SOURCE_UNAVAILABLE
    > {
        try {
            const customAvatar = await getUserAvatar(this.sql, userIdOrName, {
                includeIdp: config.AUTH_OIDC_SYNC_AVATAR,
            });
            if (customAvatar) {
                return {
                    buffer: customAvatar.avatar_data,
                    contentType: customAvatar.avatar_content_type,
                    // Older mocks/rows without a source are uploads.
                    source: customAvatar.source ?? 'upload',
                    version: customAvatar.version ?? null,
                };
            }
        } catch (error) {
            logger.warn(
                'Failed to check custom avatar in database',
                { userIdOrName },
                error as Error,
            );
            return ImageProxyService.AVATAR_SOURCE_UNAVAILABLE;
        }
        return null;
    }

    /**
     * Try fetching avatar from Gravatar using the user's email
     *
     * Returns AVATAR_SOURCE_UNAVAILABLE when gravatar.com could not be reached
     * or answered 5xx/429, as opposed to `null`, which means it answered and
     * the answer was "no such avatar" (we ask for `d=404`) or the user has no
     * email on file at all. Only the latter is safely negative-cacheable for
     * the long TTL.
     */
    private async fetchGravatarBuffer(
        username: string,
        useWebP: boolean,
        quality: number,
    ): Promise<Buffer | null | typeof ImageProxyService.AVATAR_SOURCE_UNAVAILABLE> {
        // Guarded like fetchCustomAvatarBuffer's lookup: unguarded, a pool blip
        // here threw straight out of getUserAvatar and surfaced as a 500 on an
        // avatar endpoint. "No email on file" is a fact (→ null, long TTL); "the
        // DB didn't answer" is not (→ unavailable, short TTL), and either way the
        // caller degrades to initials rather than erroring.
        let user: Awaited<ReturnType<typeof getUserByUsername>>;
        try {
            user = await getUserByUsername(this.sql, username);
        } catch (error) {
            logger.warn('Failed to look up email for Gravatar', { username }, error as Error);
            return ImageProxyService.AVATAR_SOURCE_UNAVAILABLE;
        }
        const email = user?.email;
        if (!email) return null;

        const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
        const gravatarUrl = `https://www.gravatar.com/avatar/${hash}?s=200&d=404`;

        try {
            // C22 fix-plan finding scope: fixed, non-admin-configurable
            // public host (gravatar.com) — see docs/dev/eslint-exceptions.md.
            // eslint-disable-next-line callback-safety/no-bare-fetch-in-server
            const response = await fetch(gravatarUrl, { signal: AbortSignal.timeout(10_000) });
            if (!response.ok) {
                // 404 — and ONLY 404 — is Gravatar's own "no avatar for this hash"
                // answer, because we ask for `d=404`. Everything else (403 from a
                // WAF or an IP block, 429, any 5xx) is gravatar.com declining to
                // answer and says nothing about this user, so it must not earn the
                // long TTL. Whitelisting the one meaningful status rather than
                // blacklisting the unwell ones: a status we didn't think of is
                // then cheap-and-retried, not cached as a fact for 10 minutes.
                return response.status === 404 ? null : ImageProxyService.AVATAR_SOURCE_UNAVAILABLE;
            }

            const originalBuffer = await readBoundedResponseBytes(
                response,
                MAX_UPSTREAM_IMAGE_BYTES,
            );

            if (useWebP) {
                try {
                    return await sharp(originalBuffer).webp(getWebPOptions(quality)).toBuffer();
                } catch (error) {
                    if (error instanceof ImageWorkBudgetExceededError) throw error;
                    // Use original on conversion failure
                }
            }

            return originalBuffer;
        } catch (error) {
            if (error instanceof ImageWorkBudgetExceededError) throw error;
            logger.warn('Gravatar fetch failed', { username, error });
            return ImageProxyService.AVATAR_SOURCE_UNAVAILABLE;
        }
    }

    /**
     * Cache key for the avatar negative cache.
     *
     * Case-folded, because usernames are case-insensitively unique here and the
     * caller that records a miss (`getUserAvatar`, on whatever handle the request
     * used) is rarely the caller that clears it (`invalidateAvatarCache`, on
     * `user.username` from the DB). Folding both sides is what makes "a PUT
     * upload is visible on the next request" true rather than nearly true.
     */
    private static avatarMissKey(username: string): string {
        // WHICH SOURCES the miss consulted is part of the key, not just the user.
        // Both gates below are live getters an admin can flip from settings with no
        // restart, and a miss recorded while Gravatar was off is not evidence about
        // a request made after it was switched on — the source was never asked.
        // Folding the gate state in means a flip re-probes on the very next
        // request, and the now-unreachable entries just age out; invalidation needs
        // no extra work either, since it only has to clear the key a subsequent
        // read can actually hit, i.e. the one for the CURRENT gate state.
        //
        // Token first, username second: the token is one of four fixed short
        // strings, so no username content can straddle the separator.
        const sources = `${isJellyfinSyncEnabled() ? 'j' : '-'}${features.gravatar ? 'g' : '-'}`;
        return `${sources}|${username.toLowerCase()}`;
    }

    /**
     * Invalidate all cached avatar files for a user.
     * Call after avatar upload or deletion.
     */
    async invalidateAvatarCache(username: string): Promise<void> {
        // Drop the "this user has no avatar anywhere" marker first, so even if a
        // disk purge below throws, the next request re-probes the live sources
        // instead of being short-circuited by a stale miss.
        this.avatarMissCache.delete(ImageProxyService.avatarMissKey(username));

        // Custom avatar cache key prefix
        await this.avatarCache.deleteByPrefix(`custom-${username}-`);
        // IdP (OIDC picture) avatar cache key prefix
        await this.avatarCache.deleteByPrefix(`idp-${username}-`);
        // Gravatar cache key prefix
        await this.avatarCache.deleteByPrefix(`gravatar-${username}-`);

        // Jellyfin cache uses the GUID, not username — resolve if possible.
        // Folded on lookup because resolveUserId() stores the map key folded;
        // an unfolded get() here missed whenever the caller's spelling of the
        // username differed from lower-case, leaving the Jellyfin derivatives
        // behind after an upload.
        if (operationMode.isJellyfinEnabled) {
            const guid = this.usernameToGuidCache.get(username.toLowerCase());
            if (guid) {
                // A caller that asked by raw Jellyfin GUID recorded its miss under
                // the GUID handle (that is what its next read will key on), so
                // clearing only the username key would leave that caller seeing a
                // stale miss for the rest of the TTL.
                this.avatarMissCache.delete(ImageProxyService.avatarMissKey(guid));
                const sanitizedId = guid.replace(/[^a-zA-Z0-9-_]/g, '_');
                await this.avatarCache.deleteByPrefix(`${sanitizedId}-`);
            }
        }
    }

    /**
     * Invalidate in-process L1 caches for a catalog item.
     * Clears all artwork types for the given UUID from both the image-metadata
     * LRU and the local-artwork LRU so the next request re-resolves provider
     * and file path from the database.
     *
     * Call after reconciliation or any other operation that changes which
     * external IDs or local artwork a catalog item resolves to.
     */
    invalidateCatalogImage(uuid: string): void {
        const artworkTypes = ['poster', 'backdrop', 'logo', 'thumb', 'still'] as const;
        for (const t of artworkTypes) {
            this.imageMetadataCache.delete(`${uuid}:${t}`);
            this.localArtworkCache.delete(`${uuid}:${t}`);
        }
    }

    /**
     * Get user avatar image
     *
     * Resolution chain: Custom upload (DB) → IdP picture (DB, if AUTH_OIDC_SYNC_AVATAR) →
     *   Jellyfin (if configured) → Gravatar (if enabled) → null
     * @param userIdOrName - Username, internal users.id UUID, or Jellyfin user
     *   ID (GUID). A users.id UUID is resolved to its username first so every
     *   source keys on a handle it understands (see body).
     * @param options - Image options (quality)
     */
    /**
     * The size an avatar is STORED at, and the ceiling for any request.
     *
     * The upload path has always resized to exactly this (see the PUT handler),
     * and the route's own docs promise "a fixed 200 x 200 px". Neither was true
     * of the Jellyfin fallback, which re-encoded the upstream image without ever
     * resizing it — on prod that served a 2048x2080 avatar, ~17 MB of decoded
     * bitmap, for a button drawn at 44 pt. Every source now passes through
     * `normalizeAvatar`, so the documented contract holds whatever the source is.
     */
    private static readonly AVATAR_STORED_PX = 200;

    /**
     * Widths an avatar derivative may be cut to.
     *
     * Deliberately a short ladder rather than a free integer: the avatar cache is
     * keyed by width, and an open parameter lets any caller mint unbounded cache
     * entries for a picture that is at most 200 px to begin with. Four rungs
     * cover every render in the app — the UI draws avatars between 16 px and
     * 80 px, so 48/96 serve those at 2x, 160 covers a 3x 48 pt, and 200 is the
     * stored original.
     */
    private static readonly AVATAR_WIDTH_RUNGS = [48, 96, 160, 200] as const;

    /** Smallest rung that still covers `requested`, or the full stored size. */
    static snapAvatarWidth(requested: number | undefined): number {
        if (requested === undefined || !Number.isFinite(requested)) {
            return ImageProxyService.AVATAR_STORED_PX;
        }
        const rung = ImageProxyService.AVATAR_WIDTH_RUNGS.find((w) => w >= requested);
        // Snapping UP, unlike the media-image ladder, which picks the nearest
        // rung and can therefore hand back FEWER pixels than were asked for. For
        // a 200 px ceiling the saving from rounding down is negligible and the
        // cost is a visibly soft avatar, so this ladder only ever over-serves.
        return rung ?? ImageProxyService.AVATAR_STORED_PX;
    }

    /**
     * Bring any avatar source down to `targetPx` square, as WebP when enabled.
     *
     * `withoutEnlargement` matters: a Gravatar or a small custom upload must not
     * be scaled UP to the target, which would cost bytes and add nothing. On any
     * failure the original buffer is returned — an oversized avatar is a
     * performance problem, a missing one is a broken UI.
     */
    private async normalizeAvatar(
        buffer: Buffer,
        targetPx: number,
        useWebP: boolean,
        quality: number,
    ): Promise<Buffer> {
        try {
            const pipeline = sharp(buffer).resize(targetPx, targetPx, {
                fit: 'cover',
                withoutEnlargement: true,
            });
            return useWebP
                ? await pipeline.webp(getWebPOptions(quality)).toBuffer()
                : await pipeline.toBuffer();
        } catch (error) {
            if (error instanceof ImageWorkBudgetExceededError) throw error;
            logger.warn('Avatar normalization failed; serving source unchanged', {
                targetPx,
                error: error instanceof Error ? error.message : String(error),
            });
            return buffer;
        }
    }

    async getUserAvatar(
        userIdOrName: string,
        options: ImageOptions = {},
    ): Promise<ImageResponse | null> {
        const useWebP = config.IMAGE_WEBP_ENABLED;
        const imageFormat = useWebP ? 'webp' : 'jpg';
        const contentType = useWebP ? 'image/webp' : 'image/jpeg';
        // Avatars have their own bounded width ladder below. Apply only quality
        // restrictions here so raw 48/96px requests cannot be widened to 250px.
        const quality =
            restrictImageOptions({ quality: options.quality }).quality ??
            config.IMAGE_THUMB_QUALITY;
        // Requested width, snapped onto the short avatar ladder. Part of EVERY
        // cache key below — without that, the first caller to ask for 48 px
        // would poison the entry the next caller reads at 200 px, and vice
        // versa, which is the class of bug the media-image cache key already
        // guards against by naming its variant.
        const targetPx = ImageProxyService.snapAvatarWidth(
            options.maxWidth === undefined
                ? AVATAR_SIZE_TO_WIDTH[options.size ?? '']
                : Number(options.maxWidth),
        );
        const w = `w${targetPx}`;

        // The play-session, watch-together and activity UIs pass the internal
        // users.id (a UUID) rather than a username. That UUID is neither a
        // username (the custom-avatar / Gravatar key) nor a Jellyfin user GUID,
        // so every resolution step below would miss and the avatar would 404 to
        // initials. Resolve it to the canonical username up front so all three
        // sources — and the disk cache key, which invalidateAvatarCache keys by
        // username — agree on one handle. A real Jellyfin user GUID (Jellyfin
        // mode) won't match a users.id row, so getUserById returns null and this
        // falls through unchanged for that case.
        let resolvedKey = userIdOrName;
        if (isGuid(userIdOrName)) {
            const user = await getUserById(this.sql, userIdOrName);
            if (user?.username) resolvedKey = user.username;
        }

        let imageBuffer: Buffer | null = null;
        let cacheHit = false;
        let usernameForGravatar: string = resolvedKey;
        // Set when a source could not be reached (DB error, Jellyfin timeout /
        // 5xx / redirect refusal, Gravatar network failure). Downgrades the
        // negative entry written at the bottom to the short TTL — see
        // AVATAR_MISS_TRANSIENT_TTL.
        let sourceUnavailable = false;

        // Step 0: the stored avatar (upload, else IdP copy) from the database.
        //
        // The DB is asked FIRST, for the version only (no bytea), and the disk
        // cache second, keyed by that version. An upload, delete or IdP sync
        // purges only the disk cache of the replica that handled it; reading a
        // replica's cache before the DB kept serving the old picture there — or
        // a deleted one — until the entry aged out. Keyed by version, a replica
        // holding an older copy simply misses.
        const storedCacheKey = (source: 'upload' | 'idp', version: string | null) =>
            `${source === 'idp' ? 'idp' : 'custom'}-${resolvedKey}-v${version ?? '0'}-q${quality}-${w}.${imageFormat}`;
        const storedVersion = await this.fetchStoredAvatarVersion(resolvedKey);
        // The DB could not say whether an upload exists, so whatever the steps
        // below find (Jellyfin, Gravatar) may be standing in for it: served,
        // but not for 48 h in the browser.
        let storedUnknown = false;
        if (storedVersion === ImageProxyService.AVATAR_SOURCE_UNAVAILABLE) {
            sourceUnavailable = true;
            storedUnknown = true;
        } else if (storedVersion) {
            const cachedStored = await this.avatarCache.read(
                storedCacheKey(storedVersion.source, storedVersion.version),
            );
            if (cachedStored) {
                return {
                    buffer: cachedStored,
                    contentType,
                    cacheControl: 'public, max-age=172800',
                    cacheStatus: 'HIT',
                };
            }
            const customAvatar = await this.fetchCustomAvatarBuffer(resolvedKey, useWebP, quality);
            if (customAvatar === ImageProxyService.AVATAR_SOURCE_UNAVAILABLE) {
                sourceUnavailable = true;
                storedUnknown = true;
            } else if (customAvatar) {
                // Both stored at AVATAR_STORED_PX (upload PUT handler, IdP sync), so a
                // full-size request needs no work; only a smaller rung costs a re-encode.
                const buffer =
                    targetPx >= ImageProxyService.AVATAR_STORED_PX
                        ? customAvatar.buffer
                        : await this.normalizeAvatar(
                              customAvatar.buffer,
                              targetPx,
                              useWebP,
                              quality,
                          );
                // Keyed by the version read WITH these bytes, not the one read
                // above: a change landing between the two reads must not file the
                // new picture under the old version (or the reverse).
                this.avatarCache
                    .write(storedCacheKey(customAvatar.source, customAvatar.version), buffer)
                    .catch(() => {});
                return {
                    buffer,
                    contentType:
                        buffer === customAvatar.buffer ? customAvatar.contentType : contentType,
                    cacheControl: 'public, max-age=172800',
                    cacheStatus: 'MISS',
                };
            }
            // null: removed between the two reads — fall through like "none".
        }

        // Negative-cache short-circuit: this user resolved to nothing recently, so
        // don't pay for the Jellyfin fetch + the 10 s-timeout Gravatar fetch again.
        //
        // Checked HERE rather than at the top of the method, deliberately: the two
        // step above it is a single indexed query that returns no rows for exactly
        // the users this entry covers — cheap — whereas the two steps below are
        // network round trips, which is the whole cost. Keeping the stored-avatar
        // lookup live means a PUT is visible on the next request on EVERY replica,
        // though `invalidateAvatarCache` purges this entry only on the one that
        // took the PUT; only the sources we cannot check cheaply are skipped.
        const missKey = ImageProxyService.avatarMissKey(resolvedKey);
        if (this.avatarMissCache.get(missKey) !== null) {
            return null;
        }

        // Step 1: Try Jellyfin avatar (only while Jellyfin sync is on — URL + key
        // left behind after an admin switched sync off must not cause traffic)
        if (isJellyfinSyncEnabled()) {
            const userId = await this.resolveUserId(resolvedKey);
            if (!userId) {
                // resolveJellyfinUserId never throws: it returns undefined both
                // for "this Lumastra user has no Jellyfin account" (a fact) and
                // for "Jellyfin/the DB was unreachable" (not a fact), and from
                // here the two are indistinguishable. Take the cautious reading
                // so a Jellyfin outage can't pin a 10-minute miss on a user who
                // does have a Jellyfin picture; Lumastra-only users in a hybrid
                // install pay for that with the short TTL, which still collapses
                // a page view to one probe per user per 15 s.
                sourceUnavailable = true;
            } else {
                // If the input was a GUID, try to find the username for Gravatar
                if (isGuid(resolvedKey)) {
                    for (const [name, guid] of this.usernameToGuidCache) {
                        if (guid === userId) {
                            usernameForGravatar = name;
                            break;
                        }
                    }
                }

                const sanitizedId = userId.replace(/[^a-zA-Z0-9-_]/g, '_');
                const cacheKey = `${sanitizedId}-q${quality}-${w}.${imageFormat}`;

                const cached = await this.avatarCache.read(cacheKey);
                if (cached) {
                    imageBuffer = cached;
                    cacheHit = true;
                } else if (!canCallJellyfin()) {
                    // Down or breaker open: no fetch (it would cost a timeout per
                    // avatar), and not a fact about this user.
                    sourceUnavailable = true;
                } else {
                    // Fetch from Jellyfin
                    try {
                        // Routed through the same-origin-only redirect guard
                        // (C22 fix-plan finding) — this call carries the
                        // Jellyfin admin token and is reachable anonymously
                        // via /j/UserImage (src/routes/(proprietary)/j/UserImage).
                        const avatarUrl = joinUpstreamUrl(
                            config.JELLYFINURL,
                            `/Users/${encodePathSegment(userId)}/Images/Primary?quality=${quality}`,
                        );
                        const response = await fetchWithTimeout(
                            avatarUrl,
                            {
                                headers: buildJellyfinAuthHeaders({ token: config.JELLYFINAPIKEY }),
                            },
                            JELLYFIN_DIRECT_FETCH_TIMEOUT_MS,
                        );
                        recordJellyfinTransportSuccess();

                        if (response.ok) {
                            const originalBuffer = await readBoundedResponseBytes(
                                response,
                                MAX_UPSTREAM_IMAGE_BYTES,
                            );
                            // ALWAYS normalized, unlike the other two sources.
                            // Jellyfin serves a profile image at whatever size
                            // it holds — 2048x2080 on prod — and this branch
                            // used to re-encode it to WebP without resizing, so
                            // a 44 pt avatar cost ~17 MB of decoded bitmap on
                            // every client. `quality` compresses; only a resize
                            // changes what the client has to decode.
                            const outputBuffer = await this.normalizeAvatar(
                                originalBuffer,
                                targetPx,
                                useWebP,
                                quality,
                            );

                            imageBuffer = outputBuffer;
                            // Cache asynchronously
                            this.avatarCache.write(cacheKey, outputBuffer).catch(() => {});
                        } else if (response.status !== 404) {
                            // 404 — and ONLY 404 — is Jellyfin's "this user has no
                            // primary image", the one status that is a fact about
                            // the user. A 401/403 means the admin token was rotated
                            // or revoked, which is a config fault affecting EVERY
                            // user: classifying it as a fact would blank avatars
                            // app-wide for 10 minutes and keep them blank for 10
                            // more after the token is fixed. 5xx/429 likewise.
                            sourceUnavailable = true;
                        }
                    } catch (error) {
                        if (error instanceof ImageWorkBudgetExceededError) throw error;
                        // Timeout, connection refused, or the redirect guard
                        // refusing an off-origin Location — never a statement
                        // about whether this user has an avatar.
                        sourceUnavailable = true;
                        recordJellyfinTransportFailure(error);
                        logger.warn('Failed to fetch user avatar from Jellyfin', {
                            userId,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            }
        }

        // Step 2: Try Gravatar (if enabled and Jellyfin had no avatar)
        if (!imageBuffer && features.gravatar) {
            const gravatarCacheKey = `gravatar-${usernameForGravatar}-q${quality}-${w}.${imageFormat}`;

            const cached = await this.avatarCache.read(gravatarCacheKey);
            if (cached) {
                imageBuffer = cached;
                cacheHit = true;
            } else {
                const gravatar = await this.fetchGravatarBuffer(
                    usernameForGravatar,
                    useWebP,
                    quality,
                );
                if (gravatar === ImageProxyService.AVATAR_SOURCE_UNAVAILABLE) {
                    sourceUnavailable = true;
                } else {
                    imageBuffer = gravatar;
                }
                if (imageBuffer && targetPx < ImageProxyService.AVATAR_STORED_PX) {
                    // Gravatar is requested at s=200, so it already matches the
                    // stored size; only a smaller rung needs cutting down.
                    imageBuffer = await this.normalizeAvatar(
                        imageBuffer,
                        targetPx,
                        useWebP,
                        quality,
                    );
                }
                if (imageBuffer) {
                    this.avatarCache.write(gravatarCacheKey, imageBuffer).catch(() => {});
                }
            }
        }

        if (!imageBuffer) {
            // Record the miss so the next request for this user skips the two
            // network steps above. The route still answers 404 — this changes
            // only how expensive reaching that 404 is.
            const reason = sourceUnavailable ? 'transient' : 'confirmed';
            const ttl = sourceUnavailable
                ? ImageProxyService.AVATAR_MISS_TRANSIENT_TTL
                : ImageProxyService.AVATAR_MISS_CONFIRMED_TTL;
            // Written under BOTH handles when they differ, which happens when the
            // caller passed a raw Jellyfin GUID and the Jellyfin step reversed it
            // to a username: the read above keys on the handle the caller used, so
            // the GUID form has to be recorded, and invalidateAvatarCache only ever
            // knows the username form, so that has to be recorded too (it clears
            // the GUID form via usernameToGuidCache).
            //
            // But a GUID we could NOT reverse is recorded under nothing else, and
            // invalidateAvatarCache — always called with `user.username` — has no
            // way to reach it. An unreachable entry would outlive a genuine upload
            // for the whole 10 minutes, so decline to write one at all: this only
            // gives up the optimization for a Jellyfin GUID unknown to both
            // getUserById and this process's username→GUID map, never for the
            // username or users.id handles /admin/users actually uses.
            const handleIsUnreachableGuid =
                isGuid(resolvedKey) && usernameForGravatar === resolvedKey;
            if (!handleIsUnreachableGuid) {
                for (const key of new Set([
                    missKey,
                    ImageProxyService.avatarMissKey(usernameForGravatar),
                ])) {
                    this.avatarMissCache.set(key, reason, ttl);
                }
            }
            return null;
        }

        return {
            buffer: imageBuffer,
            contentType,
            cacheControl: storedUnknown ? 'public, max-age=60' : 'public, max-age=172800', // 48 hours
            cacheStatus: cacheHit ? 'HIT' : 'MISS',
        };
    }

    /**
     * Compute and persist a BlurHash for a media item image if not already stored.
     * Runs asynchronously in the background — callers should fire-and-forget.
     */
    private async maybeSaveBlurhash(uuid: string, type: ImageType, buffer: Buffer): Promise<void> {
        if (type !== 'poster' && type !== 'backdrop') return;

        const column = type === 'poster' ? 'poster_blurhash' : 'backdrop_blurhash';

        try {
            const [row] = await this.sql`
                SELECT ${this.sql(column)} as value FROM media_items WHERE id = ${uuid}
            `;
            if (row?.value) return;

            const hash = await computeBlurHash(buffer);
            if (hash) {
                await this.sql`
                    UPDATE media_items SET ${this.sql(column)} = ${hash}
                    WHERE id = ${uuid} AND ${this.sql(column)} IS NULL
                `;
            }
        } catch (error) {
            logger.debug('Failed to save blurhash', {
                uuid,
                type,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

/**
 * Thrown when TMDB returns 429 for person API calls.
 * Route handlers should catch this and return HTTP 429.
 */
export class PersonRateLimitError extends Error {
    constructor() {
        super('TMDB rate limit exceeded');
        this.name = 'PersonRateLimitError';
    }
}
