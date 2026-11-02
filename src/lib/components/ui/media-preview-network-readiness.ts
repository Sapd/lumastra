// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media-preview-network-readiness.ts
 *
 * Pure decision logic for MediaPreviewPlayer's hls.js-path readiness check,
 * extracted out of the component (same pattern as `preview-hls-config.ts`
 * and `media-preview-hover-cap.ts`) so the header→ready decision can be
 * unit-tested directly, without driving hls.js or a `<video>` element.
 *
 * `hls.on(HlsClass.Events.MANIFEST_LOADED, ...)` and
 * `hls.on(HlsClass.Events.LEVEL_LOADED, ...)` both hand the component a
 * `data.networkDetails`, typed by hls.js as `Response | XMLHttpRequest |
 * null`. No custom loader is configured, so it is an XHR in practice — but
 * this function feature-tests for `getResponseHeader` rather than assuming
 * the XHR shape, and returns "not ready" for anything else (including a
 * `Response`, which has no `getResponseHeader` method) instead of throwing.
 * `X-Lumastra-Preview-Static` is set only when the artifact's `.ready`
 * marker exists server-side (`lumastra-segment-handler.ts:268/279/305`), so
 * it is the caller's sole readiness signal: only a ready session is worth
 * the preview-session memo retaining (see
 * `$lib/utils/preview-session-cache.ts`) — a warming one still has a live
 * FFmpeg job behind it, and retaining it would pin disk for content nobody
 * has watched.
 */
export function isPreviewReadyFromNetworkDetails(networkDetails: unknown): boolean {
    if (
        !networkDetails ||
        typeof networkDetails !== 'object' ||
        typeof (networkDetails as { getResponseHeader?: unknown }).getResponseHeader !== 'function'
    ) {
        return false;
    }

    const header = (
        networkDetails as { getResponseHeader: (name: string) => string | null }
    ).getResponseHeader('X-Lumastra-Preview-Static');

    return !!header;
}
