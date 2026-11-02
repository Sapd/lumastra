// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Core typed API client with Zod validation
 *
 * Combines the best of existing wrappers:
 * - Auth monitoring from monitoredFetch (auth-monitor.ts)
 * - Base path prefixing from url() (paths.ts)
 * - Timeout + abort support
 * - Consistent ApiResult<T> return type
 * - Zod schema validation for type-safe responses
 *
 * monitoredFetch already calls url() internally, so we pass endpoints directly.
 */

import { type z, type ZodType, type ZodObject } from 'zod';
import { monitoredFetch, handleAuthExpiration } from '$lib/auth-monitor.js';
import { browser, dev } from '$app/environment';
import type { ApiResult, ApiRequestOptions } from './types.js';
import { apiUrl, appPath } from '$lib/shared/api-urls.js';
import { reportApiContractMismatch } from './contract-reporter.js';
import { reportApiFailure } from '$lib/client-diagnostics/web-reporter.js';
import { diagnosticPathTemplate } from '$lib/client-diagnostics/route-template.js';
import { signalRunStartedIfPresent } from './run-started-signal.js';

/**
 * Apply `.strict()` so an undeclared field is REPORTED instead of silently
 * stripped. Schemas that deliberately accept extras (`.passthrough()` /
 * `z.looseObject`) are left alone.
 *
 * ## This was a no-op for the whole Zod-4 era
 *
 * The old implementation gated on `schema._def.unknownKeys === 'strip'`. Zod 3
 * carried that discriminator; Zod 4 does not — measured on the installed 4.3.6,
 * `z.object({...})._def.unknownKeys` is `undefined`, so the branch never ran and
 * `.strict()` was never applied to anything. The failure mode was therefore not
 * "a mismatch gets reported" but **a silent field strip**: an undeclared field
 * (and any extra top-level key) was deleted from the parsed result with no
 * warning, no `reportSchemaMismatchProd`, and a perfectly typed value handed to
 * the caller. Every field a client schema forgot to declare simply vanished.
 *
 * Zod 4's discriminator is the `catchall` on the internal def: absent for a
 * stripping object, `ZodUnknown` for passthrough/loose, `ZodNever` for strict
 * (all three measured). That is what this reads now.
 *
 * ## TOP LEVEL ONLY
 *
 * `.strict()` in Zod 4 constrains the outer object and nothing beneath it —
 * measured: `z.object({arr: z.array(z.object({a}))}).strict()` still strips an
 * extra key inside `arr[0]`. So a nested item shape that drifts is still a silent
 * strip, and the only real protection there is reusing ONE schema between the
 * server response and the client parse rather than keeping a private copy.
 */
function toStrict<S extends ZodType>(schema: S): S {
    const def = (schema as unknown as { _zod?: { def?: { catchall?: unknown } } })._zod?.def;
    // Not an object schema (no shape to constrain), or an object that opted into
    // extras. `catchall` is set on exactly the latter.
    if (def === undefined || !('shape' in (schema as object)) || def.catchall !== undefined) {
        return schema;
    }
    return (schema as unknown as ZodObject<never>).strict() as unknown as S;
}

let strictOverride: boolean | undefined;

export function isApiContractStrict(): boolean {
    return strictOverride ?? __API_CONTRACT_STRICT__;
}

export function setApiContractStrictForTests(value: boolean | undefined): void {
    strictOverride = value;
}

export class ApiContractError extends Error {
    readonly endpoint: string;
    readonly method: string;
    readonly status: number;
    readonly issues: { path: string; message: string }[];

    constructor(endpoint: string, method: string, status: number, error: z.ZodError) {
        const route = diagnosticPathTemplate(appPath(endpoint));
        super(`API contract mismatch: ${method} ${route} (${status})`);
        this.name = 'ApiContractError';
        this.endpoint = route;
        this.method = method;
        this.status = status;
        this.issues = error.issues.slice(0, 5).map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
        }));
    }
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * In-flight GET coalescing.
 *
 * The dashboard mounts many independent components that each request the same
 * endpoint on load (e.g. several widgets pulling the same `/api/...` resource).
 * Without coalescing every one of them opens its own connection to the backend
 * during the initial burst. Keyed by final URL, concurrent identical GETs share
 * a SINGLE network request; the entry is evicted the moment the response
 * settles, so this only ever merges genuinely-concurrent duplicates — a request
 * issued after the first has resolved re-fetches fresh (no stale caching).
 *
 * Correctness: each caller reads its OWN `response.clone()` and validates with
 * its OWN schema, so a shared request can never leak one caller's parsed/
 * validated result to another. Only plain GETs are coalesced — requests with a
 * caller-supplied `signal`, custom `headers`, or a body opt out (they may carry
 * per-caller intent the shared request wouldn't honour).
 */
const inflightGets = new Map<string, Promise<Response>>();

/** Fire-and-forget: send client-side schema errors to server log in dev mode */
function reportClientError(endpoint: string, type: string, errors: unknown): void {
    if (!dev || !browser) return;
    try {
        navigator.sendBeacon(
            apiUrl('internal', '/dev/client-errors'),
            JSON.stringify({
                endpoint,
                type,
                errors,
                timestamp: new Date().toISOString(),
            }),
        );
    } catch {
        // Swallow — reporting must never break the app
    }
}

/** Throttle window for the prod-safe schema-mismatch signal, keyed per endpoint+type. */
const SCHEMA_WARN_THROTTLE_MS = 60_000;
const lastSchemaWarnAt = new Map<string, number>();

/**
 * Prod-safe signal for schema drift on a fail-open validation mismatch.
 *
 * `reportClientError` above only fires in dev+browser, so schema drift is
 * currently invisible once deployed. This runs everywhere (dev and prod,
 * server and browser) so on-call has a signal without changing the fail-open
 * data-return contract. Throttled per endpoint+type to avoid log spam, and
 * only logs the endpoint, schema name, and a short issue summary — never the
 * response payload (may contain PII).
 */
function reportSchemaMismatchProd<S extends ZodType>(
    endpoint: string,
    type: string,
    schema: S,
    error: z.ZodError,
): void {
    const key = `${type}:${endpoint}`;
    const now = Date.now();
    const last = lastSchemaWarnAt.get(key);
    if (last !== undefined && now - last < SCHEMA_WARN_THROTTLE_MS) return;
    lastSchemaWarnAt.set(key, now);

    const schemaName = schema.description ?? schema.constructor.name;
    const issues = error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);
    console.warn(
        `[API] schema mismatch endpoint=${endpoint} type=${type} schema=${schemaName} issues=${error.issues.length}`,
        issues,
    );
}

/** Build URL with query parameters */
function buildUrl(
    endpoint: string,
    params?: Record<string, string | number | boolean | undefined>,
): string {
    if (!params) return endpoint;

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            searchParams.set(key, String(value));
        }
    }

    const qs = searchParams.toString();
    if (!qs) return endpoint;

    const separator = endpoint.includes('?') ? '&' : '?';
    return `${endpoint}${separator}${qs}`;
}

/**
 * Parsed error information extracted from a non-ok Response.
 *
 * Supports both application/problem+json (RFC 7807) and the legacy
 * {success:false, error, timestamp} envelope so both shapes work
 * without forcing a hard cutover.
 *
 * Field precedence for the human-readable message:
 *   problem+json:  detail  → error  → title  → HTTP {status}
 *   legacy:        error   → message         → HTTP {status}
 */
interface ParsedErrorResponse {
    message: string;
    /** Stable machine code from problem+json (`code` field). Undefined for legacy responses. */
    code?: string;
    /**
     * Structured detail payload, when the response body carries one (problem+json
     * `details` field, or the legacy envelope's `details`/`data` field). Passed
     * through verbatim — see `ApiResult.details` for shape caveats.
     */
    details?: unknown;
    /** problem+json `requestId`, for diagnostics only. */
    requestId?: string;
    retryAfterMs?: number;
}

/** Parse error message from a non-ok Response */
async function parseErrorResponse(response: Response): Promise<ParsedErrorResponse> {
    // Preserve the server delay even for a non-JSON proxy error body.
    const retryHeader = response.headers.get('retry-after');
    const seconds = retryHeader?.trim() ? Number(retryHeader) : NaN;
    const date = retryHeader && !Number.isFinite(seconds) ? Date.parse(retryHeader) : NaN;
    const headerRetryAfterMs =
        Number.isFinite(seconds) && seconds >= 0
            ? seconds * 1000
            : Number.isFinite(date)
              ? Math.max(0, date - Date.now())
              : undefined;
    try {
        const data = (await response.json()) as {
            // problem+json fields (RFC 7807 + our extension)
            code?: string;
            error?: string;
            detail?: string;
            title?: string;
            details?: unknown;
            requestId?: unknown;
            retryAfter?: unknown;
            // legacy envelope fields
            message?: string;
        };

        const isProblem = response.headers
            .get('content-type')
            ?.includes('application/problem+json');

        const retryAfterMs =
            headerRetryAfterMs ??
            (typeof data.retryAfter === 'number' &&
            Number.isFinite(data.retryAfter) &&
            data.retryAfter >= 0
                ? data.retryAfter * 1000
                : undefined);

        if (isProblem) {
            // problem+json: prefer the specific human text, fall back to title
            const message = data.detail ?? data.error ?? data.title ?? `HTTP ${response.status}`;
            return {
                message,
                code: data.code,
                details: data.details,
                ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
                ...(typeof data.requestId === 'string' ? { requestId: data.requestId } : {}),
            };
        }

        // Legacy envelope: {success:false, error, message, timestamp}
        const message = data.error ?? data.message ?? `HTTP ${response.status}`;
        return {
            message,
            details: data.details,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        };
    } catch {
        // best-effort: non-JSON error body → fall back to statusText / status code.
        return {
            message: response.statusText || `HTTP ${response.status}`,
            ...(headerRetryAfterMs !== undefined ? { retryAfterMs: headerRetryAfterMs } : {}),
        };
    }
}

/**
 * Check response body for auth error signals on otherwise-ok responses.
 *
 * The primary auth-failure path is HTTP 401/403 status (handled by
 * `monitoredFetch` / `reportApiCall` in auth-monitor.ts and by the
 * `!response.ok` branch below).  This function covers the legacy edge-case
 * where a route returned HTTP 200 with `error: "Authentication required"` in
 * the body — a pattern that no longer occurs once all routes emit proper
 * problem+json, but is kept for backward-compat during the transition.
 *
 * For problem+json responses we detect auth errors via the stable `code`
 * field (`unauthorized` / `invalid_token`) rather than string-matching the
 * human-readable `error` text.
 */
async function checkAuthErrorInBody(response: Response): Promise<Response> {
    // Short-circuit before touching headers: a non-browser context or a
    // mock/edge Response without a `headers` object must not throw here.
    if (!browser || !response.ok) {
        return response;
    }
    // Note: 'application/problem+json' does NOT contain the substring
    // 'application/json', so both variants must be checked explicitly or the
    // problem+json branch below is unreachable.
    const contentType = response.headers?.get('content-type') ?? '';
    const isJson =
        contentType.includes('application/json') ||
        contentType.includes('application/problem+json');

    if (!isJson) {
        return response;
    }

    const cloned = response.clone();
    try {
        const data = (await cloned.json()) as { error?: string; code?: string };

        if (contentType.includes('application/problem+json')) {
            // problem+json: use the stable code field
            if (data.code === 'unauthorized' || data.code === 'invalid_token') {
                void handleAuthExpiration();
            }
        } else {
            // Legacy envelope: string-match the human-readable error field
            if (
                typeof data?.error === 'string' &&
                (data.error.includes('Authentication required') ||
                    data.error.includes('No authentication headers'))
            ) {
                void handleAuthExpiration();
            }
        }
    } catch {
        // Ignore parse errors
    }
    return response;
}

/** Error message for a strict caller whose response did not match its schema. */
export const SCHEMA_MISMATCH_MESSAGE =
    'The server answered in a shape this page does not expect. Reload the page.';

/** The fail-closed result `options.strict` asks for: an error, never the raw payload. */
function schemaMismatch(validationError: z.ZodError, status: number): ApiResult<never> {
    return {
        data: null,
        error: SCHEMA_MISMATCH_MESSAGE,
        code: 'SCHEMA_MISMATCH',
        validationError,
        status,
    };
}

/** Core fetch implementation shared by all methods */
async function apiFetch<S extends ZodType>(
    endpoint: string,
    schema: S,
    init: RequestInit,
    options?: ApiRequestOptions,
): Promise<ApiResult<z.infer<S>>> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const url = buildUrl(endpoint, options?.params);

    const controller = new AbortController();
    let timeoutId = setTimeout(() => controller.abort(), timeout);
    const attemptLifecycle = {
        onAttempt: (): void => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => controller.abort(), timeout);
        },
        onResponse: (): void => clearTimeout(timeoutId),
    };

    // Combine external signal with timeout signal. Registered with
    // `{ once: true }` and always removed in `finally` below so a
    // long-lived/reused signal (e.g. shared across many sequential
    // apiFetch calls) doesn't accumulate listeners.
    const onExternalAbort = (): void => controller.abort();
    options?.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
        // Coalesce concurrent identical plain GETs onto one network request.
        // Opt out when the caller passes a signal, custom headers, a non-default
        // timeout, or a body — those may carry per-caller intent (e.g. a shorter
        // timeout) the shared request wouldn't honour for every participant.
        const canCoalesce =
            init.method === 'GET' &&
            !options?.signal &&
            options?.keepalive === undefined &&
            !options?.headers &&
            options?.timeout === undefined &&
            init.body == null;

        let response: Response;
        if (canCoalesce) {
            let shared = inflightGets.get(url);
            if (!shared) {
                shared = monitoredFetch(
                    url,
                    {
                        ...init,
                        headers: init.headers,
                        signal: controller.signal,
                    },
                    attemptLifecycle,
                );
                inflightGets.set(url, shared);
                // Evict as soon as the response settles (success OR failure) so a
                // later request re-fetches fresh rather than reusing a stale entry.
                void shared.then(
                    () => inflightGets.delete(url),
                    () => inflightGets.delete(url),
                );
            }
            // Clone so each coalesced caller reads the body independently and
            // validates against its own schema.
            response = (await shared).clone();
        } else {
            response = await monitoredFetch(
                url,
                {
                    ...init,
                    headers: {
                        ...init.headers,
                        ...options?.headers,
                    },
                    signal: controller.signal,
                    ...(options?.keepalive !== undefined ? { keepalive: options.keepalive } : {}),
                },
                attemptLifecycle,
            );
        }

        // Clear the abort timer as soon as headers arrive so body reading /
        // schema parsing below is not subject to the request timeout (preserves
        // pre-existing behavior). The `finally` clears it again idempotently.
        clearTimeout(timeoutId);

        await checkAuthErrorInBody(response);

        if (!response.ok) {
            const { message, code, details, requestId, retryAfterMs } =
                await parseErrorResponse(response);
            // 401 is the re-auth flow's to handle (monitoredFetch), not a failure to report.
            if (response.status !== 401) {
                reportApiFailure({
                    endpoint: url,
                    method: init.method ?? 'GET',
                    outcome: response.status >= 500 ? 'status_5xx' : 'status_4xx',
                    status: response.status,
                    problemCode: code,
                    requestId,
                });
            }
            return {
                data: null,
                error: message,
                code,
                details,
                status: response.status,
                ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            };
        }

        // Handle 204 No Content
        if (response.status === 204) {
            const effectiveSchema = toStrict(schema);
            const parseResult = effectiveSchema.safeParse(null);
            if (!parseResult.success) {
                reportSchemaMismatchProd(
                    endpoint,
                    '204-schema-mismatch',
                    effectiveSchema,
                    parseResult.error,
                );
                if (dev) {
                    const flat = parseResult.error.flatten();
                    console.warn(`[API] 204 schema mismatch: ${endpoint}`, flat);
                    reportClientError(endpoint, '204-schema-mismatch', flat);
                }
                reportApiContractMismatch(endpoint, init.method ?? 'GET', 204, parseResult.error);
                if (isApiContractStrict()) {
                    throw new ApiContractError(
                        endpoint,
                        init.method ?? 'GET',
                        204,
                        parseResult.error,
                    );
                }
                if (options?.strict) return schemaMismatch(parseResult.error, 204);
                return {
                    data: null as z.infer<S>,
                    error: null,
                    validationError: parseResult.error,
                    status: 204,
                };
            }
            return { data: parseResult.data, error: null, status: 204 };
        }

        const rawData: unknown = await response.json();
        if ((init.method ?? 'GET') !== 'GET') signalRunStartedIfPresent(rawData);

        // Validate response against schema.
        // toStrict() turns an undeclared TOP-LEVEL field into a reported mismatch
        // instead of a silent strip (see its doc — nested shapes are still
        // stripped, which is why response schemas should be shared, not copied).
        // Strict builds throw on drift; other builds preserve the fail-open result.
        const effectiveSchema = toStrict(schema);
        const parseResult = effectiveSchema.safeParse(rawData);

        if (!parseResult.success) {
            reportSchemaMismatchProd(
                endpoint,
                'schema-mismatch',
                effectiveSchema,
                parseResult.error,
            );
            if (dev) {
                const flat = parseResult.error.flatten();
                console.warn(`[API] Schema mismatch: ${endpoint}`, flat);
                reportClientError(endpoint, 'schema-mismatch', flat);
            }
            reportApiContractMismatch(
                endpoint,
                init.method ?? 'GET',
                response.status,
                parseResult.error,
            );
            if (isApiContractStrict()) {
                throw new ApiContractError(
                    endpoint,
                    init.method ?? 'GET',
                    response.status,
                    parseResult.error,
                );
            }
            if (options?.strict) return schemaMismatch(parseResult.error, response.status);
            // Fail-open: return raw data with validation error attached.
            // Consumers that check validationError can still detect the mismatch.
            return {
                data: rawData as z.infer<S>,
                error: null,
                validationError: parseResult.error,
                status: response.status,
            };
        }

        return { data: parseResult.data, error: null, status: response.status };
    } catch (err) {
        if (err instanceof ApiContractError) throw err;
        if (err instanceof DOMException && err.name === 'AbortError') {
            // The caller cancelling its own request (navigation, a newer search) is
            // not a failure; only our timeout is.
            if (!options?.signal?.aborted) {
                reportApiFailure({
                    endpoint: url,
                    method: init.method ?? 'GET',
                    outcome: 'timeout',
                });
            }
            return { data: null, error: 'Request timed out', status: 0 };
        }

        if (err instanceof DOMException && err.name === 'TimeoutError') {
            reportApiFailure({ endpoint: url, method: init.method ?? 'GET', outcome: 'timeout' });
        } else if (err instanceof TypeError) {
            // What fetch throws when the request never got an answer.
            reportApiFailure({ endpoint: url, method: init.method ?? 'GET', outcome: 'network' });
        } else if (err instanceof SyntaxError) {
            // A 2xx whose body is not JSON (an HTML error page from a proxy).
            reportApiFailure({
                endpoint: url,
                method: init.method ?? 'GET',
                outcome: 'decode',
                detail: 'invalid JSON',
            });
        }
        const message = err instanceof Error ? err.message : 'Unknown network error';
        return { data: null, error: message, status: 0 };
    } finally {
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener('abort', onExternalAbort);
    }
}

/** GET request with Zod schema validation */
export function apiGet<S extends ZodType>(
    endpoint: string,
    schema: S,
    options?: ApiRequestOptions,
): Promise<ApiResult<z.infer<S>>> {
    return apiFetch(endpoint, schema, { method: 'GET' }, options);
}

/** POST request with Zod schema validation */
export function apiPost<S extends ZodType, B = unknown>(
    endpoint: string,
    schema: S,
    body?: B,
    options?: ApiRequestOptions,
): Promise<ApiResult<z.infer<S>>> {
    const init: RequestInit = { method: 'POST' };
    if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
    }
    return apiFetch(endpoint, schema, init, options);
}

/** PUT request with Zod schema validation */
export function apiPut<S extends ZodType, B = unknown>(
    endpoint: string,
    schema: S,
    body?: B,
    options?: ApiRequestOptions,
): Promise<ApiResult<z.infer<S>>> {
    const init: RequestInit = { method: 'PUT' };
    if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
    }
    return apiFetch(endpoint, schema, init, options);
}

/** PATCH request with Zod schema validation */
export function apiPatch<S extends ZodType, B = unknown>(
    endpoint: string,
    schema: S,
    body?: B,
    options?: ApiRequestOptions,
): Promise<ApiResult<z.infer<S>>> {
    const init: RequestInit = { method: 'PATCH' };
    if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
    }
    return apiFetch(endpoint, schema, init, options);
}

/** POST request with FormData body (for file uploads) */
export function apiUpload<S extends ZodType>(
    endpoint: string,
    schema: S,
    formData: FormData,
    options?: ApiRequestOptions,
): Promise<ApiResult<z.infer<S>>> {
    // Don't set Content-Type — browser sets it with boundary automatically
    return apiFetch(endpoint, schema, { method: 'POST', body: formData }, options);
}

/** DELETE request with Zod schema validation */
export function apiDelete<S extends ZodType, B = unknown>(
    endpoint: string,
    schema: S,
    body?: B,
    options?: ApiRequestOptions,
): Promise<ApiResult<z.infer<S>>> {
    const init: RequestInit = { method: 'DELETE' };
    if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
    }
    return apiFetch(endpoint, schema, init, options);
}
