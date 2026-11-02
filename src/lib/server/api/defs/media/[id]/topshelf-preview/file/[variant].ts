// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media/{id}/topshelf-preview/file/{variant} — serves the actual Top Shelf
 * preview/cinemagraph MP4 bytes.
 *
 * Auth: PUBLIC, but unlike the media-image route (where `?sig=` is an
 * OPTIONAL alternate credential) a valid signature is REQUIRED here — the sig
 * IS the entire credential. No other auth path is accepted: a session cookie
 * or Bearer token on this route grants nothing extra. sig-or-403, always.
 *
 * Class R (binary) response: raw MP4 bytes on success, problem+json on any
 * pre-stream failure.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { verifySignedUrl } from '$lib/server/utils/signed-url.js';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser.js';
import { serveFileWithRange } from '$lib/server/utils/http-range.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isRecord } from '$lib/utils/data-extraction.js';
import { getTopShelfArtifactStore } from '$lib/server/services/topshelf/topshelf-artifact.store.js';
import type { StoreVariantKey } from '$lib/server/services/topshelf/topshelf-artifact.store.js';
import { resolveAndEnqueueTopShelfVariant } from '$lib/server/services/topshelf/topshelf-render.service.js';
import type { TopShelfVariant } from '$lib/server/services/topshelf/topshelf-content-key.js';
import { parseOverlayToken } from '$lib/server/services/topshelf/topshelf-overlay.js';
import type { ParsedOverlayToken } from '$lib/server/services/topshelf/topshelf-overlay.js';

const logger = Logger.for('TopShelfPreviewFileRoute');

// Accepts both the plain `preview.mp4`/`cinemagraph.mp4` filenames and a
// compound overlay token (e.g. `preview-ov-logo-tl-s1-x40.mp4`) — validated
// below via `parseOverlayToken`. The `?sig=` HMAC covers the whole path
// (including this token), so an attacker cannot forge one to serve an
// artifact under a different mode/locale than what was actually minted.
const VARIANT_FILENAME_PATTERN = /^(.+)\.mp4$/;

/** Fallback locale for heal re-resolution — only exercised for logo tokens, which never carry a locale. */
const HEAL_FALLBACK_LOCALE = 'en';

/**
 * Best-effort background heal for a manifest-present/file-missing artifact.
 *
 * For a plain variant, re-renders unconditionally (unchanged from before).
 * For a compound overlay token, re-resolves the CURRENT overlay for the
 * token's `style`/`locale` and only re-renders if the resolved mode still
 * matches the token's mode — e.g. a `logo` token whose logo has since been
 * removed resolves to `text` (or `none`) and is deliberately NOT re-rendered
 * here: silently switching a `logo` URL to burn `text` would violate the
 * token's own tamper-proof contract. In that case the artifact just stays a
 * plain 410 until the client re-mints a fresh token via the mint endpoint.
 */
function healMissingArtifact(
    mediaId: string,
    baseVariant: TopShelfVariant,
    token: ParsedOverlayToken | null,
): void {
    const sql = getDb();
    if (!sql) return;
    const run = token
        ? (async (): Promise<void> => {
              const { resolveOverlay } =
                  await import('$lib/server/services/topshelf/topshelf-overlay-resolver.js');
              const resolved = await resolveOverlay(
                  sql,
                  mediaId,
                  token.style,
                  token.locale ?? HEAL_FALLBACK_LOCALE,
              );
              if (resolved.mode !== token.mode || !resolved.contentHash) return;
              await resolveAndEnqueueTopShelfVariant(sql, mediaId, baseVariant, {
                  base: token.base,
                  mode: token.mode,
                  style: token.style,
                  locale: token.locale,
                  text: resolved.text,
                  badge: resolved.badge,
                  contentHash: resolved.contentHash,
              });
          })()
        : resolveAndEnqueueTopShelfVariant(sql, mediaId, baseVariant);
    run.catch((err: unknown) => {
        logger.warn('Top Shelf heal-on-410 re-render enqueue failed', {
            mediaId,
            variant: baseVariant,
            error: err instanceof Error ? err.message : String(err),
        });
    });
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Media'],
            summary: 'Serve a Top Shelf preview/cinemagraph MP4',
            stability: 'experimental',
            auth: 'none',
            description:
                'Serves the rendered MP4 bytes for a Top Shelf preview or cinemagraph variant. A valid ' +
                '`?sig=` HMAC (purpose `topshelf-preview`) is REQUIRED — there is no other accepted auth ' +
                'path on this route. Supports single-range `Range` requests for progressive playback.',
            responses: {
                200: { binary: ['video/mp4'], description: 'Full MP4 body' },
                206: { binary: ['video/mp4'], description: 'Partial MP4 body (Range request)' },
                304: {
                    description: 'Not modified (If-None-Match matched the current ETag)',
                    headers: {
                        ETag: { description: 'Echoes the validator that matched.' },
                    },
                },
                422: 'Malformed id or variant',
                403: 'Missing, invalid, or expired signature',
                404: 'Feature disabled, or no artifact has ever been minted for this item/variant',
                410: 'Manifest entry exists but the artifact file is gone (a re-render was enqueued)',
                416: 'Unsatisfiable Range request',
            },
        },
        HEAD: {
            tags: ['Media'],
            summary: 'Probe a Top Shelf preview/cinemagraph MP4 (headers only)',
            stability: 'experimental',
            auth: 'none',
            responses: {
                200: 'Headers only, no body',
                403: 'Missing, invalid, or expired signature',
                404: 'Feature disabled, or no artifact has ever been minted for this item/variant',
                410: 'Manifest entry exists but the artifact file is gone',
            },
        },
    },

    auth: { kind: 'feature', flag: 'TOPSHELF_PREVIEWS', then: { kind: 'public' } },
    raw: true,

    handlers: {
        GET: (event) => serveTopShelfFile(event),
        HEAD: (event) => serveTopShelfFile(event),
    },
});

async function serveTopShelfFile(event: RequestEvent): Promise<Response> {
    const { params, url, request } = event;

    // The sig IS the credential — no other auth path is accepted, ever.
    const verification = verifySignedUrl(url, 'topshelf-preview');
    if (!verification.valid) {
        logger.debug('Top Shelf signed URL verification failed', {
            path: url.pathname,
            reason: verification.reason,
        });
        return ApiProblem.forbidden('Invalid or expired signature');
    }

    const rawVariant = params.variant ?? '';
    const variantMatch = VARIANT_FILENAME_PATTERN.exec(rawVariant);
    if (!variantMatch) {
        return ApiProblem.validationFailed([{ field: 'variant', message: 'Malformed variant' }]);
    }
    // The store/manifest key: the bare plain variant, or the full compound
    // overlay token (e.g. `preview-ov-logo-tl-s1-x40`) — never just the
    // token's base, since distinct tokens for the same base are distinct
    // artifacts in the store.
    const storeKey = variantMatch[1];
    const parsedToken = parseOverlayToken(storeKey);
    const isPlain = storeKey === 'preview' || storeKey === 'cinemagraph';
    if (!isPlain && !parsedToken) {
        return ApiProblem.validationFailed([
            { field: 'variant', message: 'Unknown variant token' },
        ]);
    }
    const baseVariant: TopShelfVariant = isPlain
        ? (storeKey as TopShelfVariant)
        : (parsedToken!.base as TopShelfVariant);

    // Signed paths only ever contain bare internal UUIDs.
    const rawId = params.id ?? '';
    if (!isUuid(rawId)) {
        return ApiProblem.validationFailed([{ field: 'id', message: 'Invalid media id' }]);
    }
    const mediaId = normalizeUuid(rawId);

    const store = getTopShelfArtifactStore();
    const lookup = await store.getVariantArtifact(mediaId, storeKey as StoreVariantKey);

    if (lookup.status === 'no_entry') {
        // A bare, never-minted item is not a regeneration trigger — keeping
        // the DoS surface on the authenticated mint endpoint.
        return ApiProblem.notFound('No Top Shelf artifact has been minted for this item/variant');
    }

    if (lookup.status === 'missing_file') {
        healMissingArtifact(mediaId, baseVariant, parsedToken);
        return problem('gone', {
            error: 'Top Shelf artifact is missing on disk; a re-render has been enqueued',
        });
    }

    await store.touch(mediaId, storeKey as StoreVariantKey);

    const etag = `"${lookup.entry.contentKey}"`;
    if (request.headers.get('if-none-match') === etag) {
        return new Response(null, {
            status: 304,
            headers: {
                ETag: etag,
                'Cache-Control': 'public, max-age=3600',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }

    try {
        return await serveFileWithRange(lookup.path, request, {
            contentType: 'video/mp4',
            headers: {
                'Cache-Control': 'public, max-age=3600',
                'Access-Control-Allow-Origin': '*',
                ETag: etag,
            },
        });
    } catch (err) {
        // Serve-race: GC deleted the file between the store lookup and
        // serveFileWithRange's own fs.stat — the same outcome as
        // `missing_file` above (410 + heal), not an internal error.
        if (isRecord(err) && err.code === 'ENOENT') {
            healMissingArtifact(mediaId, baseVariant, parsedToken);
            return problem('gone', {
                error: 'Top Shelf artifact is missing on disk; a re-render has been enqueued',
            });
        }
        throw err;
    }
}
