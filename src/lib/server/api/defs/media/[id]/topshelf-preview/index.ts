// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media/{id}/topshelf-preview — mint signed URLs for the tvOS Top Shelf
 * carousel's `previewVideoURL` (focus preview) and `cinemagraphURL` (silent
 * looping teaser).
 *
 * The Top Shelf extension hands the system player (Pineboard) two plain
 * URLs per title and can never set headers, run an AVAssetResourceLoader, or
 * heartbeat a session — so this endpoint mints a stateless HMAC-signed URL
 * (purpose `'topshelf-preview'`) that plays for up to
 * `TOPSHELF_PREVIEW_URL_TTL_SECONDS` (default 48h) with zero server
 * interaction beyond plain HTTP GETs. See the design doc for the full
 * rationale against reusing the preview session / preview cache / stream
 * token machinery.
 *
 * Access is checked ONLY here, at mint time, against the PARENT item on
 * BOTH axes (library-group + age-rating). After mint, the signed URL plays
 * for any holder until expiry — same trust model as existing preview
 * segment URLs, whose lifetime we are lengthening for a narrower artifact
 * class (a ≤90s trailer or ≤30s snippet), not weakening.
 *
 * AGE-GATE-ON-SHARE CAVEAT: a user who passes the age gate at mint can hand
 * the URL to a profile that would not. Accepted because the content is a
 * short promotional clip the minting user already sees in-app, lifetime is
 * bounded (≤48h), and operators can lower `TOPSHELF_PREVIEW_URL_TTL_SECONDS`
 * or disable `FEATURE_TOPSHELF_PREVIEWS` if this posture is unacceptable for
 * a deployment.
 *
 * The mint endpoint NEVER blocks on a render — it stays cheap so the tvOS
 * extension can call it on every Home load. A cache-miss enqueues a
 * coalesced background render and reports `status:'pending'`.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/index.js';
import { parseMediaId } from '$lib/server/utils/media-key-parser.js';
import { resolveMediaIdByProvider } from '$lib/server/database/queries/resolvers/media-id.resolver.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { signUrl } from '$lib/server/utils/signed-url.js';
import { getTopShelfArtifactStore } from '$lib/server/services/topshelf/topshelf-artifact.store.js';
import {
    resolveAndEnqueueTopShelfVariant,
    selectTopShelfSource,
} from '$lib/server/services/topshelf/topshelf-render.service.js';
import {
    computeTopShelfContentKey,
    OVERLAY_PROFILE_REV,
} from '$lib/server/services/topshelf/topshelf-content-key.js';
import type { TopShelfVariant } from '$lib/server/services/topshelf/topshelf-content-key.js';
import {
    normalizeOverlayStyle,
    normalizeOverlayLocale,
    serializeOverlayToken,
    type OverlayStyle,
} from '$lib/server/services/topshelf/topshelf-overlay.js';
import { resolveOverlay } from '$lib/server/services/topshelf/topshelf-overlay-resolver.js';
import { TopShelfPreviewResponseSchema } from '$lib/schemas/api-topshelf-responses.js';
import { apiUrl } from '$lib/shared/api-urls.js';

const TOPSHELF_VARIANTS: readonly TopShelfVariant[] = ['preview', 'cinemagraph'];
/** Hint returned (and set as the Retry-After header) on a 202 pending response. */
const RETRY_AFTER_SECONDS = 30;

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Media'],
            summary: 'Get signed Top Shelf preview URLs',
            stability: 'experimental',
            auth: 'bearer',
            description:
                'Mints stateless HMAC-signed URLs for the tvOS Top Shelf carousel: a focus preview ' +
                '(trailer or runtime-proportional snippet) and a silent looping cinemagraph. Access is ' +
                'checked ONLY at mint time (library-group + age-rating, against the parent item) — the ' +
                'returned signed URL then plays for any holder until it expires ' +
                '(`TOPSHELF_PREVIEW_URL_TTL_SECONDS`, default 48h), same trust model as existing ' +
                'preview-segment URLs. AGE-GATE-ON-SHARE CAVEAT: a user who passes the age gate at mint ' +
                'can hand the URL to a profile that would not — accepted because the content is a short ' +
                'promotional clip the minting user already sees in-app and the lifetime is bounded.',
            responses: {
                200: {
                    schema: TopShelfPreviewResponseSchema,
                    description:
                        'status=ready (at least the preview variant exists) or status=unavailable',
                },
                202: {
                    schema: TopShelfPreviewResponseSchema,
                    description:
                        'status=pending — render enqueued/coalesced; retry after retryAfterSeconds',
                    headers: {
                        'Retry-After': { description: 'Seconds until a re-poll may succeed' },
                    },
                },
                422: 'Malformed media id',
                404: 'Feature disabled, media not found, or access denied (existence-leak rule)',
                429: 'Mint rate limit exceeded',
                503: 'Database unavailable',
            },
        },
    },

    auth: { kind: 'feature', flag: 'TOPSHELF_PREVIEWS', then: { kind: 'user' } },

    handlers: {
        GET: async (event, ctx) => {
            const surface = ctx.surface;
            const { params, locals } = event;

            const id = params.id ?? '';
            if (!id) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Media ID is required' },
                ]);
            }

            const parsed = parseMediaId(id);
            if (id.includes(':') && parsed.type === 'uuid') {
                return ApiProblem.validationFailed([
                    {
                        field: 'id',
                        message:
                            'Composite keys must include provider, id, and media type (e.g. tmdb:603:movie)',
                    },
                ]);
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            let mediaId: string;
            if (parsed.type === 'uuid' && parsed.uuid) {
                mediaId = parsed.uuid;
            } else if (parsed.type === 'composite' && parsed.provider && parsed.externalId) {
                // `resolveMediaIdByProvider` runs an UNFILTERED external_ids
                // lookup whenever `mediaType` is omitted — and TMDB ids collide
                // across media types (e.g. 1429 = a movie AND a TV show). Only
                // resolve with an EXPLICIT type when the composite's media
                // type can be correctly disambiguated to what the resolver
                // filters on ('movie' | 'tv'); fold series aliases to 'tv'.
                // `parsed.mediaType === undefined` is the parser's dedicated
                // 2-part form for providers with a globally-unique ID space
                // (e.g. `imdb:tt0137523` — no TMDB-style collision risk), so
                // the resolver's own unfiltered lookup stays intentional
                // there. Anything ELSE that isn't movie/tv — episode, season,
                // or an unrecognized 3-part token — is refused outright
                // rather than resolved unfiltered: 404, matching the
                // existence-leak rule, never a silent wrong-item resolve.
                let resolverMediaType: 'movie' | 'tv' | undefined;
                if (parsed.mediaType === undefined) {
                    resolverMediaType = undefined;
                } else if (isMovie(parsed.mediaType)) {
                    resolverMediaType = 'movie';
                } else if (isSeries(parsed.mediaType)) {
                    resolverMediaType = 'tv';
                } else {
                    return ApiProblem.notFound('Media item not found');
                }
                const found = await resolveMediaIdByProvider(
                    sql,
                    parsed.provider,
                    parsed.externalId,
                    resolverMediaType,
                );
                if (!found) return ApiProblem.notFound('Media item not found');
                mediaId = found;
            } else {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Invalid media ID format' },
                ]);
            }

            // Access gate — BOTH axes, against the PARENT item. Existence-leak
            // rule: 404, never 403.
            const accessible = await checkMediaAccess(sql, mediaId, locals.user);
            if (!accessible) return ApiProblem.notFound('Media item not found');

            // Mint rate limit — tight enough to stop scripted farming of
            // signed URLs. The tvOS app mints up to 24 titles per Home load,
            // so the old default of 60 per 5 min ran out on the third load
            // (366 429s a day on prod). 240 covers ten Home loads; renders
            // stay bounded by TOPSHELF_MAX_PENDING_RENDERS.
            const rateLimitKey = `topshelf-mint:${locals.user?.userId ?? locals.user?.username ?? 'unknown'}`;
            const rate = await checkRateLimit(rateLimitKey, config.TOPSHELF_MINT_RATE_LIMIT, 300);
            if (!rate.allowed) {
                const retryAfter = Math.max(1, rate.resetAt - Math.floor(Date.now() / 1000));
                return ApiProblem.rateLimited(retryAfter);
            }

            const store = getTopShelfArtifactStore();
            const ttlSeconds = config.TOPSHELF_PREVIEW_URL_TTL_SECONDS;

            // Overlay is strictly OPT-IN (`?overlay=1` / `?logo=1`). When it is
            // NOT requested the code below the `useOverlay` branch is the exact
            // plain path as before — byte-identical response.
            const overlayRequested =
                event.url.searchParams.get('overlay') === '1' ||
                event.url.searchParams.get('logo') === '1';
            const style: OverlayStyle = normalizeOverlayStyle(
                {
                    pos: event.url.searchParams.get('ovPos') ?? undefined,
                    scrim: event.url.searchParams.get('ovScrim') ?? undefined,
                    scale: event.url.searchParams.get('ovScale') ?? undefined,
                },
                {
                    pos: config.TOPSHELF_OVERLAY_DEFAULT_POSITION,
                    scrim: config.TOPSHELF_OVERLAY_DEFAULT_SCRIM,
                    scale: config.TOPSHELF_OVERLAY_DEFAULT_SCALE,
                },
            );
            // v1 burns the stored title (no per-request translation), so
            // always use the default overlay language; re-thread
            // Accept-Language here when localized titles are wired.
            const locale = normalizeOverlayLocale(null, config.TOPSHELF_OVERLAY_TEXT_LOCALES);

            // NON-NEGOTIABLE: resolveOverlay's unscoped media_items read is only
            // safe because the PARENT has already passed `checkMediaAccess`
            // above — never hoist this call above that gate.
            let overlayResolved: Awaited<ReturnType<typeof resolveOverlay>> | null = null;
            if (overlayRequested) {
                overlayResolved = await resolveOverlay(sql, mediaId, style, locale);
            }
            // Both preview and cinemagraph share this ONE resolved mode/locale/
            // style; the response reports the PREVIEW variant's effective mode.
            const useOverlay = overlayResolved !== null && overlayResolved.mode !== 'none';
            let overlayMode: 'logo' | 'text' | 'none' | undefined = overlayRequested
                ? (overlayResolved?.mode ?? 'none')
                : undefined;

            let previewState: 'ready' | 'pending' | 'unavailable' = 'unavailable';
            let previewVideoUrl: string | undefined;
            let cinemagraphUrl: string | undefined;
            let previewSource: 'trailer' | 'snippet' | undefined;
            let previewRetryAfterSeconds = RETRY_AFTER_SECONDS;

            // Resolve one overlaid base variant (preview|cinemagraph): applies
            // the logo→text READINESS ladder and the §5.1 content-key reconcile.
            const resolveVariantUrl = async (
                base: TopShelfVariant,
            ): Promise<{
                url?: string;
                mode: 'logo' | 'text' | 'none';
                ready: boolean;
                source?: 'trailer' | 'snippet';
                state: 'pending' | 'unavailable';
                retryAfterSeconds?: number;
            }> => {
                if (!overlayResolved || overlayResolved.mode === 'none') {
                    return { mode: 'none', ready: false, state: 'unavailable' };
                }
                const primary = overlayResolved.mode; // 'logo' | 'text'
                const overlayContentHash = overlayResolved.contentHash ?? '';

                // Serve an already-rendered token if it is ready. `reconcile`
                // is only meaningful for the token whose overlay input we
                // actually resolved (the primary mode) — the logo→text fallback
                // serves a pre-existing text artifact whose text/hash we do NOT
                // hold here, so it is served as-is without a drift check.
                const serveIfReady = async (
                    mode: 'logo' | 'text',
                    reconcile: boolean,
                ): Promise<{ url: string; source?: 'trailer' | 'snippet' } | null> => {
                    const tokenLocale = mode === 'text' ? locale : undefined;
                    const token = serializeOverlayToken(base, mode, style, tokenLocale);
                    const lookup = await store.getVariantArtifact(mediaId, token);
                    if (lookup.status !== 'ready') return null;

                    await store.touch(mediaId, token);

                    if (reconcile) {
                        // §5.1: recompute the expected content key from the
                        // current source selection + resolved overlay hash. On
                        // drift, fire-and-forget a re-render while STILL serving
                        // the current (stale) artifact — never block the mint.
                        const selection = await selectTopShelfSource(sql, mediaId, base);
                        if (selection.status === 'ready') {
                            const expectedKey = computeTopShelfContentKey({
                                sourceItemId: selection.sourceItemId!,
                                fileId: selection.fileId!,
                                fileVersion: selection.fileVersion ?? 'unknown',
                                variant: token,
                                startSeconds: selection.startSeconds!,
                                durationSeconds: selection.durationSeconds!,
                                overlayContentHash,
                                overlayProfileRev: OVERLAY_PROFILE_REV,
                            });
                            if (expectedKey !== lookup.entry.contentKey) {
                                void resolveAndEnqueueTopShelfVariant(sql, mediaId, base, {
                                    base,
                                    mode,
                                    style,
                                    locale: tokenLocale,
                                    text: overlayResolved.text,
                                    badge: overlayResolved.badge,
                                    contentHash: overlayContentHash,
                                }).catch(() => {});
                            }
                        }
                    }

                    const path = apiUrl(
                        surface,
                        `/media/${mediaId}/topshelf-preview/file/${token}.mp4`,
                    );
                    return {
                        url: signUrl(path, { expiresIn: ttlSeconds, purpose: 'topshelf-preview' }),
                        source: lookup.entry.source,
                    };
                };

                // 1) Primary token ready → serve it (with reconcile).
                const primaryHit = await serveIfReady(primary, true);
                if (primaryHit) {
                    return {
                        url: primaryHit.url,
                        mode: primary,
                        ready: true,
                        source: primaryHit.source,
                        state: 'pending',
                    };
                }

                // 2) Primary miss → enqueue the primary render (never blocks).
                const enqueued = await resolveAndEnqueueTopShelfVariant(sql, mediaId, base, {
                    base,
                    mode: primary,
                    style,
                    locale: primary === 'text' ? locale : undefined,
                    text: overlayResolved.text,
                    badge: overlayResolved.badge,
                    contentHash: overlayContentHash,
                });

                // 3) Ladder: primary is logo and not ready → serve a READY text
                // artifact if one already exists (keys on artifact readiness,
                // NOT the negative-cache signal), letting the logo retry in the
                // background. No enqueue here — we don't hold the text content.
                if (primary === 'logo') {
                    const textHit = await serveIfReady('text', false);
                    if (textHit) {
                        return {
                            url: textHit.url,
                            mode: 'text',
                            ready: true,
                            source: textHit.source,
                            state: 'pending',
                        };
                    }
                }

                return {
                    mode: primary,
                    ready: false,
                    state: enqueued.state,
                    retryAfterSeconds: enqueued.retryAfterSeconds,
                };
            };

            if (useOverlay) {
                const previewResult = await resolveVariantUrl('preview');
                const cinemagraphResult = await resolveVariantUrl('cinemagraph');
                overlayMode = previewResult.mode;
                if (previewResult.ready) {
                    previewState = 'ready';
                    previewVideoUrl = previewResult.url;
                    previewSource = previewResult.source;
                } else {
                    previewState = previewResult.state;
                    if (previewResult.retryAfterSeconds !== undefined) {
                        previewRetryAfterSeconds = previewResult.retryAfterSeconds;
                    }
                }
                if (cinemagraphResult.ready) cinemagraphUrl = cinemagraphResult.url;

                if (previewState === 'ready') {
                    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
                    return json({
                        status: 'ready',
                        previewVideoUrl,
                        ...(cinemagraphUrl ? { cinemagraphUrl } : {}),
                        ...(previewSource ? { previewSource } : {}),
                        ...(overlayMode ? { overlay: overlayMode } : {}),
                        expiresAt,
                    });
                }
                if (previewState === 'pending') {
                    return json(
                        { status: 'pending', retryAfterSeconds: previewRetryAfterSeconds },
                        {
                            status: 202,
                            headers: { 'Retry-After': String(previewRetryAfterSeconds) },
                        },
                    );
                }
                return json({ status: 'unavailable' });
            }

            for (const variant of TOPSHELF_VARIANTS) {
                const lookup = await store.getVariantArtifact(mediaId, variant);

                if (lookup.status === 'ready') {
                    // Touch on every mint that finds an artifact — this is the
                    // durability contract's input (§4.3): any artifact a live
                    // signed URL can point at must be inside the pinning window.
                    await store.touch(mediaId, variant);

                    const path = apiUrl(
                        surface,
                        `/media/${mediaId}/topshelf-preview/file/${variant}.mp4`,
                    );
                    const signed = signUrl(path, {
                        expiresIn: ttlSeconds,
                        purpose: 'topshelf-preview',
                    });

                    if (variant === 'preview') {
                        previewState = 'ready';
                        previewVideoUrl = signed;
                        previewSource = lookup.entry.source;
                    } else {
                        cinemagraphUrl = signed;
                    }
                    continue;
                }

                // No artifact on disk (never minted, or manifest-present-file-
                // missing) — enqueue a coalesced render. Never blocks the mint.
                // Only the PREVIEW variant's state drives the response status
                // (§2.2): cinemagraph may still be pending/omitted on a 200.
                const result = await resolveAndEnqueueTopShelfVariant(sql, mediaId, variant);
                if (variant === 'preview') {
                    previewState = result.state;
                    // A negative-cached (permanently-broken) source gets a
                    // much longer retry hint than the default short poll, so
                    // a corrupt source doesn't re-run the DB queries every
                    // RETRY_AFTER_SECONDS forever.
                    if (result.retryAfterSeconds !== undefined) {
                        previewRetryAfterSeconds = result.retryAfterSeconds;
                    }
                }
            }

            if (previewState === 'ready') {
                const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
                return json({
                    status: 'ready',
                    previewVideoUrl,
                    ...(cinemagraphUrl ? { cinemagraphUrl } : {}),
                    ...(previewSource ? { previewSource } : {}),
                    ...(overlayMode ? { overlay: overlayMode } : {}),
                    expiresAt,
                });
            }

            if (previewState === 'pending') {
                return json(
                    { status: 'pending', retryAfterSeconds: previewRetryAfterSeconds },
                    { status: 202, headers: { 'Retry-After': String(previewRetryAfterSeconds) } },
                );
            }

            // previewState === 'unavailable' — structurally implies cinemagraph
            // is unavailable too (both fall back to the same parent file check
            // when there's no trailer); no URLs, no render enqueued.
            return json({ status: 'unavailable' });
        },
    },
});
