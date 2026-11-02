// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sandbox every endpoint response a browser could render as a document.
 *
 * Endpoints serve bytes we did not write — library files, MKV attachments with
 * their own `mimetype` tag, embedded cover art, sidecars, provider posters, M3U
 * logos, plugin assets — and several take the Content-Type from those bytes or
 * their metadata. A `text/html`, `image/svg+xml` or XHTML body opened as a page
 * would run its script on our origin with the viewer's session, and the
 * document CSP allows inline script. So any response that is not a SvelteKit
 * page, not one of the reviewed first-party HTML endpoints, and not a type a
 * browser never executes, gets a sandbox CSP and nosniff.
 */

export const SCRIPTABLE_RESPONSE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

/**
 * `+server.ts` routes whose own HTML needs script. Reviewed: both build their
 * markup from constants and URL-validated ids, never from file or provider bytes.
 */
export const FIRST_PARTY_HTML_ENDPOINT_ROUTES: ReadonlySet<string> = new Set([
    '/(proprietary)/j/web', // bare /j/web: re-exports the catch-all handler below
    '/(proprietary)/j/web/[...path]', // Jellyfin web deep-link shim (redirect script)
    '/api-docs', // API reference UI; sets its own route CSP
]);

const SAFE_EXACT = new Set([
    'application/json',
    'application/octet-stream',
    'application/pdf',
    'application/vnd.apple.mpegurl',
    'application/x-mpegurl',
    'application/zip',
    'application/gzip',
    'application/x-gzip',
    'application/javascript',
    'application/wasm',
    'multipart/byteranges',
    'text/plain',
    'text/vtt',
    'text/css',
    'text/csv',
    'text/javascript',
    'text/event-stream',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
    'image/gif',
    'image/bmp',
    'image/x-icon',
    'image/vnd.microsoft.icon',
]);

/** Types a browser displays or downloads but never runs as a same-origin document. */
export function isInertContentType(contentType: string | null): boolean {
    const mime = (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
    if (!mime) return false;
    if (SAFE_EXACT.has(mime)) return true;
    if (mime.endsWith('+json')) return true;
    return mime.startsWith('audio/') || mime.startsWith('video/') || mime.startsWith('font/');
}

/**
 * Apply the sandbox to an endpoint response. `renderedPage` comes from hooks'
 * transformPageChunk, which SvelteKit calls only when it renders a page; those
 * keep the document CSP set later in hooks. Not the `x-sveltekit-page` header:
 * an endpoint that copies upstream headers could carry it. A bodiless response
 * (redirect, 204, 304) has nothing to render.
 */
export function sandboxScriptableResponse(
    response: Response,
    routeId: string | null,
    renderedPage: boolean,
): void {
    if (renderedPage) return;
    const headers = response.headers;
    if (routeId && FIRST_PARTY_HTML_ENDPOINT_ROUTES.has(routeId)) return;
    if (response.body === null && !headers.has('Content-Type')) return;
    if (isInertContentType(headers.get('Content-Type'))) return;
    headers.set('Content-Security-Policy', SCRIPTABLE_RESPONSE_CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
}
