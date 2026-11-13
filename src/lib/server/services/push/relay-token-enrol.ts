// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Push relay token enrolment.
 *
 * Out-of-the-box push for the Apple apps goes through the Lumastra relay
 * (`push.lumastra.org`), which wants a short-lived (at most 24 h) relay token
 * bound to this install. This loop fetches it from lumastra.org:
 *
 *     POST https://lumastra.org/api/push/relay-token
 *     { "install_uuid": "...", "app_version": "..." }
 *  -> { "relayToken": "<ES256 JWT>", "relayTokenExp": <unix seconds> }
 *
 * Only the install UUID and the app version are sent. No licence key, no
 * status code, no check-in, no library data. There is no licence any more;
 * this is the one call to lumastra.org that remains, and it is documented in
 * the data-flow reference.
 *
 * It runs only while ALL of these hold (checked on every tick):
 * - `FEATURE_PUSH_NOTIFICATIONS` is on,
 * - delivery goes through the relay (no operator APNs signing key),
 * - `PUSH_RELAY_URL` is the default relay and no own `PUSH_RELAY_TOKEN` is set,
 * - `LICENSE_SERVER_CONTACT_ENABLED` is on (the stored key name of the
 *   "contact lumastra.org" switch is kept so every existing opt-out keeps
 *   working),
 * - the operator has answered the contact question, or setup is a day old
 *   (an install set up through the wizard never calls before its answer).
 * Otherwise nothing is sent, and a held minted token is dropped when contact is
 * switched off.
 *
 * The token is held in memory (relay-token.store.ts) and shared through Valkey
 * (relay-token.shared.ts), so a restart or a sibling process adopts the one the
 * install already holds and does not call again. A tick every ~6 h renews it; a
 * relay 401 triggers an early renewal (at most every 15 minutes).
 *
 * @module services/push/relay-token-enrol
 */

import { config } from '$lib/server/config.js';
import { getConfigState, isEnvOverridden, onConfigChange } from '$lib/server/config/index.js';
import { getDb } from '$lib/server/database';
import { getInstallUuid } from '$lib/server/database/queries/install-identity.queries.js';
import { isFirstRunSetupOlderThan } from '$lib/server/database/queries/onboarding.queries.js';
import { isIsolationWorker } from '$lib/server/tasks/isolation/isolation-context.js';
import { Logger } from '$lib/server/utils/logger.js';
import { currentPushTransportSelection } from './push-transport-selector.js';
import {
    adoptRelayTokenIfFresher,
    hasLiveMintedRelayToken,
    onRelayTokenInvalidated,
    relayTokenExpiryMs,
    relayTokenNeedsRenewal,
    setRelayToken,
} from './relay-token.store.js';
import {
    acquireEnrolLock,
    clearSharedRelayToken,
    clearSharedRelayTokenIfEquals,
    loadSharedRelayToken,
    releaseEnrolLock,
    saveSharedRelayToken,
} from './relay-token.shared.js';

const logger = Logger.for('RelayTokenEnrol');

/** The one endpoint this module calls. Hardcoded: the relay trusts this server's key. */
export const RELAY_TOKEN_ENDPOINT = 'https://lumastra.org/api/push/relay-token';
const DEFAULT_RELAY_ORIGIN = 'https://push.lumastra.org';

/** How often the loop checks whether a token is due. */
export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Retry delay after a failed attempt while the install holds no usable token. */
export const RETRY_INTERVAL_MS = 30 * 60 * 1000;
/** First tick: this long after start plus up to the jitter (spreads boots and replicas). */
export const FIRST_TICK_DELAY_MS = 5_000;
export const FIRST_TICK_JITTER_MS = 25_000;
/** A relay 401 triggers an early renewal at most this often. */
export const EARLY_REFRESH_MIN_INTERVAL_MS = 15 * 60 * 1000;
/** An install without a stored answer to the contact question waits this long after setup. */
export const ENROL_SETUP_FALLBACK_MS = 24 * 60 * 60 * 1000;
const INTERVAL_JITTER = 0.1;
const RETRY_JITTER = 0.2;
const FAILURE_WARN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
/** The answer is a token and an expiry: anything bigger is not from the real endpoint. */
const MAX_RESPONSE_BYTES = 16 * 1024;
/** A token must have at least this much life left to be worth storing or sharing. */
const MIN_USABLE_LIFE_MS = 5 * 60 * 1000;
/** The server mints at most 24 h; allow a little clock skew on top. */
const MAX_TOKEN_LIFE_MS = 24 * 60 * 60 * 1000 + MIN_USABLE_LIFE_MS;
/** Another process is fetching the token: look at the shared slot again soon. */
const BUSY_RETRY_MS = 5_000;
/**
 * `acquireLock` answers null both for "a sibling holds it" and for "the
 * coordination Valkey is down" (it refuses an in-memory lock there). After this
 * many 'busy' answers in a row, with no token appearing in the shared slot, the
 * lock is taken to be unavailable and the request goes out without it: a few
 * duplicate calls are better than no push token for as long as Valkey is down.
 */
const BUSY_BEFORE_LOCKLESS = 3;

const CONTACT_KEY = 'LICENSE_SERVER_CONTACT_ENABLED';

/** `base` spread by +-`fraction`, uniformly. */
export function jittered(base: number, fraction: number, rand: () => number = Math.random): number {
    return Math.round(base * (1 - fraction + 2 * fraction * rand()));
}

/** A `Retry-After` header in ms (delta-seconds or HTTP date), or null. */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
    const at = Date.parse(trimmed);
    return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** The operator answered the contact question (environment, wizard or admin save). */
function contactAnswered(): boolean {
    return (
        isEnvOverridden(CONTACT_KEY) || getConfigState()?.jsonOverrides.has(CONTACT_KEY) === true
    );
}

/**
 * Why this install must not ask lumastra.org for a relay token, or null when it
 * may: push on, relay delivery, default relay, no own token, contact switched
 * on. Pure config, no I/O.
 */
export function relayTokenIneligibleReason(): string | null {
    if (!config.FEATURE_PUSH_NOTIFICATIONS) return 'push notifications are off';
    if (!config.LICENSE_SERVER_CONTACT_ENABLED) return 'contact with lumastra.org is switched off';
    if (config.PUSH_RELAY_TOKEN.trim().length > 0) return 'an own PUSH_RELAY_TOKEN is set';
    if (currentPushTransportSelection().kind !== 'relay') return 'push is delivered with an own Apple key';
    try {
        if (new URL(config.PUSH_RELAY_URL).origin !== new URL(DEFAULT_RELAY_ORIGIN).origin) {
            return 'an own relay URL is set';
        }
    } catch {
        return 'the relay URL is not valid';
    }
    return null;
}

/** Whether this install should get a relay token from lumastra.org at all. */
export function relayTokenEnrolEligible(): boolean {
    return relayTokenIneligibleReason() === null;
}

let lastEligibilityNote: string | null | undefined;

/** Log a change of the answer once (info), not on every tick. */
function noteEligibility(reason: string | null): void {
    if (reason === lastEligibilityNote) return;
    const first = lastEligibilityNote === undefined;
    lastEligibilityNote = reason;
    if (reason === null) {
        if (!first) logger.info('Asking lumastra.org for the push relay token is allowed again');
        return;
    }
    logger.info(`Not asking lumastra.org for a push relay token: ${reason}`);
}

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

export type EnrolOutcome =
    /** Not eligible (push off, contact off, own relay or own token). Nothing sent. */
    | 'ineligible'
    /** Another process holds the call lock and is fetching the token. Nothing sent. */
    | 'busy'
    /** A live token is held or was adopted from a sibling process. Nothing sent. */
    | 'fresh'
    /** Eligible but the operator has not answered the contact question yet. Nothing sent. */
    | 'waiting-for-answer'
    /** A token was fetched and stored. */
    | 'minted'
    /** The call failed (network, non-2xx, no token in the answer). */
    | 'failed';

interface EnrolState {
    failureStreak: number;
    lastFailureWarnAt: number;
    retryAfterMs: number | null;
    /** A shorter retry than the usual 30 minutes (another process is fetching). */
    shortRetryMs: number | null;
    needsRetry: boolean;
    loggedWaiting: boolean;
    /** Consecutive 'busy' answers (the lock was not available). */
    busyStreak: number;
    loggedLocklessFetch: boolean;
}

const state: EnrolState = {
    failureStreak: 0,
    lastFailureWarnAt: 0,
    retryAfterMs: null,
    shortRetryMs: null,
    needsRetry: false,
    loggedWaiting: false,
    busyStreak: 0,
    loggedLocklessFetch: false,
};

function noteSuccess(): void {
    if (state.failureStreak > 0) {
        logger.info('lumastra.org reachable again for the push relay token', {
            failedAttempts: state.failureStreak,
        });
    }
    state.failureStreak = 0;
    state.lastFailureWarnAt = 0;
    state.retryAfterMs = null;
}

function noteFailure(message: string, meta: Record<string, unknown> | Error): void {
    state.failureStreak += 1;
    const now = Date.now();
    if (state.failureStreak === 1 || now - state.lastFailureWarnAt >= FAILURE_WARN_INTERVAL_MS) {
        state.lastFailureWarnAt = now;
        logger.warn(
            state.failureStreak === 1
                ? message
                : `${message} (still failing, ${state.failureStreak} attempts)`,
            meta,
        );
    } else {
        logger.debug(message, meta);
    }
}

async function mayCallNow(sql: NonNullable<ReturnType<typeof getDb>>): Promise<boolean> {
    let allowed = contactAnswered();
    if (!allowed) {
        try {
            allowed = await isFirstRunSetupOlderThan(sql, ENROL_SETUP_FALLBACK_MS);
        } catch (err) {
            logger.debug('Setup state unknown; not contacting lumastra.org yet', {
                error: err instanceof Error ? err.message : String(err),
            });
            allowed = false;
        }
    }
    if (allowed) {
        state.loggedWaiting = false;
    } else if (!state.loggedWaiting) {
        state.loggedWaiting = true;
        logger.info(
            'Waiting for the setup wizard to ask about contacting lumastra.org before the first push relay token call',
        );
    }
    return allowed;
}

/**
 * POST the enrolment request. Throws on network error. The caller has checked
 * eligibility; this re-checks the contact switch because it is the one place a
 * request leaves (a switch flipped mid-tick must not slip past).
 */
async function postRelayTokenRequest(installUuid: string, shutdown: AbortSignal): Promise<Response> {
    if (!config.LICENSE_SERVER_CONTACT_ENABLED) throw new ContactDisabledError();
    // RELAY_TOKEN_ENDPOINT is a hardcoded Lumastra-operated vendor endpoint, not
    // admin-configurable (see docs/dev/eslint-exceptions.md, same class as the
    // former licence endpoint). A redirect is never followed: the answer must come
    // from this exact endpoint.
    // eslint-disable-next-line callback-safety/no-bare-fetch-in-server
    return fetch(RELAY_TOKEN_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ install_uuid: installUuid, app_version: config.APP_VERSION }),
        signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), shutdown]),
    });
}

/** Aborted by {@link stopRelayTokenEnrolLoop}; a fresh one is made on every stop. */
let shutdownController = new AbortController();

class ContactDisabledError extends Error {
    constructor() {
        super('Contact with lumastra.org is switched off');
        this.name = 'ContactDisabledError';
    }
}

interface RelayTokenResponse {
    relayToken?: unknown;
    relayTokenExp?: unknown;
}

/** The response body as text, or null when it is bigger than `max` bytes. */
async function readBodyCapped(res: Response, max: number): Promise<string | null> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) return null;
    const reader = res.body?.getReader();
    if (!reader) {
        const text = await res.text();
        return text.length > max ? null : text;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
            await reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** Adopt what a sibling shared; true when this process now holds a token that needs no renewal. */
async function adoptSharedToken(): Promise<boolean> {
    const shared = await loadSharedRelayToken();
    if (shared) adoptRelayTokenIfFresher(shared.token, shared.expiresAtMs);
    return !relayTokenNeedsRenewal();
}

/**
 * One enrolment attempt: at most ONE request to lumastra.org, none when
 * ineligible, when a live token is held (own or adopted from a sibling), while
 * the contact question is unanswered, or while another process holds the call
 * lock (it re-reads the shared slot after taking the lock, so two processes with
 * an empty slot make one request). Never throws. A plugin-isolation worker never
 * gets this far.
 */
export async function enrolRelayTokenOnce(): Promise<EnrolOutcome> {
    const outcome = await enrolAttempt();
    if (outcome !== 'busy') state.busyStreak = 0;
    return outcome;
}

async function enrolAttempt(): Promise<EnrolOutcome> {
    const shutdown = shutdownController.signal;
    state.needsRetry = false;
    state.shortRetryMs = null;
    if (isIsolationWorker()) return 'ineligible';
    let lock: string | null = null;
    try {
        const reason = relayTokenIneligibleReason();
        noteEligibility(reason);
        if (reason !== null) {
            if (!config.LICENSE_SERVER_CONTACT_ENABLED) {
                // An opt-out leaves no token behind, in this process or in the shared slot.
                setRelayToken(null);
                await clearSharedRelayToken();
            }
            return 'ineligible';
        }

        // A restart or a sibling process may already hold a fresh token.
        if (await adoptSharedToken()) return 'fresh';

        const sql = getDb();
        if (!sql) {
            state.needsRetry = true;
            return 'failed';
        }
        if (!(await mayCallNow(sql))) {
            state.needsRetry = true;
            state.retryAfterMs = null;
            return 'waiting-for-answer';
        }

        lock = await acquireEnrolLock();
        if (lock === null) {
            state.busyStreak += 1;
            if (state.busyStreak <= BUSY_BEFORE_LOCKLESS) {
                // A sibling is fetching: look at the shared slot again in a few seconds.
                state.needsRetry = !hasLiveMintedRelayToken();
                state.shortRetryMs = BUSY_RETRY_MS;
                return 'busy';
            }
            // The lock never frees and the shared slot stays empty: the lock
            // service is down. Fetch without it.
            if (!state.loggedLocklessFetch) {
                state.loggedLocklessFetch = true;
                logger.warn(
                    'The push relay token lock is unavailable (coordination Valkey down?); fetching the token without it',
                );
            }
        } else {
            // The holder before us may have stored a token while we waited for the lock.
            if (await adoptSharedToken()) return 'fresh';
        }

        // Without a live token a failure means push is down now: retry soon.
        const pushDownIfFails = !hasLiveMintedRelayToken();
        try {
            const installUuid = await getInstallUuid(sql);
            const res = await postRelayTokenRequest(installUuid, shutdown);
            if (!res.ok) {
                state.needsRetry = pushDownIfFails;
                state.retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
                noteFailure('Push relay token request was not OK', { status: res.status });
                return 'failed';
            }
            const text = await readBodyCapped(res, MAX_RESPONSE_BYTES);
            let data: RelayTokenResponse = {};
            if (text !== null) {
                try {
                    data = JSON.parse(text) as RelayTokenResponse;
                } catch {
                    data = {};
                }
            }
            if (typeof data.relayToken !== 'string' || data.relayToken.length === 0) {
                state.needsRetry = pushDownIfFails;
                noteFailure('lumastra.org returned no push relay token; push stays unavailable', {});
                return 'failed';
            }
            // A claimed expiry must be a real time, in the future, at most about a day away.
            const claimedExpSeconds =
                typeof data.relayTokenExp === 'number' && Number.isFinite(data.relayTokenExp)
                    ? data.relayTokenExp
                    : undefined;
            if (data.relayTokenExp !== undefined && claimedExpSeconds === undefined) {
                state.needsRetry = pushDownIfFails;
                noteFailure('lumastra.org returned a push relay token with an invalid expiry', {});
                return 'failed';
            }
            if (claimedExpSeconds !== undefined) {
                const lifeMs = claimedExpSeconds * 1000 - Date.now();
                if (lifeMs < MIN_USABLE_LIFE_MS || lifeMs > MAX_TOKEN_LIFE_MS) {
                    state.needsRetry = pushDownIfFails;
                    noteFailure('lumastra.org returned a push relay token with an unusable expiry', {
                        lifeSeconds: Math.round(lifeMs / 1000),
                    });
                    return 'failed';
                }
            }
            // Shut down while the request was in flight: keep nothing.
            if (shutdown.aborted) return 'ineligible';
            // The switch may have been flipped while the request was in flight.
            if (relayTokenIneligibleReason() !== null) return 'ineligible';

            // Judge the new token BEFORE it replaces the held one: a token that is
            // (nearly) dead must never cost a still-valid held token.
            const expiresAtMs = relayTokenExpiryMs(data.relayToken, claimedExpSeconds);
            if (expiresAtMs - Date.now() < MIN_USABLE_LIFE_MS) {
                state.needsRetry = true;
                noteFailure('The push relay token from lumastra.org is not usable; will retry', {});
                return 'failed';
            }
            setRelayToken(data.relayToken, claimedExpSeconds);
            noteSuccess();
            await saveSharedRelayToken(data.relayToken, expiresAtMs);
            return 'minted';
        } catch (err) {
            if (err instanceof ContactDisabledError || shutdown.aborted) return 'ineligible';
            state.needsRetry = pushDownIfFails;
            noteFailure('Push relay token request failed (will retry later)', err as Error);
            return 'failed';
        }
    } catch (err) {
        state.needsRetry = true;
        logger.warn('Push relay token enrolment tick failed', err as Error);
        return 'failed';
    } finally {
        if (lock !== null) await releaseEnrolLock(lock);
    }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

let running = false;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let switchOnTimer: ReturnType<typeof setTimeout> | null = null;
let earlyTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<unknown> | null = null;
let rerunAfterInFlight = false;
let lastEarlyRefreshAt = 0;
let unsubscribeInvalidation: (() => void) | null = null;
let unsubscribeConfigChange: (() => void) | null = null;

/** Arm a timer that never keeps the process alive. */
function unrefTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms);
    if (typeof t.unref === 'function') t.unref();
    return t;
}

/** Whether the loop runs in this process. */
export function isRelayTokenEnrolLoopRunning(): boolean {
    return running;
}

/**
 * Start the periodic enrolment loop (idempotent). Main process only: a
 * plugin-isolation worker has no database and must not call anyone.
 */
export function startRelayTokenEnrolLoop(): void {
    if (isIsolationWorker()) return;
    // A stream-proxy-only node has no database: nothing to enrol, nobody to push for.
    if (config.STREAM_PROXY_MODE) return;
    if (running) return;
    running = true;

    // Pick up a token a sibling process or a previous boot already shared, now,
    // so capabilities do not report `no_relay_credential` for the 5-30 s before
    // the first tick. Adopting makes no request. Skipped when this install may
    // not hold a minted token at all (contact off, own relay, ...).
    void (async () => {
        if (relayTokenIneligibleReason() !== null) return;
        const shared = await loadSharedRelayToken();
        if (shared && running && relayTokenIneligibleReason() === null) {
            adoptRelayTokenIfFresher(shared.token, shared.expiresAtMs);
        }
    })();

    const scheduleNext = (ms: number): void => {
        if (!running) return;
        if (loopTimer) clearTimeout(loopTimer);
        loopTimer = unrefTimer(() => {
            loopTimer = null;
            tick();
            scheduleNext(jittered(REFRESH_INTERVAL_MS, INTERVAL_JITTER));
        }, ms);
    };

    const tick = (): void => {
        if (inFlight) {
            // A tick asked for while one runs must not be lost.
            rerunAfterInFlight = true;
            return;
        }
        inFlight = enrolRelayTokenOnce()
            .catch((err: unknown) => {
                logger.warn('Push relay token tick failed', err as Error);
            })
            .finally(() => {
                inFlight = null;
                if (rerunAfterInFlight && running) {
                    rerunAfterInFlight = false;
                    tick();
                    return;
                }
                // No usable token and the call did not work: try again soon rather
                // than in 6 h, jittered, never sooner than the server's Retry-After
                // (capped at the regular interval).
                if (state.needsRetry && running && !retryTimer) {
                    const delay =
                        state.shortRetryMs !== null
                            ? jittered(state.shortRetryMs, RETRY_JITTER)
                            : Math.max(
                                  jittered(RETRY_INTERVAL_MS, RETRY_JITTER),
                                  Math.min(state.retryAfterMs ?? 0, REFRESH_INTERVAL_MS),
                              );
                    retryTimer = unrefTimer(() => {
                        retryTimer = null;
                        tick();
                    }, delay);
                }
            });
    };

    // The relay rejected the minted token (a 401, e.g. it rotated its key): fetch
    // a new one now instead of at the next tick, at most every 15 minutes so a
    // relay that rejects every token cannot turn this into a request loop. A 401
    // inside that window is not lost: a timer runs it when the window ends. The
    // shared copy is dropped first, but only if it is the token that was rejected
    // (a sibling may already have stored a newer one), or the tick would adopt it
    // right back.
    unsubscribeInvalidation = onRelayTokenInvalidated((rejectedToken) => {
        const runEarlyRefresh = (): void => {
            lastEarlyRefreshAt = Date.now();
            logger.info('Push relay rejected the relay token; renewing it early');
            void clearSharedRelayTokenIfEquals(rejectedToken).finally(tick);
        };
        const waitMs = EARLY_REFRESH_MIN_INTERVAL_MS - (Date.now() - lastEarlyRefreshAt);
        if (waitMs <= 0) {
            runEarlyRefresh();
            return;
        }
        if (earlyTimer || !running) return;
        earlyTimer = unrefTimer(() => {
            earlyTimer = null;
            if (running) runEarlyRefresh();
        }, waitMs);
    });

    // Contact switched back on (or the first answer saved): fetch now rather than
    // at the next tick, after the same jitter as the first tick so replicas do not
    // all call at once. Switched off: drop the minted token and its shared copy,
    // so push through the standard relay stops now rather than within 24 h.
    let contactWasEnabled = config.LICENSE_SERVER_CONTACT_ENABLED;
    let contactWasAnswered = contactAnswered();
    unsubscribeConfigChange = onConfigChange(() => {
        const enabled = config.LICENSE_SERVER_CONTACT_ENABLED;
        const answered = contactAnswered();
        const changed = enabled !== contactWasEnabled;
        const newlyAnswered = answered && !contactWasAnswered;
        contactWasEnabled = enabled;
        contactWasAnswered = answered;
        if ((!changed && !(newlyAnswered && enabled)) || !running) return;
        if (!enabled) {
            logger.info('Contact with lumastra.org switched off; dropping the push relay token');
            setRelayToken(null);
            void clearSharedRelayToken();
            return;
        }
        logger.info('Contact with lumastra.org switched on; fetching the push relay token soon');
        if (switchOnTimer) clearTimeout(switchOnTimer);
        switchOnTimer = unrefTimer(
            () => {
                switchOnTimer = null;
                tick();
            },
            Math.round(Math.random() * FIRST_TICK_JITTER_MS),
        );
    });

    scheduleNext(FIRST_TICK_DELAY_MS + Math.round(Math.random() * FIRST_TICK_JITTER_MS));
}

/** Stop the loop and reset its state (tests, shutdown). */
export function stopRelayTokenEnrolLoop(): void {
    running = false;
    // Abort a request that is in flight; its answer is dropped.
    shutdownController.abort();
    shutdownController = new AbortController();
    for (const t of [loopTimer, retryTimer, switchOnTimer, earlyTimer]) if (t) clearTimeout(t);
    loopTimer = null;
    retryTimer = null;
    switchOnTimer = null;
    earlyTimer = null;
    unsubscribeInvalidation?.();
    unsubscribeInvalidation = null;
    unsubscribeConfigChange?.();
    unsubscribeConfigChange = null;
    rerunAfterInFlight = false;
    lastEarlyRefreshAt = 0;
    inFlight = null;
    state.failureStreak = 0;
    state.lastFailureWarnAt = 0;
    state.retryAfterMs = null;
    state.shortRetryMs = null;
    state.needsRetry = false;
    state.loggedWaiting = false;
    state.busyStreak = 0;
    state.loggedLocklessFetch = false;
    lastEligibilityNote = undefined;
}
