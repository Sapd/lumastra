// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Top Shelf render service — source selection, ffmpeg arg building, and the
 * coalesced/semaphore-guarded render pipeline for tvOS Top Shelf preview and
 * cinemagraph artifacts.
 *
 * Does NOT go through the HLS session pipeline (preview-session.service.ts /
 * ffmpeg-transcode.service.ts) — these are tiny, offline, single-file MP4
 * jobs, spawned directly via `spawnFFmpegSafely`.
 */

import { promises as fs } from 'node:fs';
import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { AsyncSemaphore } from '$lib/server/utils/async-semaphore.js';
import { spawnFFmpegSafely } from '$lib/server/utils/ffmpeg-spawn.js';
import { findLocalTrailerForItem } from '$lib/server/database/queries/media-extras.queries.js';
import {
    getFilesForMediaItem,
    type MediaFileRow,
} from '$lib/server/database/queries/media-files.queries.js';
import { resolvePreviewStartPosition } from '$lib/server/utils/preview-start-position.js';
import { resolveFileVersion } from '$lib/server/services/preview-session.service.js';
import { computeTopShelfContentKey, OVERLAY_PROFILE_REV } from './topshelf-content-key.js';
import type { TopShelfVariant } from './topshelf-content-key.js';
import { getTopShelfArtifactStore } from './topshelf-artifact.store.js';
import type { StoreVariantKey } from './topshelf-artifact.store.js';
import {
    overlayGeometry,
    materializeLogoPng,
    renderTextPng,
    ensureScrimAsset,
} from './topshelf-overlay-render.js';
import { computeOverlayBox, serializeOverlayToken } from './topshelf-overlay.js';
import type { OverlayStyle } from './topshelf-overlay.js';

/**
 * Descriptor threaded from the mint's overlay resolution into the render
 * pipeline. Absent → a plain (non-overlaid) render, byte-identical to before.
 */
export interface TopShelfOverlayRenderInput {
    base: 'preview' | 'cinemagraph';
    mode: 'logo' | 'text';
    style: OverlayStyle;
    locale?: string;
    /** Present for text mode — the string to burn. */
    text?: string;
    /**
     * Present for logo mode on EPISODES — the `S01E02` chip composited under
     * the inherited series logo into ONE content PNG. Folded into
     * `contentHash` by the resolver, so a renumber rotates the artifact.
     */
    badge?: string;
    /** overlayContentHash from resolveOverlay. */
    contentHash: string;
}

const logger = Logger.for('TopShelfRenderService');

// ---------------------------------------------------------------------------
// Source selection (§5) — pure decision logic, unit-tested in isolation.
// ---------------------------------------------------------------------------

export interface TopShelfSourceSelection {
    status: 'ready' | 'unavailable';
    /** The trailer child item id, or the parent item id (snippet case). */
    sourceItemId?: string;
    fileId?: string;
    filePath?: string;
    /** Stable file-identity string, or null when indeterminate (see resolveFileVersion). */
    fileVersion?: string | null;
    startSeconds?: number;
    durationSeconds?: number;
    /** What the PREVIEW variant would be rendered from. Absent for cinemagraph. */
    previewSource?: 'trailer' | 'snippet';
}

/** Pick the file a Top Shelf render should use: the default, else the first. */
function pickDefaultFile(files: MediaFileRow[]): MediaFileRow | undefined {
    return files.find((f) => f.is_default) ?? files[0];
}

/**
 * Select the source for the PREVIEW variant.
 *
 * 1. Local trailer child, if one exists (child media_items row, structurally
 *    scoped to `parent_id = mediaId` by `findLocalTrailerForItem`) → preferred:
 *    legitimately promotional/shareable content, editorially better for a
 *    carousel.
 * 2. Else the parent's own default playable file → a runtime-proportional
 *    snippet (skips studio logos / opening credits).
 * 3. Else unavailable (series with no trailer and no direct file; catalog
 *    ghosts with no files at all).
 *
 * SECURITY (parent-gating, verified fact 1): trailer/extras rows can carry
 * `library_group_id = NULL`, which `isMediaAccessible` treats as world-
 * readable. This function NEVER runs an access check against the trailer
 * row — the only access decision is `checkMediaAccess(sql, mediaId, user)`
 * at mint time, against the PARENT id. The trailer is reached exclusively
 * through `findLocalTrailerForItem(mediaId)`, which structurally enforces
 * `WHERE mi.parent_id = mediaId` — a caller cannot pass an arbitrary trailer
 * id here to bypass the parent gate.
 */
async function selectPreviewSource(
    sql: postgres.Sql,
    mediaId: string,
): Promise<TopShelfSourceSelection> {
    const trailerId = await findLocalTrailerForItem(sql, mediaId);
    if (trailerId) {
        const files = await getFilesForMediaItem(sql, trailerId);
        const file = pickDefaultFile(files);
        if (file) {
            const trailerDuration =
                file.duration_seconds && file.duration_seconds > 0
                    ? file.duration_seconds
                    : config.TOPSHELF_TRAILER_MAX_SECONDS;
            return {
                status: 'ready',
                sourceItemId: trailerId,
                fileId: file.id,
                filePath: file.file_path,
                fileVersion: await resolveFileVersion(sql, file.id),
                startSeconds: 0,
                durationSeconds: Math.min(trailerDuration, config.TOPSHELF_TRAILER_MAX_SECONDS),
                previewSource: 'trailer',
            };
        }
    }

    const files = await getFilesForMediaItem(sql, mediaId);
    const file = pickDefaultFile(files);
    if (!file) return { status: 'unavailable' };

    const startSeconds = await resolvePreviewStartPosition(sql, mediaId, undefined);
    return {
        status: 'ready',
        sourceItemId: mediaId,
        fileId: file.id,
        filePath: file.file_path,
        fileVersion: await resolveFileVersion(sql, file.id),
        startSeconds,
        durationSeconds: config.TOPSHELF_PREVIEW_DURATION_SECONDS,
        previewSource: 'snippet',
    };
}

/**
 * Select the source for the CINEMAGRAPH variant.
 *
 * Always a real-media snippet from the item's own default playable file —
 * NEVER the trailer (trailers are fast-cut and audio-driven; a silent
 * mid-trailer excerpt loops badly). Unavailable when the item has no direct
 * playable file (series container) — Top Shelf degrades gracefully to the
 * static image for the cinemagraph slot.
 */
async function selectCinemagraphSource(
    sql: postgres.Sql,
    mediaId: string,
): Promise<TopShelfSourceSelection> {
    const files = await getFilesForMediaItem(sql, mediaId);
    const file = pickDefaultFile(files);
    if (!file) return { status: 'unavailable' };

    const startSeconds = await resolvePreviewStartPosition(sql, mediaId, undefined);
    return {
        status: 'ready',
        sourceItemId: mediaId,
        fileId: file.id,
        filePath: file.file_path,
        fileVersion: await resolveFileVersion(sql, file.id),
        startSeconds,
        durationSeconds: config.TOPSHELF_CINEMAGRAPH_DURATION_SECONDS,
    };
}

export async function selectTopShelfSource(
    sql: postgres.Sql,
    mediaId: string,
    variant: TopShelfVariant,
): Promise<TopShelfSourceSelection> {
    return variant === 'preview'
        ? selectPreviewSource(sql, mediaId)
        : selectCinemagraphSource(sql, mediaId);
}

// ---------------------------------------------------------------------------
// FFmpeg arg builder (§4.4) — pure, unit-tested in isolation.
// ---------------------------------------------------------------------------

export interface BuildTopShelfFfmpegArgsInput {
    variant: TopShelfVariant;
    sourcePath: string;
    startSeconds: number;
    durationSeconds: number;
    /** Destination path for the (in-progress) render — a `*.tmp.*` path. */
    outputPath: string;
    /** When present, burn an overlay via -filter_complex instead of -vf. */
    overlay?: {
        style: OverlayStyle;
        contentPngPath: string;
        scrimPngPath?: string;
        padding: number;
    };
}

/**
 * Build the flat ffmpeg arg list for one Top Shelf render.
 *
 * Borrows the heroSafe codec decision from preview-session.service.ts
 * (`PREVIEW_FORCE_UNIVERSAL_CODEC` → h264/AAC) but always renders h264 here —
 * these are tiny promotional clips where universal compatibility matters more
 * than matching source codec. The base RESOLUTION is Top Shelf's OWN knob
 * (`TOPSHELF_RENDER_MAX_WIDTH`/`_HEIGHT`, 1280x720) — NOT `PREVIEW_MAX_WIDTH`,
 * which lives in the 'hover' section and defaults to 640px for a small web
 * hover card, far too soft upscaled to a full-bleed 4K-TV Top Shelf preview.
 * Still reuses `PREVIEW_ENCODING_PRESET` / `PREVIEW_MAX_VIDEO_BITRATE_MBPS`
 * (2 Mbps) rather than minting duplicate knobs — 1280x720 at 2 Mbps is a
 * well-matched pair.
 *
 * `-movflags +faststart` is mandatory — AVPlayer progressive playback needs
 * the moov atom up front.
 */
export function buildTopShelfFfmpegArgs(input: BuildTopShelfFfmpegArgsInput): string[] {
    const maxWidth = config.TOPSHELF_RENDER_MAX_WIDTH;
    const maxHeight = config.TOPSHELF_RENDER_MAX_HEIGHT;
    const preset = config.PREVIEW_ENCODING_PRESET;
    const bitrateMbps = config.PREVIEW_MAX_VIDEO_BITRATE_MBPS;
    const ov = input.overlay;

    const args: string[] = [
        // Never wait on stdin — a container's stdin can be a non-tty pipe
        // that ffmpeg would otherwise block reading from.
        '-nostdin',
        '-ss',
        String(input.startSeconds),
        '-i',
        input.sourcePath,
    ];

    // Extra `-i` image inputs (overlay path) MUST be inserted here, before
    // `-t` — appending them after `-t` would attach the duration to the last
    // input instead of the primary source.
    if (ov) {
        if (ov.scrimPngPath) args.push('-i', ov.scrimPngPath);
        args.push('-i', ov.contentPngPath);
    }

    args.push('-t', String(input.durationSeconds));

    if (ov) {
        // Overlay path: build a -filter_complex graph and map its terminal
        // [vout] label instead of the raw decoded stream.
        //
        // ABSOLUTE SIZES, NO REFERENCE VARIABLES. The previous graph sized the
        // scrim and content against [base] with the two-input ref-scale form
        // (`[content][base]scale=rw*0.4:-1`). `rw`/`rh` did NOT resolve
        // consistently across ffmpeg builds — on the shipped one the scrim came
        // out roughly a third of the frame width and the content was mis-sized,
        // which is what cut the burned label at both ends. Every dimension here
        // is instead computed in JS from `TOPSHELF_RENDER_MAX_WIDTH`, and the
        // base is forced to that exact width (overlay path only — the plain
        // path's -vf below is untouched and stays `min(maxWidth,iw)`), so the
        // graph is fully deterministic and build-independent.
        const g = overlayGeometry(ov.style.pos, ov.padding);
        const scrimIdx = 1;
        const contentIdx = ov.scrimPngPath ? 2 : 1;
        /** Scrim band covers this fraction of the frame height. */
        const SCRIM_HEIGHT_FRACTION = 0.4;
        /**
         * FIXED OVERLAY BOX. The content PNG is materialized at EXACTLY
         * `boxW x boxH` (see `composeLogoWithBadge` / `renderTextPng`), so the
         * graph overlays it verbatim — there is deliberately NO content
         * `scale` filter left here. The previous `scale=contentW:-1` sized the
         * burn by WIDTH ONLY, which let the content PNG's intrinsic aspect
         * decide its on-frame height (a stacked logo measured ~88% of the
         * frame height, a chip-dominated canvas 147%) and scaled the `S01E02`
         * badge by the same factor. Bounding both axes at materialization time
         * makes over-sizing and escaping the padded box structurally
         * impossible rather than merely unlikely.
         */
        const box = computeOverlayBox(ov.style.scale, maxWidth, maxHeight);
        /**
         * The base is cover-cropped to EXACTLY `maxWidth x maxHeight` (see the
         * `[base]` chain below), so the scrim and box geometry size against
         * the real frame, not a reference.
         *
         * `Math.max` keeps the band covering the WHOLE box (padding + box +
         * a little breathing room) even if the box fraction is ever raised
         * above the band fraction — the scrim exists for the burn's
         * legibility, so it must never end above the burn.
         */
        const padY = Math.round(ov.padding * box.baseHeight);
        const scrimH = Math.min(
            box.baseHeight,
            Math.max(
                Math.round(box.baseHeight * SCRIM_HEIGHT_FRACTION),
                padY + box.boxH + Math.round(box.baseHeight * 0.02),
            ),
        );

        /**
         * COVER-CROP THE BASE TO THE TOP SHELF'S OWN 16:9. tvOS aspect-fills
         * the preview into a 16:9 shelf, so a source of any other shape is
         * cropped on the device: a 4:3 episode (Star Trek TNG, 960x720) used
         * to render at 1280x960, and the shelf cut 120px off its top — taking
         * the burned logo and `S03E13` badge (53px from the top) with it, while
         * every 16:9 title looked fine. Cropping here, centred like tvOS does,
         * makes the frame we burn into the frame the viewer sees, so the
         * padded box is inside the visible area for every source shape.
         * `iw*sar` first, so an anamorphic (non-square-pixel) source is
         * measured by its display shape, not its storage shape.
         */
        const graph: string[] = [
            `[0:v]scale=trunc(iw*sar/2)*2:ih,setsar=1,` +
                `scale=${maxWidth}:${maxHeight}:force_original_aspect_ratio=increase,` +
                `crop=${maxWidth}:${maxHeight},setsar=1[base]`,
        ];
        let last = 'base';
        if (ov.scrimPngPath) {
            const flip = g.scrimFlip ? ',vflip' : '';
            graph.push(
                `[${scrimIdx}:v]scale=${maxWidth}:${scrimH}${flip}[scr]`,
                `[${last}][scr]overlay=0:${g.scrimYExpr}[scrimmed]`,
            );
            last = 'scrimmed';
        }
        graph.push(`[${last}][${contentIdx}:v]overlay=${g.xExpr}:${g.yExpr}[vout]`);
        args.push('-filter_complex', graph.join(';'), '-map', '[vout]');
    } else {
        args.push('-map', '0:v:0');
    }

    if (input.variant === 'cinemagraph') {
        // Silent — hard requirement for a looping ambient clip.
        args.push('-an');
    } else {
        // Optional audio map (`?` suffix): never fails the job when the
        // source has no audio stream.
        args.push('-map', '0:a:0?');
    }

    args.push('-c:v', 'libx264', '-preset', preset, '-profile:v', 'high', '-pix_fmt', 'yuv420p');

    if (bitrateMbps > 0) {
        args.push('-maxrate', `${bitrateMbps}M`, '-bufsize', `${bitrateMbps * 2}M`);
    }

    if (!ov) {
        args.push('-vf', `scale='min(${maxWidth},iw)':-2`);
    }

    if (input.variant === 'preview') {
        args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
    } else {
        // Clean closed-GOP stream for a hard-cut loop seam.
        args.push('-g', '48', '-sc_threshold', '0');
    }

    // `-y`: always overwrite — a stale tmp path from an unclean shutdown
    // (Node is often PID 1 in Docker, so `${finalPath}.tmp.${process.pid}`
    // can recur) would otherwise make ffmpeg prompt to overwrite and fail.
    args.push('-y', '-movflags', '+faststart', '-f', 'mp4', input.outputPath);
    return args;
}

// ---------------------------------------------------------------------------
// Coalesced, semaphore-guarded render pipeline (§4.4)
// ---------------------------------------------------------------------------

/** Wall-clock cap for a single Top Shelf render (tiny clips; generous headroom). */
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;
/** How long a failed contentKey is negative-cached so a broken source can't hot-loop ffmpeg. */
const NEGATIVE_CACHE_MS = 10 * 60 * 1000;

export interface TopShelfRenderResult {
    ok: boolean;
    contentKey: string;
    bytes?: number;
    error?: string;
}

let renderSemaphore: AsyncSemaphore | null = null;
function getRenderSemaphore(): AsyncSemaphore {
    if (!renderSemaphore) {
        renderSemaphore = new AsyncSemaphore(config.TOPSHELF_MAX_CONCURRENT_RENDERS);
    }
    return renderSemaphore;
}

/** Module-level coalescing: concurrent mints for the same contentKey await one render. */
const inFlightRenders = new Map<string, Promise<TopShelfRenderResult>>();
/** contentKey → epoch-ms it stops being negatively cached. */
const negativeCache = new Map<string, number>();

function isNegativelyCached(contentKey: string): boolean {
    const expiresAt = negativeCache.get(contentKey);
    if (expiresAt === undefined) return false;
    if (Date.now() >= expiresAt) {
        negativeCache.delete(contentKey);
        return false;
    }
    return true;
}

async function runRender(params: {
    mediaId: string;
    variant: TopShelfVariant;
    /**
     * The store/manifest key the artifact is recorded under: the bare variant
     * for a plain render, or the compound overlay token for an overlaid one.
     * `inFlightRenders` still coalesces on `contentKey`, not this.
     */
    storeKey: StoreVariantKey;
    selection: TopShelfSourceSelection;
    contentKey: string;
    overlay?: TopShelfOverlayRenderInput;
}): Promise<TopShelfRenderResult> {
    const { mediaId, variant, storeKey, selection, contentKey, overlay } = params;
    const store = getTopShelfArtifactStore();

    return getRenderSemaphore().withPermit(async () => {
        // Everything after permit acquisition lives inside the try —
        // including `mkdir` — so an EACCES/ENOSPC cache-dir failure is
        // caught, returns `{ok:false}`, and negative-caches the contentKey
        // instead of rejecting this promise unhandled.
        let tmpPath: string | undefined;
        // Per-render content PNG (logo/text). The shared scrim is NEVER
        // deleted here — it lives at the store root and is reused across
        // renders (see ensureScrimAsset).
        let contentPng: string | undefined;
        try {
            const dir = store.itemDir(mediaId);
            await fs.mkdir(dir, { recursive: true });
            const finalPath = store.artifactPath(mediaId, storeKey, contentKey);
            tmpPath = `${finalPath}.tmp.${process.pid}`;
            // Belt-and-suspenders: Node is often PID 1 in Docker, so a stale
            // tmp path from an unclean shutdown can recur under the same
            // PID; clear it before spawning even though `-y` also covers it.
            await fs.rm(tmpPath, { force: true });

            // Materialize the overlay assets at render time as `*.tmp.*` files
            // in the item dir, so the store's `.tmp.` sweep + the catch-rm
            // below cover them if we crash mid-render.
            let overlayArgs: BuildTopShelfFfmpegArgsInput['overlay'];
            if (overlay) {
                contentPng = `${finalPath}.content.tmp.${process.pid}.png`;
                // The SAME box the ffmpeg graph assumes — both derive it from
                // (style.scale, TOPSHELF_RENDER_MAX_WIDTH, TOPSHELF_RENDER_MAX_HEIGHT),
                // so the PNG is already the exact size the graph overlays and
                // no rescale is involved.
                const box = computeOverlayBox(
                    overlay.style.scale,
                    config.TOPSHELF_RENDER_MAX_WIDTH,
                    config.TOPSHELF_RENDER_MAX_HEIGHT,
                );
                if (overlay.mode === 'logo') {
                    const ok = await materializeLogoPng(
                        mediaId,
                        contentPng,
                        overlay.badge,
                        box,
                        overlay.style.pos,
                    );
                    // `false` (no logo bytes) THROWS so the contentKey
                    // negative-caches — the mint ladder then falls to text.
                    if (!ok) throw new Error('topshelf-overlay: logo bytes unavailable');
                } else {
                    await renderTextPng(overlay.text ?? '', contentPng, box, overlay.style.pos);
                }
                const scrimPng = overlay.style.scrim ? await ensureScrimAsset() : undefined;
                overlayArgs = {
                    style: overlay.style,
                    contentPngPath: contentPng,
                    scrimPngPath: scrimPng,
                    padding: config.TOPSHELF_OVERLAY_SAFE_PADDING,
                };
            }

            const args = buildTopShelfFfmpegArgs({
                variant,
                sourcePath: selection.filePath!,
                startSeconds: selection.startSeconds!,
                durationSeconds: selection.durationSeconds!,
                outputPath: tmpPath,
                overlay: overlayArgs,
            });

            await spawnFFmpegSafely({
                args,
                libraryInput: selection.filePath!,
                timeout: RENDER_TIMEOUT_MS,
                context: { operation: 'topshelf-preview', mediaId, variant, contentKey },
            });
            await fs.rename(tmpPath, finalPath);
            const stat = await fs.stat(finalPath);

            await store.recordVariant(mediaId, storeKey, {
                contentKey,
                source: selection.previewSource ?? 'snippet',
                ...(overlay ? { mode: overlay.mode } : {}),
                bytes: stat.size,
                createdAt: new Date().toISOString(),
                lastRequestedAt: new Date().toISOString(),
            });

            // Content PNG only — never the shared scrim.
            if (contentPng) await fs.rm(contentPng, { force: true }).catch(() => {});

            return { ok: true, contentKey, bytes: stat.size };
        } catch (err) {
            if (tmpPath) await fs.rm(tmpPath, { force: true }).catch(() => {});
            if (contentPng) await fs.rm(contentPng, { force: true }).catch(() => {});
            const message = err instanceof Error ? err.message : String(err);
            logger.error('Top Shelf render failed', err instanceof Error ? err : undefined, {
                mediaId,
                variant,
                contentKey,
            });
            negativeCache.set(contentKey, Date.now() + NEGATIVE_CACHE_MS);
            return { ok: false, contentKey, error: message };
        }
    });
}

export type EnqueueTopShelfRenderOutcome =
    { enqueued: true } | { enqueued: false; reason: 'negative_cache' | 'queue_full' };

/**
 * Ensure a render for `contentKey` is in flight (or already running), subject
 * to the pending-queue cap and the failure negative-cache. Never awaits
 * completion — the caller (mint handler) must stay cheap.
 */
export function enqueueTopShelfRender(params: {
    mediaId: string;
    variant: TopShelfVariant;
    /**
     * Compound overlay token when overlaid; defaults to the bare `variant` for
     * plain direct callers (keeps the non-overlay path byte-identical and
     * backward-compatible with callers that predate the overlay threading).
     */
    storeKey?: StoreVariantKey;
    selection: TopShelfSourceSelection;
    contentKey: string;
    overlay?: TopShelfOverlayRenderInput;
}): EnqueueTopShelfRenderOutcome {
    const { contentKey } = params;

    if (inFlightRenders.has(contentKey)) return { enqueued: true };
    if (isNegativelyCached(contentKey)) return { enqueued: false, reason: 'negative_cache' };
    if (inFlightRenders.size >= config.TOPSHELF_MAX_PENDING_RENDERS) {
        return { enqueued: false, reason: 'queue_full' };
    }

    // When an overlay is present but the caller didn't supply an explicit
    // storeKey, derive the compound overlay token rather than falling back
    // to the bare `variant` — otherwise an overlay-burned artifact would
    // mis-record under the PLAIN key, shadowing (or being shadowed by) the
    // non-overlay render for the same variant. No live caller hits this
    // path today (resolveAndEnqueueTopShelfVariant always passes storeKey
    // explicitly); this hardens any future direct caller.
    const effectiveStoreKey: StoreVariantKey = params.storeKey
        ? params.storeKey
        : params.overlay
          ? serializeOverlayToken(
                params.overlay.base,
                params.overlay.mode,
                params.overlay.style,
                params.overlay.locale,
            )
          : params.variant;

    const promise = runRender({ ...params, storeKey: effectiveStoreKey })
        // Belt-and-suspenders: runRender already catches everything it can
        // throw and negative-caches on failure, but this terminal `.catch`
        // guards against any future unguarded throw slipping in — nothing
        // awaits this promise, so an unguarded rejection would otherwise be
        // unhandled and could crash the process.
        .catch((err: unknown) => {
            logger.error(
                'Top Shelf render rejected outside its own error handling',
                err instanceof Error ? err : undefined,
                { mediaId: params.mediaId, variant: params.variant, contentKey },
            );
            negativeCache.set(contentKey, Date.now() + NEGATIVE_CACHE_MS);
            return {
                ok: false,
                contentKey,
                error: err instanceof Error ? err.message : String(err),
            };
        })
        .finally(() => {
            inFlightRenders.delete(contentKey);
        });
    inFlightRenders.set(contentKey, promise);
    return { enqueued: true };
}

export interface ResolveAndEnqueueTopShelfResult {
    state: 'pending' | 'unavailable';
    /**
     * Present only when `state === 'pending'` and the enqueue hit the
     * failure negative-cache (a permanently-broken source) — the caller
     * should hand this back as the poll's `retryAfterSeconds` instead of the
     * short default, so a corrupt source doesn't get re-queried every
     * `RETRY_AFTER_SECONDS`. Matches `NEGATIVE_CACHE_MS`. Absent for the
     * `queue_full` case, which stays a normal short-retry 202.
     */
    retryAfterSeconds?: number;
}

/**
 * Resolve the current render state for (mediaId, variant): selects the
 * source and — when ready — enqueues a coalesced render. Shared by the mint
 * handler (cache-miss path) and the serving route's heal-on-410 path.
 */
export async function resolveAndEnqueueTopShelfVariant(
    sql: postgres.Sql,
    mediaId: string,
    variant: TopShelfVariant,
    overlay?: TopShelfOverlayRenderInput,
): Promise<ResolveAndEnqueueTopShelfResult> {
    const selection = await selectTopShelfSource(sql, mediaId, variant);
    if (selection.status === 'unavailable') return { state: 'unavailable' };

    // Store/manifest key: the compound overlay token when overlaid, else the
    // bare variant (plain path stays byte-identical to before).
    const storeKey: StoreVariantKey = overlay
        ? serializeOverlayToken(overlay.base, overlay.mode, overlay.style, overlay.locale)
        : variant;

    const contentKey = computeTopShelfContentKey({
        sourceItemId: selection.sourceItemId!,
        fileId: selection.fileId!,
        fileVersion: selection.fileVersion ?? 'unknown',
        variant: storeKey,
        startSeconds: selection.startSeconds!,
        durationSeconds: selection.durationSeconds!,
        ...(overlay
            ? { overlayContentHash: overlay.contentHash, overlayProfileRev: OVERLAY_PROFILE_REV }
            : {}),
    });

    const outcome = enqueueTopShelfRender({
        mediaId,
        variant,
        storeKey,
        selection,
        contentKey,
        overlay,
    });
    if (!outcome.enqueued && outcome.reason === 'negative_cache') {
        return { state: 'pending', retryAfterSeconds: Math.ceil(NEGATIVE_CACHE_MS / 1000) };
    }
    return { state: 'pending' };
}

/** Reset in-memory render state — exclusively for tests. */
export function __resetTopShelfRenderStateForTests(): void {
    inFlightRenders.clear();
    negativeCache.clear();
    renderSemaphore = null;
}
