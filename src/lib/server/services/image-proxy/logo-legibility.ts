// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Serve a light TMDB logo variant instead of a dark one.
 *
 * Every client draws title logos over a darkened backdrop (the apps are
 * dark-only), so dark logo art — e.g. "The Ministry of Ungentlemanly
 * Warfare" — is close to unreadable. TMDB often carries a white or light
 * variant of the same logo in the same language; the stored `logo_path` just
 * happened to pick the other one (first English entry, no tone awareness).
 *
 * At serve time the image proxy asks {@link LogoLegibilityResolver.resolve}
 * for the path to use: a light stored logo is returned untouched; a dark one
 * is swapped for the best-voted light logo of the SAME language when TMDB has
 * one, else kept. Luminance is measured on TMDB's tiny `w92` rendition and
 * both the per-path measurement and the per-item decision are memoised, so
 * each logo costs one small fetch (plus, only when dark, one TMDB images call
 * and at most {@link MAX_ALTERNATIVES} more small fetches) per process.
 */

import { hasImageWorkBudget, requireImageProviderBudget } from './work-budget';
import sharp from '$lib/server/services/image-proxy/image-sharp';
import { LRUCache } from '$lib/server/cache/lru-cache.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('LogoLegibility');

/** Mean opaque-pixel luma (0..1) below which a logo counts as dark. */
export const DARK_LOGO_LUMA = 0.35;
/** Alternatives measured per dark logo, best-voted first. */
export const MAX_ALTERNATIVES = 4;

export interface LogoCandidate {
    file_path: string;
    iso_639_1: string | null;
    vote_average?: number;
}

/**
 * Alpha-weighted mean Rec.601 luma (gamma-encoded, 0..1) of an image's
 * visible pixels. Null when the image has no visible pixels.
 */
export async function measureLogoLuma(image: Buffer): Promise<number | null> {
    const { data, info } = await sharp(image)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    let weighted = 0;
    let alphaSum = 0;
    for (let i = 0; i < data.length; i += info.channels) {
        const a = data[i + 3] / 255;
        if (a === 0) continue;
        weighted += a * (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        alphaSum += a;
    }
    return alphaSum > 0 ? weighted / alphaSum / 255 : null;
}

/**
 * Pick the path to serve. Pure apart from `measure` (path → luma, null when
 * unmeasurable); `candidates` is TMDB's logo list for the item.
 */
export async function chooseLegibleLogo(
    current: string,
    candidates: readonly LogoCandidate[],
    measure: (path: string) => Promise<number | null>,
): Promise<string> {
    const currentLuma = await measure(current);
    if (currentLuma === null || currentLuma >= DARK_LOGO_LUMA) return current;

    const own = candidates.find((c) => c.file_path === current);
    // Unknown language → no safe like-for-like swap.
    if (!own) return current;

    const alternatives = candidates
        .filter((c) => c.file_path !== current && c.iso_639_1 === own.iso_639_1)
        .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))
        .slice(0, MAX_ALTERNATIVES);

    for (const alt of alternatives) {
        const luma = await measure(alt.file_path);
        if (luma !== null && luma >= DARK_LOGO_LUMA) return alt.file_path;
    }
    return current;
}

const UNMEASURABLE = -1;

export type LogoListFetcher = (
    tmdbId: number,
    mediaType: 'movie' | 'tv',
) => Promise<readonly LogoCandidate[]>;

async function fetchThumbLuma(path: string): Promise<number | null> {
    await requireImageProviderBudget();
    const res = await fetchWithTimeout(`https://image.tmdb.org/t/p/w92${path}`, {}, 8000);
    if (!res.ok) return null;
    return measureLogoLuma(Buffer.from(await res.arrayBuffer()));
}

export class LogoLegibilityResolver {
    /** path → luma, `UNMEASURABLE` for null; logos at a TMDB path never change. */
    private readonly lumaCache = new LRUCache<number>({
        maxSize: 20_000,
        defaultTTL: 30 * 24 * 60 * 60 * 1000,
        namespace: 'logo-luma',
    });
    /** `${mediaType}:${tmdbId}:${path}` → path to serve. */
    private readonly decisionCache = new LRUCache<string>({
        maxSize: 20_000,
        defaultTTL: 7 * 24 * 60 * 60 * 1000,
        namespace: 'logo-legible',
    });
    private readonly inflight = new Map<string, Promise<string>>();

    constructor(
        private readonly listLogos: LogoListFetcher,
        private readonly measurePath: (path: string) => Promise<number | null> = fetchThumbLuma,
    ) {}

    /** Path to serve for `storedPath`; never throws, falls back to `storedPath`. */
    async resolve(tmdbId: string, mediaType: string, storedPath: string): Promise<string> {
        const numericId = Number.parseInt(tmdbId, 10);
        if (!Number.isFinite(numericId) || (mediaType !== 'movie' && mediaType !== 'tv')) {
            return storedPath;
        }
        const key = `${mediaType}:${numericId}:${storedPath}`;
        const cached = this.decisionCache.get(key);
        if (cached !== null) return cached;
        const share = !hasImageWorkBudget();
        const pending = share ? this.inflight.get(key) : undefined;
        if (pending) return pending;

        const work = this.decide(numericId, mediaType, storedPath)
            .then((chosen) => {
                this.decisionCache.set(key, chosen);
                return chosen;
            })
            .catch((error: unknown) => {
                // Not cached: a transient CDN/API failure retries next request.
                logger.warn('Logo legibility check failed; serving the stored logo', {
                    tmdbId: numericId,
                    mediaType,
                    storedPath,
                    error: error instanceof Error ? error.message : String(error),
                });
                return storedPath;
            })
            .finally(() => {
                if (share) this.inflight.delete(key);
            });
        if (share) this.inflight.set(key, work);
        return work;
    }

    private async decide(
        tmdbId: number,
        mediaType: 'movie' | 'tv',
        storedPath: string,
    ): Promise<string> {
        const luma = await this.measure(storedPath);
        // Only a dark stored logo needs TMDB's logo list.
        if (luma === null || luma >= DARK_LOGO_LUMA) return storedPath;
        const candidates = await this.listLogos(tmdbId, mediaType);
        const chosen = await chooseLegibleLogo(storedPath, candidates, (p) => this.measure(p));
        if (chosen !== storedPath) {
            logger.info('Serving a light logo variant for a dark stored logo', {
                tmdbId,
                mediaType,
                storedPath,
                chosen,
            });
        }
        return chosen;
    }

    private async measure(path: string): Promise<number | null> {
        const cached = this.lumaCache.get(path);
        if (cached !== null) return cached === UNMEASURABLE ? null : cached;
        const luma = await this.measurePath(path);
        this.lumaCache.set(path, luma ?? UNMEASURABLE);
        return luma;
    }
}
