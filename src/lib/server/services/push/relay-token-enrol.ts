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
 * Coexistence with the legacy licence loop (until it is removed): while this
 * loop runs in a process, `wantsLicenceMintedRelayToken()` answers false, so the
 * licence loop of that process never mints a token too.
 *
 * @module services/push/relay-token-enrol
 */

import { config } from '$lib/server/config.js';
import { getConfigState, isEnvOverridden, onConfigChange } from '$lib/server/config/index.js';
import { getDb } from '$lib/server/database';
import { getInstallUuid } from '$lib/server/database/queries/license-install.queries.js';
import { isFirstRunSetupOlderThan } from '$lib/server/database/queries/onboarding.queries.js';
import { isIsolationWorker } from '$lib/server/tasks/isolation/isolation-context.js';
import { Logger } from '$lib/server/utils/logger.js';
import { currentPushTransportSelection } from './push-transport-selector.js';
import {
    adoptRelayTokenIfFresher,
    hasLiveMintedRelayToken,
    heldRelayTokenExpiresAtMs,
    onRelayTokenInvalidated,
    relayTokenNeedsRenewal,
    setRelayEnrolLoopActive,
    setRelayToken,
} from './relay-token.store.js';
import {
    clearSharedRelayToken,
    loadSharedRelayToken,
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
 * Whether this install should get a relay token from lumastra.org at all, ignoring
 * whether one is held: push on, relay delivery, default relay, no own token,
 * contact switched on. Pure config, no I/O.
 */
export function relayTokenEnrolEligible(): boolean {
    if (!config.FEATURE_PUSH_NOTIFICATIONS) return false;
    if (!config.LICENSE_SERVER_CONTACT_ENABLED) return false;
    if (config.PUSH_RELAY_TOKEN.trim().length > 0) return false;
    if (currentPushTransportSelection().kind !== 'relay') return false;
    try {
        return new URL(config.PUSH_RELAY_URL).origin === new URL(DEFAULT_RELAY_ORIGIN).origin;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

export type EnrolOutcome =
    /** Not eligible (push off, contact off, own relay or own token). Nothing sent. */
    | 'ineligible'
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
    needsRetry: boolean;
    loggedWaiting: boolean;
}

const state: EnrolState = {
    failureStreak: 0,
    lastFailureWarnAt: 0,
    retryAfterMs: null,
    needsRetry: false,
    loggedWaiting: false,
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
async function postRelayTokenRequest(installUuid: string): Promise<Response> {
    if (!config.LICENSE_SERVER_CONTACT_ENABLED) throw new ContactDisabledError();
    // RELAY_TOKEN_ENDPOINT is a hardcoded Lumastra-operated vendor endpoint, not
    // admin-configurable (see docs/dev/eslint-exceptions.md, same class as the
    // former licence endpoint).
    // eslint-disable-next-line callback-safety/no-bare-fetch-in-server
    return fetch(RELAY_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ install_uuid: installUuid, app_version: config.APP_VERSION }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
}

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

/**
 * One enrolment attempt: at most ONE request to lumastra.org, none when
 * ineligible, when a live token is held (own or adopted from a sibling), or
 * while the contact question is unanswered. Never throws.
 */
export async function enrolRelayTokenOnce(): Promise<EnrolOutcome> {
    state.needsRetry = false;
    try {
        if (!relayTokenEnrolEligible()) return 'ineligible';

        // A restart or a sibling process may already hold a fresh token.
        const shared = await loadSharedRelayToken();
        if (shared) adoptRelayTokenIfFresher(shared.token, shared.expiresAtMs);
        if (!relayTokenNeedsRenewal()) return 'fresh';

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

        // Without a live token a failure means push is down now: retry soon.
        const pushDownIfFails = !hasLiveMintedRelayToken();
        try {
            const installUuid = await getInstallUuid(sql);
            const res = await postRelayTokenRequest(installUuid);
            if (!res.ok) {
                state.needsRetry = pushDownIfFails;
                state.retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
                noteFailure('Push relay token request was not OK', { status: res.status });
                return 'failed';
            }
            const data = (await res.json()) as RelayTokenResponse;
            if (typeof data.relayToken !== 'string' || data.relayToken.length === 0) {
                state.needsRetry = pushDownIfFails;
                noteFailure(
                    'lumastra.org returned no push relay token; push stays unavailable',
                    {},
                );
                return 'failed';
            }
            noteSuccess();
            setRelayToken(
                data.relayToken,
                typeof data.relayTokenExp === 'number' ? data.relayTokenExp : undefined,
            );
            const expiresAtMs = heldRelayTokenExpiresAtMs();
            if (expiresAtMs !== null) await saveSharedRelayToken(data.relayToken, expiresAtMs);
            return 'minted';
        } catch (err) {
            if (err instanceof ContactDisabledError) return 'ineligible';
            state.needsRetry = pushDownIfFails;
            noteFailure('Push relay token request failed (will retry later)', err as Error);
            return 'failed';
        }
    } catch (err) {
        state.needsRetry = true;
        logger.warn('Push relay token enrolment tick failed', err as Error);
        return 'failed';
    }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

let running = false;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let switchOnTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (running) return;
    running = true;
    setRelayEnrolLoopActive(true);

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
                    const delay = Math.max(
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
    // a new one now instead of at the next tick, rate-limited so a relay that
    // rejects every token cannot turn this into a request loop. The shared copy
    // is dropped first, or the tick would adopt it right back.
    unsubscribeInvalidation = onRelayTokenInvalidated(() => {
        const now = Date.now();
        if (now - lastEarlyRefreshAt < EARLY_REFRESH_MIN_INTERVAL_MS) return;
        lastEarlyRefreshAt = now;
        logger.info('Push relay rejected the relay token; renewing it early');
        void clearSharedRelayToken().finally(tick);
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
            void clearSharedRelayToken().catch(() => {});
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
    setRelayEnrolLoopActive(false);
    for (const t of [loopTimer, retryTimer, switchOnTimer]) if (t) clearTimeout(t);
    loopTimer = null;
    retryTimer = null;
    switchOnTimer = null;
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
    state.needsRetry = false;
    state.loggedWaiting = false;
}
