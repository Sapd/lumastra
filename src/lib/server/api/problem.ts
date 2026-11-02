// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * problem.ts — application/problem+json response contract.
 *
 * One coherent contract for envelope + errors + pagination:
 *
 *  - problem(code, opts)      → RFC 7807 / problem+json Response
 *  - paginate(items, page)    → { items, page } collection envelope
 *  - ApiProblem.*             → named shortcuts
 *
 * The `code` field is the machine-parseable contract; `error` text is
 * human/localizable and MUST NOT be parsed by clients.
 *
 * Design notes:
 * - `timestamp` is dropped: use the HTTP `Date` response header instead.
 * - `success: true/false` wrapper is not used.
 * - `requestId` is optional; routes may attach it when one is available.
 * - `retryAfter` is seconds (integer), mapped to both the body and the
 *   `Retry-After` HTTP header.
 */

import { json } from '@sveltejs/kit';
import type { PlaybackRefusalDetails } from '$lib/schemas/playback-refusal.js';
import {
    LIVETV_FAILURE_POLICY,
    type LiveTvFailureReason,
} from '../../../shared/livetv-failure-reason.js';

// ---------------------------------------------------------------------------
// Code taxonomy (closed — add new codes via PR + changelog)
// ---------------------------------------------------------------------------

/**
 * Closed string taxonomy for the `code` field in problem+json responses.
 *
 * Every error that leaves the server MUST carry one of these codes.
 * Clients SHOULD switch on `code`, not `status` or `error` text.
 *
 * HTTP status mapping (informational — the actual status is in the Response):
 *   401  unauthorized, invalid_token, invalid_grant
 *   403  forbidden, scope_required, ip_mismatch
 *   404  not_found
 *   409  conflict
 *   410  gone, route_retired
 *   413  payload_too_large
 *   422  validation_failed, stream_limit (VOD start)
 *   429  rate_limited
 *   500  internal_error
 *   502  bad_gateway, channel_offline, provider_auth_failed, geo_blocked, no_video, all_feeds_failed, upstream_stalled
 *   503  dependency_unavailable, server_id_unavailable, shutting_down, stream_limit, cap_unavailable, provider_connection_limit
 *   504  provider_unreachable
 */
export type ProblemCode =
    | 'unauthorized' // 401 — no credential or session
    | 'invalid_token' // 401 — credential present but invalid/expired
    | 'invalid_grant' // 401 — playback grant (?grant=) invalid, expired, revoked or its session ended
    | 'ip_mismatch' // 403 — IP-pinned playback grant used from another network address
    | 'forbidden' // 403 — authenticated but lacking permission
    | 'scope_required' // 403 — token present but scope insufficient
    | 'not_found' // 404 — resource does not exist (or feature is off)
    | 'conflict' // 409 — resource exists / operation in-flight
    | 'gone' // 410 — resource permanently removed
    | 'route_retired' // 410 — the path was retired by a breaking API cutover; use the replacement URL
    | 'payload_too_large' // 413 — request body exceeds the endpoint's size cap
    | 'validation_failed' // 422 — request syntactically valid but semantically wrong
    | 'quota_exceeded' // 422 — request quota exhausted for the bucket
    | 'rate_limited' // 429 — too many requests
    | 'internal_error' // 500 — unhandled server error
    | 'bad_gateway' // 502 — upstream returned an unexpected error
    | 'server_id_unavailable' // 503 — persistent discovery identity unavailable
    | 'dependency_unavailable' // 503 — required dependency (DB, Valkey, external API) is down
    | 'shutting_down' // 503 — this server process is stopping (rolling update); retry after Retry-After
    | 'stream_limit' // 503 Live / 422 VOD start — stream slot capacity full
    | 'transcode_not_allowed'
    | 'source_incompatible'
    | 'ip_restricted'
    | 'prefetch_requires_current_session'
    | 'plugin_denied'
    | 'cap_unavailable' // 503 — requested Live TV bitrate ceiling could not be honored
    // Live TV failure taxonomy (src/shared/livetv-failure-reason.ts); status per LIVETV_FAILURE_POLICY.
    | 'channel_offline' // 502 — upstream 404/410, empty playlist, no data before the first segment
    | 'provider_auth_failed' // 502 — upstream 401/403
    | 'provider_connection_limit' // 503 — the provider's own connection limit
    | 'provider_unreachable' // 504 — DNS/connect/TLS/timeout/5xx or URL blocked
    | 'geo_blocked' // 502 — upstream 451 or geo 403
    | 'no_video' // 502 — neither video nor audio, or no compatible decoder
    | 'encoder_failed' // 500 — our transcode/egress FFmpeg died or could not spawn
    | 'all_feeds_failed' // 502 — every URL of the station failed
    | 'upstream_stalled'; // 502 — the source stopped after segments were produced

// ---------------------------------------------------------------------------
// Problem body shape
// ---------------------------------------------------------------------------

/**
 * Structured detail for validation errors.
 */
export interface ValidationDetail {
    field: string;
    message: string;
    value?: unknown;
}

/**
 * Structured detail for quota_exceeded errors.
 *
 * Clients should switch on the `bucket` field to surface the correct
 * per-bucket copy.  `limit` and `used` are raw integers; `remaining`
 * is `null` when the quota is unlimited (limit === 0).
 */
export interface QuotaDetail {
    bucket: string;
    limit: number;
    used: number;
    remaining: number | null;
}

export interface WindowSpanDetail {
    maxSpanSeconds: number;
}

/**
 * The problem+json body shape.
 *
 * `code` is the stable contract identifier.
 * `error` is a human-readable description — treat as display text only.
 * `status` mirrors the HTTP status code for clients that parse the body.
 * `details` carries structured data (e.g. field-level validation errors or
 *   quota info for quota_exceeded responses).
 * `requestId` is optional — attach when a correlation ID is available.
 * `retryAfter` is seconds until the client may retry (maps to Retry-After header).
 */
export interface ProblemBody {
    code: ProblemCode;
    error: string;
    status: number;
    details?: ValidationDetail[] | QuotaDetail | WindowSpanDetail | PlaybackRefusalDetails | string;
    requestId?: string;
    retryAfter?: number;
    reason?: string;
    /** Live TV failures: the extension object next to the standard members. */
    failure?: LiveTvFailureExtension;
}

/**
 * The `failure` extension member of a Live TV problem. `retryable` false means do not retry
 * automatically; `feedsTried` reaches administrators only. The wait before a retry is the
 * standard `retryAfter` (seconds) and the `Retry-After` header.
 */
export interface LiveTvFailureExtension {
    retryable: boolean;
    feedsTried?: LiveTvFeedTried[];
}

/** One feed of a station that failed. Ids and names only, never URLs, hosts or credentials. */
export interface LiveTvFeedTried {
    feedId?: string;
    feedName?: string;
    reason: LiveTvFailureReason;
    upstreamStatus?: number;
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

export interface ProblemOptions {
    /** Human-readable description. Defaults to a sensible message per code. */
    error?: string;
    /** Structured details (validation errors, quota info) or a freeform string. */
    details?: ValidationDetail[] | QuotaDetail | WindowSpanDetail | PlaybackRefusalDetails | string;
    /** Request correlation ID. */
    requestId?: string;
    /** Retry-After in seconds. Emitted as both body field and HTTP header. */
    retryAfter?: number;
    reason?: string;
    /** Live TV failures: whether to retry, and (admins only) how each feed failed. */
    failure?: LiveTvFailureExtension;
    /** Additional headers to include in the Response. */
    headers?: Record<string, string>;
    /**
     * Explicit HTTP status override.
     *
     * By default the status is derived from `code` via {@link STATUS_FOR_CODE}.
     * This escape hatch lets a caller emit the problem+json body under a
     * DIFFERENT HTTP status without changing the code→status default for any
     * other caller. It exists for the legacy {@link ApiResponses} shim, which
     * must PRESERVE its historical HTTP statuses (e.g. validation errors at
     * 400, not the taxonomy default of 422) while still emitting problem+json.
     *
     * The override applies to both the HTTP Response status and the `status`
     * field mirrored into the problem body, so the two never disagree.
     *
     * /api/v1 routes MUST NOT use this — they rely on the canonical
     * code→status mapping.
     */
    status?: number;
}

/** Default human-readable message per code. Override via `opts.error`. */
const DEFAULT_MESSAGES: Record<ProblemCode, string> = {
    unauthorized: 'Authentication required',
    invalid_token: 'Token is invalid or has expired',
    invalid_grant: 'Playback grant is invalid or has expired',
    ip_mismatch:
        'This playback grant is pinned to the network address that started playback; start with castTarget: true to play from another address',
    forbidden: 'Insufficient permissions',
    scope_required: 'Token does not have the required scope',
    not_found: 'Resource not found',
    conflict: 'Resource already exists or operation is already in progress',
    gone: 'Resource has been permanently removed',
    route_retired: 'This route was retired; use the replacement URL named in the API docs',
    payload_too_large: 'Request body exceeds the maximum size allowed for this endpoint',
    validation_failed: 'Request validation failed',
    quota_exceeded: 'Request quota exceeded for this period',
    rate_limited: 'Too many requests — please slow down',
    internal_error: 'An unexpected server error occurred',
    bad_gateway: 'Upstream service returned an unexpected response',
    server_id_unavailable: 'Persistent server identity is currently unavailable',
    dependency_unavailable: 'A required dependency is currently unavailable',
    shutting_down: 'The server is restarting; retry shortly',
    transcode_not_allowed: 'Transcoding is not allowed',
    source_incompatible: 'Source is incompatible with this client',
    ip_restricted: 'Playback is restricted to one IP',
    prefetch_requires_current_session: 'Prefetch requires an admitted active or paused session on this device; start normal playback instead',
    plugin_denied: 'Playback was refused by a plugin',
    stream_limit: 'Stream slot limit reached — no viewer slot available',
    cap_unavailable: 'Requested Live TV bitrate cap is unavailable',
    channel_offline: 'This channel is offline',
    provider_auth_failed: 'The provider rejected the credentials for this channel',
    provider_connection_limit: 'The provider has no free connection for this channel right now',
    provider_unreachable: 'The provider could not be reached',
    geo_blocked: 'The provider blocks this channel in the server region',
    no_video: 'The channel carries no playable video or audio',
    encoder_failed: 'The server could not encode this channel',
    all_feeds_failed: 'Every feed of this channel failed',
    upstream_stalled: 'The channel stopped delivering video',
};

/**
 * HTTP status code per problem code. Exported so the OpenAPI generator's
 * `PROBLEM_CODES` list can be checked against the runtime taxonomy.
 */
export const STATUS_FOR_CODE: Record<ProblemCode, number> = {
    unauthorized: 401,
    invalid_token: 401,
    invalid_grant: 401,
    ip_mismatch: 403,
    forbidden: 403,
    scope_required: 403,
    not_found: 404,
    conflict: 409,
    gone: 410,
    route_retired: 410,
    payload_too_large: 413,
    validation_failed: 422,
    quota_exceeded: 422,
    rate_limited: 429,
    internal_error: 500,
    bad_gateway: 502,
    server_id_unavailable: 503,
    dependency_unavailable: 503,
    shutting_down: 503,
    stream_limit: 503,
    transcode_not_allowed: 422,
    source_incompatible: 422,
    ip_restricted: 422,
    plugin_denied: 422,
    prefetch_requires_current_session: 422,
    cap_unavailable: 503,
    channel_offline: LIVETV_FAILURE_POLICY.channel_offline.status,
    provider_auth_failed: LIVETV_FAILURE_POLICY.provider_auth_failed.status,
    provider_connection_limit: LIVETV_FAILURE_POLICY.provider_connection_limit.status,
    provider_unreachable: LIVETV_FAILURE_POLICY.provider_unreachable.status,
    geo_blocked: LIVETV_FAILURE_POLICY.geo_blocked.status,
    no_video: LIVETV_FAILURE_POLICY.no_video.status,
    encoder_failed: LIVETV_FAILURE_POLICY.encoder_failed.status,
    all_feeds_failed: LIVETV_FAILURE_POLICY.all_feeds_failed.status,
    upstream_stalled: LIVETV_FAILURE_POLICY.upstream_stalled.status,
};

/**
 * Build an `application/problem+json` Response.
 *
 * This is the SINGLE entry-point for all error responses on the /api/v1
 * surface. Every `ApiProblem.*` shortcut below calls this function.
 *
 * @example
 * return problem('not_found', { error: 'Series not found' });
 * return problem('validation_failed', { details: [{ field: 'limit', message: 'Must be > 0' }] });
 * return problem('rate_limited', { retryAfter: 60 });
 */
export function problem(code: ProblemCode, opts: ProblemOptions = {}): Response {
    const status = opts.status ?? STATUS_FOR_CODE[code];
    const body: ProblemBody = {
        code,
        error: opts.error ?? DEFAULT_MESSAGES[code],
        status,
    };

    if (opts.reason !== undefined) body.reason = opts.reason;
    if (opts.details !== undefined) body.details = opts.details;
    if (opts.requestId !== undefined) body.requestId = opts.requestId;
    if (opts.retryAfter !== undefined) body.retryAfter = opts.retryAfter;
    if (opts.failure !== undefined) body.failure = opts.failure;

    const headers: Record<string, string> = {
        'Content-Type': 'application/problem+json',
        ...opts.headers,
    };
    if (opts.retryAfter !== undefined) {
        headers['Retry-After'] = String(opts.retryAfter);
    }

    return json(body, { status, headers });
}

/**
 * Build the problem+json for a typed Live TV failure.
 *
 * `code` is the taxonomy reason, the HTTP status comes from LIVETV_FAILURE_POLICY unless
 * `status` overrides it (an ended session answers 410). `retryAfterMs` (the policy's unit) is sent
 * as `retryAfter` in seconds, rounded up, plus the `Retry-After` header. `retryable` and
 * `feedsTried` go in the `failure` extension; `feedsTried` reaches admins only.
 */
export function liveTvFailureProblem(input: {
    reason: LiveTvFailureReason;
    retryable: boolean;
    retryAfterMs?: number;
    feedsTried?: LiveTvFeedTried[];
    isAdmin: boolean;
    error?: string;
    /** Overrides the policy status, e.g. 410 for an ended session. */
    status?: number;
    /** Extra body field `reason` (e.g. `failed` on a keepalive 410). */
    detailReason?: string;
}): Response {
    const feedsTried =
        input.isAdmin && input.feedsTried && input.feedsTried.length > 0
            ? input.feedsTried
            : undefined;
    return problem(input.reason, {
        error: input.error,
        status: input.status ?? LIVETV_FAILURE_POLICY[input.reason].status,
        failure: { retryable: input.retryable, ...(feedsTried ? { feedsTried } : {}) },
        ...(input.retryAfterMs !== undefined
            ? { retryAfter: Math.ceil(input.retryAfterMs / 1000) }
            : {}),
        ...(input.detailReason ? { reason: input.detailReason } : {}),
    });
}

// ---------------------------------------------------------------------------
// Collection envelope
// ---------------------------------------------------------------------------

/**
 * Pagination block that every collection response MUST include.
 *
 * `hasMore` is mandatory and drives infinite scroll without a COUNT query.
 * `total` is opt-in — only include when cheap (e.g. bounded) or explicitly
 * requested via `?count=true`.
 *
 * `offset` and `nextCursor` are the two live paging mechanisms and are mutually
 * exclusive *as the mechanism driving a given request*: a request is served
 * either by offset or by cursor, never both.
 *
 * Bootstrap exception (Gate J1): a cursor-eligible feed may additionally emit
 * `nextCursor` on an *offset*-mode response as a forward bootstrap value — the
 * server-minted cursor a client hands back to switch into keyset paging. Such a
 * response carries both `offset` (the mechanism that produced this page) and
 * `nextCursor` (a handoff token for the *next* request). This is not "both
 * mechanisms live for this request"; `offset` alone produced it.
 */
export interface PageBlock {
    limit: number;
    /** Offset-based paging — for stable, filterable collections. */
    offset?: number;
    /** Cursor-based paging — for high-churn / large stably-ordered streams. */
    nextCursor?: string;
    /** True when there are more items after this page. */
    hasMore: boolean;
    /** Total matching items — only include when cheap or explicitly requested. */
    total?: number;
}

/**
 * Canonical collection envelope returned by all paginated endpoints.
 */
export interface PagedResponse<T> {
    items: T[];
    page: PageBlock;
}

/**
 * Build the standard `{ items, page }` collection envelope.
 *
 * The caller is responsible for computing `hasMore` (typically by fetching
 * `limit + 1` items and checking whether the result set exceeds `limit`).
 *
 * @example — offset paging:
 * const rows = await db.query({ limit: limit + 1, offset });
 * const hasMore = rows.length > limit;
 * return json(paginate(rows.slice(0, limit), { limit, offset, hasMore }));
 *
 * @example — cursor paging:
 * const rows = await db.query({ limit: limit + 1, after: cursor });
 * const hasMore = rows.length > limit;
 * const nextCursor = hasMore ? encodeCursor(rows[limit - 1]) : undefined;
 * return json(paginate(rows.slice(0, limit), { limit, nextCursor, hasMore }));
 */
export function paginate<T>(items: T[], page: PageBlock): PagedResponse<T> {
    return { items, page };
}

// ---------------------------------------------------------------------------
// Throwable dependency-down signal
// ---------------------------------------------------------------------------

/** A forced refresh must reach mount as a 429, never an empty recommendation rail. */
export class AISuggestionRateLimitError extends Error {
    readonly statusCode = 429;
    constructor(readonly retryAfter: number) {
        super('AI suggestion rate limit exceeded');
    }
}

/**
 * Throwable signal that a required dependency (DB, Valkey, AI store, external
 * API) is DOWN.
 *
 * This is the throwable counterpart to `ApiProblem.dependencyUnavailable()`
 * (which builds a Response). Use it in layers that produce *values*, not
 * Responses — e.g. recommender strategies — so a dependency-down condition is
 * SIGNALLED rather than conflated with a genuine-empty result (`items: []`).
 *
 * Contract:
 * - A producer (strategy/service) `throw`s this on `!sql` / a real dependency
 *   failure — it MUST NOT swallow to an empty collection.
 * - Tier-2 data-plane endpoints let it propagate and map it to a
 *   `503 dependency_unavailable` problem+json via
 *   `ApiProblem.dependencyUnavailable()`.
 * - Fault-isolating aggregators (e.g. the /feed SDUI compositor) CATCH it
 *   per-section and drop only that section — the aggregate response stays 200.
 *
 * NEVER return 200-with-empty-array for a dependency failure.
 */
export class DependencyUnavailableError extends Error {
    /** Brand for cross-realm/duck-typed identification (survives bundling). */
    readonly isDependencyUnavailable = true as const;
    /** Optional dependency label for logs (e.g. 'postgres', 'valkey', 'ai-db'). */
    readonly dependency?: string;

    constructor(message = 'A required dependency is currently unavailable', dependency?: string) {
        super(message);
        this.name = 'DependencyUnavailableError';
        this.dependency = dependency;
        // Restore prototype chain for `instanceof` across transpilation targets.
        Object.setPrototypeOf(this, DependencyUnavailableError.prototype);
    }
}

/**
 * Type guard for a thrown dependency-down signal.
 *
 * Matches both real `DependencyUnavailableError` instances and any duck-typed
 * object carrying the `isDependencyUnavailable` brand (robust across module
 * realms / bundling boundaries).
 */
export function isDependencyUnavailable(err: unknown): err is DependencyUnavailableError {
    return (
        err instanceof DependencyUnavailableError ||
        (typeof err === 'object' &&
            err !== null &&
            (err as { isDependencyUnavailable?: unknown }).isDependencyUnavailable === true)
    );
}

// ---------------------------------------------------------------------------
// Named shortcuts (re-aliases for ApiResponses.* error methods)
// ---------------------------------------------------------------------------

/**
 * Named error response shortcuts.
 *
 * These are convenience wrappers over `problem()`.
 *
 * Import as a namespace:
 * ```ts
 * import { ApiProblem } from '$lib/server/api/problem.js';
 * return ApiProblem.unauthorized();
 * return ApiProblem.notFound('Series not found');
 * ```
 */
export const ApiProblem = {
    /** 401 — no credential present. */
    unauthorized(error?: string, opts?: Omit<ProblemOptions, 'error'>): Response {
        return problem('unauthorized', { error, ...opts });
    },

    /** 401 — credential present but invalid or expired. */
    invalidToken(error?: string, opts?: Omit<ProblemOptions, 'error'>): Response {
        return problem('invalid_token', { error, ...opts });
    },

    /** 403 — authenticated but lacking permission. */
    forbidden(error?: string, opts?: Omit<ProblemOptions, 'error'>): Response {
        return problem('forbidden', { error, ...opts });
    },

    /** 403 — token present but required scope not granted. */
    scopeRequired(anyOf: string[], opts?: Omit<ProblemOptions, 'error'>): Response {
        return problem('scope_required', {
            error: `Token does not have the required scope. Required one of: ${anyOf.join(', ')}`,
            ...opts,
        });
    },

    /** 404 — resource does not exist (or feature is disabled). */
    notFound(error?: string, opts?: Omit<ProblemOptions, 'error'>): Response {
        return problem('not_found', { error, ...opts });
    },

    /** 409 — resource already exists or conflicting operation in-flight. */
    conflict(error?: string, opts?: Omit<ProblemOptions, 'error'>): Response {
        return problem('conflict', { error, ...opts });
    },

    /** 410 — resource permanently removed. */
    gone(error?: string, opts?: Omit<ProblemOptions, 'error'>): Response {
        return problem('gone', { error, ...opts });
    },

    /** 413 — request body exceeds the endpoint's size cap. */
    payloadTooLarge(error?: string, opts?: Omit<ProblemOptions, 'error'>): Response {
        return problem('payload_too_large', { error, ...opts });
    },

    /**
     * 422 — request validation failed.
     *
     * Pass an array of {@link ValidationDetail} for field-level errors → carried
     * in the structured `details` field. Pass a plain string for a freeform
     * human reason → promoted to the top-level `error` field, because that is
     * the field clients surface (they read `detail`/`error`/`title`, never the
     * structured `details`). Passing a reason only into `details` is why such
     * messages used to vanish behind the generic "Request validation failed".
     * An explicit `opts.error` always wins.
     */
    validationFailed(
        details: ValidationDetail[] | string,
        opts?: Omit<ProblemOptions, 'details'>,
    ): Response {
        if (typeof details === 'string') {
            return problem('validation_failed', { ...opts, error: opts?.error ?? details });
        }
        return problem('validation_failed', { details, ...opts });
    },

    /**
     * 422 — request quota exceeded for a bucket (`movie` or `series`).
     *
     * Pass `details` as a {@link QuotaDetail} object so clients can render
     * per-bucket copy without parsing the human-readable `error` string.
     * A plain string is accepted for backwards-compatibility but structured
     * details are strongly preferred.
     */
    quotaExceeded(
        details?: ValidationDetail[] | QuotaDetail | string,
        opts?: Omit<ProblemOptions, 'details'>,
    ): Response {
        return problem('quota_exceeded', { details, ...opts });
    },

    /**
     * 429 — rate limited.
     * `retryAfter` is seconds until the client may retry.
     */
    rateLimited(retryAfter?: number, opts?: Omit<ProblemOptions, 'retryAfter'>): Response {
        return problem('rate_limited', { retryAfter, ...opts });
    },

    /** 500 — internal server error. */
    internalError(error?: string, opts?: Omit<ProblemOptions, 'error'>): Response {
        return problem('internal_error', { error, ...opts });
    },

    /** 502 — upstream returned an unexpected response. */
    badGateway(error?: string, opts?: Omit<ProblemOptions, 'error'>): Response {
        return problem('bad_gateway', { error, ...opts });
    },

    /**
     * 503 — a required dependency is unavailable.
     * Use this for DB-down, Valkey-down, external API failures.
     * NEVER return 200-with-empty-array for dependency failures.
     */
    dependencyUnavailable(error?: string, opts?: Omit<ProblemOptions, 'error'>): Response {
        return problem('dependency_unavailable', { error, ...opts });
    },

    /**
     * 503 — live-TV stream slot limit reached.
     * Distinct from `rate_limited` (429): this is a capacity constraint, not a
     * per-client request-rate violation.  HLS players / tvOS treat 503+Retry-After
     * as "capacity full, back off and retry" rather than "you are sending too fast".
     * `retryAfter` is seconds until a slot may be available.
     */
    streamLimit(retryAfter?: number, opts?: Omit<ProblemOptions, 'retryAfter'>): Response {
        return problem('stream_limit', { retryAfter, ...opts });
    },
} as const;
