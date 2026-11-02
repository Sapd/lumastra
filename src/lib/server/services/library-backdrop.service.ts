// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library Backdrop Service
 *
 * Generates a fan-art–style 16:9 backdrop image for a library
 * (CollectionFolder) by compositing posters from the highest-rated items in
 * that library on top of a blurred + darkened background.
 *
 * Used by the Jellyfin compatibility layer to give Infuse / Swiftfin / etc.
 * something to render behind the library name on the libraries home screen
 * (real Jellyfin only does this if the library has a manually-set backdrop;
 * we generate one automatically).
 *
 * Cache strategy:
 *   - Output is cached on disk at .cache/library-backdrop/{libId}.{hash}.webp
 *   - Hash includes COUNT(*) and MAX(updated_at) of the library's items, so
 *     adding/removing/updating any item rotates the hash and forces clients
 *     to re-fetch via a new BackdropImageTag.
 *   - Empty libraries fall back to a static placeholder; no generation happens.
 */
import { hasImageWorkBudget } from '$lib/server/services/image-proxy/work-budget';
import sharp from '$lib/server/services/image-proxy/image-sharp';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type postgres from 'postgres';
import { getImageProxyService } from './image-proxy';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import {
    getDeniedLibraryGroups,
    type LibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';

const logger = Logger.for('LibraryBackdrop');

// Disk cache lives next to the existing custom-url cache (process-cwd-relative
// is what the rest of image-proxy uses; keep it consistent so a single .cache
// volume mount covers everything).
const CACHE_DIR = path.join(process.cwd(), '.cache', 'library-backdrop');
// Static files live in /static during dev (process.cwd()/static), but the
// SvelteKit production build copies them into build/client. Try both.
const STATIC_DIRS = [
    path.join(process.cwd(), 'static'),
    path.join(process.cwd(), 'build', 'client'),
];

// Layout — 1920x1080 canvas, 6 posters in a horizontal row, centered, with a
// blurred copy of the top-rated poster behind. Numbers picked by eye on a
// 16:9 phone preview; tweak here if the aesthetic needs adjustment.
const TARGET_W = 1920;
const TARGET_H = 1080;
const POSTER_W = 220;
const POSTER_H = 330;
const POSTER_COUNT = 6;
const POSTER_GAP = 18;
const BG_BLUR_SIGMA = 30;
// modulate.brightness < 1 darkens; 0.45 puts the background well behind the
// foreground posters but keeps enough silhouette to feel like fanart.
const BG_BRIGHTNESS = 0.45;

interface LibraryItem {
    id: string;
    title: string;
    media_type: string;
}

export interface BackdropResult {
    buffer: Buffer;
    contentType: string;
    contentHash: string;
}

/**
 * Stable signature of a library's content. Used as both the disk-cache key
 * and the BackdropImageTag emitted to clients — when it changes, clients
 * see a "new" image and refetch.
 *
 * Returns null for empty libraries so the caller can short-circuit to a
 * placeholder without running the generator.
 */
export async function getLibraryBackdropHash(
    sql: postgres.Sql,
    libraryGroupId: string,
): Promise<string | null> {
    // Guard the ::uuid cast — a non-UUID value would otherwise throw and
    // bubble up as 500 from any caller (UserViews, /j/Items image proxy,
    // /api/image/library, etc.) instead of returning null/404.
    if (!isUuid(libraryGroupId)) return null;
    const rows = await sql<{ max_updated: string | null; cnt: number }[]>`
        SELECT
            COALESCE(MAX(mi.updated_at)::text, '') AS max_updated,
            COUNT(*)::int AS cnt
        FROM media_items mi
        JOIN media_file_items mfi ON mfi.media_item_id = mi.id
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE mf.library_group_id = ${libraryGroupId}::uuid
          AND mi.status = 'active'
    `;
    const row = rows[0];
    if (!row || row.cnt === 0) return null;
    const seed = `${libraryGroupId}|${row.max_updated ?? ''}|${row.cnt}`;
    return createHash('md5').update(seed).digest('hex').slice(0, 16);
}

/**
 * Lookup helper for the image routes — does this UUID identify a library
 * group rather than a media item, AND (when `user` is supplied) is `user`
 * not denied that group?
 *
 * All three route handlers that serve the mosaic/backdrop bytes
 * (`defs/libraries/[id]/images/[role].ts`, `routes/api/image/library/[id]/[type]`,
 * `/j/Items/[itemId]/Images/[imageType]`) — plus the roles-listing endpoint
 * (`defs/libraries/[id]/images/index.ts`) — gate on this single function's
 * result rather than each re-implementing the check, so a denied group and a
 * nonexistent one collapse to the exact same "not a library group" answer
 * each caller already had a branch for. `user` is omitted by design when the
 * caller has no session (the `/j` image proxy is intentionally public) —
 * `getDeniedLibraryGroups` treats no user the same as an admin (no filter).
 */
export async function isLibraryGroup(
    sql: postgres.Sql,
    itemId: string,
    user: LibraryAccessUser | undefined,
): Promise<boolean> {
    // Guard ::uuid cast — image route calls this with whatever UUID-shaped
    // string came in. Non-UUIDs would otherwise throw a postgres error.
    if (!isUuid(itemId)) return false;
    const denied = user ? await getDeniedLibraryGroups(sql, user) : null;
    // The denial check runs INSIDE the same ::uuid-cast comparison as the
    // existence check, not as a JS `.includes(itemId)` against the raw
    // input string. `itemId` may be dashless/uppercase (isUuid accepts both
    // — Jellyfin's native client form is dashless), and Postgres treats
    // every UUID spelling as equal under `::uuid`, but `getDeniedLibraryGroups`
    // returns canonical lowercase-dashed strings — a JS string comparison
    // between the two would silently miss and fail OPEN for a denied group
    // requested in its dashless form. Comparing both sides through the same
    // `::uuid` cast Postgres already uses for the existence check keeps this
    // immune to spelling, matching how `checkMediaAccess`'s SQL-side
    // `buildLibraryAccessFilter` is immune to it.
    const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
            SELECT 1 FROM library_groups
            WHERE id = ${itemId}::uuid
            ${denied && denied.length > 0 ? sql`AND id != ALL(${denied}::uuid[])` : sql``}
        ) AS exists
    `;
    return rows[0]?.exists ?? false;
}

async function getTopLibraryItems(
    sql: postgres.Sql,
    libraryGroupId: string,
    limit: number,
): Promise<LibraryItem[]> {
    if (!isUuid(libraryGroupId)) return [];
    // For each library type, return items at the level that owns the
    // *poster* artwork (the level Infuse renders as a tile elsewhere):
    //   movie/anime films → movie items themselves
    //   tv / anime series → series items (walk episode→season→series)
    //   music             → album items  (walk track→album)
    // Episodes have stills, not posters; using them in a montage looks bad.
    return await sql<LibraryItem[]>`
        SELECT id, title, media_type, created_at
        FROM media_items
        WHERE id IN (
            -- Direct file owners (movies, music videos, etc.)
            SELECT DISTINCT mfi.media_item_id
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mf.library_group_id = ${libraryGroupId}::uuid
              AND mi.media_type IN ('movie', 'video')

            UNION

            -- TV series: episode → season → series
            SELECT DISTINCT series.id
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            JOIN media_items ep ON ep.id = mfi.media_item_id
            JOIN media_items season ON season.id = ep.parent_id
            JOIN media_items series ON series.id = season.parent_id
            WHERE mf.library_group_id = ${libraryGroupId}::uuid
              AND series.media_type IN ('tv', 'series')

            UNION

            -- Music albums: track → album
            SELECT DISTINCT album.id
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            JOIN media_items track ON track.id = mfi.media_item_id
            JOIN media_items album ON album.id = track.parent_id
            WHERE mf.library_group_id = ${libraryGroupId}::uuid
              AND album.media_type = 'album'
        )
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT ${limit}
    `;
}

async function readCachedBackdrop(
    libraryGroupId: string,
    contentHash: string,
): Promise<Buffer | null> {
    const file = path.join(CACHE_DIR, `${libraryGroupId}.${contentHash}.webp`);
    try {
        return await fs.readFile(file);
    } catch {
        return null;
    }
}

async function writeCachedBackdrop(
    libraryGroupId: string,
    contentHash: string,
    buffer: Buffer,
): Promise<void> {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const final = path.join(CACHE_DIR, `${libraryGroupId}.${contentHash}.webp`);
    // Write to a unique temp path first then atomic rename. Without this a
    // process kill mid-write leaves a truncated file that subsequent reads
    // happily serve as a corrupt webp.
    const tmp = `${final}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(tmp, buffer);
        await fs.rename(tmp, final);
    } catch (err) {
        // Best-effort cleanup of the temp file.
        await fs.unlink(tmp).catch(() => {});
        throw err;
    }
}

async function fetchPosters(items: LibraryItem[]): Promise<Buffer[]> {
    const proxy = getImageProxyService();
    const buffers = await Promise.all(
        items.map(async (item) => {
            try {
                const result = await proxy.getImageByCatalogId(item.id, 'poster', { quality: 90 });
                return result?.buffer ?? null;
            } catch (err) {
                logger.debug('poster fetch failed', {
                    itemId: item.id,
                    error: (err as Error).message,
                });
                return null;
            }
        }),
    );
    return buffers.filter((b): b is Buffer => b !== null);
}

async function compositeBackdrop(posters: Buffer[]): Promise<Buffer | null> {
    // Background: try posters in order until one decodes. A single corrupt
    // poster at index 0 used to kill the entire montage; now we fall back
    // through the next candidate.
    let bg: Buffer | null = null;
    for (const p of posters) {
        try {
            bg = await sharp(p)
                .resize(TARGET_W, TARGET_H, { fit: 'cover' })
                .blur(BG_BLUR_SIGMA)
                .modulate({ brightness: BG_BRIGHTNESS })
                .toBuffer();
            break;
        } catch (err) {
            logger.debug('background poster decode failed; trying next', {
                error: (err as Error).message,
            });
        }
    }
    if (!bg) return null;

    // Foreground tiles: allSettled so corrupt ones don't abort the rest.
    const fgInputs = posters.slice(0, POSTER_COUNT);
    const fgResults = await Promise.allSettled(
        fgInputs.map((p) => sharp(p).resize(POSTER_W, POSTER_H, { fit: 'cover' }).toBuffer()),
    );
    const fgTiles = fgResults
        // Extract from the array's own element type rather than naming
        // `PromiseFulfilledResult<Buffer>`: sharp 0.35 types `toBuffer()` as
        // `Buffer<ArrayBuffer>`, which a bare `Buffer` predicate no longer matches.
        .filter(
            (r): r is Extract<(typeof fgResults)[number], { status: 'fulfilled' }> =>
                r.status === 'fulfilled',
        )
        .map((r) => r.value);
    if (fgTiles.length === 0) return null;

    const totalW = fgTiles.length * POSTER_W + (fgTiles.length - 1) * POSTER_GAP;
    const startX = Math.max(0, Math.floor((TARGET_W - totalW) / 2));
    const startY = Math.floor((TARGET_H - POSTER_H) / 2);
    const composites = fgTiles.map((tile, i) => ({
        input: tile,
        left: startX + i * (POSTER_W + POSTER_GAP),
        top: startY,
    }));

    return await sharp(bg).composite(composites).webp({ quality: 85 }).toBuffer();
}

// In-flight dedupe: when N concurrent requests hit the same uncached
// (library, contentHash) tuple they used to all run sharp + write to disk.
// Now they all await the same promise. Keyed by libId|hash so a content-hash
// rotation (library got new items) immediately starts a fresh generation.
const inFlight = new Map<string, Promise<BackdropResult | null>>();

/**
 * Get (or generate) the backdrop image for a library. Returns null when the
 * library is empty — caller should serve `getLibraryPlaceholder` instead.
 */
export async function getLibraryBackdrop(
    sql: postgres.Sql,
    libraryGroupId: string,
): Promise<BackdropResult | null> {
    if (!isUuid(libraryGroupId)) return null;

    const contentHash = await getLibraryBackdropHash(sql, libraryGroupId);
    if (!contentHash) return null;

    const cached = await readCachedBackdrop(libraryGroupId, contentHash);
    if (cached) {
        return { buffer: cached, contentType: 'image/webp', contentHash };
    }

    const flightKey = `${libraryGroupId}|${contentHash}`;
    const share = !hasImageWorkBudget();
    const existing = share ? inFlight.get(flightKey) : undefined;
    if (existing) return existing;

    const work = (async (): Promise<BackdropResult | null> => {
        try {
            // Pull 3x candidates so items whose proxy lookup fails (no art
            // mapped, network blip, etc.) still leave us POSTER_COUNT usable
            // tiles.
            const items = await getTopLibraryItems(sql, libraryGroupId, POSTER_COUNT * 3);
            if (items.length === 0) return null;

            const posters = await fetchPosters(items);
            if (posters.length === 0) {
                // Items exist but no poster fetched — transient proxy/network.
                // Don't poison the cache; placeholder serves until next attempt.
                logger.warn('library has items but no fetchable posters', {
                    libraryGroupId,
                    itemCount: items.length,
                });
                return null;
            }

            const buffer = await compositeBackdrop(posters);
            if (!buffer) {
                logger.warn('compositeBackdrop returned null', {
                    libraryGroupId,
                    posterCount: posters.length,
                });
                return null;
            }

            void writeCachedBackdrop(libraryGroupId, contentHash, buffer).catch((err) =>
                logger.warn('backdrop cache write failed', {
                    libraryGroupId,
                    error: (err as Error).message,
                }),
            );

            return { buffer, contentType: 'image/webp', contentHash };
        } finally {
            if (share) inFlight.delete(flightKey);
        }
    })();
    if (share) inFlight.set(flightKey, work);
    return work;
}

/**
 * Static placeholder for empty libraries. Music libraries get the
 * "Various Artists" cover; everything else gets the generic Lumastra
 * blurred backdrop.
 */
export async function getLibraryPlaceholder(
    sql: postgres.Sql,
    libraryGroupId: string,
): Promise<BackdropResult | null> {
    // media_type lives on library_paths (1..N per library_group). Pick any —
    // a single group has homogeneous media_type in practice.
    const rows = isUuid(libraryGroupId)
        ? await sql<{ media_type: string }[]>`
            SELECT media_type FROM library_paths
            WHERE library_group_id = ${libraryGroupId}::uuid
            LIMIT 1
        `
        : [];
    const mediaType = rows[0]?.media_type ?? 'movie';
    const filename =
        mediaType === 'music'
            ? 'placeholders/lumastra-various-artists.webp'
            : 'branding/lumastra-background-blurred.webp';
    for (const dir of STATIC_DIRS) {
        try {
            const buffer = await fs.readFile(path.join(dir, filename));
            const contentHash = createHash('md5')
                .update(`placeholder:${mediaType}`)
                .digest('hex')
                .slice(0, 16);
            return { buffer, contentType: 'image/webp', contentHash };
        } catch {
            // Try next dir.
        }
    }
    logger.warn('placeholder not found in any static dir', {
        mediaType,
        filename,
        searched: STATIC_DIRS,
    });
    return null;
}
