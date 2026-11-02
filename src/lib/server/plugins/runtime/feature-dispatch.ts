// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure route-matching for feature-plugin `routes`. Kept free of SvelteKit so
 * it can be unit-tested. The catch-all `+server.ts` builds the context and
 * calls the matched handler.
 */
import type {
    FeatureDefinition,
    FeatureRoute,
    PluginContext,
    PluginUser,
} from '@sapd/lumastra-plugin-sdk';
import type { RequestEvent } from '@sveltejs/kit';
import {
    DEFAULT_MAX_BODY_BYTES,
    BODY_TOO_LARGE,
    isDeclaredContentLengthOverCap,
    readBoundedBodyText,
    readBoundedBodyBytes,
    restoreRequestBody,
    restoreRequestBodyBytes,
} from '$lib/server/utils/bounded-body-reader.js';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('FeatureDispatch');

/**
 * Cap applied before ANY feature-plugin handler sees a request body (C26,
 * 2026-09-16 fix plan). No finding-specified value for this surface — reuses
 * `bounded-body-reader.ts`'s own default, the same cap `mount()` applies to
 * every def with no explicit `maxBodyBytes`.
 */
const MAX_FEATURE_BODY_BYTES = DEFAULT_MAX_BODY_BYTES;

/**
 * True when `request`'s body can be safely round-tripped through
 * `TextDecoder`/`new Request(url, {body: text})` without altering its bytes.
 *
 * Fix-round-1 review finding: the original C26 fix applied the
 * read-as-text-then-`restoreRequestBody` round trip UNCONDITIONALLY to every
 * request with a body. `mount.ts`'s own `readRequestBody()` documents exactly
 * why that is unsafe for `multipart/form-data` ("NOT round-trippable through
 * text — boundary/binary semantics") and sidesteps it by only ever reading
 * bodies for defs that declare a `request.body` schema (the one multipart
 * handler in this codebase, avatar upload, declares none). A `FeatureRoute`
 * has no such escape hatch — the plugin SDK hands third-party feature routes
 * a raw `Request` with no content-type restriction (a plugin may legitimately
 * call `req.formData()` or `req.arrayBuffer()` for an upload) — so applying
 * the same round trip here would silently mangle any non-UTF-8-text body via
 * `TextDecoder`'s U+FFFD replacement, with no error raised.
 *
 * Anything NOT recognized here (multipart/form-data, application/octet-stream,
 * image/*, etc.) skips the TEXT round trip — {@link readBoundedBodyBytes} /
 * {@link restoreRequestBodyBytes} enforce the SAME byte cap for these without
 * ever decoding through `TextDecoder` (fix-round-2 review finding: the
 * declared-Content-Length precheck alone is not enough here — a client can
 * omit it (chunked transfer-encoding) or lie, and this codebase treats that
 * header as untrustworthy everywhere else, per `bounded-body-reader.ts`'s own
 * docstring and the whole premise of C15/C16. Skipping the streamed cap
 * entirely for these content types would have reopened exactly the
 * unbounded-buffering harm C26 named, for precisely the content types a
 * feature route legitimately uses for uploads).
 */
function isTextSafeContentType(request: Request): boolean {
    const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
    // No declared Content-Type is the common case for a plain JSON POST.
    if (contentType === '') return true;
    if (contentType.startsWith('application/json')) return true;
    if (contentType.startsWith('application/x-www-form-urlencoded')) return true;
    if (contentType.startsWith('text/')) return true;
    return false;
}

export interface FeatureRouteMatch {
    route: FeatureRoute;
    params: Record<string, string>;
}

function normalize(path: string): string {
    const p = path.startsWith('/') ? path : `/${path}`;
    return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function tryMatch(pattern: string, actual: string): Record<string, string> | null {
    const pSegs = normalize(pattern).split('/');
    const aSegs = normalize(actual).split('/');
    if (pSegs.length !== aSegs.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < pSegs.length; i++) {
        const ps = pSegs[i];
        const as = aSegs[i];
        if (ps.startsWith(':')) {
            if (!as) return null;
            let decoded: string;
            try {
                decoded = decodeURIComponent(as);
            } catch {
                // Malformed percent-escape (e.g. '%', '%zz') — treat as a non-match
                // so the matcher stays a pure function that returns a match or null
                // instead of throwing a URIError into the caller.
                return null;
            }
            params[ps.slice(1)] = decoded;
        } else if (ps !== as) {
            return null;
        }
    }
    return params;
}

/**
 * Find the route in `feature.routes` matching `method` + `restPath`. Static
 * segments win over param segments (we test exact-string routes first).
 */
export function matchFeatureRoute(
    feature: FeatureDefinition,
    method: string,
    restPath: string,
): FeatureRouteMatch | null {
    const candidates = feature.routes.filter((r) => r.method === method);
    // Exact (no ':' param) matches first so a static route beats a param route.
    const staticFirst = [...candidates].sort(
        (a, b) => Number(a.path.includes(':')) - Number(b.path.includes(':')),
    );
    for (const route of staticFirst) {
        const params = tryMatch(route.path, restPath);
        if (params) return { route, params };
    }
    return null;
}

export interface FeatureDispatchInput {
    featureId: string;
    rest: string;
    method: string;
    request: Request;
    user: PluginUser | null;
}

export interface FeatureDispatchDeps {
    getFeature(id: string): FeatureDefinition | undefined;
    /**
     * Build the request-scoped `PluginContext`. May be async — the request
     * dispatcher uses `buildRequestPluginContext` (which awaits the optional
     * `ctx.ai` loader). A synchronous return is also accepted (tests).
     */
    buildCtx(featureId: string, user: PluginUser): PluginContext | Promise<PluginContext>;
}

/**
 * Auth-gate + route-match + invoke a feature handler. The route file is a thin
 * wrapper around this. Default posture: authenticated user required (this path
 * is outside the hooks.server.ts /api/v1 + /api/admin backstops).
 *
 * Note: matched `:param` segments (e.g. `:id`) are NOT forwarded to the handler.
 * The handler signature is `(ctx, request)`. Handlers that need a path parameter
 * must extract it themselves from the request URL, e.g.
 * `new URL(request.url).pathname.split('/')`. Threading `match.params` into the
 * handler would require a coordinated `@sapd/lumastra-plugin-sdk` `FeatureRoute`
 * type change.
 *
 * The handler invocation is wrapped so a plugin handler that throws, rejects, or
 * returns a non-`Response` value cannot escape this dispatcher's JSON-error
 * contract (the 401/404 branches above return `{ error }`). Without the guard
 * such a handler would propagate to SvelteKit's default error path (no custom
 * `handleError` is exported in `hooks.server.ts`), yielding a generic 500 and
 * potentially leaking a stack/detail in dev.
 */
export async function dispatchFeatureRequest(
    input: FeatureDispatchInput,
    deps: FeatureDispatchDeps,
): Promise<Response> {
    if (!input.user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const feature = deps.getFeature(input.featureId);
    if (!feature) {
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const match = matchFeatureRoute(feature, input.method, input.rest);
    if (!match) {
        return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // C26: bound the body BEFORE any plugin handler buffers it — every
    // feature handler previously read `req.json()`/`.text()` itself, with no
    // shared cap, so an oversized body was fully buffered and
    // synchronously JSON.parse'd per request at an unbounded request rate.
    // Only requests that actually carry a body stream go through this (a
    // GET/HEAD's `request.body` is null).
    let request = input.request;
    if (request.body) {
        // The cheap declared-Content-Length check touches no bytes and is
        // safe for EVERY content type (including multipart/binary) — applied
        // unconditionally.
        if (isDeclaredContentLengthOverCap(request, MAX_FEATURE_BODY_BYTES)) {
            return Response.json({ error: 'Payload too large' }, { status: 413 });
        }
        // The TEXT round trip (readBoundedBodyText/restoreRequestBody) is only
        // safe for text-representable bodies — see isTextSafeContentType's
        // docstring. Everything else still gets the SAME streamed byte-count
        // cap, via the byte-preserving (never-decoded-as-text) counterpart, so
        // a multipart/binary body can never bypass the cap by omitting or
        // lying about Content-Length (fix-round-2 review finding).
        if (isTextSafeContentType(request)) {
            const bodyText = await readBoundedBodyText(request, MAX_FEATURE_BODY_BYTES);
            if (bodyText === BODY_TOO_LARGE) {
                return Response.json({ error: 'Payload too large' }, { status: 413 });
            }
            const restoreTarget = { request } as unknown as RequestEvent;
            restoreRequestBody(restoreTarget, bodyText);
            request = restoreTarget.request;
        } else {
            const bodyBytes = await readBoundedBodyBytes(request, MAX_FEATURE_BODY_BYTES);
            if (bodyBytes === BODY_TOO_LARGE) {
                return Response.json({ error: 'Payload too large' }, { status: 413 });
            }
            const restoreTarget = { request } as unknown as RequestEvent;
            restoreRequestBodyBytes(restoreTarget, bodyBytes);
            request = restoreTarget.request;
        }
    }

    try {
        // Build the context INSIDE the try: `buildRequestPluginContext` awaits
        // `buildAiSurface` + `buildPluginContext`, either of which can reject
        // (e.g. the proprietary AI module's top-level evaluation throws, or
        // `getTaskDb()` throws). A rejection here must map to the dispatcher's
        // 500 JSON contract, not escape unhandled to SvelteKit's default error
        // path (which has no custom `handleError` and could leak a stack in dev).
        const ctx = await deps.buildCtx(input.featureId, input.user);
        const result = await match.route.handler(ctx, request, match.params);
        if (result instanceof Response) {
            return result;
        }
        logger.error('Feature handler returned a non-Response value', undefined, {
            featureId: input.featureId,
            method: input.method,
            path: match.route.path,
        });
        return Response.json({ error: 'Internal error' }, { status: 500 });
    } catch (error) {
        logger.error('Feature handler threw', error instanceof Error ? error : undefined, {
            featureId: input.featureId,
            method: input.method,
            path: match.route.path,
            error: error instanceof Error ? error.message : String(error),
        });
        return Response.json({ error: 'Internal error' }, { status: 500 });
    }
}
