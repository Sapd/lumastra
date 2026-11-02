// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Feature-gate helper (AGPL core).
 *
 * Single entry-point for AGPL-core code to ask "is this commercial module
 * licensed?" and "what is the seat state right now?". Everything here
 * delegates to `getEffectiveEntitlements()` — the existing fail-open shim —
 * so the open-core boundary is never crossed.
 *
 * FAIL-OPEN SEMANTICS (resolved decision 2026-06-22):
 * - `isModuleLicensed()` on error → free-tier answer (module absent).
 *   This is intentional: an error should NOT grant access to paid modules.
 *   The free tier itself keeps working, so no legitimate user is locked out.
 * - `getSeatState()` on error → `{ allowed: true, ... }` (within-limit).
 *   A buggy seat count must never degrade a paying customer's session.
 *
 * Placement: module gates belong at the `+layout.server.ts` load layer,
 * NOT in `hooks.server.ts` (a throwing hook downs the whole app).
 */

import { Logger } from '$lib/server/utils/logger';
import {
    getEffectiveEntitlements,
    getLicenseStatus,
    FREE_TIER_ENTITLEMENTS,
    type LicenseModule,
} from './entitlements';

const logger = Logger.for('FeatureGate');

// ---------------------------------------------------------------------------
// Module gate
// ---------------------------------------------------------------------------

/**
 * Returns `true` iff the given commercial module is licensed under the current
 * entitlements (enforcement off → true; unlimited → true; error → false).
 *
 * On ANY error this returns `false` (the free-tier answer) — not `true`. This
 * is the one place where "fail-open" means "fail to free": we never grant paid
 * modules to an error path, but we also never lock the free tier out.
 *
 * @param m - The module to check.
 */
export async function isModuleLicensed(m: LicenseModule): Promise<boolean> {
    try {
        const ent = await getEffectiveEntitlements();
        return ent.modules.has(m);
    } catch (err) {
        // Fail to free tier (module absent) on any error.
        logger.warn(`isModuleLicensed(${m}) failed; treating as unlicensed`, err as Error);
        return FREE_TIER_ENTITLEMENTS.modules.has(m);
    }
}

// ---------------------------------------------------------------------------
// Seat state
// ---------------------------------------------------------------------------

/** Result of a seat-state check. */
export interface SeatState {
    /** True when the seat count is within the licensed limit (or unlimited). Fail-open: true on error. */
    readonly allowed: boolean;
    /** Number of currently active seats (null when not measured / error). */
    readonly inUse: number | null;
    /** Licensed seat ceiling (null when unlimited / not applicable). */
    readonly limit: number | null;
    /** Policy that governs overflow behaviour. */
    readonly overflowPolicy: 'observe' | 'degrade';
}

/**
 * Returns the current seat state for the installation.
 *
 * The actual seat count is fetched by the proprietary provider (via
 * `getEffectiveEntitlements()`). This helper surfaces the result in a
 * convenient shape for call sites that need to decide whether to observe or
 * degrade overflow.
 *
 * Fail-open: any error returns `{ allowed: true, inUse: null, limit: null,
 * overflowPolicy: 'observe' }` so a buggy count never degrades a paying
 * customer.
 *
 * NOTE: The seat count is intentionally NOT on the hot path. Call this only
 * from informational surfaces (admin pages, background checks) — never from
 * per-request middleware or streaming gates.
 */
export async function getSeatState(): Promise<SeatState> {
    try {
        const ent = await getEffectiveEntitlements();

        // No seat cap configured → unconditionally allowed.
        if (ent.maxSeats === null) {
            return {
                allowed: true,
                inUse: null,
                limit: null,
                overflowPolicy: ent.seatOverflowPolicy,
            };
        }

        // Fetch the actual active-seat count from the license status. getLicenseStatus()
        // is the AGPL-core function that delegates to the proprietary provider's
        // getCachedSeatCount() (with Valkey 15-min cache). Any error here → fail open.
        const status = await getLicenseStatus();
        const inUse = status.seatsInUse;

        // Compare active seats vs the licensed ceiling.
        // If the seat count is unknown (null) we fail open: assume within-limit.
        const overLimit = inUse !== null && inUse > ent.maxSeats;

        return {
            allowed: !overLimit,
            inUse,
            limit: ent.maxSeats,
            overflowPolicy: ent.seatOverflowPolicy,
        };
    } catch (err) {
        // Fail open — assume within limit on any error.
        logger.warn('getSeatState failed; treating as within-limit', err as Error);
        return {
            allowed: true,
            inUse: null,
            limit: null,
            overflowPolicy: 'observe',
        };
    }
}
