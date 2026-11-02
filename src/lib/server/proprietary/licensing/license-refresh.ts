// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * License auto-enrol + refresh loop (proprietary).
 *
 * When enforcement is on and the stored license is missing, invalid, expired, or
 * expiring soon, this pings the licensing server with ONLY the deployment's
 * install UUID and the app version (no library data, no prompts —
 * privacy-clean) and stores the freshly-signed key it returns. With no stored
 * key it calls `/api/license/issue` (enrolment), otherwise `/refresh`. During
 * early access the server issues every install an early-access key that ends
 * on one global date; after it, the free tier — old app versions still demand
 * a license, so the lever stays effective.
 *
 * The same call also returns the ≤24h push relay token (relay-token.store.ts).
 * So the loop ALSO calls the server when push wants a token
 * (`wantsLicenceMintedRelayToken()`: push on, default relay, no configured
 * PUSH_RELAY_TOKEN, token missing or due) — even when the license is valid or
 * enforcement is off. That relay-only call stores the relay token and never
 * the license key, which the server re-signs on every call. A relay 401 also
 * triggers an early refresh (at most every {@link EARLY_REFRESH_MIN_INTERVAL_MS}).
 *
 * WEEKLY CHECK-IN. A valid licence that makes no other call (push off, or its
 * relay token fresh) still calls `/refresh` about once a week
 * (license-check-in.ts), so the licensing server can count running installs.
 * The check-in (and the relay-token call, for a valid licence) stores the
 * returned key only when it verifies and changes nothing but a later `exp` (a
 * moved early-access cutoff); anything else — a failure, a 4xx/5xx, another
 * tier or module set, an earlier `exp` — leaves the key and the entitlements
 * exactly as they are. A failed check-in is retried after a day. Enforcement
 * off, or `LICENSE_CHECK_IN_ENABLED` off, means no check-in; with it off, a
 * moved early-access cutoff is picked up only in the 14-day renewal window
 * (or by a relay-token call).
 *
 * CONTACT OFF. `LICENSE_SERVER_CONTACT_ENABLED` off means NO call at all:
 * no enrolment, no renewal, no check-in, no relay token. The tick still
 * writes its local status line. {@link postRefresh} refuses on its own as
 * well, so a future caller (or a switch flipped mid-tick) cannot slip past it.
 * license.service then runs a key-less install on the free tier at once.
 * Switching it off also drops the held relay token; switching it back on runs
 * a tick within {@link FIRST_TICK_JITTER_MS} instead of at the next 6h tick.
 *
 * The first tick runs a few seconds after boot (hooks.server.ts loads this
 * module at startup). While the install has no usable key, a failed attempt is
 * retried after {@link RETRY_INTERVAL_MS} rather than the 6h interval, and the
 * failure is logged at warn once, then at debug until it recovers (or a day
 * passes) — an offline install must not fill its log.
 *
 * FIRST CALL WAITS FOR AN ANSWER. An install with no key does not call the
 * server until the operator has answered whether to contact lumastra.org:
 * `LICENSE_SERVER_CONTACT_ENABLED` set in the environment, or stored in
 * settings.json (the setup wizard always stores it, even when on; so does a
 * save in Admin → Settings). An install set up without the wizard gets a
 * fallback: the first admin is {@link ENROLMENT_SETUP_FALLBACK_MS} old. So
 * turning contact off in the wizard means nothing was ever sent. Until then
 * the no-key grace of license.service applies, the loop re-checks every
 * {@link RETRY_INTERVAL_MS}, and the answer arriving starts a tick at once.
 * An install that has a key is not affected.
 *
 * The loop is fail-safe: a server outage simply leaves the existing key in place
 * (the grace window in license.service keeps a just-expired key working), and
 * every error is swallowed. It NEVER degrades anyone on its own.
 */

import { decodeJwt } from 'jose';
import { config } from '$lib/server/config';
import {
    getConfigState,
    isEnvOverridden,
    onConfigChange,
    saveConfig,
} from '$lib/server/config/index.js';
import { isIsolationWorker } from '$lib/server/tasks/isolation/isolation-context.js';
import { getDb } from '$lib/server/database';
import { getInstallUuid } from '$lib/server/database/queries/license-install.queries.js';
import { isFirstRunSetupOlderThan } from '$lib/server/database/queries/onboarding.queries.js';
import { Logger } from '$lib/server/utils/logger';
import { clearLicenseCache, getStatus, verifyLicenseKey } from './license.service.js';
import type { Entitlements } from '$lib/server/licensing/entitlements.js';
import { checkInDue, noteCheckInFailure, noteLicenseServerContact } from './license-check-in.js';
import { LICENSE_SERVER_URL } from './license-server.js';
import {
    adoptRelayTokenIfFresher,
    hasLiveMintedRelayToken,
    heldRelayTokenExpiresAtMs,
    onRelayTokenInvalidated,
    setRelayToken,
} from '$lib/server/services/push/relay-token.store.js';
import {
    clearSharedRelayToken,
    loadSharedRelayToken,
    saveSharedRelayToken,
} from '$lib/server/services/push/relay-token.shared.js';
import { wantsLicenceMintedRelayToken } from '$lib/server/services/push/push-transport-selector.js';
import {
    collectInstallDiagnostics,
    collectDisabledDiagnostics,
    statusCorrelationId,
} from './diagnostics.js';

const logger = Logger.for('LicenseRefresh');

/** How often the background loop re-checks (and renews if needed). */
export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
/** Retry delay after a failed attempt while the install has no usable key. */
export const RETRY_INTERVAL_MS = 30 * 60 * 1000; // 30min
/**
 * Fallback for an install set up without the wizard: with no stored answer to
 * the contact question, the first call waits until the first admin is this old.
 */
export const ENROLMENT_SETUP_FALLBACK_MS = 24 * 60 * 60 * 1000; // 24h

const CONTACT_KEY = 'LICENSE_SERVER_CONTACT_ENABLED';
let loggedWaitingForAnswer = false;

/** The operator answered the contact question (environment, wizard or admin save). */
function contactAnswered(): boolean {
    return (
        isEnvOverridden(CONTACT_KEY) || getConfigState()?.jsonOverrides.has(CONTACT_KEY) === true
    );
}

/**
 * Whether an install WITHOUT a key may make its first call. False while the
 * contact question is unanswered and setup is younger than the fallback;
 * never throws (an unknown state counts as not yet).
 */
async function firstCallAllowed(sql: NonNullable<ReturnType<typeof getDb>>): Promise<boolean> {
    let allowed = contactAnswered();
    if (!allowed) {
        try {
            allowed = await isFirstRunSetupOlderThan(sql, ENROLMENT_SETUP_FALLBACK_MS);
        } catch (err) {
            logger.debug('Licence: setup state unknown; not contacting the licensing server yet', {
                error: err instanceof Error ? err.message : String(err),
            });
            allowed = false;
        }
    }
    if (allowed) {
        loggedWaitingForAnswer = false;
    } else if (!loggedWaitingForAnswer) {
        loggedWaitingForAnswer = true;
        logger.info(
            'Licence: waiting for the setup wizard to ask about contacting lumastra.org before the first call',
        );
    }
    return allowed;
}
/**
 * The first tick runs this long after boot plus up to {@link FIRST_TICK_JITTER_MS}.
 * The jitter spreads installs that boot together (a host reboot, a release-day
 * image pull) so they neither hit the per-IP rate limit at lumastra.org as one
 * burst nor stay in lockstep on every later tick.
 */
export const FIRST_TICK_DELAY_MS = 5_000;
export const FIRST_TICK_JITTER_MS = 25_000;
/** ± fraction applied to the 6h interval and the retry delay. */
const INTERVAL_JITTER = 0.1;
const RETRY_JITTER = 0.2;
/** A failure is re-logged at warn at most this often. */
const FAILURE_WARN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
/** Network timeout for a single refresh request. */
const REFRESH_TIMEOUT_MS = 10_000;

/** `base` spread by ±`fraction`, uniformly. */
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

let running = false;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeInvalidation: (() => void) | null = null;
let unsubscribeConfigChange: (() => void) | null = null;
let switchOnTimer: ReturnType<typeof setTimeout> | null = null;
/** A tick was requested while another was in flight. */
let rerunAfterInFlight = false;
/** When a relay-token rejection last triggered an early refresh. */
let lastEarlyRefreshAt = 0;
/** A relay 401 triggers an early refresh at most this often. */
export const EARLY_REFRESH_MIN_INTERVAL_MS = 15 * 60 * 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<unknown> | null = null;

/** Consecutive failed attempts, and when one was last logged at warn. */
let failureStreak = 0;
let lastFailureWarnAt = 0;
/** Whether the last attempt failed while the install had no usable key. */
let lastAttemptNeedsRetry = false;
/** A `Retry-After` from the last non-OK answer (ms), honoured by the next retry. */
let retryAfterMs: number | null = null;

/** What the admin page shows about contact with the licensing server. */
export interface LicenseRefreshState {
    /** Last time the server answered 200 (this process), ISO. */
    lastSuccessAt: string | null;
    /** Start of the current failure streak, ISO; null when the last attempt worked. */
    failingSince: string | null;
    /** Consecutive failed attempts. */
    failedAttempts: number;
    /** `http-<status>` or `unreachable` for the last failure. */
    lastFailure: string | null;
    /** When this process will try again, ISO; null when no attempt is scheduled. */
    nextAttemptAt: string | null;
    /** Last completed tick, ISO — a tick that needed no call still counts. */
    checkedAt: string | null;
}

let lastSuccessAt: number | null = null;
let failingSince: number | null = null;
let lastFailure: string | null = null;
let nextAttemptAt: number | null = null;
let checkedAt: number | null = null;

export function getLicenseRefreshState(): LicenseRefreshState {
    const iso = (ms: number | null): string | null =>
        ms === null ? null : new Date(ms).toISOString();
    return {
        lastSuccessAt: iso(lastSuccessAt),
        failingSince: iso(failingSince),
        failedAttempts: failureStreak,
        lastFailure,
        nextAttemptAt: iso(nextAttemptAt),
        checkedAt: iso(checkedAt),
    };
}

/**
 * Log a failed refresh: warn on the first failure of a streak and then at most
 * once a day, debug otherwise. A 404/503/unreachable server repeats every
 * tick for as long as it lasts; one warning says everything the rest would.
 */
function logRefreshFailure(message: string, meta: Record<string, unknown> | Error): void {
    // Contact switched off while this tick was under way: the operator's
    // choice, not a failure (no warning, no streak, no quick retry).
    if (meta instanceof LicenseServerContactDisabledError) {
        lastAttemptNeedsRetry = false;
        return;
    }
    failureStreak += 1;
    const now = Date.now();
    failingSince ??= now;
    lastFailure =
        meta instanceof Error || typeof meta.status !== 'number'
            ? 'unreachable'
            : `http-${meta.status}`;
    if (failureStreak === 1 || now - lastFailureWarnAt >= FAILURE_WARN_INTERVAL_MS) {
        lastFailureWarnAt = now;
        logger.warn(
            failureStreak === 1 ? message : `${message} (still failing, ${failureStreak} attempts)`,
            meta,
        );
    } else {
        logger.debug(message, meta);
    }
}

function noteRefreshSuccess(): void {
    if (failureStreak > 0) {
        logger.info('License server reachable again', { failedAttempts: failureStreak });
    }
    failureStreak = 0;
    lastFailureWarnAt = 0;
    lastSuccessAt = Date.now();
    failingSince = null;
    lastFailure = null;
    retryAfterMs = null;
}

/** Remember a non-OK answer's `Retry-After` for the next retry. */
function noteRetryAfter(res: Response): void {
    retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
}

/** Unverified read of a JWT's `exp` (seconds). Verification happens in license.service. */
function unverifiedExp(token: string): number | null {
    try {
        const exp = decodeJwt(token).exp;
        return typeof exp === 'number' ? exp : null;
    } catch {
        return null;
    }
}

interface RefreshResponse {
    license_key?: string;
    key?: string;
    /**
     * Short-lived (≤24h) relay-scoped push credential, minted alongside the
     * license key on every issue/refresh. NOT the license JWT — see
     * relay-token.store.ts for why a separate, short-lived credential exists.
     */
    relayToken?: string;
    /** `relayToken`'s expiry, unix seconds. */
    relayTokenExp?: number;
}

/** Thrown by {@link postRefresh} when the operator switched contact off. */
export class LicenseServerContactDisabledError extends Error {
    constructor() {
        super('Contact with the licensing server is switched off');
        this.name = 'LicenseServerContactDisabledError';
    }
}

/**
 * POST the refresh (or, with no stored key, the enrolment) request. Throws on
 * network error, and {@link LicenseServerContactDisabledError} when
 * `LICENSE_SERVER_CONTACT_ENABLED` is off (callers check first; this is the
 * backstop at the one place a request leaves); the caller handles it. `rc` is omitted when undefined — the
 * enforcement-off relay-only call sends no status code at all (its diagnostic
 * codes are local-log only; LICENSING.md §3b). `app_version` is the build's
 * version string; the server keeps only its release part for install counts.
 */
async function postRefresh(
    installUuid: string,
    rc: number | undefined,
    endpoint: 'issue' | 'refresh' = 'refresh',
): Promise<Response> {
    if (!config.LICENSE_SERVER_CONTACT_ENABLED) throw new LicenseServerContactDisabledError();
    const url = `${LICENSE_SERVER_URL}/api/license/${endpoint}`;
    // C22 fix-plan finding scope: LICENSE_SERVER_URL is a hardcoded
    // Lumastra-operated vendor endpoint, not admin-configurable — not
    // the "admin-configured or credentialed private host" class the
    // same-origin-only guard is for. See docs/dev/eslint-exceptions.md.
    // eslint-disable-next-line callback-safety/no-bare-fetch-in-server
    return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
            install_uuid: installUuid,
            ...(rc === undefined ? {} : { rc }),
            app_version: config.APP_VERSION,
        }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
}

/**
 * Hand a returned relay token to the push store and share it with the
 * install's other processes (and its next boot). True when one was present.
 */
async function storeRelayToken(data: RefreshResponse): Promise<boolean> {
    if (typeof data.relayToken !== 'string' || data.relayToken.length === 0) return false;
    setRelayToken(
        data.relayToken,
        typeof data.relayTokenExp === 'number' ? data.relayTokenExp : undefined,
    );
    const expiresAtMs = heldRelayTokenExpiresAtMs();
    if (expiresAtMs !== null) await saveSharedRelayToken(data.relayToken, expiresAtMs);
    return true;
}

/**
 * Adopt the relay token a sibling process or a previous boot already minted,
 * when it outlives ours. Runs before every "does push need a token?" decision,
 * so a restart or a second process does not call the server for one.
 */
async function syncSharedRelayToken(): Promise<void> {
    const shared = await loadSharedRelayToken();
    if (shared) adoptRelayTokenIfFresher(shared.token, shared.expiresAtMs);
}

/** What a VALID licence is compared against before a returned key replaces it. */
interface CurrentLicense {
    tier: string;
    expiresAt: string | null;
    entitlements: Entitlements;
}

/** Same edition, caps, seat policy and module set. */
function sameEntitlements(a: Entitlements, b: Entitlements): boolean {
    return (
        a.edition === b.edition &&
        a.jellyfinMaxConcurrentStreams === b.jellyfinMaxConcurrentStreams &&
        a.aiAssistant === b.aiAssistant &&
        a.maxSeats === b.maxSeats &&
        a.seatOverflowPolicy === b.seatOverflowPolicy &&
        a.modules.size === b.modules.size &&
        [...a.modules].every((m) => b.modules.has(m))
    );
}

/**
 * Store a key returned for a VALID licence only when it changes nothing but
 * the expiry: it verifies for this install, has the same tier and the same
 * entitlements, and a later `exp` (the early-access cutoff was moved). Any
 * other key waits for the regular renewal. `keyAtStart` is the key the call
 * was judged against; if an admin pasted another meanwhile, nothing is stored.
 * True when a key was stored. Throws only what saveConfig throws.
 */
async function adoptLaterKey(
    data: RefreshResponse,
    installUuid: string,
    current: CurrentLicense,
    keyAtStart: string,
): Promise<boolean> {
    const newKey = data.license_key ?? data.key;
    if (typeof newKey !== 'string' || !newKey || newKey === keyAtStart) return false;
    const currentExpMs = current.expiresAt ? Date.parse(current.expiresAt) : NaN;
    let next: Awaited<ReturnType<typeof verifyLicenseKey>>;
    try {
        next = await verifyLicenseKey(newKey, installUuid);
    } catch {
        return false; // documented never to throw; a key we cannot judge is not stored
    }
    const nextExpMs = next.expiresAt ? Date.parse(next.expiresAt) : NaN;
    if (
        next.validity !== 'valid' ||
        !Number.isFinite(currentExpMs) ||
        !(nextExpMs > currentExpMs)
    ) {
        return false;
    }
    if (next.tier !== current.tier || !sameEntitlements(next.entitlements, current.entitlements)) {
        logger.info(
            'License server returned a key with other entitlements; it applies at renewal',
            {
                current: current.tier,
                returned: next.tier,
            },
        );
        return false;
    }
    if (config.LICENSE_KEY !== keyAtStart) return false;
    await saveConfig({ LICENSE_KEY: newKey });
    clearLicenseCache();
    logger.info('Stored a license key with a later expiry');
    return true;
}

/**
 * The call made ONLY for the push relay token: the license itself needs
 * nothing (valid, or enforcement off). Stores the relay token. LICENSE_KEY is
 * left alone unless `current` is given (enforcement on, valid licence) and the
 * returned key only moves `exp` later ({@link adoptLaterKey}) — the server
 * re-signs on every call, so storing every key would rewrite settings every
 * six hours for nothing. True when a key was stored.
 */
async function refreshRelayTokenOnly(
    installUuid: string,
    rc: number | undefined,
    current?: CurrentLicense,
): Promise<boolean> {
    // Without a live token, a failure means push is down now: retry soon.
    const pushDownIfFails = !hasLiveMintedRelayToken();
    const keyAtStart = config.LICENSE_KEY;
    try {
        const res = await postRefresh(installUuid, rc);
        if (!res.ok) {
            lastAttemptNeedsRetry = pushDownIfFails;
            noteRetryAfter(res);
            logRefreshFailure('Push relay token refresh was not OK', { status: res.status });
            return false;
        }
        const data = (await res.json()) as RefreshResponse;
        noteRefreshSuccess();
        await noteLicenseServerContact();
        if (!(await storeRelayToken(data))) {
            logger.warn('License server returned no push relay token; push stays unavailable');
        }
        return current ? await adoptLaterKey(data, installUuid, current, keyAtStart) : false;
    } catch (err) {
        lastAttemptNeedsRetry = pushDownIfFails;
        logRefreshFailure('Push relay token refresh failed (will retry later)', err as Error);
        return false;
    }
}

/**
 * The weekly check-in for a VALID licence (see the module header). A failure
 * is logged like any refresh failure and the next attempt waits a day
 * (license-check-in.ts) — never the 30 min retry, since nothing is broken.
 * A returned key is stored only through {@link adoptLaterKey}. True when a
 * key was stored.
 */
async function checkIn(installUuid: string, rc: number, current: CurrentLicense): Promise<boolean> {
    const keyAtStart = config.LICENSE_KEY;
    try {
        const res = await postRefresh(installUuid, rc);
        if (!res.ok) {
            // No noteRetryAfter: a check-in is never retried sooner than a
            // day, and a stale value would stretch a later enrolment retry.
            noteCheckInFailure();
            logRefreshFailure('License check-in was not OK', { status: res.status });
            return false;
        }
        const data = (await res.json()) as RefreshResponse;
        noteRefreshSuccess();
        await noteLicenseServerContact();
        await storeRelayToken(data);
        return await adoptLaterKey(data, installUuid, current, keyAtStart);
    } catch (err) {
        noteCheckInFailure();
        logRefreshFailure('License check-in failed (will retry later)', err as Error);
        return false;
    }
}

/**
 * Refresh the license now if the current state warrants it. Returns true when a
 * new key was stored. Never throws.
 */
export async function maybeRefreshLicense(): Promise<boolean> {
    // Gate off: no enrol, no network. Still emit the routine local status line so
    // its shape stays constant across states; the correlation id carries the rest.
    // The one exception to "no network": push still needs its relay token.
    if (!config.LICENSE_ENFORCEMENT_ENABLED) {
        lastAttemptNeedsRetry = false;
        try {
            const sql = getDb();
            if (sql) {
                const rc = await collectDisabledDiagnostics(sql);
                const installUuid = await getInstallUuid(sql);
                logger.info('license status refreshed', {
                    install: installUuid,
                    validity: 'free-tier',
                    cid: statusCorrelationId(installUuid, 'free-tier', rc),
                });
                // No rc: the enforcement-off codes never leave the machine.
                // Contact off: not even the relay token (push via the standard
                // relay then stays unavailable).
                // No key yet: the relay-token call waits for the contact answer
                // too, and is retried like a first enrolment.
                const allowed =
                    config.LICENSE_SERVER_CONTACT_ENABLED &&
                    (config.LICENSE_KEY !== '' || (await firstCallAllowed(sql)));
                if (config.LICENSE_SERVER_CONTACT_ENABLED && !allowed) {
                    lastAttemptNeedsRetry = true;
                    retryAfterMs = null;
                }
                if (allowed) {
                    await syncSharedRelayToken();
                    if (wantsLicenceMintedRelayToken())
                        await refreshRelayTokenOnly(installUuid, undefined);
                }
            }
        } catch {
            // never disrupt
        }
        return false;
    }

    try {
        const sql = getDb();
        if (!sql) return false;
        const status = await getStatus();
        const installUuid = await getInstallUuid(sql);
        const rc = await collectInstallDiagnostics(sql);

        // Status line emitted on every tick (valid or not), so its shape is
        // routine; the correlation id is what varies.
        logger.info('license status refreshed', {
            install: installUuid,
            validity: status.validity,
            cid: statusCorrelationId(installUuid, status.validity, rc),
        });

        lastAttemptNeedsRetry = false;
        // Contact off (Admin → Settings → General → Licensing, or /setup): no
        // enrolment, renewal, check-in or relay token. license.service already
        // answers with the free tier (or the stored key until it expires).
        if (!config.LICENSE_SERVER_CONTACT_ENABLED) return false;

        // No key yet: the first call waits until the operator answered whether
        // to contact lumastra.org at all. Re-checked after RETRY_INTERVAL_MS
        // (a stale Retry-After must not stretch that), and at once when the
        // answer is saved.
        if (!config.LICENSE_KEY && !(await firstCallAllowed(sql))) {
            lastAttemptNeedsRetry = true;
            retryAfterMs = null;
            return false;
        }

        // The license renews only when not cleanly valid (missing/invalid/
        // expired/expiring-soon). A valid license with push due a relay token
        // makes a relay-only call that leaves LICENSE_KEY alone; otherwise it
        // checks in about once a week.
        await syncSharedRelayToken();
        if (status.validity === 'valid') {
            const current: CurrentLicense = {
                tier: status.tier,
                expiresAt: status.expiresAt,
                entitlements: status.entitlements,
            };
            if (wantsLicenceMintedRelayToken()) {
                return await refreshRelayTokenOnly(installUuid, rc, current);
            }
            // Admin → Settings → Diagnostics (or /setup) can turn the check-in off;
            // renewals and the relay token above are not affected.
            if (config.LICENSE_CHECK_IN_ENABLED && (await checkInDue())) {
                return await checkIn(installUuid, rc, current);
            }
            return false;
        }
        // No usable key → a failure below schedules a quick retry.
        const unlicensed = status.validity !== 'expiring-soon';

        // No stored key → this is the install's enrolment.
        const endpoint = config.LICENSE_KEY ? 'refresh' : 'issue';
        const res = await postRefresh(installUuid, rc, endpoint);

        if (!res.ok) {
            lastAttemptNeedsRetry =
                unlicensed || (wantsLicenceMintedRelayToken() && !hasLiveMintedRelayToken());
            noteRetryAfter(res);
            logRefreshFailure('License refresh request was not OK', {
                status: res.status,
                url: `${LICENSE_SERVER_URL}/api/license/${endpoint}`,
            });
            return false;
        }
        noteRefreshSuccess();
        await noteLicenseServerContact();

        const data = (await res.json()) as RefreshResponse;
        await storeRelayToken(data);

        const newKey = data.license_key ?? data.key;
        if (!newKey || typeof newKey !== 'string') {
            logger.warn('License refresh response had no license_key');
            return false;
        }

        if (newKey === config.LICENSE_KEY) {
            // Server returned the same key (already current) — nothing to do.
            return false;
        }

        // Early-access keys all end on one global date, so a renewal of a key
        // that is expiring soon (or already expired) can return a key with the
        // SAME exp. Storing it would rewrite settings on every attempt — every
        // 6h for two weeks, or every 30min while expired — and change nothing.
        if (
            (status.validity === 'expiring-soon' || status.validity === 'expired') &&
            status.expiresAt
        ) {
            const newExp = unverifiedExp(newKey);
            if (newExp !== null && newExp * 1000 <= Date.parse(status.expiresAt)) {
                logger.debug('License refresh returned no later expiry; keeping the current key');
                return false;
            }
        }

        await saveConfig({ LICENSE_KEY: newKey });
        clearLicenseCache();
        logger.info('Stored refreshed license key from licensing server');
        return true;
    } catch (err) {
        // Transient outage / network error — keep the existing key, do not degrade.
        lastAttemptNeedsRetry = true;
        logRefreshFailure('License refresh failed (will retry later)', err as Error);
        return false;
    }
}

/** Arm a timer that never keeps the process alive. */
function unrefTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms);
    if (typeof t.unref === 'function') t.unref();
    return t;
}

/**
 * Start the periodic refresh loop (idempotent). The first tick runs
 * {@link FIRST_TICK_DELAY_MS} plus a random share of {@link FIRST_TICK_JITTER_MS}
 * after boot, then every {@link REFRESH_INTERVAL_MS} ±10 %.
 */
export function startLicenseRefreshLoop(): void {
    // Main-process only — a tick may saveConfig({ LICENSE_KEY }), a sealed-secret
    // write a plugin-isolation worker cannot make (no master key there; B1).
    if (isIsolationWorker()) return;
    if (running) return;
    running = true;

    const scheduleNext = (ms: number): void => {
        if (!running) return;
        if (loopTimer) clearTimeout(loopTimer);
        nextAttemptAt = Date.now() + ms;
        loopTimer = unrefTimer(() => {
            loopTimer = null;
            tick();
            scheduleNext(jittered(REFRESH_INTERVAL_MS, INTERVAL_JITTER));
        }, ms);
    };

    const tick = (): void => {
        if (inFlight) {
            // A tick asked for while one runs (contact just switched on) must
            // not be lost; it runs once the current one is done.
            rerunAfterInFlight = true;
            return;
        }
        inFlight = maybeRefreshLicense()
            .catch((err) => {
                logger.warn('License refresh tick failed', err as Error);
            })
            // `finally` so a future throw in the catch can't strand `inFlight` set
            // (which would silently stop all further refresh ticks).
            .finally(() => {
                inFlight = null;
                checkedAt = Date.now();
                if (rerunAfterInFlight && running) {
                    rerunAfterInFlight = false;
                    tick();
                    return;
                }
                // No usable key and the server did not answer: try again soon
                // rather than in 6h, so a fresh install enrols shortly after
                // the network / licensing server comes back. Jittered so
                // installs that failed together do not all come back together,
                // and never sooner than the server's Retry-After (capped at
                // the regular interval).
                if (lastAttemptNeedsRetry && running && !retryTimer) {
                    const delay = Math.max(
                        jittered(RETRY_INTERVAL_MS, RETRY_JITTER),
                        Math.min(retryAfterMs ?? 0, REFRESH_INTERVAL_MS),
                    );
                    nextAttemptAt = Math.min(nextAttemptAt ?? Infinity, Date.now() + delay);
                    retryTimer = unrefTimer(() => {
                        retryTimer = null;
                        tick();
                    }, delay);
                }
            });
    };

    // The relay rejected the minted token (a 401 — e.g. the relay rotated its
    // key): fetch a new one now instead of at the next 6h tick, rate-limited so
    // a relay that rejects every token cannot turn this into a request loop.
    // The shared copy is dropped first, or the tick would adopt it right back.
    unsubscribeInvalidation = onRelayTokenInvalidated(() => {
        const now = Date.now();
        if (now - lastEarlyRefreshAt < EARLY_REFRESH_MIN_INTERVAL_MS) return;
        lastEarlyRefreshAt = now;
        logger.info('Push relay rejected the relay token; refreshing it early');
        void clearSharedRelayToken().finally(tick);
    });

    // Contact switched back on: enrol or fetch the relay token now rather than
    // at the next 6h tick. Fires in every process after the save's reload, so
    // the call waits the same jitter as the first tick: replicas do not all
    // call at once. Switched off: drop the licence-minted relay token too, so
    // push through the standard relay stops now rather than within 24h.
    let contactWasEnabled = config.LICENSE_SERVER_CONTACT_ENABLED;
    let contactWasAnswered = contactAnswered();
    unsubscribeConfigChange = onConfigChange(() => {
        const enabled = config.LICENSE_SERVER_CONTACT_ENABLED;
        const answered = contactAnswered();
        const changed = enabled !== contactWasEnabled;
        // The wizard stores "on" (the default): no change of value, but the
        // first call it was waiting for may go out now.
        const newlyAnswered = answered && !contactWasAnswered;
        contactWasEnabled = enabled;
        contactWasAnswered = answered;
        if ((!changed && !(newlyAnswered && enabled)) || !running) return;
        clearLicenseCache();
        if (!enabled) {
            logger.info('Contact with the licensing server switched off');
            setRelayToken(null);
            void clearSharedRelayToken().catch(() => {});
            return;
        }
        logger.info('Contact with the licensing server switched on; checking the license soon');
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

/** Stop the loop (for tests / shutdown). */
export function stopLicenseRefreshLoop(): void {
    running = false;
    if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
    }
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    unsubscribeInvalidation?.();
    unsubscribeInvalidation = null;
    unsubscribeConfigChange?.();
    unsubscribeConfigChange = null;
    if (switchOnTimer) {
        clearTimeout(switchOnTimer);
        switchOnTimer = null;
    }
    rerunAfterInFlight = false;
    lastEarlyRefreshAt = 0;
    inFlight = null;
    failureStreak = 0;
    lastFailureWarnAt = 0;
    lastAttemptNeedsRetry = false;
    retryAfterMs = null;
    lastSuccessAt = null;
    failingSince = null;
    lastFailure = null;
    nextAttemptAt = null;
    checkedAt = null;
}
