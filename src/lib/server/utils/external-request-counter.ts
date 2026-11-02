// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Count HTTP requests sent, including every retry attempt, fallback request,
 * address attempt and redirect hop. A rejected redirect is an error on the
 * request that returned it; a guard rejection before any send is not a call.
 * 404 is `not_found`, not a provider error. Caller cancellation is excluded.
 *
 * Global provider counters record independently of those scopes (provider-calls.ts).
 * Task execution opens a counter via withApiCallSpend; nested helpers share it.
 * Only an active explicit request scope may write live hourly stats, and only
 * for REQUEST_PATH_PROVIDER_HOSTS. Unscoped background work and work outliving
 * a scope never become live traffic. Task error keys use that same allowlist.
 * Transport loops report individual attempts; outer client/SDK wrappers defer
 * to them so a request can never be counted twice.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
    recordProviderCallForUrl,
    recordProviderRetry,
    withProviderCallScope,
} from './provider-calls.js';
import type { ProviderCallProvider } from '$lib/schemas/provider-calls.js';
import { recordRequestPathCall, type ExternalCallOutcome } from './external-request-stats.js';

export type { ExternalCallOutcome } from './external-request-stats.js';

interface RequestCounterState {
    byHost: Map<string, number>;
    errorsByHost: Map<string, number>;
    rateLimitedByHost: Map<string, number>;
}

const storage = new AsyncLocalStorage<RequestCounterState>();
const requestStorage = new AsyncLocalStorage<{ active: boolean }>();

interface CallTrackingState {
    delegated: boolean;
    parent?: CallTrackingState;
}
const callStorage = new AsyncLocalStorage<CallTrackingState>();

/** Transport loops own their individual attempt counts, even if no send occurs. */
export function delegateExternalCallCounting(): void {
    for (let span = callStorage.getStore(); span; span = span.parent) span.delegated = true;
}

/** Open only around real HTTP request handling; detached continuations expire with it. */
export async function withRequestPathCallScope<T>(fn: () => T | Promise<T>): Promise<T> {
    const state = { active: true };
    try {
        return await requestStorage.run(state, fn);
    } finally {
        state.active = false;
    }
}

/** Bucket label for URLs we can't parse a host from. */
const UNKNOWN_HOST = 'unknown';

/**
 * Third-party provider hosts whose request-path calls are counted. Exact
 * hostnames. Add a host here when a new provider client is wired in.
 */
export const REQUEST_PATH_PROVIDER_HOSTS: ReadonlySet<string> = new Set([
    'api.themoviedb.org',
    'image.tmdb.org',
    'musicbrainz.org',
    'coverartarchive.org',
    'api.acoustid.org',
    'lrclib.net',
    'ws.audioscrobbler.com',
    'api.deezer.com',
    'api.discogs.com',
    'www.theaudiodb.com',
    'api.mdblist.com',
    'mdblist.com',
    'api.myanimelist.net',
    'api.anidb.net',
    'api.openai.com',
    'api.voyageai.com',
    'api.anthropic.com',
]);

function hostFromUrl(url: string): string {
    try {
        return new URL(url).hostname || UNKNOWN_HOST;
    } catch {
        return UNKNOWN_HOST;
    }
}

function bump(map: Map<string, number>, host: string): void {
    map.set(host, (map.get(host) ?? 0) + 1);
}

/** Map an HTTP status (or `null` = no response) onto an outcome class. */
export function classifyExternalCallStatus(status: number | null): ExternalCallOutcome {
    if (status === null) return 'network_error';
    if (status === 404) return 'not_found';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server_error';
    if (status >= 400) return 'client_error';
    return 'ok';
}

/**
 * Record one finished request attempt to `url`. `status` is its HTTP status,
 * or `null` for a connection failure or rejected redirect. `wireStatus` preserves
 * the actual HTTP response for global telemetry when a redirect guard rejects it.
 */
export function countExternalCall(
    url: string,
    status: number | null,
    wireStatus: number | null = status,
): void {
    delegateExternalCallCounting();
    recordProviderCallForUrl(url, wireStatus);
    const outcome = classifyExternalCallStatus(status);
    const host = hostFromUrl(url);
    const state = storage.getStore();
    if (state) {
        bump(state.byHost, host);
        if (outcome !== 'ok' && outcome !== 'not_found') bump(state.errorsByHost, host);
        if (outcome === 'rate_limited') bump(state.rateLimitedByHost, host);
        return;
    }
    if (requestStorage.getStore()?.active && REQUEST_PATH_PROVIDER_HOSTS.has(host))
        recordRequestPathCall(host, outcome);
}

/**
 * Run `run` (one HTTP call) and record its outcome: the resolved response's
 * status, or a network error when it rejects. A rejection caused by the
 * caller's own abort signal is not an error of the provider and is not
 * counted. The original response or error is returned/rethrown unchanged.
 */
export async function trackExternalCall(
    url: string,
    run: () => Promise<Response>,
    callerSignal?: AbortSignal | null,
): Promise<Response> {
    const span: CallTrackingState = { delegated: false, parent: callStorage.getStore() };
    let response: Response;
    try {
        response = await callStorage.run(span, run);
    } catch (err) {
        if (!span.delegated && !callerSignal?.aborted) countExternalCall(url, null);
        throw err;
    }
    if (!span.delegated) countExternalCall(url, response.status);
    return response;
}

function urlOfFetchInput(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

/**
 * Wrap a `typeof fetch`-shaped function (what SDKs receive as their `fetch:`
 * option) so every call it makes is counted.
 */
export function withExternalCallCounting(
    impl: typeof fetch,
    provider?: ProviderCallProvider,
): typeof fetch {
    const counted: typeof fetch = (input, init) =>
        trackExternalCall(
            urlOfFetchInput(input),
            () => impl(input, init),
            init?.signal === undefined
                ? input instanceof Request
                    ? input.signal
                    : undefined
                : init.signal,
        );
    if (!provider) return counted;
    return (input, init) =>
        withProviderCallScope(provider, () => {
            const headers = new Headers(
                init?.headers ?? (input instanceof Request ? input.headers : undefined),
            );
            if (Number(headers.get('x-stainless-retry-count') ?? 0) > 0)
                recordProviderRetry(provider);
            return counted(input, init);
        });
}

/** Result of a counted scope: the body's value plus per-host counts and totals. */
export interface ExternalRequestCount<T> {
    result: T;
    /** Calls made, keyed by destination host. */
    byHost: Map<string, number>;
    /** Failed calls (4xx except 404, 5xx, network), keyed by host. Includes 429s. */
    errorsByHost: Map<string, number>;
    /** HTTP 429 responses, keyed by host. A subset of `errorsByHost`. */
    rateLimitedByHost: Map<string, number>;
    /** Sum of all per-host call counts. */
    total: number;
}

function sum(map: Map<string, number>): number {
    let total = 0;
    for (const n of map.values()) total += n;
    return total;
}

function emptyState(): RequestCounterState {
    return { byHost: new Map(), errorsByHost: new Map(), rateLimitedByHost: new Map() };
}

/**
 * Run `fn` with a fresh counter in scope and return its result alongside the
 * per-host counts and the totals made while it ran.
 */
export async function withExternalRequestCount<T>(
    fn: () => Promise<T>,
): Promise<ExternalRequestCount<T>> {
    const state = emptyState();
    const result = await storage.run(state, fn);
    return {
        result,
        byHost: state.byHost,
        errorsByHost: state.errorsByHost,
        rateLimitedByHost: state.rateLimitedByHost,
        total: sum(state.byHost),
    };
}

/**
 * Like {@link withExternalRequestCount} but reports the counts via `report`
 * in a `finally`, so calls already made are accounted for EVEN IF `fn` throws
 * partway through. A drain that burned real API quota and then hit a DB error
 * must not report zero cost. `fn`'s throw is re-raised unchanged.
 */
export async function withExternalRequestCountSettled<T>(
    fn: () => Promise<T>,
    report: (counts: Omit<ExternalRequestCount<never>, 'result'>) => void,
): Promise<T> {
    // The runner owns the outer spend scope; opt-in helpers must not charge twice.
    if (storage.getStore()) return fn();
    const state = emptyState();
    try {
        return await storage.run(state, fn);
    } finally {
        const total = sum(state.byHost);
        if (total > 0) {
            report({
                byHost: state.byHost,
                errorsByHost: state.errorsByHost,
                rateLimitedByHost: state.rateLimitedByHost,
                total,
            });
        }
    }
}
