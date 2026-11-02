// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cover collage — a square 2x2 of poster art for a mix, mood, station or
 * playlist, rendered server-side so every client (web, iOS, tvOS) shows the
 * same tile without composing four images itself.
 *
 * Input is an ordered list of media UUIDs (tracks, albums, artists — anything
 * the catalog image route resolves; a track inherits its album cover). Tiles
 * are fetched through the image proxy, byte-identical covers are collapsed (so
 * five tracks from one album do not fill all four tiles), and:
 *   - 4+ distinct covers → 2x2 grid of the first four
 *   - 1-3 distinct covers → the first cover, full-bleed
 *   - 0 → null (caller answers 404)
 *
 * Cache: rendered webp on disk under .cache/cover-collage, keyed by the revision, id list
 * and size. The key does not change when an album's art is replaced, so entries
 * expire after DISK_TTL_MS and are re-rendered; the HTTP layer uses a matching
 * max-age rather than `immutable`.
 */

import { hasImageWorkBudget } from '$lib/server/services/image-proxy/work-budget';
import sharp from '$lib/server/services/image-proxy/image-sharp';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getImageProxyService } from '$lib/server/services/image-proxy/index.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('CoverCollage');

const CACHE_DIR = path.join(process.cwd(), '.cache', 'cover-collage');
const DISK_TTL_MS = 24 * 60 * 60 * 1000;

export type CollageSize = 'thumb' | 'card' | 'full';

/** Output edge length in px, and the image-proxy preset each tile is fetched at. */
const SIZES: Record<CollageSize, { edge: number; tile: 'card' | 'hd' }> = {
    thumb: { edge: 256, tile: 'card' },
    card: { edge: 512, tile: 'card' },
    full: { edge: 1024, tile: 'hd' },
};

export interface CollageResult {
    buffer: Buffer;
    contentType: 'image/webp';
    etag: string;
}

function cacheFile(
    ids: readonly string[],
    size: CollageSize,
    revision?: string,
): { file: string; hash: string } {
    const hash = createHash('sha256')
        .update(JSON.stringify(['v2', size, ids, revision ?? '']))
        .digest('hex')
        .slice(0, 32);
    return { file: path.join(CACHE_DIR, `${hash}.webp`), hash };
}

async function readFresh(file: string): Promise<Buffer | null> {
    try {
        const stat = await fs.stat(file);
        if (Date.now() - stat.mtimeMs > DISK_TTL_MS) return null;
        return await fs.readFile(file);
    } catch {
        return null;
    }
}

async function writeAtomic(file: string, buffer: Buffer): Promise<void> {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    // Temp + rename: a kill mid-write must never leave a truncated webp that
    // later reads serve as a valid hit.
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(tmp, buffer);
        await fs.rename(tmp, file);
    } catch (err) {
        await fs.unlink(tmp).catch(() => {});
        throw err;
    }
}

/**
 * Fetch covers in id order and keep the first `want` DISTINCT ones.
 * Distinct = different bytes: the proxy returns the same album cover for
 * every track of that album, which is exactly the duplicate to drop.
 */
async function fetchDistinctCovers(
    ids: readonly string[],
    tile: 'card' | 'hd',
    want: number,
): Promise<Buffer[]> {
    const proxy = getImageProxyService();
    const results = await Promise.all(
        ids.map(async (id) => {
            try {
                const r = await proxy.getImageByCatalogId(id, 'poster', { size: tile });
                return r?.buffer ?? null;
            } catch (err) {
                logger.debug('collage tile fetch failed', {
                    id,
                    error: (err as Error).message,
                });
                return null;
            }
        }),
    );
    const seen = new Set<string>();
    const out: Buffer[] = [];
    for (const buf of results) {
        if (!buf) continue;
        const digest = createHash('sha1').update(buf).digest('hex');
        if (seen.has(digest)) continue;
        seen.add(digest);
        out.push(buf);
        if (out.length === want) break;
    }
    return out;
}

async function squareTile(buf: Buffer, edge: number): Promise<Buffer | null> {
    try {
        return await sharp(buf).resize(edge, edge, { fit: 'cover' }).toBuffer();
    } catch (err) {
        logger.debug('collage tile decode failed', { error: (err as Error).message });
        return null;
    }
}

/** Exported for tests: render already-fetched covers into the final webp. */
export async function composeCollage(covers: Buffer[], edge: number): Promise<Buffer | null> {
    const half = Math.floor(edge / 2);
    const tiles: Buffer[] = [];
    // Decode more than needed so one corrupt cover does not drop to single mode.
    for (const cover of covers) {
        const tile = await squareTile(cover, half);
        if (tile) tiles.push(tile);
        if (tiles.length === 4) break;
    }

    if (tiles.length === 4) {
        return sharp({
            create: { width: edge, height: edge, channels: 3, background: '#111' },
        })
            .composite(
                tiles.map((input, i) => ({
                    input,
                    left: (i % 2) * half,
                    top: Math.floor(i / 2) * half,
                })),
            )
            .webp({ quality: 85 })
            .toBuffer();
    }

    for (const cover of covers) {
        try {
            return await sharp(cover)
                .resize(edge, edge, { fit: 'cover' })
                .webp({ quality: 85 })
                .toBuffer();
        } catch {
            // try the next cover
        }
    }
    return null;
}

const inFlight = new Map<string, Promise<CollageResult | null>>();

/**
 * Render (or read from cache) the collage for `ids`. The caller must have
 * already dropped ids the viewer may not see — this function serves whatever
 * it is given.
 */
export async function getCoverCollage(
    ids: readonly string[],
    size: CollageSize,
    revision?: string,
): Promise<CollageResult | null> {
    if (ids.length === 0) return null;
    const { file, hash } = cacheFile(ids, size, revision);
    const etag = `"cc-${hash}"`;

    const cached = await readFresh(file);
    if (cached) return { buffer: cached, contentType: 'image/webp', etag };

    const share = !hasImageWorkBudget();
    const existing = share ? inFlight.get(file) : undefined;
    if (existing) return existing;

    const work = (async (): Promise<CollageResult | null> => {
        const { edge, tile } = SIZES[size];
        // Fetch spares: up to 6 distinct covers so a corrupt one still leaves 4.
        const covers = await fetchDistinctCovers(ids, tile, 6);
        if (covers.length === 0) return null;
        const buffer = await composeCollage(covers, edge);
        if (!buffer) return null;
        await writeAtomic(file, buffer).catch((err) =>
            logger.debug('collage cache write failed', { error: (err as Error).message }),
        );
        return { buffer, contentType: 'image/webp', etag };
    })().finally(() => {
        if (share) inFlight.delete(file);
    });

    if (share) inFlight.set(file, work);
    return work;
}
