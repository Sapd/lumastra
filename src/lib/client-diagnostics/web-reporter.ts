// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The web client's automatic diagnostics: uncaught errors, failed API calls and
 * failure messages the user saw, sent as `js_error` / `api_failures` events to
 * the same ingest the Apple apps use (Admin → Users → Client diagnostics).
 *
 * Volume. Every report carries a dedupe key. The first occurrence of a key is
 * queued; repeats while it waits only raise its `occurrences`; repeats after it
 * was sent are counted and sent as one follow-up event at most every
 * {@link REPEAT_INTERVAL_MS} (or when the tab closes). A tab sends at most
 * {@link RATE_MAX} API-failure events and {@link RATE_MAX} error events per
 * {@link RATE_WINDOW_MS} — two budgets, so routine 4xx noise cannot starve real
 * errors — and tracks at most {@link MAX_KEYS} keys, evicting idle ones. Events
 * go out in batches after {@link FLUSH_DELAY_MS}: at most 50 events and
 * {@link BATCH_BYTES} per request, a 429/5xx batch retried once after a minute.
 *
 * Privacy. A path is kept only as SvelteKit route id or as a template whose
 * words are all literal route names (route-template.ts); query strings never
 * leave. Free text (messages, stacks) is scrubbed for credentials, query
 * strings, opaque tokens and e-mail addresses before it is queued. Error
 * messages can still carry what the code put in them (a title, a server error
 * text); that is the part that makes a report diagnosable, and the server
 * redacts it again. No request or response body is ever read into a report.
 *
 * Opt-out, fail closed. The admin switch `FEATURE_CLIENT_DIAGNOSTICS` reaches the
 * page as `features.clientDiagnostics`; the root layout passes it to
 * {@link setClientDiagnosticsEnabled} (false when signed out). Until it arrives,
 * reports are held, never sent; off drops them and forgets this tab's state.
 * The server enforces the same switch.
 *
 * Every entry point swallows its own failures: diagnostics must never break the
 * page they describe or report themselves.
 */

import { browser, version } from '$app/environment';
import { apiUrl } from '$lib/shared/api-urls.js';
import type { DiagnosticEventInput } from '$lib/schemas/client-diagnostics.js';
import { diagnosticPathTemplate } from './route-template.js';
import { scrubClientText } from './scrub.js';

export const FLUSH_DELAY_MS = 2_000;
export const REPEAT_INTERVAL_MS = 5 * 60_000;
export const RATE_WINDOW_MS = 10 * 60_000;
/** Per budget (API failures, errors) per tab per window. */
export const RATE_MAX = 20;
export const MAX_KEYS = 100;
const BATCH_MAX = 50;
/** Well under the ingest's 512 KiB body cap. */
const BATCH_BYTES = 200 * 1024;
const RETRY_DELAY_MS = 60_000;
/** Browsers refuse a keepalive request once in-flight keepalive bodies pass 64 KiB. */
const KEEPALIVE_BYTES = 60 * 1024;
/** Reports held before the opt-out is known. */
const HELD_MAX = 50;
/** An API failure this recent is attached to a failure message as its likely cause. */
const CAUSE_WINDOW_MS = 10_000;
/** An untagged toast this soon after a tagged failure report is the same failure. */
const TAGGED_SHADOW_MS = 3_000;
/** Requests in flight when a tab is hidden fail on resume (mobile); not a server fault. */
const RESUME_GRACE_MS = 3_000;

const MESSAGE_MAX = 500;
const STACK_MAX = 4_000;
/** Below the server's 16 KiB js_error cap with room for JSON escaping. */
const JS_ERROR_BYTES = 14 * 1024;
const API_FAILURE_BYTES = 2 * 1024;

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type ApiOutcome = 'status_4xx' | 'status_5xx' | 'network' | 'timeout' | 'decode';
type JsErrorEvent = Extract<DiagnosticEventInput, { kind: 'js_error' }>;
type ApiFailureEvent = Extract<DiagnosticEventInput, { kind: 'api_failures' }>;
type JsErrorPayload = JsErrorEvent['payload'];
type ApiCause = NonNullable<JsErrorPayload['cause']>;
type Budget = 'api' | 'js';

interface Entry {
    budget: Budget;
    /** The event waiting in `pending`, if any. */
    queued: DiagnosticEventInput | null;
    lastQueuedAt: number;
    /** Occurrences seen since the last queued event. */
    suppressed: number;
    /** Builds a fresh event for this key (latest occurrence wins). */
    build: () => DiagnosticEventInput;
}

let enabled: boolean | undefined;
let routeId: string | null = null;
const entries = new Map<string, Entry>();
let pending: DiagnosticEventInput[] = [];
let retried = new WeakSet<DiagnosticEventInput>();
let timer: ReturnType<typeof setTimeout> | undefined;
let sentAt: Record<Budget, number[]> = { api: [], js: [] };
let lastApiFailure: { at: number; cause: ApiCause } | null = null;
let lastTaggedFailureAt = 0;
let lifecycleInstalled = false;
/** Requests cut off by leaving the page fail as network errors; they are not failures. */
let unloading = false;
let lastVisibleAt = 0;

function eventId(): string {
    // randomUUID needs a secure context; plain-HTTP LAN access is supported.
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch {
        // fall through
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const n = Math.floor(Math.random() * 16);
        return (c === 'x' ? n : (n & 3) | 8).toString(16);
    });
}

function appVersion(): string | undefined {
    return typeof version === 'string' && version ? version.slice(0, 32) : undefined;
}

function origin(): string | undefined {
    return typeof location !== 'undefined' ? location.origin : undefined;
}

function byteLength(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function takeRateToken(budget: Budget, now: number): boolean {
    const recent = sentAt[budget].filter((t) => now - t < RATE_WINDOW_MS);
    sentAt[budget] = recent;
    if (recent.length >= RATE_MAX) return false;
    recent.push(now);
    return true;
}

function schedule(delay = FLUSH_DELAY_MS): void {
    if (enabled !== true) return;
    timer ??= setTimeout(() => {
        void flush();
    }, delay);
}

/** Take the next batch off `pending`: ≤ BATCH_MAX events and ≤ BATCH_BYTES. */
function takeBatch(): DiagnosticEventInput[] {
    const batch: DiagnosticEventInput[] = [];
    let bytes = 0;
    while (pending.length > 0 && batch.length < BATCH_MAX) {
        const size = byteLength(pending[0]);
        if (batch.length > 0 && bytes + size > BATCH_BYTES) break;
        bytes += size;
        batch.push(pending.shift()!);
    }
    return batch;
}

async function flush(): Promise<void> {
    timer = undefined;
    if (enabled !== true) return;
    const events = takeBatch();
    if (pending.length > 0) schedule();
    for (const entry of entries.values()) {
        if (entry.queued && events.includes(entry.queued)) entry.queued = null;
    }
    if (events.length === 0) return;
    let status = 0;
    try {
        const body = JSON.stringify({ events });
        // The internal mount of the same def accepts the web session cookie.
        const response = await fetch(apiUrl('internal', '/diagnostics/events'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            // Survives a closing tab; a batch too large for it goes as a plain request.
            keepalive: new TextEncoder().encode(body).byteLength < KEEPALIVE_BYTES,
            body,
        });
        status = response.status;
    } catch {
        // Lost reports are acceptable; reporting the reporter is not.
    }
    // Rate-limited or unreachable: one more try a minute later. A 4xx other than
    // 429 is a rejected batch and resending it would only be rejected again.
    if (status === 429 || status === 0 || status >= 500) {
        const again = events.filter((e) => !retried.has(e));
        for (const e of again) retried.add(e);
        if (again.length > 0 && enabled === true) {
            pending = [...again, ...pending].slice(0, BATCH_MAX * 2);
            if (timer) clearTimeout(timer);
            timer = undefined;
            schedule(RETRY_DELAY_MS);
        }
    }
}

/**
 * Hidden or closing tab: send what is queued. On close, also the counts of
 * every suppressed repeat; on a mere hide only those whose repeat interval is
 * up, so switching tabs back and forth does not resend counts.
 */
function flushOnHide(closing: boolean): void {
    if (enabled !== true) return;
    const now = Date.now();
    for (const entry of entries.values()) {
        if (entry.suppressed === 0 || entry.queued) continue;
        if (!closing && now - entry.lastQueuedAt < REPEAT_INTERVAL_MS) continue;
        if (!takeRateToken(entry.budget, now)) continue;
        queueEntry(entry, entry.suppressed, now);
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    void flush();
}

function installLifecycle(): void {
    if (lifecycleInstalled || typeof window === 'undefined' || typeof document === 'undefined')
        return;
    lifecycleInstalled = true;
    window.addEventListener('beforeunload', () => {
        unloading = true;
        // A cancelled unload (a "leave page?" prompt) must not mute reports for good.
        setTimeout(() => {
            unloading = false;
        }, 10_000);
    });
    window.addEventListener('pageshow', () => {
        unloading = false;
        lastVisibleAt = Date.now();
    });
    window.addEventListener('pagehide', () => {
        unloading = true;
        flushOnHide(true);
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushOnHide(false);
        else lastVisibleAt = Date.now();
    });
}

/** A network failure now is the browser's doing, not the server's. */
function networkFailureExpected(): boolean {
    if (unloading) return true;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return true;
    return Date.now() - lastVisibleAt < RESUME_GRACE_MS;
}

function queueEntry(entry: Entry, occurrences: number, now: number): void {
    const event = entry.build();
    event.eventId = eventId();
    event.occurrences = Math.min(1_000_000, Math.max(1, occurrences));
    entry.queued = event;
    entry.lastQueuedAt = now;
    entry.suppressed = 0;
    pending.push(event);
    if (enabled !== true && pending.length > HELD_MAX) {
        const dropped = pending.shift();
        for (const e of entries.values()) if (e.queued === dropped) e.queued = null;
    }
    schedule();
}

/** Make room for a new key: forget the idle key queued longest ago. */
function evictIdle(): boolean {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, entry] of entries) {
        if (entry.queued || entry.suppressed > 0) continue;
        if (entry.lastQueuedAt < oldestAt) {
            oldestAt = entry.lastQueuedAt;
            oldestKey = key;
        }
    }
    if (oldestKey === null) return false;
    entries.delete(oldestKey);
    return true;
}

/**
 * Count one occurrence of `key`; queue an event for it when the dedupe and rate
 * rules allow. `build` must return a complete, already-scrubbed event.
 */
export function recordDiagnostic(
    key: string,
    build: () => DiagnosticEventInput,
    budget: Budget = 'api',
): void {
    if (!browser || enabled === false) return;
    try {
        installLifecycle();
        const now = Date.now();
        let entry = entries.get(key);
        if (entry?.queued) {
            const queued = entry.queued;
            queued.occurrences = Math.min(1_000_000, (queued.occurrences ?? 1) + 1);
            if (queued.kind === 'api_failures') queued.payload.windowEnd = now;
            return;
        }
        if (entry && now - entry.lastQueuedAt < REPEAT_INTERVAL_MS) {
            entry.suppressed++;
            entry.build = build;
            return;
        }
        if (!entry) {
            if (entries.size >= MAX_KEYS && !evictIdle()) return;
            entry = { budget, queued: null, lastQueuedAt: 0, suppressed: 0, build };
            entries.set(key, entry);
        } else {
            entry.build = build;
        }
        const occurrences = entry.suppressed + 1;
        if (!takeRateToken(budget, now)) {
            // Keep the count; it rides on the next event this key is allowed to send.
            entry.suppressed = occurrences;
            entry.lastQueuedAt = now;
            return;
        }
        queueEntry(entry, occurrences, now);
    } catch {
        // Includes environments without TextEncoder/crypto.
    }
}

/** Root layout: the admin switch, false when signed out. */
export function setClientDiagnosticsEnabled(value: boolean): void {
    if (value === enabled) return;
    enabled = value;
    if (value) {
        if (pending.length > 0) schedule();
        return;
    }
    // Off, or signed out: nothing from this period may reach the next account.
    pending = [];
    if (timer) clearTimeout(timer);
    timer = undefined;
    entries.clear();
    sentAt = { api: [], js: [] };
    lastApiFailure = null;
    lastTaggedFailureAt = 0;
}

/** `undefined` until the root layout has passed the admin switch. */
export function isClientDiagnosticsEnabled(): boolean | undefined {
    return enabled;
}

/** Root layout: the SvelteKit route id of the current page (`/(app)/media/[id]`). */
export function setClientDiagnosticsRoute(id: string | null | undefined): void {
    routeId = id ?? null;
}

/**
 * The page the user is on, as a route template: the SvelteKit route id, or
 * before the router knows it, the path with every non-route word as `:id`.
 */
export function currentDiagnosticRoute(): string | undefined {
    if (routeId) return routeId.slice(0, 256);
    if (typeof location === 'undefined') return undefined;
    return diagnosticPathTemplate(location.pathname).slice(0, 256);
}

function errorParts(error: unknown): { name: string; message: string; stack?: string } {
    if (error instanceof Error) {
        return { name: error.name || 'Error', message: error.message, stack: error.stack };
    }
    if (typeof error === 'string') return { name: 'Error', message: error };
    if (error && typeof error === 'object' && 'message' in error) {
        const message = (error as { message: unknown }).message;
        return { name: 'Error', message: typeof message === 'string' ? message : '' };
    }
    // A rejected Response, Event or plain object: its type is all that is safe to say.
    return { name: error === null ? 'null' : typeof error, message: '' };
}

function isChunkLoadError(message: string): boolean {
    return /dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to fetch dynamically/i.test(
        message,
    );
}

function buildJsError(
    payload: Omit<JsErrorPayload, 'name' | 'message' | 'stack'>,
    error: unknown,
): JsErrorEvent {
    const parts = errorParts(error);
    const o = origin();
    const event: JsErrorEvent = {
        kind: 'js_error',
        platform: 'web',
        eventId: '',
        occurredAt: Date.now(),
        ...(appVersion() ? { appVersion: appVersion() } : {}),
        payload: {
            ...payload,
            name: scrubClientText(parts.name, o).slice(0, 128) || 'Error',
            message: scrubClientText(parts.message, o).slice(0, MESSAGE_MAX),
            ...(parts.stack ? { stack: scrubClientText(parts.stack, o).slice(0, STACK_MAX) } : {}),
        },
    };
    if (isChunkLoadError(parts.message)) event.payload.tag = 'chunk_load';
    while (byteLength(event.payload) > JS_ERROR_BYTES && event.payload.stack) {
        event.payload.stack = event.payload.stack.slice(0, -500) || undefined;
    }
    while (byteLength(event.payload) > JS_ERROR_BYTES && event.payload.message) {
        event.payload.message = event.payload.message.slice(0, -100);
    }
    return event;
}

/** Benign browser noise that says nothing about Lumastra. */
function isNoise(message: string): boolean {
    return /ResizeObserver loop|^Script error\.?$/i.test(message);
}

/** Code the operator does not ship: browser extensions and injected scripts. */
const FOREIGN_FRAME = /(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//i;

/** window `error` / `unhandledrejection`. `filename` is the ErrorEvent's script URL. */
export function reportJsError(
    origin: 'window_error' | 'unhandled_rejection',
    error: unknown,
    filename?: string,
): void {
    if (!browser || enabled === false) return;
    try {
        const parts = errorParts(error);
        if (parts.name === 'AbortError' || isNoise(parts.message)) return;
        if (FOREIGN_FRAME.test(parts.stack ?? '') || FOREIGN_FRAME.test(filename ?? '')) return;
        if (
            filename &&
            typeof location !== 'undefined' &&
            /^[a-z][a-z0-9+.-]*:\/\//i.test(filename) &&
            !filename.startsWith(location.origin)
        )
            return;
        const route = currentDiagnosticRoute();
        const topFrame = (parts.stack ?? '')
            .split('\n')
            .slice(0, 3)
            .join('|')
            .replace(/\d+/g, '#');
        const key = JSON.stringify([
            'js',
            origin,
            parts.name,
            // Ids and counters in a message must not make every occurrence a new key.
            parts.message.slice(0, 200).replace(/\d+/g, '#'),
            topFrame,
        ]);
        recordDiagnostic(
            key,
            () => buildJsError({ origin, ...(route ? { route } : {}) }, error),
            'js',
        );
    } catch {
        // never throw from an error handler
    }
}

export interface ApiFailureReport {
    endpoint: string;
    method: string;
    outcome: ApiOutcome;
    status?: number;
    problemCode?: string;
    requestId?: string;
    /** Decode failures only, e.g. "invalid JSON". */
    detail?: string;
}

const METHODS = new Set<ApiMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function isOwnSink(route: string): boolean {
    return (
        route.endsWith(apiUrl('internal', '/diagnostics/events')) ||
        route.endsWith(apiUrl('v1', '/diagnostics/events')) ||
        route.endsWith(apiUrl('internal', '/client-errors'))
    );
}

/**
 * A failed call through the central API client. `endpoint` may be a raw URL —
 * only its templated path is ever kept. The caller skips the re-auth 401 and
 * its own aborts; offline, hidden and unloading tabs are skipped here.
 */
export function reportApiFailure(report: ApiFailureReport): void {
    if (!browser || enabled === false) return;
    try {
        installLifecycle();
        if (
            (report.outcome === 'network' || report.outcome === 'timeout') &&
            networkFailureExpected()
        )
            return;
        const method = report.method.toUpperCase() as ApiMethod;
        if (!METHODS.has(method)) return;
        const route = diagnosticPathTemplate(report.endpoint);
        if (isOwnSink(route)) return;
        const status =
            typeof report.status === 'number' && report.status >= 100 && report.status <= 599
                ? report.status
                : undefined;
        const problemCode =
            report.problemCode && /^[a-z0-9_]{1,64}$/.test(report.problemCode)
                ? report.problemCode
                : undefined;
        const requestId =
            report.requestId && /^[A-Za-z0-9_.:-]{1,100}$/.test(report.requestId)
                ? report.requestId
                : undefined;
        const detail =
            report.outcome === 'decode' && report.detail
                ? scrubClientText(report.detail).slice(0, 300)
                : undefined;
        const now = Date.now();
        lastApiFailure = {
            at: now,
            cause: {
                method,
                route,
                outcome: report.outcome,
                ...(status ? { status } : {}),
                ...(problemCode ? { problemCode } : {}),
            },
        };
        const key = JSON.stringify(['api', method, route, report.outcome, status, problemCode]);
        recordDiagnostic(key, (): ApiFailureEvent => {
            const at = Date.now();
            const event: ApiFailureEvent = {
                kind: 'api_failures',
                platform: 'web',
                eventId: '',
                occurredAt: at,
                ...(appVersion() ? { appVersion: appVersion() } : {}),
                payload: {
                    windowStart: at,
                    windowEnd: at,
                    method,
                    route,
                    outcome: report.outcome,
                    ...(status ? { status } : {}),
                    ...(problemCode ? { problemCode } : {}),
                    ...(requestId ? { requestId } : {}),
                    ...(detail ? { detail } : {}),
                },
            };
            if (byteLength(event.payload) > API_FAILURE_BYTES) {
                delete event.payload.requestId;
                delete event.payload.detail;
            }
            return event;
        });
    } catch {
        // never affect the request
    }
}

export interface UserFacingFailure {
    /** Message key of what the user saw (`audiobook_playback_failed`). */
    key?: string;
    /** The error behind it, when the caller has one. */
    error?: unknown;
}

/**
 * The user saw a failure: an error toast, or a player stopping with an error.
 * Attaches the API call that failed in this tab within the last few seconds, so
 * "failed to play" leaves a trace even when nothing threw.
 */
export function reportUserFacingFailure(failure: UserFacingFailure = {}): void {
    if (!browser || enabled === false) return;
    try {
        const now = Date.now();
        const toastKey =
            failure.key && /^[A-Za-z0-9_.:-]{1,100}$/.test(failure.key) ? failure.key : 'untagged';
        if (toastKey === 'untagged' && now - lastTaggedFailureAt < TAGGED_SHADOW_MS) return;
        if (toastKey !== 'untagged') lastTaggedFailureAt = now;
        const cause =
            lastApiFailure && now - lastApiFailure.at < CAUSE_WINDOW_MS
                ? lastApiFailure.cause
                : undefined;
        const route = currentDiagnosticRoute();
        const key = JSON.stringify([
            'toast',
            toastKey,
            route,
            cause ? [cause.method, cause.route, cause.status, cause.problemCode] : null,
        ]);
        recordDiagnostic(
            key,
            () =>
                buildJsError(
                    {
                        origin: 'error_toast',
                        toastKey,
                        ...(route ? { route } : {}),
                        ...(cause ? { cause } : {}),
                    },
                    failure.error ?? { message: toastKey },
                ),
            'js',
        );
    } catch {
        // never affect the UI that is showing the failure
    }
}

/** Test seam: module state survives between tests otherwise. */
export function resetClientDiagnosticsForTests(): void {
    enabled = undefined;
    routeId = null;
    entries.clear();
    pending = [];
    retried = new WeakSet();
    if (timer) clearTimeout(timer);
    timer = undefined;
    sentAt = { api: [], js: [] };
    lastApiFailure = null;
    lastTaggedFailureAt = 0;
    unloading = false;
    lastVisibleAt = 0;
}
