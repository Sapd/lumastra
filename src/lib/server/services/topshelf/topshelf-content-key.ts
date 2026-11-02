// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Top Shelf content-key derivation — pure, unit-testable.
 *
 * The content key names ONE rendered artifact for (media item, variant):
 * `preview-{contentKey}.mp4` / `cinemagraph-{contentKey}.mp4` under the item's
 * directory in the durable Top Shelf artifact store
 * (`topshelf-artifact.store.ts`). It changes whenever any input that would
 * change the rendered bytes changes (source item, file identity/version,
 * variant, seek bucket, duration, or encode profile revision), so a re-render
 * after a library file upgrade produces a NEW key rather than silently
 * overwriting a stale artifact still referenced by a live signed URL — the
 * store's serving route resolves "current artifact for (uuid, variant)" via
 * the manifest, so old signed URLs simply start serving the new artifact.
 */

import { createHash } from 'node:crypto';
import { seekBucket } from '$lib/server/services/preview-cache-key.js';

/**
 * Bump when the ffmpeg encode args for Top Shelf artifacts change shape.
 * `ts2`: base render dimensions moved off the shared hover-preview knob
 * (`PREVIEW_MAX_WIDTH`, 640px) onto Top Shelf's own `TOPSHELF_RENDER_MAX_WIDTH`/
 * `_HEIGHT` (1280x720) — every previously rendered PLAIN (non-overlay)
 * artifact was encoded at the old, softer 640-wide base and must re-render.
 */
export const TOPSHELF_PROFILE_REV = 'ts2';

/**
 * Bump when the overlay filter-graph geometry changes.
 * `ov2`: absolute-pixel scrim/content sizing (replaced the `rw`/`rh` ref-scale
 * form) + measured, force-fit text rendering — every previously rendered
 * overlay artifact is geometrically stale.
 * `ov3`: text overlay is now SHRINK-TO-FIT (binary-searched font size, 48–96px)
 * instead of one fixed size + ellipsis-on-overflow — every previously rendered
 * text overlay artifact renders at the wrong (and now-stale) size.
 * `ov4`: the burn is composited into a FIXED `boxW x boxH` overlay box (bounded
 * in BOTH axes) and ffmpeg no longer rescales it; the `S01E02` badge is sized
 * from the box instead of inheriting the logo composite's scale factor. Every
 * previously rendered overlay artifact has the old width-only geometry —
 * oversized for tall logos, oversized badge, unbounded relative to the padded
 * safe area.
 * `ov5`: the overlay box now derives from `TOPSHELF_RENDER_MAX_WIDTH`/`_HEIGHT`
 * (1280x720) instead of the shared hover-preview `PREVIEW_MAX_WIDTH` (640px),
 * and the safe-area padding moved from 0.04 to 0.055 (TV title-safe
 * convention, ~5.5%) after a report of a wide logo clipping on the left edge
 * on a real Apple TV. Every previously rendered overlay artifact has the old
 * (smaller, less-padded) geometry.
 * `ov6`: the overlay path cover-crops the base to exactly 16:9 (1280x720)
 * instead of keeping the source aspect. tvOS aspect-fills the shelf, so a 4:3
 * source rendered at 1280x960 lost its top 120px on the device, and with it the
 * burned logo and episode badge. Every overlay artifact of a non-16:9 source
 * is clipped on screen.
 */
export const OVERLAY_PROFILE_REV = 'ov6';

/**
 * Seek-bucket width (seconds) for the content key's `startBucket` component.
 * Mirrors the preview cache's coalescing tolerance so repeated mints for the
 * same item/variant collapse onto the same artifact instead of re-rendering
 * for every few-second difference in the resolved start position.
 */
export const TOPSHELF_CONTENT_KEY_BUCKET_SECONDS = 15;

export type TopShelfVariant = 'preview' | 'cinemagraph';

export interface TopShelfContentKeyInput {
    /** The trailer child item id, or the parent item id (snippet case). */
    sourceItemId: string;
    /** media_files.id backing the render. */
    fileId: string;
    /**
     * Stable file-identity string (see `resolveFileVersion` in
     * preview-session.service.ts) — changes when the underlying file is
     * replaced/upgraded so the key rotates and a stale artifact is never
     * served under a new file's identity.
     */
    fileVersion: string;
    /** Plain variant (`preview`/`cinemagraph`) or a compound overlay token. */
    variant: string;
    /** Raw (unbucketed) start position in seconds. */
    startSeconds: number;
    /** Clip duration in seconds. */
    durationSeconds: number;
    /** Encode-profile revision. Defaults to {@link TOPSHELF_PROFILE_REV}. */
    profileRev?: string;
    /** Present only for overlaid variants — hash of the burned logo/text. */
    overlayContentHash?: string;
    /** Present only for overlaid variants — {@link OVERLAY_PROFILE_REV}. */
    overlayProfileRev?: string;
}

/** Bucket a raw start position onto the content-key coalescing grid. */
export function bucketTopShelfStartPosition(startSeconds: number): number {
    return seekBucket(startSeconds, TOPSHELF_CONTENT_KEY_BUCKET_SECONDS);
}

/**
 * Derive the 16-hex-char content key for one Top Shelf artifact.
 *
 * `sha1("v1:{sourceItemId}:{fileId}:{fileVersion}:{variant}:{startBucket}:{durationSeconds}:{profileRev}[:{overlayContentHash}:{overlayProfileRev}]").slice(0, 16)`
 *
 * Overlay fields are appended only when `overlayContentHash` is present, keeping plain keys byte-identical.
 */
export function computeTopShelfContentKey(input: TopShelfContentKeyInput): string {
    const startBucket = bucketTopShelfStartPosition(input.startSeconds);
    const profileRev = input.profileRev ?? TOPSHELF_PROFILE_REV;
    const parts = [
        'v1',
        input.sourceItemId,
        input.fileId,
        input.fileVersion,
        input.variant,
        String(startBucket),
        String(input.durationSeconds),
        profileRev,
    ];
    if (input.overlayContentHash !== undefined) {
        parts.push(input.overlayContentHash, input.overlayProfileRev ?? OVERLAY_PROFILE_REV);
    }
    const canonical = parts.join(':');
    return createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}
