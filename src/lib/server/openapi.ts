// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/openapi.ts
import type { z } from 'zod';
import type { ProblemCode } from './api/problem.js';

/**
 * A single custom response header to advertise in the spec. Used for byte/binary
 * surfaces (trickplay, etc.) that carry meaningful metadata in non-standard
 * `X-*` headers the handler sets on the `Response`. `schema` defaults to a plain
 * string when omitted; set it for typed (e.g. integer-as-string) header values.
 */
export interface ResponseHeader {
    /** Human-readable description of the header's meaning. */
    description?: string;
    /** Zod schema for the header value (defaults to `z.string()`). */
    schema?: z.ZodType;
}

/**
 * Map of response-header name → declaration, attachable to any non-string
 * {@link ResponseDef}. Emitted as OpenAPI `responses[code].headers`.
 */
export type ResponseHeaders = Record<string, ResponseHeader>;

/**
 * Response definition for a single status code.
 *
 * The body-bearing variants accept an optional `headers` map so byte/binary
 * surfaces can advertise the custom (`X-*`) response headers their handler
 * sets. The last object variant is for a response that carries headers but
 * NO body at all (e.g. a `304 Not Modified` that still sets `ETag`) — using
 * one of the body-bearing variants there would document `content` for a
 * response the handler never sends one on. `headers` is REQUIRED on it:
 * with no headers to advertise there is nothing this variant does that the
 * plain-string shorthand below doesn't already do.
 */
export type ResponseDef =
    | {
          schema: z.ZodType;
          description?: string;
          headers?: ResponseHeaders;
          contentType?: 'application/json' | 'application/problem+json';
      }
    | { binary: string[]; description?: string; headers?: ResponseHeaders }
    | { text: string; description?: string; headers?: ResponseHeaders }
    | { sse: true; description?: string; headers?: ResponseHeaders }
    | { description: string; headers: ResponseHeaders } // no body, e.g. 304 with ETag
    // Description-only error response with an explicit problem `code` override
    // (otherwise the status code's DEFAULT_CODE_FOR_STATUS applies — see
    // apiErrorResponse in scripts/openapi/helpers.ts). Use when a def's runtime
    // handler sends a code other than the status-default one, e.g. a 503 that
    // is actually `stream_limit`, not `dependency_unavailable`.
    | { description: string; code: ProblemCode }
    | string; // shorthand: just a description (for 204, simple errors)

/**
 * Stability tier for an API operation. Surfaced in OpenAPI as the
 * `x-stability` extension so third parties know what is contract-stable.
 *
 * - `stable`   — Core primitives (search, media, ratings, playback session,
 *                music). Backwards-compatibility maintained.
 * - `beta`     — UI-aggregation/discovery endpoints (browse, for-you,
 *                calendar, trending, continue-watching, recommendations,
 *                mood). May change.
 * - `experimental` — Pre-alpha feature surface still under active shaping
 *                (e.g. Top Shelf preview rendering). Expect breaking changes,
 *                including removal.
 * - `protocol` — Auth-bypass / device / streaming protocol endpoints
 *                (HMAC-signed images, query-token stream sessions, AirPlay).
 *                Shape is dictated by the client protocol, not a general
 *                contract.
 * - `deprecated` — Superseded by another endpoint (named in `description`).
 *                Still functions for existing clients but should not be used
 *                by new ones; removal is tracked separately (see the design
 *                doc's cleanup sub-project).
 */
export type StabilityTier = 'stable' | 'beta' | 'experimental' | 'protocol' | 'deprecated';

/**
 * Required with `stability: 'deprecated'`. Drives both the spec
 * (`deprecated: true` + `x-deprecation`) and the runtime `Deprecation` /
 * `Sunset` / `Link` headers (`api/deprecation.ts`). Policy: docs/api/API.md,
 * "Stability and deprecation".
 */
export interface DeprecationInfo {
    /** ISO date (YYYY-MM-DD) the deprecation was announced. */
    since: string;
    /** ISO date the operation will be removed; omit until announced. */
    sunset?: string;
    /** Replacement operation's path, without the surface prefix (`/diagnostics/events`). */
    replacement: string;
}

/**
 * OpenAPI metadata for a single HTTP method on a route.
 */
export interface MethodMetadata {
    /** Spec visibility override for this method; defaults to the route visibility. */
    visibility?: Visibility;
    /** OpenAPI tags for grouping */
    tags: string[];
    /** One-line summary */
    summary: string;
    /**
     * Explicit operationId override. Omit to auto-derive a camelCase id from the
     * path (the default + strongly preferred). Set ONLY to disambiguate a genuine
     * cross-doc collision (e.g. an internal route whose path camelCases to the
     * same id as a public one). MUST be camelCase — the operationId style guard
     * rejects underscores/hyphens.
     */
    operationId?: string;
    /**
     * Stability tier (emitted as `x-stability`). Defaults to `'beta'` when
     * omitted. Set explicitly so consumers know the contract guarantee.
     */
    stability?: StabilityTier;
    /** Required when `stability` is `'deprecated'`; see {@link DeprecationInfo}. */
    deprecation?: DeprecationInfo;
    /** Multi-line description (optional) */
    description?: string;
    /** Request body Zod schema (for POST/PUT/PATCH) */
    body?: z.ZodType;
    /** Whether the documented JSON request body is required (documentation only). */
    bodyRequired?: boolean;
    /** Query parameter Zod schema */
    query?: z.ZodType;
    /**
     * Path-parameter Zod schema (object keyed by param name). The generator
     * already derives `parameters[].in=path` from the route's `{id}` segments
     * typed as `string`; declare `params` ONLY to override the type of specific
     * segments (e.g. a numeric `width` → `z.coerce.number().int()`). Keys not
     * present here keep the default string typing; extra keys are ignored.
     */
    params?: z.ZodObject;
    /**
     * Request HEADER-parameter schema (object keyed by header name → Zod
     * value schema). DOCUMENTATION ONLY: unlike `query`/`body`/`params`,
     * mount()/enforce() do NOT parse or validate headers this way — a
     * handler still reads them straight off `event.request.headers`, same as
     * before. Declaring one here only changes the generated spec: the
     * generator emits it as OpenAPI `parameters[].in=header` (via
     * zod-openapi's `requestParams.header`, which accepts exactly this
     * shape — see `ParameterLocation` in the zod-openapi types), so a
     * generated client gets a real field to set instead of the caller having
     * to intercept raw requests to send a header the spec never mentioned.
     */
    headers?: z.ZodObject;
    /** Response definitions keyed by status code */
    responses: Record<number, ResponseDef>;
    /**
     * Override auth detection.
     * - undefined: auto-detect from handler source
     * - 'bearer': force bearerAuth
     * - 'bearer-or-grant': account Bearer OR a playback delivery grant in the query
     * - 'none': force no auth (e.g. public discovery)
     */
    auth?: 'bearer' | 'bearer-or-grant' | 'none';
}

/**
 * SPEC/DOC VISIBILITY for a route — does NOT affect routing or auth.
 *
 * This is the SINGLE mechanism the spec generator reads to decide which
 * published spec a route lands in. It is consumed identically for BOTH
 * def-backed routes (feed it via `visibilityFromDef(def)`) and bespoke/legacy
 * `+server.ts` routes (set it as a literal on their `_openapi.ts` `route`
 * export). Every route stays mounted on `/api/v1/*` and reachable as today.
 *
 *  - `'public'`   (default) → published `docs/api/api-v1.yaml`
 *  - `'internal'` → `docs/api/internal-api.yaml`
 */
export type Visibility = 'public' | 'internal';

/**
 * Route metadata export shape. HTTP-method keys carry per-method OpenAPI
 * metadata; route-level `visibility` defaults to `'public'`. Methods may override
 * it so public reads and internal writes on the same path land in separate specs.
 */
export type RouteMetadata = Partial<
    Record<'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD', MethodMetadata>
> & {
    /**
     * SPEC/DOC visibility for this route. Omit (or `'public'`) to publish to
     * the external `api-v1.yaml`; set `'internal'` to route it to
     * `internal-api.yaml` instead. Does NOT change routing or auth.
     */
    visibility?: Visibility;
};

// NOTE: `requestFromDef()` and `visibilityFromDef()` were removed once the spec
// generator began importing defs directly (it reads `def.request`/`def.docs`/
// `def.visibility` itself via scripts/openapi). Route metadata now lives in the
// def's `docs` slot, not a colocated `_openapi.ts`, so these bridge helpers are
// obsolete.
