// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fetch utilities with timeout support
 * Prevents hanging requests to unresponsive external services
 */

import { countExternalCall, delegateExternalCallCounting } from './external-request-counter.js';
import { Logger } from './logger.js';

const logger = Logger.for('FetchUtils');

export class FetchTimeoutError extends Error {
    constructor(url: string, timeout: number) {
        super(`Request to ${url} timed out after ${timeout}ms`);
        this.name = 'FetchTimeoutError';
    }
}

/**
 * Thrown by {@link fetchWithTimeout} when a redirect fails the same-host
 * policy: a different hostname, OR the same hostname with a scheme
 * *downgrade* (`https:` → `http:`). Port is never compared — see
 * {@link isAllowedRedirectTarget} for the full rule (a same-host scheme
 * *upgrade*, `http:` → `https:`, on any port, is allowed and does NOT throw
 * this).
 *
 * Admin-configured integration clients (Sonarr/Radarr, Jellyseerr,
 * Kavita, Audiobookshelf, …) send credentials (API keys, bearer tokens) on
 * every request. Following an arbitrary redirect — the default `fetch`
 * behaviour — lets a compromised or misbehaving upstream 3xx the request
 * anywhere, including an internal address the app can reach but the caller
 * cannot (blind SSRF), or downgrade a request to plaintext on the same host.
 * Both are refused; only a same-host redirect that holds or upgrades scheme
 * is followed (C29 fix-plan finding; scheme/port policy corrected under the
 * C22 fix-plan review).
 *
 * The rule is evaluated against the *original* request URL on every hop, not
 * the current hop's URL — so `http:` → `https:` → `http:` is permitted (the
 * credential already went out in cleartext on hop 0, so the second downgrade
 * adds no new exposure). This is "relative to the original", not monotonic.
 *
 * The policy is also host-only, not host+port: a compromised admin-configured
 * host can still redirect a credentialed request to a *different port on the
 * same hostname* (e.g. `http://jellyfin.internal:8096` → `:22`). That is an
 * accepted residual surface of this rule (Task 11 standing policy — an
 * admin-configured host fronted by a reverse proxy on a different port must
 * keep working), not an oversight.
 */
/**
 * Why a {@link FetchRedirectError} was thrown. Stored on the instance (see
 * `reason` below) rather than only baked into the message string, so a
 * caller can tell the three cases apart by field — matching on a message
 * substring is exactly the fragile pattern collapsing the two
 * `FetchRedirectError` classes into one was meant to let callers stop doing.
 * `'cross-origin'` covers BOTH a different hostname and a same-host scheme
 * downgrade — see {@link isAllowedRedirectTarget}; it is not literally
 * "different origin" in the URL-spec sense once port-blindness and the
 * upgrade exception are accounted for.
 */
export type FetchRedirectReason = 'cross-origin' | 'unresendable-body' | 'redirect-limit-exceeded';

export class FetchRedirectError extends Error {
    constructor(
        host: string,
        public readonly reason: FetchRedirectReason = 'cross-origin',
    ) {
        super(
            reason === 'cross-origin'
                ? `refusing to follow cross-origin redirect to ${host}`
                : reason === 'unresendable-body'
                  ? `refusing to follow redirect to ${host}: request body cannot be resent (streamed body)`
                  : `redirect limit (${MAX_REDIRECTS}) exceeded while following redirects from ${host}`,
        );
        this.name = 'FetchRedirectError';
    }
}

/**
 * Maximum redirect hops {@link fetchWithTimeout} will follow before giving
 * up. Exported so `fetch-timeout.ts` (whose own `fetchWithTimeout` shares
 * this same hop limit) imports this single copy rather than defining its
 * own — two independently-defined copies of the same constant could drift,
 * and the error message above interpolates THIS one regardless of which
 * module's loop actually hit the limit.
 */
export const MAX_REDIRECTS = 5;

/**
 * Same-host redirect policy (fix-plan ledger, Task 11 standing policy):
 * scheme/port may change, but only in the SAFE direction. A same-host
 * `http://` → `https://` hop is an upgrade and is followed; the reverse
 * (`https://` → `http://`) is a downgrade on a credentialed request — worse
 * than the outage a same-host-only, scheme-blind check would otherwise
 * prevent — and is refused, same as a cross-host hop. Port is never
 * compared: an admin-configured host fronted by a reverse proxy on a
 * different port is exactly the same-host case this policy exists for.
 */
function isAllowedRedirectTarget(next: URL, original: URL): boolean {
    if (next.hostname !== original.hostname) return false;
    if (next.protocol === original.protocol) return true;
    return original.protocol === 'http:' && next.protocol === 'https:';
}

/** Strip body-describing headers that no longer apply once the body is dropped. */
function stripBodyHeaders(headers: RequestInit['headers']): Headers {
    const h = new Headers(headers);
    h.delete('content-type');
    h.delete('content-length');
    return h;
}

/**
 * The ONE same-origin-only redirect-following loop in the tree (C22 fix-plan
 * finding). `fetch-utils.ts` `fetchWithTimeout` and `fetch-timeout.ts`
 * `fetchWithTimeout` both delegate here — they used to each carry a full,
 * independently-maintained COPY of this loop, which is exactly the kind of
 * duplication that let 2026-09-13's collapse task land only one of the two
 * copies (see `fetch-redirect-error-shared.test.ts`, which fixed the
 * `FetchRedirectError` half of the same duplication). Callers differ only in
 * how they build the abort `signal` (a plain timeout vs a timeout wrapped in
 * FetchTimeoutError translation) — the redirect policy itself must never
 * diverge between them again, so it now physically cannot: there is only one
 * place to edit.
 *
 * Exported ONLY for `fetch-timeout.ts` to import — `fetchWithTimeout` (either
 * module) is the intended public surface for everyone else. `fetch-timeout.ts`
 * needs the loop directly, without the FetchTimeoutError-on-abort translation
 * `fetchWithTimeout` here applies (that module never threw FetchTimeoutError;
 * it lets a raw AbortError propagate, and changing that would be an
 * observable behaviour change for its callers).
 */
export async function followRedirectsWithGuard(
    url: string,
    options: RequestInit,
    signal: AbortSignal,
): Promise<Response> {
    delegateExternalCallCounting();
    let currentUrl = url;
    const originalUrl = new URL(url);
    // Mutable per-hop request shape — RFC 7231 §6.4 mandates different
    // method/body handling per redirect status (303 always downgrades to
    // GET; 301/302 downgrade only a non-GET/HEAD method; 307/308 must
    // preserve both). Declared outside the loop so a downgrade on hop N
    // carries into hop N+1's actual fetch() call below.
    let method = options.method ?? 'GET';
    let body = options.body;
    let headers = options.headers;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let wireStatus: number | null = null;
        try {
            // redirect:'manual' — we re-validate every hop ourselves rather
            // than letting the runtime follow blindly (see FetchRedirectError).
            const response = await fetch(currentUrl, {
                ...options,
                method,
                body,
                headers,
                signal,
                redirect: 'manual',
            });

            wireStatus = response.status;
            if (response.status < 300 || response.status >= 400) {
                countExternalCall(currentUrl, response.status);
                return response;
            }
            const location = response.headers.get('location');
            if (!location) {
                countExternalCall(currentUrl, response.status);
                return response;
            }

            // From here on this response is an INTERMEDIATE hop — never
            // returned to the caller, never read. undici otherwise keeps the
            // underlying connection open until the body is consumed or
            // cancelled, so a redirect chain of any length would accumulate
            // held connections instead of releasing them back to the pool.
            await response.body?.cancel().catch(() => {});

            if (hop === MAX_REDIRECTS) {
                logger.warn('Redirect hop limit exceeded', { url: currentUrl });
                throw new FetchRedirectError(new URL(currentUrl).host, 'redirect-limit-exceeded');
            }

            const nextUrl = new URL(location, currentUrl);
            if (!isAllowedRedirectTarget(nextUrl, originalUrl)) {
                logger.warn('Refusing cross-host or scheme-downgrade redirect', {
                    host: nextUrl.host,
                    protocol: nextUrl.protocol,
                });
                throw new FetchRedirectError(nextUrl.host);
            }

            if (response.status === 303) {
                // 303 See Other ALWAYS redirects via GET with no body,
                // regardless of the original method.
                method = 'GET';
                body = undefined;
                headers = stripBodyHeaders(headers);
            } else if (response.status === 301 || response.status === 302) {
                // 301/302 only downgrade a non-GET/HEAD method (matches
                // fetch()/browser behaviour); GET/HEAD pass through unchanged.
                if (method !== 'GET' && method !== 'HEAD') {
                    method = 'GET';
                    body = undefined;
                    headers = stripBodyHeaders(headers);
                }
            } else if (response.status === 307 || response.status === 308) {
                // 307/308 MUST preserve method + body. A streamed body was
                // already consumed by the fetch() call above and cannot be
                // resent — refuse rather than silently sending an empty body.
                if (body instanceof ReadableStream) {
                    logger.warn('Refusing redirect: request body cannot be resent', {
                        host: nextUrl.host,
                    });
                    throw new FetchRedirectError(nextUrl.host, 'unresendable-body');
                }
            }
            countExternalCall(currentUrl, response.status);
            currentUrl = nextUrl.toString();
        } catch (error) {
            if (!options.signal?.aborted) countExternalCall(currentUrl, null, wireStatus);
            throw error;
        }
    }
    // Unreachable — the loop above always returns or throws.
    throw new Error('fetchWithTimeout: exhausted redirect chain');
}

/**
 * Fetch with timeout - wraps native fetch with AbortController timeout
 *
 * @param url - URL to fetch
 * @param options - Standard fetch options
 * @param timeout - Timeout in milliseconds (default: 10000ms = 10s)
 * @returns Promise<Response>
 * @throws FetchTimeoutError if request times out
 *
 * @example
 * ```typescript
 * // Basic usage with default 10s timeout
 * const response = await fetchWithTimeout('https://api.example.com/data');
 *
 * // Custom timeout
 * const response = await fetchWithTimeout('https://slow-api.com/data', {}, 30000);
 *
 * // With fetch options
 * const response = await fetchWithTimeout('https://api.example.com/data', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ foo: 'bar' })
 * }, 5000);
 * ```
 */
export async function fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeout: number = 10000,
): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Compose in any caller-supplied signal so soft-budget aborts from the
    // sync drain propagate into the fetch. AbortSignal.any is the
    // standardised approach (Node 20+); we branch on presence so we don't
    // force callers to construct a signal they don't need.
    const callerSignal = options.signal as AbortSignal | undefined;
    const signal = callerSignal
        ? AbortSignal.any([controller.signal, callerSignal])
        : controller.signal;

    try {
        return await followRedirectsWithGuard(url, options, signal);
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            // Distinguish timeout-abort from caller-abort: if the caller's
            // signal fired, surface that (so the drain's composed signal
            // can propagate cleanly). Otherwise it was our own timeout.
            if (callerSignal?.aborted) throw error;
            throw new FetchTimeoutError(url, timeout);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Normalises a `Request`/`URL`/`string` fetch input into a plain
 * `(urlString, init)` pair, buffering a `Request` body so it can be replayed
 * through {@link fetchWithTimeout}. Shared by every `typeof fetch`-shaped
 * guarded default passed to a third-party SDK's `fetch:` option (the SDKs
 * are observed to call with a plain URL string, but `typeof fetch` allows
 * any of the three input shapes).
 */
async function normalizeFetchInput(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<{ url: string; init: RequestInit }> {
    if (typeof Request !== 'undefined' && input instanceof Request) {
        const hasBody = input.method !== 'GET' && input.method !== 'HEAD';
        const bufferedBody = hasBody ? await input.clone().text() : undefined;
        return {
            url: input.url,
            init: {
                method: input.method,
                headers: input.headers,
                ...(bufferedBody !== undefined ? { body: bufferedBody } : {}),
                ...init,
                signal: init?.signal === undefined ? input.signal : init.signal,
            },
        };
    }
    return {
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        init: init ?? {},
    };
}

/**
 * `fetchWithTimeout`'s own default (10s, tuned for short admin-configured
 * integration calls) is far too short for a non-streamed chat completion:
 * a non-streaming Anthropic/OpenAI call emits NO response headers until
 * generation finishes, and `clearTimeout` only fires once the response
 * resolves — so the 10s default becomes a hard cap on GENERATION time, not
 * idle time. With adaptive thinking enabled (anthropic-provider.ts lifts
 * `max_tokens` for it), ten seconds to first byte is routinely exceeded,
 * the SDK aborts, retries, and the assistant call fails outright. This
 * mirrors the SDKs' own default request timeout (~10 minutes) instead of
 * silently imposing fetch-utils.ts's short-integration-call default on a
 * generation workload it was never tuned for. Streaming calls are
 * unaffected (headers arrive immediately either way).
 */
const CHAT_SDK_TIMEOUT_MS = 10 * 60_000;

/**
 * `typeof fetch`-shaped wrapper around {@link fetchWithTimeout}, for SDKs
 * that accept a `fetch:` option (both assistant chat backends —
 * `openai-provider.ts` / `anthropic-provider.ts` — pass this as
 * `fetch: guardedDefaultFetch`). Per the fix-plan Task 11 ruling: an
 * admin-configured `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` is a private,
 * operator-controlled target (same class as ABS/Kavita/the sonic sidecar),
 * so it gets the same-origin-only guard here rather than the public-only
 * `safeFetch` — a self-hosted OpenAI-compatible proxy on a LAN address must
 * keep working. `ai/voyage.ts` defines its own differently-shaped
 * `guardedDefaultFetch` (it branches on `EMBEDDING_ALLOW_PRIVATE_URLS` to
 * choose between this same-origin guard and the public-only `safeFetch`);
 * this export is the generic case with no such opt-in to branch on.
 */
export const guardedDefaultFetch: typeof fetch = async (input, init) => {
    const { url, init: effectiveInit } = await normalizeFetchInput(input, init);
    return fetchWithTimeout(url, effectiveInit, CHAT_SDK_TIMEOUT_MS);
};

/**
 * Fetch JSON with timeout - convenience wrapper that also parses JSON
 *
 * @param url - URL to fetch
 * @param options - Standard fetch options
 * @param timeout - Timeout in milliseconds (default: 10000ms)
 * @returns Promise<T> - Parsed JSON response
 * @throws FetchTimeoutError if request times out
 * @throws Error if response is not OK or JSON parsing fails
 */
export async function fetchJsonWithTimeout<T = unknown>(
    url: string,
    options: RequestInit = {},
    timeout: number = 10000,
): Promise<T> {
    const response = await fetchWithTimeout(url, options, timeout);

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
}

/**
 * Default timeout values for different types of operations
 */
export const TIMEOUTS = {
    /** Quick metadata lookups */
    FAST: 5000,
    /** Standard API calls */
    DEFAULT: 10000,
    /** Image downloads, larger payloads */
    MEDIUM: 20000,
    /** Video stream initialization, large file operations */
    SLOW: 30000,
    /** Background sync operations that can take longer */
    BACKGROUND: 60000,
} as const;
