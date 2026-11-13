// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * License entitlements registry (AGPL core shim).
 *
 * This is the ONE clean boundary between AGPL core and the proprietary licensing
 * module. Core code (the /j stream gate, the AI assistant gate, the admin
 * licensing page) calls the functions here; it NEVER imports proprietary code.
 * The proprietary module, when present (official build), registers itself as the
 * entitlements provider via {@link registerEntitlementsProvider}. When absent
 * (an AGPL-only tree with the proprietary dirs removed — a removal LICENSING.md
 * §3 explicitly permits), no provider registers and these functions return safe
 * defaults.
 *
 * SAFETY CONTRACT — fail open, never lock out:
 * - Enforcement OFF (default) → UNLIMITED. Existing deployments are unchanged.
 * - Enforcement ON, valid license → the license's entitlements.
 * - Enforcement ON, anything wrong (no provider, invalid/expired key, verify
 *   error) → FREE tier. This is a graceful DEGRADE, not a denial: free-tier
 *   playback, login, and browsing always keep working.
 *
 * The proprietary provider is loaded lazily and build-safely via `import.meta.glob`
 * (see {@link ensureProvider}): in a tree where the proprietary dirs have been
 * removed, the file does not exist and the glob simply matches nothing.
 */

import { config } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';
import { isIsolationWorker } from '$lib/server/tasks/isolation/isolation-context.js';

const logger = Logger.for('Licensing');

// ---------------------------------------------------------------------------
// Tier + module types (AGPL — only defines shapes, no policy)
// ---------------------------------------------------------------------------

/**
 * Product edition carried by the license.
 * The proprietary verifier maps the JWT `tier` claim to one of these.
 * AGPL core only reads this for display purposes; policy lives in the provider.
 */
export type LicenseEdition = 'free' | 'pro' | 'enterprise' | 'unlimited';

/**
 * Optional commercial modules a license may unlock.
 *
 * Defined in `$lib/shared/license-modules.ts` and re-exported here so every
 * existing `from '$lib/server/licensing/entitlements.js'` import keeps working.
 * It lives there rather than here because the admin UI needs to type an
 * exhaustive `Record<LicenseModule, …>` and a Svelte component cannot import
 * from `$lib/server/**` — see that file for the full reasoning.
 */
export type { LicenseModule } from '$lib/shared/license-modules.js';
import type { LicenseModule } from '$lib/shared/license-modules.js';

// ---------------------------------------------------------------------------
// Entitlements shape
// ---------------------------------------------------------------------------

export interface Entitlements {
    /**
     * Product edition (free / pro / enterprise / unlimited).
     * Used for display on the admin page; do NOT gate features on this alone —
     * use `modules.has(...)` for policy decisions.
     */
    readonly edition: LicenseEdition;
    /**
     * Maximum concurrent /j (Jellyfin-compat) streams per server. `null` = unlimited.
     * The free-tier cap is defined by FREE_TIER_ENTITLEMENTS below.
     * Back-compat: existing call sites (`playback-utils.ts`) read this field.
     */
    readonly jellyfinMaxConcurrentStreams: number | null;
    /**
     * Back-compat convenience: `true` iff `modules.has('ai_assistant')`.
     * Existing AI-assistant call sites read this boolean rather than the set.
     */
    readonly aiAssistant: boolean;
    /** Max licensed seats (distinct active users in the activity window). `null` = unlimited. */
    readonly maxSeats: number | null;
    /**
     * What to do when active users exceed `maxSeats`:
     * - `'observe'` (default) — log + surface an admin banner; no enforcement.
     * - `'degrade'`           — opt-in per contract; write-class actions degrade.
     */
    readonly seatOverflowPolicy: 'observe' | 'degrade';
    /**
     * Set of commercial modules this license unlocks.
     * `ReadonlySet` prevents accidental mutation.
     */
    readonly modules: ReadonlySet<LicenseModule>;
}

// ---------------------------------------------------------------------------
// License status (informational, for the admin page)
// ---------------------------------------------------------------------------

/** Validity classification surfaced to the operator on /admin/system/instance. */
export type LicenseValidity =
    | 'grace' // no key yet — full access for a window after the image build
    | 'free-tier' // no valid license — running on the free tier
    | 'valid' // verified, well within its term
    | 'expiring-soon' // verified, but the term ends within the renewal window
    | 'expired' // term has passed (degraded to free unless inside the grace window)
    | 'unknown'; // enforcement off / status not yet determined

/**
 * Stable identifier for WHY {@link LicenseStatus.reason} says what it says.
 * `reason` itself is English prose (server-only, never localized — it can be
 * generated outside any paraglide request context, e.g. from a background
 * cache refresh) and used to be rendered verbatim on /admin/system/instance
 * regardless of the viewer's UI language. `reasonCode` lets the CLIENT pick a
 * localized message (see `LICENSE_REASON_MESSAGE` in that page) while
 * `reason` stays as the English fallback for any consumer that predates this
 * field or doesn't have a matching case (never expected, but `reason` always
 * being present keeps that path non-broken rather than blank).
 */
export type LicenseReasonCode =
    | 'valid'
    | 'valid-expiring-soon'
    | 'grace-active'
    | 'no-key-free'
    | 'grace-ended-free'
    | 'expired-in-grace'
    | 'expired-beyond-grace'
    | 'invalid-key-free'
    | 'db-unavailable-free'
    | 'install-identity-unavailable-free'
    | 'check-failed-free'
    | 'no-provider-free'
    | 'enforcement-disabled'
    // LICENSE_SERVER_CONTACT_ENABLED off: no key → free tier at once; a stored
    // key → honoured until it expires (never renewed); expired → free tier.
    | 'contact-off-free'
    | 'contact-off-key-until-expiry'
    | 'contact-off-expired-free';

export interface LicenseStatus {
    /** Whether enforcement is currently switched on (config getter). */
    readonly enforcementEnabled: boolean;
    /**
     * The verified tier claim (e.g. 'early_access', 'pro', 'enterprise'), 'grace'
     * during the no-key grace window, or 'free' / 'unlicensed'.
     */
    readonly tier: string;
    readonly validity: LicenseValidity;
    /**
     * License expiry as an ISO string — or, for `validity: 'grace'`, when the
     * grace window ends. Null when there is neither.
     */
    readonly expiresAt: string | null;
    /** The entitlements that would apply under the current license/state. */
    readonly entitlements: Entitlements;
    /** Human-readable explanation for the admin UI (English — see `reasonCode`). */
    readonly reason: string;
    /** Stable code for a localized rendering of `reason`. See {@link LicenseReasonCode}. */
    readonly reasonCode?: LicenseReasonCode;
    /** True when a proprietary verifier produced this status (vs. core default). */
    readonly verified: boolean;
    /** Current active-seat count (from the DB query), or null when not measured. */
    readonly seatsInUse: number | null;
    /** Licensed seat ceiling from the token, or null when unlimited / not applicable. */
    readonly seatLimit: number | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Graceful-degrade target: the free tier. Push only, 2 /j streams per server, AI off.
 *
 * Push is in every tier (the licensing server's free tier carries it too): it
 * still needs the licence-minted relay token to deliver, and the server decides
 * who is minted one, so granting the module here costs nothing and keeps a
 * key-less install from answering `not_entitled`.
 */
export const FREE_TIER_ENTITLEMENTS: Entitlements = {
    edition: 'free',
    jellyfinMaxConcurrentStreams: 2,
    aiAssistant: false,
    maxSeats: null, // free tier does not cap seats
    seatOverflowPolicy: 'observe',
    modules: new Set<LicenseModule>(['push']),
};

/** Enforcement off (or AGPL build with nothing to gate): no restrictions. */
export const UNLIMITED_ENTITLEMENTS: Entitlements = {
    edition: 'unlimited',
    jellyfinMaxConcurrentStreams: null,
    aiAssistant: true,
    maxSeats: null,
    seatOverflowPolicy: 'observe',
    modules: new Set<LicenseModule>([
        'jellyfin_compat',
        'ai_assistant',
        'branding_removal',
        'assessment',
        'showcase',
        'sso_enterprise',
        'push',
    ]),
};

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

/**
 * Contract the proprietary licensing module implements and registers. Both
 * methods MUST be internally fail-open (return FREE on any error) — the core
 * also guards with try/catch as defence in depth.
 */
/**
 * This process's contact with the licensing server, for the admin page — so an
 * operator can tell "waiting for the first contact" from "lumastra.org has not
 * answered since Tuesday".
 */
export interface LicenseServerContact {
    lastSuccessAt: string | null;
    failingSince: string | null;
    failedAttempts: number;
    /** `http-<status>` or `unreachable`. */
    lastFailure: string | null;
    nextAttemptAt: string | null;
    /** Last completed check; a check that needed no call still counts. */
    checkedAt: string | null;
}

export interface EntitlementsProvider {
    getEntitlements(): Promise<Entitlements>;
    getStatus(): Promise<LicenseStatus>;
    getServerContact?(): LicenseServerContact;
}

let provider: EntitlementsProvider | null = null;
let initAttempt: Promise<void> | null = null;

/**
 * Called by the proprietary licensing module on load to wire itself in.
 * (proprietary → core direction, which the boundary permits.)
 */
export function registerEntitlementsProvider(p: EntitlementsProvider): void {
    provider = p;
    logger.info('License entitlements provider registered');
}

/**
 * Lazily, and at most once, attempt to load the optional proprietary licensing
 * module. `import.meta.glob` is resolved at build time: in the official build it
 * finds `proprietary/licensing/init.ts` and bundles it as a lazy chunk; in an
 * AGPL-only tree (anyone may delete the proprietary dirs and rebuild — there is
 * no separate automated "public build" pipeline) the path does not exist, the
 * glob matches nothing, and this is a no-op. Any load/init error is swallowed —
 * the caller then falls back to the safe defaults.
 */
async function ensureProvider(): Promise<void> {
    if (provider) return;
    // Never inside a plugin-isolation worker: the proprietary init starts the
    // licence refresh loop, whose tick writes LICENSE_KEY via saveConfig — a
    // sealed-secret write the worker cannot make (it holds no master key; B1).
    // Entitlement reads there fall back exactly as when no provider is
    // registered (free tier when enforcing), which is also what the worker
    // bundle did before: esbuild leaves `import.meta.glob` untransformed, so
    // the load below threw in the worker anyway.
    if (isIsolationWorker()) return;
    if (!initAttempt) {
        initAttempt = (async () => {
            const mods = import.meta.glob('/src/lib/server/proprietary/licensing/init.{ts,js}');
            for (const load of Object.values(mods)) {
                try {
                    const mod = (await load()) as {
                        initProprietaryLicensing?: () => void | Promise<void>;
                    };
                    await mod.initProprietaryLicensing?.();
                } catch (err) {
                    logger.warn('Proprietary licensing module failed to initialise', err as Error);
                }
            }
        })();
    }
    await initAttempt;
}

/**
 * Force the optional proprietary tree to load (and self-register) if present,
 * independent of the license-enforcement flag.
 *
 * `getEffectiveEntitlements()` short-circuits to UNLIMITED when enforcement is
 * off and therefore may never trigger `ensureProvider()`. Other consumers of the
 * proprietary tree that register through `init.ts` (e.g. the AI assistant
 * provider — see `ai/assistant-provider.ts`) need the module loaded regardless
 * of enforcement, so they call this. Idempotent and safe; a no-op in AGPL-only
 * builds (the glob matches nothing). Never throws.
 */
export async function ensureProprietaryLoaded(): Promise<void> {
    await ensureProvider();
}

/**
 * The entitlements that apply to THIS request, honouring the enforcement flag.
 * This is what the /j and AI gates call. Always resolves; never throws.
 */
export async function getEffectiveEntitlements(): Promise<Entitlements> {
    return resolveEffectiveEntitlements();
}

async function resolveEffectiveEntitlements(): Promise<Entitlements> {
    // Enforcement off → behave exactly as before (no gating).
    if (!config.LICENSE_ENFORCEMENT_ENABLED) return UNLIMITED_ENTITLEMENTS;
    try {
        await ensureProvider();
        if (!provider) return FREE_TIER_ENTITLEMENTS;
        return await provider.getEntitlements();
    } catch (err) {
        // Fail OPEN to the free tier — never deny.
        logger.warn('Entitlement resolution failed; degrading to free tier', err as Error);
        return FREE_TIER_ENTITLEMENTS;
    }
}

/**
 * Informational license status for the admin page. Reports the verified state
 * regardless of whether enforcement is currently on (so an operator can see "you
 * hold a valid license; enforcement is off"). Never throws.
 */
/** The licensing-server contact state, or null in a build without the verifier. Never throws. */
export async function getLicenseServerContact(): Promise<LicenseServerContact | null> {
    try {
        await ensureProvider();
        return provider?.getServerContact?.() ?? null;
    } catch {
        return null;
    }
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
    const enforcementEnabled = config.LICENSE_ENFORCEMENT_ENABLED;
    try {
        await ensureProvider();
        if (provider) return await provider.getStatus();
    } catch (err) {
        logger.warn('License status resolution failed', err as Error);
    }
    // No proprietary verifier (public build, or not yet registered).
    return {
        enforcementEnabled,
        tier: 'unlicensed',
        validity: enforcementEnabled ? 'free-tier' : 'unknown',
        expiresAt: null,
        entitlements: enforcementEnabled ? FREE_TIER_ENTITLEMENTS : UNLIMITED_ENTITLEMENTS,
        reason: enforcementEnabled
            ? 'No active license — running on the free tier.'
            : 'License enforcement is disabled; all features are available.',
        reasonCode: enforcementEnabled ? 'no-provider-free' : 'enforcement-disabled',
        verified: false,
        seatsInUse: null,
        seatLimit: null,
    };
}

/** Test seam: reset the registered provider + init memo. */
export function __resetEntitlementsProviderForTests(): void {
    provider = null;
    initAttempt = null;
}
