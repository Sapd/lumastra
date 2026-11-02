// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image Parameter Parsing Utilities
 *
 * Centralized parsing for image route URL parameters.
 * Eliminates duplication across 8+ route handlers.
 */

import { hasImageWorkBudget, isRestrictedImageRequest } from '../services/image-proxy/work-budget';
import { QUALITY_TIERS, snapQualityToTier } from './image-quality';
import { config } from '../config';
import type { ImageFormat, ImageOptions, ImageSize } from '../services/image-proxy/types';
import { SIZE_PRESET_WIDTHS } from './image-proxy';

/** Hard clamp for any custom/exact pixel width (1px .. 4K). */
const MIN_CUSTOM_WIDTH = 1;
const MAX_CUSTOM_WIDTH = 3840;

/** Canonical quality tiers a raw `?quality=Q` snaps onto (within ±20%). */
export { QUALITY_TIERS, snapQualityToTier } from './image-quality';

/** Snap tolerance: a value snaps to a target when |v-target|/target <= 0.20. */
const SNAP_TOLERANCE = 0.2;

/**
 * Result of resolving a raw `?width=N` against the bounded preset set.
 *
 * - `{ size }`     — the width landed within ±20% of a named preset and was
 *                    snapped onto it. This is the cache-friendly canonical form;
 *                    the derivative gets the preset's immutable cache entry.
 * - `{ maxWidth }` — the width is too far from any preset (or `exact=true`); it
 *                    renders as a custom derivative with its own cache key.
 */
export interface SnappedWidth {
    size?: ImageSize;
    maxWidth?: number;
}

/**
 * Snap a raw pixel width onto a named preset within ±20% of it, preferring the
 * smallest QUALIFYING preset that is at least as wide as the request; otherwise
 * return a clamped custom `maxWidth`.
 *
 * The point is cache-economy: e.g. `?width=460` and `?width=500` both collapse
 * onto the `card` preset (480px) so the derivative cache stays small.
 * Only the bounded preset set in SIZE_PRESET_WIDTHS is a snap target; `full`
 * (the unbounded original) is never a snap target.
 *
 * ## Why "prefer up" and not "nearest"
 *
 * This used to select by absolute distance and then apply the RELATIVE
 * tolerance to the winner only — a mixed metric. Two consequences, and only one
 * of them was a bug:
 *
 *  - `?width=300` is exactly equidistant from thumb (250) and medium (350). The
 *    comparison is strict `<`, so the incumbent won, and the incumbent was
 *    whichever key `Object.entries` yielded first — thumb, by declaration order.
 *    A caller asking for 300 received 250, i.e. FEWER pixels than it asked for,
 *    decided by the order constants happen to be written in.
 *  - `?width=400 → medium(350)` was reported alongside it and is NOT a defect:
 *    400 is genuinely nearer 350 than 480, absolutely and relatively. Any
 *    nearest-rule agrees. It is named here so nobody "fixes" it later.
 *
 * The deeper point is that nearest is the wrong objective for image sizing at
 * all: downscaling in the browser is free and invisible, upscaling is visible.
 * So among presets that pass the SAME ±20% membership test as before, this now
 * picks the smallest one that still covers the request.
 *
 * ## Why this cannot cause an expensive jump
 *
 * Preferring up is only safe because the tolerance bands barely overlap:
 *
 *     thumb  250 → 200..300      medium 350 → 280..420
 *     card   480 → 384..576      hd    1280 → 1024..1536
 *     wide  1920 → 1536..2304
 *
 * `card ∩ hd` is empty (576 < 1024) and `hd ∩ wide` touches only at 1536.
 * Enumerated over 1..3840, exactly 54 widths change behaviour:
 *
 *     280..300   thumb  → medium
 *     384..415   medium → card
 *     1536       hd     → wide   (1536 requested, hd would upscale from 1280)
 *
 * A request for 1300 still lands on hd — 1920 is 32% away and fails membership —
 * so the feared `1300 → 1920` is structurally impossible, not merely unlikely.
 * The large rungs are self-protecting because the gap between 480 and 1280 is
 * wider than any tolerance band.
 */
export function snapWidthToPreset(width: number): SnappedWidth {
    const clamped = Math.min(Math.max(Math.round(width), MIN_CUSTOM_WIDTH), MAX_CUSTOM_WIDTH);

    // WHETHER to snap is decided exactly as before: by the NEAREST preset in
    // absolute distance passing the relative tolerance. Only WHICH preset wins,
    // once snapping is on, has changed.
    //
    // Keeping the old gate is load-bearing, and measuring found out why. An
    // earlier attempt here asked "does ANY preset pass tolerance", which quietly
    // widened snapping itself: a request for 1537 used to fail the gate (its
    // nearest, hd=1280, is 20.1% away) and render as an EXACT 1537px custom
    // derivative — already the ideal answer. Under the widened gate it qualified
    // for wide (19.9% away) and got promoted to 1920px: 56% more pixels than
    // asked for, on the most expensive rung, for 64 widths in 1537..1600. That
    // is the opposite of the goal — the point is to stop serving FEWER pixels
    // than requested, and a custom width already serves exactly the right number.
    let nearest: { size: ImageSize; presetW: number; dist: number } | null = null;
    const qualifying: Array<{ size: ImageSize; presetW: number }> = [];
    for (const [name, presetW] of Object.entries(SIZE_PRESET_WIDTHS)) {
        const dist = Math.abs(clamped - presetW);
        if (!nearest || dist < nearest.dist) {
            nearest = { size: name as ImageSize, presetW, dist };
        }
        if (dist / presetW <= SNAP_TOLERANCE) {
            qualifying.push({ size: name as ImageSize, presetW });
        }
    }
    if (!nearest || nearest.dist / nearest.presetW > SNAP_TOLERANCE) {
        return { maxWidth: clamped };
    }
    if (qualifying.length === 0) return { maxWidth: clamped };

    // Smallest qualifying preset that covers the request…
    const covering = qualifying
        .filter((p) => p.presetW >= clamped)
        .sort((a, b) => a.presetW - b.presetW)[0];
    if (covering) return { size: covering.size };

    // …and when every qualifying preset is smaller than the request (the top of
    // a band, e.g. 2304 against wide=1920), take the largest. Nothing wider is
    // in range, so this is a genuine downscale rather than a choice.
    const largest = qualifying.sort((a, b) => b.presetW - a.presetW)[0];
    return { size: largest.size };
}

/** Raw request widths are finite; anonymous/signed qualities and AVIF are bounded too. */
export function restrictImageOptions<T extends ImageOptions & { width?: number | string }>(
    options: T,
    restricted = hasImageWorkBudget() && isRestrictedImageRequest(),
): Omit<T, 'quality' | 'format' | 'maxWidth' | 'width'> &
    Pick<ImageOptions, 'quality' | 'format' | 'maxWidth'> & { width?: number | string } {
    const bucketWidth = (value: number | string): number =>
        PUBLIC_IMAGE_WIDTHS.find((bucket) => bucket >= Number(value)) ?? 3840;
    // Presets keep their canonical dimensions. Raw dimensions share one ladder
    // on all request surfaces, even for authenticated callers and exact=true.
    options = {
        ...options,
        ...(options.maxWidth === undefined
            ? {}
            : { maxWidth: String(bucketWidth(options.maxWidth)) }),
        ...(options.width === undefined
            ? {}
            : {
                  width:
                      typeof options.width === 'number'
                          ? bucketWidth(options.width)
                          : String(bucketWidth(options.width)),
              }),
    };
    if (!restricted) return options;
    const preset =
        options.size &&
        Object.hasOwn(SIZE_PRESET_WIDTHS, options.size) &&
        !options.maxWidth &&
        !options.width &&
        !options.maxHeight;
    return {
        ...options,
        quality:
            options.quality === undefined
                ? undefined
                : snapQualityToTier(options.quality, QUALITY_TIERS, true),
        format: options.format === 'avif' && !preset ? 'webp' : options.format,
    };
}

/**
 * Parse `?exact=true|1` — bypasses BOTH width and quality snapping so the caller
 * gets the precise width + quality it asked for (its own distinct cache entry).
 */
export function parseExact(url: URL): boolean {
    const raw = url.searchParams.get('exact');
    if (!raw) return false;
    const v = raw.toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
}

/**
 * Parse image size from URL search params
 * @param url - Request URL
 * @returns Valid ImageSize or default 'full'
 */
export function parseImageSize(url: URL): ImageSize {
    const param = url.searchParams.get('size') || 'full';
    return ['thumb', 'medium', 'card', 'hd', 'wide', 'full'].includes(param)
        ? (param as ImageSize)
        : 'full';
}

/**
 * Downgrade an image size by one tier. Used when the client opts into
 * data-saver mode (sends `Save-Data: on`) so the same URL serves a
 * lighter variant. Cache keys already differ by size so no collisions.
 */
function downgradeImageSize(size: ImageSize): ImageSize {
    switch (size) {
        case 'full':
            return 'wide';
        case 'wide':
            return 'hd';
        case 'hd':
            return 'card';
        case 'card':
            return 'medium';
        case 'medium':
            return 'thumb';
        case 'thumb':
            return 'thumb';
    }
}

/**
 * Apply Save-Data downgrade if the request opted in.
 * Callers MUST also add `Vary: Save-Data` to the response so caches
 * partition by header.
 */
export function applySaveDataDowngrade(size: ImageSize, request: Request): ImageSize {
    if (isSaveData(request)) {
        return downgradeImageSize(size);
    }
    return size;
}

/**
 * True when the request opted into data-saver mode. The Save-Data spec
 * (W3C Network Information API) defines the value as case-insensitive, so
 * `Save-Data: ON` and `Save-Data: on` should both count.
 */
export function isSaveData(request: Request): boolean {
    return request.headers.get('save-data')?.toLowerCase() === 'on';
}

/**
 * Parse image format from URL search params
 * @param url - Request URL
 * @returns Valid ImageFormat or undefined for default
 */
export function parseImageFormat(url: URL): ImageFormat | undefined {
    const param = url.searchParams.get('format');
    return param && ['webp', 'avif', 'jpg', 'png'].includes(param)
        ? (param as ImageFormat)
        : undefined;
}

/**
 * Resolve the output image format for a request.
 *
 * Order of precedence:
 *   1. Explicit `?format=...` URL param (admin/debug override)
 *   2. AVIF if `IMAGE_AVIF_ENABLED` and the client's `Accept` header includes
 *      `image/avif`
 *   3. WebP if `IMAGE_WEBP_ENABLED` (the codebase default)
 *   4. JPEG fallback when WebP is explicitly disabled — preserves the
 *      pre-AVIF contract for operators who set `IMAGE_WEBP_ENABLED=false`
 *      (e.g. clients that don't render WebP correctly).
 *
 * Callers MUST add `Accept` to the response's `Vary` header so browser/CDN
 * caches partition responses by client capabilities — `imageResponse()`
 * already does this.
 */
export function resolveImageFormat(url: URL, request: Request): ImageFormat {
    const safeFormat = (format: ImageFormat): ImageFormat => {
        const preset =
            Object.hasOwn(SIZE_PRESET_WIDTHS, url.searchParams.get('size') ?? '') &&
            parseRawWidth(url) === undefined;
        return hasImageWorkBudget() && isRestrictedImageRequest() && format === 'avif' && !preset
            ? 'webp'
            : format;
    };
    const explicit = parseImageFormat(url);
    if (explicit) return safeFormat(explicit);

    if (config.IMAGE_AVIF_ENABLED) {
        const accept = request.headers.get('accept') ?? '';
        if (accept.toLowerCase().includes('image/avif')) {
            return safeFormat('avif');
        }
    }
    if (config.IMAGE_WEBP_ENABLED) {
        return 'webp';
    }
    return 'jpg';
}

/**
 * Parse image quality from URL search params
 * @param url - Request URL
 * @returns Quality value (1-100) or undefined for default
 */
export function parseImageQuality(url: URL): number | undefined {
    const param = url.searchParams.get('quality');
    if (!param) return undefined;

    const quality = Number.parseInt(param, 10);
    if (Number.isNaN(quality) || quality < 1 || quality > 100) {
        return undefined;
    }

    return quality;
}

/**
 * Parse all image options from URL search params
 * @param url - Request URL
 * @returns ImageOptions object with parsed parameters
 */
export function parseImageOptions(url: URL): ImageOptions {
    return {
        size: parseImageSize(url),
        quality: parseImageQuality(url),
        format: parseImageFormat(url),
    };
}

/**
 * Parse a raw pixel width from `?width=` (preferred) or `?maxWidth=` (alias).
 * Returns undefined when absent or non-numeric.
 */
function parseRawWidth(url: URL): number | undefined {
    const raw = url.searchParams.get('width') ?? url.searchParams.get('maxWidth');
    if (!raw) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve the EFFECTIVE (snapped) image options for a preset-aware image route
 * (media / and any future route using the thumb|medium|card|full vocabulary).
 *
 * This is the single place where raw `?width` / `?quality` collapse onto the
 * bounded preset/tier set BEFORE the proxy cache key is built, so near-identical
 * requests (width=295 vs width=305) share one cache entry. Precedence:
 *
 *   1. `?exact=true` → bypass BOTH snaps; honor the exact width + quality.
 *      Custom variant (never `bounded`).
 *   2. `?width=N`    → snapWidthToPreset(): within ±20% of a preset → that
 *      preset (bounded); otherwise a clamped custom maxWidth (not bounded).
 *      A raw width always wins over `?size=` so a pixel cap is authoritative.
 *   3. `?size=`      → the named preset (`full` = original; bounded for the
 *      three real presets, full is bounded too since it's a fixed canonical
 *      form). Save-Data downgrade is applied to the named preset.
 *
 * Quality: snapped to the nearest tier (within ±20%) unless `exact`.
 *
 * The returned `bounded` flag drives `immutable` Cache-Control in the response
 * layer; the returned `maxWidth` (string) is what providers/resizers consume.
 */
export function resolveEffectiveImageOptions(
    url: URL,
    request: Request,
): ImageOptions & { bounded: boolean } {
    const exact = parseExact(url);
    const format = resolveImageFormat(url, request);
    const rawQuality = parseImageQuality(url);
    const rawWidth = parseRawWidth(url);

    // ---- Quality (effective) ----
    const quality =
        rawQuality === undefined ? undefined : exact ? rawQuality : snapQualityToTier(rawQuality);

    // ---- exact: honor precise width, no snap, custom variant ----
    if (exact) {
        if (rawWidth !== undefined) {
            const clampedW = Math.min(Math.max(Math.round(rawWidth), 1), 3840);
            return {
                size: 'custom' as unknown as ImageSize,
                maxWidth: String(clampedW),
                quality,
                format,
                bounded: false,
                exact: true,
            };
        }
        // exact with no width → exact quality on the named size (or full).
        const size = applySaveDataDowngrade(parseImageSize(url), request);
        return { size, quality, format, bounded: false, exact: true };
    }

    // ---- raw width present: snap onto a preset or render custom ----
    if (rawWidth !== undefined) {
        const snapped = snapWidthToPreset(rawWidth);
        if (snapped.size) {
            return { size: snapped.size, quality, format, bounded: true };
        }
        return {
            // Sentinel size keeps the resize/cache paths from treating a custom
            // width as a preset; the width itself drives the resize.
            size: 'custom' as unknown as ImageSize,
            maxWidth: String(snapped.maxWidth),
            quality,
            format,
            bounded: false,
        };
    }

    // ---- named preset (or full) ----
    const size = applySaveDataDowngrade(parseImageSize(url), request);
    return { size, quality, format, bounded: true };
}

/**
 * Canonical cache-key token for the EFFECTIVE size of a derivative. Two requests
 * that resolve to the same token MUST share a cache entry. Shapes:
 *
 *   - 'thumb' | 'medium' | 'card' | 'full'  — bounded preset variants
 *   - 'w<N>'                                 — custom / exact width
 *   - 'orig'                                 — no size info (legacy callers)
 *
 * Raw width/quality must NEVER appear in a cache key — only this token plus the
 * effective quality token (see `qualityCacheToken`).
 */
export function sizeCacheToken(options: Pick<ImageOptions, 'size' | 'maxWidth'>): string {
    if (options.maxWidth) return `w${options.maxWidth}`;
    if (options.size && options.size !== ('custom' as ImageSize)) return options.size;
    return 'orig';
}

/**
 * Canonical cache-key token for the EFFECTIVE quality of a derivative.
 * 'qdef' when unset (config default applies), else 'q<N>'.
 */
export function qualityCacheToken(quality?: number): string {
    return quality === undefined ? 'qdef' : `q${quality}`;
}

// ---------------------------------------------------------------------------
// Avatar sizing
// ---------------------------------------------------------------------------

/**
 * Named avatar widths. thumb/card/full mirror the `?size=` hrefs that
 * `users/[id]/images/index.ts` has always advertised for the avatar.
 */
export const AVATAR_SIZE_TO_WIDTH: Record<string, number> = { thumb: 48, card: 96, full: 200 };

/**
 * Requested avatar width from `?width=` or `?size=`; `width` wins when both are
 * present, being the more specific of the two. Undefined for missing/invalid so
 * the caller falls back to the stored size.
 *
 * Shared by BOTH avatar routes on purpose. `/api/v1/users/{id}/images/avatar`
 * and the legacy `/api/image/user/{username}/avatar` both reach the same
 * `getUserAvatar`, and the legacy one is still used by the admin stats
 * leaderboards and two playlist components. Adding the parameter to only one of
 * them would leave the busiest avatar lists silently unsized — a param that
 * looks honoured and is not.
 */
export function parseAvatarWidth(url: URL): number | undefined {
    const raw = url.searchParams.get('width');
    if (raw) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 1) return n;
    }
    const size = url.searchParams.get('size');
    return size ? AVATAR_SIZE_TO_WIDTH[size.toLowerCase()] : undefined;
}

/** Preserve named avatar presets so common raw-width bucketing cannot widen them. */
export function parseAvatarImageOptions(url: URL): Pick<ImageOptions, 'size' | 'maxWidth'> {
    const size = url.searchParams.get('size')?.toLowerCase();
    if (!url.searchParams.get('width') && size && Object.hasOwn(AVATAR_SIZE_TO_WIDTH, size)) {
        return { size: size as ImageSize };
    }
    const width = parseAvatarWidth(url);
    return width === undefined ? {} : { maxWidth: String(width) };
}

/** Public media routes expose a finite width ladder, including with exact=true. */
export const PUBLIC_IMAGE_WIDTHS = [250, 350, 480, 768, 1280, 1920, 2560, 3840] as const;

export function resolvePublicImageOptions(
    url: URL,
    request: Request,
): ImageOptions & { bounded: boolean } {
    const options = resolveEffectiveImageOptions(url, request);
    return restrictImageOptions(options, isRestrictedImageRequest());
}
