// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Offline signed-key license verification (proprietary).
 *
 * Verifies the stored `LICENSE_KEY` (a JWS/JWT signed by the licensing server)
 * against the baked-in public key, checks the audience binds to THIS deployment's
 * install UUID, and derives entitlements. Everything is local — no phone-home for
 * the crypto. The result is cached ~2h.
 *
 * FAIL OPEN, ALWAYS. Every path that cannot positively confirm a valid license
 * degrades to the free tier rather than denying. A verification bug must never
 * block login, browsing, or free-tier playback.
 *
 * GRACE WINDOW. A genuinely expired key keeps working for {@link GRACE_MS} after
 * its `exp`, so a licensing-server outage at renewal time does not degrade an
 * operator who had a valid license. Only once expiry + grace has passed do we
 * fall back to the free tier.
 *
 * NO-KEY GRACE. An install that has no key at all (fresh boot, offline, the
 * licensing server down) runs with the full early-access entitlements for
 * {@link NO_KEY_GRACE_MS} counted from the IMAGE BUILD time — a constant baked
 * into the bundle at build (see {@link IMAGE_BUILD_TIME_MS}), not first-boot or
 * DB time, which an operator could reset. Pinning an old image therefore cannot
 * extend it. A key that is present but invalid/expired never gets this grace:
 * it degrades to the free tier as before.
 *
 * CONTACT OFF. With `LICENSE_SERVER_CONTACT_ENABLED` off the install never
 * talks to lumastra.org, so nothing can ever replace or renew its key. Then:
 * no key → the free tier at once (no no-key grace, so nobody is downgraded a
 * month later by surprise); a stored key that verifies → honoured until its
 * `exp`, then the free tier (no {@link GRACE_MS} cushion: that exists only to
 * ride out a server outage at renewal, and no renewal will be tried). The
 * admin pages say so through the `contact-off-*` reason codes.
 *
 * NBF SKEW. A ±30 s tolerance on `nbf` prevents clock skew from making a
 * freshly issued key appear "not yet valid" on a slightly slow host clock.
 *
 * SEAT COUNT. `seatsInUse` is populated in the status by querying the DB via
 * the AGPL-core `countActiveSeats` query. A 15-minute Valkey cache prevents
 * the count from hitting the DB on every admin-page load.
 */

import { importSPKI, jwtVerify, type JWTPayload } from 'jose';
import { config } from '$lib/server/config';
import { getDb } from '$lib/server/database';
import { observeInstallClock } from '$lib/server/database/queries/license-install.queries.js';
import { countActiveSeats } from '$lib/server/database/queries/license-seats.queries.js';
import {
    FREE_TIER_ENTITLEMENTS,
    UNLIMITED_ENTITLEMENTS,
    type Entitlements,
    type LicenseModule,
    type LicenseStatus,
    type LicenseReasonCode,
} from '$lib/server/licensing/entitlements.js';
import { Logger } from '$lib/server/utils/logger';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { LICENSE_PUBLIC_KEY_PEM, LICENSE_JWT_ALG, LICENSE_JWT_ISSUER } from './public-key.js';

const logger = Logger.for('LicenseService');

/** How long a verification result is reused before re-checking. */
const VERIFY_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2h
/** How long past `exp` an expired key is still honoured (server-outage cushion). */
export const GRACE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
/** How close to `exp` we flag "expiring soon" (and the refresh loop renews). */
export const RENEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
/** How long after the image build an install with NO key keeps full access. */
export const NO_KEY_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * When this image was built (ms since epoch), or null when unknown.
 *
 * `import.meta.env.LUMASTRA_IMAGE_BUILD_TIME` is replaced by a string literal at
 * BUILD time (vite.config.ts `define`, from the CI's APP_BUILD_TIME build-arg);
 * it is not read from the runtime environment, so `docker run -e` cannot move
 * it. Undefined outside a Vite build (vitest) → null → no grace.
 */
export const IMAGE_BUILD_TIME_MS: number | null = (() => {
    let raw: string | undefined;
    try {
        // Outside Vite (a bare-node script) `import.meta.env` is undefined.
        raw = import.meta.env.LUMASTRA_IMAGE_BUILD_TIME as string | undefined;
    } catch {
        raw = undefined;
    }
    const ms = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(ms) ? ms : null;
})();

/**
 * Entitlements for the no-key grace window: the same set an early-access key
 * grants (every supporter module, unlimited /j streams, no seat cap). Enterprise
 * modules are contract-only and never part of early access.
 */
export const GRACE_ENTITLEMENTS: Entitlements = {
    edition: 'pro',
    jellyfinMaxConcurrentStreams: null,
    aiAssistant: true,
    maxSeats: null,
    seatOverflowPolicy: 'observe',
    modules: new Set<LicenseModule>([
        'jellyfin_compat',
        'ai_assistant',
        'branding_removal',
        'push',
    ]),
};

/** ±NBF skew tolerance: accept tokens issued within this window in the future. */
const NBF_SKEW_MS = 30 * 1000; // 30 seconds

/** Valkey cache key for the active-seat count (single global entry). */
const SEAT_CACHE_KEY = 'v1:seats';

// ---------------------------------------------------------------------------
// JWT payload shapes
// ---------------------------------------------------------------------------

/** Entitlement claims embedded in a license token (extended format). */
interface LicenseEntitlementClaim {
    // -- stream cap (unchanged) --
    jellyfinMaxConcurrentStreams?: number | null;
    // -- seat caps --
    maxSeats?: number | null;
    seatOverflowPolicy?: 'observe' | 'degrade';
    /** Activity window for seat counting (days). Defaults to 30. */
    seatWindowDays?: number;
    // -- module set --
    modules?: string[];
    // -- back-compat (old format: top-level boolean) --
    /** @deprecated Use modules array instead. Kept for back-compat key migration. */
    aiAssistant?: boolean;
}

interface LicensePayload extends JWTPayload {
    tier?: string;
    ent?: LicenseEntitlementClaim;
}

// ---------------------------------------------------------------------------
// Public-key singleton
// ---------------------------------------------------------------------------

let publicKeyPromise: Promise<CryptoKey> | null = null;
function getPublicKey(): Promise<CryptoKey> {
    if (!publicKeyPromise) {
        publicKeyPromise = importSPKI(LICENSE_PUBLIC_KEY_PEM, LICENSE_JWT_ALG);
    }
    return publicKeyPromise;
}

// ---------------------------------------------------------------------------
// Verification cache (in-memory, per-instance)
//
// Only the JWT verification result (entitlements, validity, expiry) is stored
// here. seatsInUse is intentionally NOT cached here — it is fetched fresh via
// getCachedSeatCount() (15-min Valkey TTL) on every getStatus() call. This
// prevents the seat count from being up to 2h stale behind the verify cache.
// ---------------------------------------------------------------------------

interface CacheEntry {
    cacheKey: string; // `${installUuid}:${serverContact}:${licenseKey}`
    computedAtMs: number;
    /** Status WITHOUT seatsInUse populated — injected fresh in getStatusCached(). */
    status: Omit<LicenseStatus, 'seatsInUse'> & { seatsInUse: null };
}
let cache: CacheEntry | null = null;

/** Clear the verification cache and seat-count cache (on key change / for tests). */
export function clearLicenseCache(): void {
    cache = null;
    // Also evict the Valkey seat-count entry so a fresh count is fetched next
    // time. Fire-and-forget; a stale Valkey entry is harmless beyond the TTL.
    cacheManager
        .for(CACHE_NAMESPACES.licenseSeatCount)
        .delete(SEAT_CACHE_KEY)
        .catch(() => {
            // Non-fatal — the TTL will expire it naturally
        });
}

// ---------------------------------------------------------------------------
// Seat count cache — Valkey-backed, cluster-shared (15-min TTL)
// ---------------------------------------------------------------------------

/**
 * Return the cached active-seat count for the given window.
 *
 * Uses the `licenseSeatCount` namespace (Valkey L2 + in-process L1, both 15 min)
 * so the result is consistent across all replicas in a cluster — satisfying the
 * Resolved Decision requirement for a 'Valkey 15-min TTL cache'.
 *
 * Cache key: `v1:seats` — single global entry, not per windowDays. If the
 * operator changes seatWindowDays via a new license token the cache will be
 * stale for up to 15 minutes, which is acceptable for an informational count.
 *
 * Fail-open: any error (Valkey unavailable, DB query fails) returns null so
 * callers treat the count as unknown and remain within-limit.
 */
async function getCachedSeatCount(windowDays: number): Promise<number | null> {
    const seatCache = cacheManager.for(CACHE_NAMESPACES.licenseSeatCount);
    try {
        const cached = await seatCache.get<number>(SEAT_CACHE_KEY);
        if (cached !== null && cached !== undefined) {
            return cached;
        }
    } catch {
        // Valkey unavailable — fall through to DB query
    }

    const sql = getDb();
    if (!sql) return null;
    try {
        const count = await countActiveSeats(sql, windowDays);
        try {
            await seatCache.set(SEAT_CACHE_KEY, count);
        } catch {
            // Cache write failure is non-fatal
        }
        return count;
    } catch (err) {
        logger.warn('Seat count query failed; treating as within-limit', err as Error);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Claim → Entitlements mapping
// ---------------------------------------------------------------------------

/**
 * All known LicenseModule values, exhaustive BY CONSTRUCTION.
 *
 * A plain string Set here was a silent-failure trap: adding a member to
 * LicenseModule without adding it here means the verifier drops that module
 * from every license, disabling the feature with no type error and no runtime
 * warning. `satisfies Record<LicenseModule, true>` makes the compiler reject
 * an incomplete list.
 */
const ALL_MODULES = {
    jellyfin_compat: true,
    ai_assistant: true,
    branding_removal: true,
    assessment: true,
    showcase: true,
    sso_enterprise: true,
    push: true,
} satisfies Record<LicenseModule, true>;

const KNOWN_MODULES: Set<LicenseModule> = new Set(
    Object.keys(ALL_MODULES) as (keyof typeof ALL_MODULES)[],
);

/**
 * Map a license token's entitlement claim to the internal Entitlements shape.
 *
 * Back-compat rules (so existing issued keys keep working):
 * 1. A validly signed license with NO `ent` claim at all → UNLIMITED_ENTITLEMENTS
 *    (legacy behaviour, preserved for deployment continuity). The licensing server
 *    must issue a new key with an explicit `ent.modules` array for the operator to
 *    move to the module-scoped grant. A warning is logged to prompt key rotation.
 *    This is safe because only a correctly signed + audience-bound token reaches
 *    this branch; an attacker cannot forge one without the signing private key.
 * 2. An old-format key with `ent.aiAssistant === true` but no `modules` array
 *    → grant `['ai_assistant', 'jellyfin_compat']` (the pre-modules "full unlock").
 * 3. A new-format key with `ent.modules` → use the modules array directly.
 */
function entitlementsFromClaim(payload: LicensePayload): Entitlements {
    const ent = payload.ent;
    // A token with no `ent` claim is a pre-module-era key issued before the
    // `ent.modules` field was introduced. Preserve the previous UNLIMITED grant so
    // existing prod deployments do not silently lose module access on upgrade.
    //
    // Security note: this path is ONLY reachable for tokens that have passed full
    // ECDSA signature + issuer + audience + expiry validation. An unsigned / forged
    // token cannot reach here. Granting UNLIMITED to an authentic but old-format
    // key is the correct migration stance — it preserves the "licensed → no
    // restrictions" contract until the operator rotates to a new-format key.
    //
    // Operators should rotate to a new key with an explicit `ent.modules` list to
    // move to fine-grained module control. The warning below signals this need.
    if (!ent) {
        logger.warn(
            'License token has no ent claim (pre-module-era key) — granting UNLIMITED as ' +
                'migration grace. Issue a new key with ent.modules to move to scoped entitlements.',
            { tier: payload.tier ?? 'unknown', sub: payload.sub ?? 'unknown' },
        );
        return UNLIMITED_ENTITLEMENTS;
    }

    // --- Resolve module set ---
    let moduleSet: Set<LicenseModule>;
    if (Array.isArray(ent.modules)) {
        // New format: explicit modules list.
        moduleSet = new Set(
            ent.modules.filter((m): m is LicenseModule => KNOWN_MODULES.has(m as LicenseModule)),
        );
    } else if (ent.aiAssistant === true) {
        // Old format back-compat: explicit true flag → grant the pre-modules bundle.
        // Using === true (not !== false) so tokens that simply OMIT the aiAssistant
        // field (undefined) do NOT silently inherit ai_assistant + jellyfin_compat.
        // Only tokens that positively set aiAssistant:true were "full unlock" keys.
        moduleSet = new Set<LicenseModule>(['ai_assistant', 'jellyfin_compat']);
    } else {
        moduleSet = new Set<LicenseModule>();
    }

    // --- Resolve edition ---
    const tier = typeof payload.tier === 'string' ? payload.tier : 'licensed';
    type E = Entitlements['edition'];
    const edition: E =
        tier === 'pro' || tier === 'enterprise' || tier === 'unlimited' || tier === 'free'
            ? (tier as E)
            : 'pro'; // unknown tier in a valid signed key → treat as pro

    // --- Resolve stream cap ---
    const streams = ent.jellyfinMaxConcurrentStreams;
    const jellyfinMaxConcurrentStreams: number | null =
        streams === null || (typeof streams === 'number' && streams >= 0)
            ? (streams ?? null)
            : null;

    // --- Resolve seats ---
    const maxSeats = typeof ent.maxSeats === 'number' && ent.maxSeats > 0 ? ent.maxSeats : null;
    const seatOverflowPolicy: 'observe' | 'degrade' =
        ent.seatOverflowPolicy === 'degrade' ? 'degrade' : 'observe';

    return {
        edition,
        jellyfinMaxConcurrentStreams,
        aiAssistant: moduleSet.has('ai_assistant'),
        maxSeats,
        seatOverflowPolicy,
        modules: moduleSet,
    };
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function isExpiredError(err: unknown): err is { code: string; payload?: LicensePayload } {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === 'ERR_JWT_EXPIRED'
    );
}

function freeStatus(
    enforcementEnabled: boolean,
    reason: string,
    validity: LicenseStatus['validity'] = 'free-tier',
    expiresAt: string | null = null,
    seatsInUse: number | null = null,
    reasonCode?: LicenseReasonCode,
): LicenseStatus {
    return {
        enforcementEnabled,
        tier: 'free',
        validity,
        expiresAt,
        // When enforcement is off we never restrict, even with no/invalid key.
        entitlements: enforcementEnabled ? FREE_TIER_ENTITLEMENTS : UNLIMITED_ENTITLEMENTS,
        reason,
        reasonCode,
        verified: false,
        seatsInUse,
        seatLimit: null,
    };
}

/**
 * Status for an install with no key. Inside the build-anchored grace window it
 * gets the full early-access set; after it, the free tier. `effectiveNowMs` is
 * the monotonic install clock, so winding the OS clock back cannot reopen it.
 */
function noKeyStatus(
    enforcementEnabled: boolean,
    effectiveNowMs: number,
    imageBuildTimeMs: number | null,
    serverContact: boolean,
): LicenseStatus {
    // Contact off: no key will ever arrive, so a grace window would only end in
    // a downgrade the operator did not see coming. Free tier from the start.
    if (enforcementEnabled && !serverContact) {
        return freeStatus(
            enforcementEnabled,
            'Not contacting lumastra.org — running on the free tier.',
            'free-tier',
            null,
            null,
            'contact-off-free',
        );
    }
    const graceEndMs = imageBuildTimeMs === null ? null : imageBuildTimeMs + NO_KEY_GRACE_MS;
    if (graceEndMs !== null && effectiveNowMs < graceEndMs) {
        return {
            enforcementEnabled,
            tier: 'grace',
            validity: 'grace',
            expiresAt: new Date(graceEndMs).toISOString(),
            entitlements: enforcementEnabled ? GRACE_ENTITLEMENTS : UNLIMITED_ENTITLEMENTS,
            reason:
                'No license key yet — full access during the grace period while this install ' +
                'fetches its license from lumastra.org.',
            reasonCode: 'grace-active',
            verified: false,
            seatsInUse: null,
            seatLimit: null,
        };
    }
    return freeStatus(
        enforcementEnabled,
        graceEndMs === null
            ? 'No license key configured — running on the free tier.'
            : 'No license key, and the grace period for this release has ended — running on the free tier.',
        'free-tier',
        graceEndMs === null ? null : new Date(graceEndMs).toISOString(),
        null,
        graceEndMs === null ? 'no-key-free' : 'grace-ended-free',
    );
}

// ---------------------------------------------------------------------------
// Core verification
// ---------------------------------------------------------------------------

/**
 * Verify the stored key for the given install UUID and produce a status. Pure
 * w.r.t. config/DB: callers pass the already-resolved key + uuid. Never throws.
 *
 * `publicKey` defaults to the baked-in production key; tests inject a test key.
 * `effectiveNowMs` is the reference time for expiry checks (defaults to now).
 * `imageBuildTimeMs` anchors the no-key grace window (defaults to the baked
 * build time; tests inject one). `serverContact` is
 * `LICENSE_SERVER_CONTACT_ENABLED` (see CONTACT OFF in the module header).
 */
export async function verifyLicenseKey(
    licenseKey: string,
    installUuid: string,
    publicKey?: CryptoKey,
    effectiveNowMs: number = Date.now(),
    imageBuildTimeMs: number | null = IMAGE_BUILD_TIME_MS,
    // Only an explicit `false` is off (a partial config stub reads undefined).
    serverContact: boolean = config.LICENSE_SERVER_CONTACT_ENABLED !== false,
): Promise<LicenseStatus> {
    const enforcementEnabled = config.LICENSE_ENFORCEMENT_ENABLED;
    // A key that cannot be renewed: the reason says so instead of "it will auto-renew".
    const noRenewal = enforcementEnabled && !serverContact;

    if (!licenseKey) {
        return noKeyStatus(enforcementEnabled, effectiveNowMs, imageBuildTimeMs, serverContact);
    }

    const pub = publicKey ?? (await getPublicKey());

    try {
        const { payload } = await jwtVerify<LicensePayload>(licenseKey, pub, {
            issuer: LICENSE_JWT_ISSUER,
            audience: installUuid,
            algorithms: [LICENSE_JWT_ALG],
            // Evaluate exp/nbf against the monotonic floor, not the raw OS clock.
            currentDate: new Date(effectiveNowMs),
            // Allow tokens issued slightly in the future (clock skew tolerance).
            clockTolerance: NBF_SKEW_MS / 1000, // jose takes seconds
        });
        // Signature + issuer + audience + exp all valid.
        const expMs = (payload.exp ?? 0) * 1000;
        const expiresAt = payload.exp ? new Date(expMs).toISOString() : null;
        const expiringSoon = expMs > 0 && expMs - effectiveNowMs <= RENEW_WINDOW_MS;
        const entitlements = entitlementsFromClaim(payload);
        const tier = typeof payload.tier === 'string' ? payload.tier : 'licensed';

        // NOTE: seatsInUse is intentionally omitted here (null). It is injected
        // fresh in getStatusCached() via getCachedSeatCount() so the seat count
        // is never stale behind the 2h verify cache.
        return {
            enforcementEnabled,
            tier,
            validity: expiringSoon ? 'expiring-soon' : 'valid',
            expiresAt,
            entitlements,
            reason: noRenewal
                ? 'License is valid until it expires. Not contacting lumastra.org, so it is not renewed.'
                : expiringSoon
                  ? 'License is valid but expiring soon — it will auto-renew.'
                  : 'License is valid.',
            reasonCode: noRenewal
                ? 'contact-off-key-until-expiry'
                : expiringSoon
                  ? 'valid-expiring-soon'
                  : 'valid',
            verified: true,
            seatsInUse: null, // populated by getStatusCached() via getCachedSeatCount()
            seatLimit: entitlements.maxSeats,
        };
    } catch (err) {
        // Signature was verified BEFORE claim checks, so an "expired" error means
        // the token is authentic but past `exp`. Re-confirm issuer + audience from
        // the carried payload (defence in depth), then apply the grace window.
        if (isExpiredError(err) && err.payload) {
            const payload = err.payload;
            const audOk = Array.isArray(payload.aud)
                ? payload.aud.includes(installUuid)
                : payload.aud === installUuid;
            const issOk = payload.iss === LICENSE_JWT_ISSUER;
            if (audOk && issOk) {
                const expMs = (payload.exp ?? 0) * 1000;
                const expiresAt = expMs ? new Date(expMs).toISOString() : null;
                const sinceExpMs = effectiveNowMs - expMs;
                // Contact off: no renewal will be tried, so no outage cushion either.
                if (expMs > 0 && sinceExpMs <= GRACE_MS && !noRenewal) {
                    // Within grace: keep honouring the license's entitlements.
                    const entitlements = entitlementsFromClaim(payload);
                    return {
                        enforcementEnabled,
                        tier: typeof payload.tier === 'string' ? payload.tier : 'licensed',
                        validity: 'expired',
                        expiresAt,
                        entitlements,
                        reason: 'License expired but within the grace window — attempting to renew.',
                        reasonCode: 'expired-in-grace',
                        verified: true,
                        seatsInUse: null, // populated by getStatusCached()
                        seatLimit: entitlements.maxSeats,
                    };
                }
                // Past grace → degrade to free.
                if (noRenewal) {
                    return freeStatus(
                        enforcementEnabled,
                        'License expired. Not contacting lumastra.org — running on the free tier.',
                        'expired',
                        expiresAt,
                        null,
                        'contact-off-expired-free',
                    );
                }
                return freeStatus(
                    enforcementEnabled,
                    'License expired beyond the grace window — running on the free tier.',
                    'expired',
                    expiresAt,
                    null,
                    'expired-beyond-grace',
                );
            }
        }
        // Bad signature, wrong audience (key meant for another install), or
        // malformed token → free tier. Do NOT leak details to callers.
        logger.warn('License verification failed; degrading to free tier', err as Error);
        return freeStatus(
            enforcementEnabled,
            'License key is invalid for this installation — running on the free tier.',
            'free-tier',
            null,
            null,
            'invalid-key-free',
        );
    }
}

// ---------------------------------------------------------------------------
// Cached status
// ---------------------------------------------------------------------------

/** Resolve current install UUID + license key and return a cached status. */
async function getStatusCached(): Promise<LicenseStatus> {
    const sql = getDb();
    const licenseKey = config.LICENSE_KEY;

    if (!sql) {
        // No DB → cannot resolve the install UUID → fail open.
        return freeStatus(
            config.LICENSE_ENFORCEMENT_ENABLED,
            'Database unavailable — running on the free tier.',
            'free-tier',
            null,
            null,
            'db-unavailable-free',
        );
    }

    // Resolve the install identity and the reference time in one round-trip.
    let installUuid: string;
    let effectiveNowMs: number;
    try {
        const obs = await observeInstallClock(sql, new Date().toISOString());
        installUuid = obs.installUuid;
        effectiveNowMs = obs.effectiveNowMs;
    } catch (err) {
        logger.warn('Could not resolve install identity; degrading to free tier', err as Error);
        return freeStatus(
            config.LICENSE_ENFORCEMENT_ENABLED,
            'Install identity unavailable — running on the free tier.',
            'free-tier',
            null,
            null,
            'install-identity-unavailable-free',
        );
    }

    // The contact switch changes the verdict (no-key grace, expiry grace), so a
    // flip must not wait out the 2h cache.
    const serverContact = config.LICENSE_SERVER_CONTACT_ENABLED !== false;
    const cacheKey = `${installUuid}:${serverContact ? 1 : 0}:${licenseKey}`;

    let baseStatus: Omit<LicenseStatus, 'seatsInUse'> & { seatsInUse: null };
    // A verdict never outlives an `exp` (or grace end) that lay ahead when it
    // was computed: with contact off a key drops to the free tier right at
    // `exp`, not up to 2h later. Entries already past it stay cached.
    const cachedExpMs = cache?.status.expiresAt ? Date.parse(cache.status.expiresAt) : NaN;
    const expPassedSinceVerify =
        cache !== null && cachedExpMs > cache.computedAtMs && cachedExpMs <= Date.now();
    if (
        cache &&
        cache.cacheKey === cacheKey &&
        Date.now() - cache.computedAtMs < VERIFY_CACHE_TTL_MS &&
        !expPassedSinceVerify
    ) {
        baseStatus = cache.status;
    } else {
        const verified = await verifyLicenseKey(
            licenseKey,
            installUuid,
            undefined,
            effectiveNowMs,
            IMAGE_BUILD_TIME_MS,
            serverContact,
        );
        // Store WITHOUT seatsInUse in the 2h verify cache.
        baseStatus = { ...verified, seatsInUse: null };
        cache = { cacheKey, computedAtMs: Date.now(), status: baseStatus };
    }

    // Inject fresh seatsInUse (15-min Valkey cache) so the admin page always
    // shows the latest count even when the 2h verify cache is warm.
    // Use the default 30-day window; the JWT-claim override is parsed only at
    // verify time and is not stored in the cached entitlements shape.
    const seatsInUse =
        baseStatus.entitlements.maxSeats !== null ? await getCachedSeatCount(30) : null;

    return { ...baseStatus, seatsInUse };
}

// ---------------------------------------------------------------------------
// Public API (EntitlementsProvider contract)
// ---------------------------------------------------------------------------

/** EntitlementsProvider.getStatus — never throws. */
export async function getStatus(): Promise<LicenseStatus> {
    try {
        return await getStatusCached();
    } catch (err) {
        logger.warn('getStatus failed; degrading to free tier', err as Error);
        return freeStatus(
            config.LICENSE_ENFORCEMENT_ENABLED,
            'License check failed — running on the free tier.',
            'free-tier',
            null,
            null,
            'check-failed-free',
        );
    }
}

/** EntitlementsProvider.getEntitlements — never throws. */
export async function getEntitlements(): Promise<Entitlements> {
    const status = await getStatus();
    return status.entitlements;
}
