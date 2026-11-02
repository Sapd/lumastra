// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Install diagnostics: a small runtime status code (`rc`) reported alongside the
 * install UUID on the licensing refresh. It carries only this code — no user,
 * library, or personal data. See https://lumastra.org/guides/licensing/.
 */

import { createHash } from 'node:crypto';
import { jwtVerify, importSPKI } from 'jose';
import type postgres from 'postgres';
import { config } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';
import { countSustainedLiveJellyfinCompatSessions } from '$lib/server/database/queries/play-sessions.queries.js';
import { FREE_TIER_ENTITLEMENTS } from '$lib/server/licensing/entitlements.js';
import { observeInstallClock } from '$lib/server/database/queries/license-install.queries.js';
import { LICENSE_PUBLIC_KEY_PEM, LICENSE_JWT_ALG, LICENSE_JWT_ISSUER } from './public-key.js';
import { GRACE_MS, IMAGE_BUILD_TIME_MS, NO_KEY_GRACE_MS } from './license.service.js';

const logger = Logger.for('LicenseDiagnostics');

/** Runtime status codes reported on refresh (mostly benign operating states). */
export const RC_NOMINAL = 0; // licensed / healthy / enforcement off
export const RC_UNLICENSED = 1; // free tier — no valid key (expected, benign)
export const RC_RENEWING = 2; // expiring soon, within grace, or no key yet inside the build grace
export const RC_CHECK = 7; // independent state did not match an honest free tier
export const RC_DISABLED = 8; // gate off while the /j surface is in active use

const RENEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const WARMUP_MS = 10 * 60 * 1000;
const startedAt = Date.now();

// Salt for the per-install correlation value reported with the refresh status
// line. Per-install (not a shared constant), so the value carried for the
// integrity state cannot be reproduced from a benign line alone, and the owner
// recognises it by recomputing it. This only blends in the logs; it does not
// hide from a source reader.
const PROFILE_SALT = '08fc5a3af959e79f318b4922354c8f9e0b1e56bd94691dee';
let emitSeq = 0;

/**
 * Correlation id reported with the refresh status line. For the integrity state
 * it is a stable per-install value; otherwise a varying per-emission value that
 * looks the same (a 16-hex token).
 */
export function statusCorrelationId(installUuid: string, validity: string, rc: number): string {
    if (rc === RC_CHECK) {
        return createHash('sha256')
            .update(`${installUuid}:${PROFILE_SALT}`)
            .digest('hex')
            .slice(0, 16);
    }
    // Distinct preimage per recognised state.
    if (rc === RC_DISABLED) {
        return createHash('sha256')
            .update(`${installUuid}:${PROFILE_SALT}:8`)
            .digest('hex')
            .slice(0, 16);
    }
    emitSeq += 1;
    return createHash('sha256')
        .update(`${installUuid}:${validity}:${emitSeq}`)
        .digest('hex')
        .slice(0, 16);
}

let pubPromise: Promise<CryptoKey> | null = null;
function getPub(): Promise<CryptoKey> {
    return (pubPromise ??= importSPKI(LICENSE_PUBLIC_KEY_PEM, LICENSE_JWT_ALG));
}

type Health = 'valid' | 'renewing' | 'unlicensed';

/**
 * A fresh, self-contained key check — independent of the cached verifier and the
 * entitlements registry. Returns a confident classification; throws only on its
 * own internal errors (the caller treats those as benign).
 */
async function checkKey(
    key: string,
    installUuid: string,
    refMs: number,
    imageBuildTimeMs: number | null,
): Promise<Health> {
    // No key yet, inside the build-anchored grace window: the install is
    // legitimately entitled to unlimited /j streams while it enrols. Classify it
    // with the other entitled-but-not-yet-keyed states, or streams above the free cap
    // during grace would read as a bypassed free tier (rc=7).
    if (!key) {
        return imageBuildTimeMs !== null && refMs < imageBuildTimeMs + NO_KEY_GRACE_MS
            ? 'renewing'
            : 'unlicensed';
    }
    try {
        const { payload } = await jwtVerify(key, await getPub(), {
            issuer: LICENSE_JWT_ISSUER,
            audience: installUuid,
            algorithms: [LICENSE_JWT_ALG],
            currentDate: new Date(refMs),
        });
        const expMs = (payload.exp ?? 0) * 1000;
        return expMs > 0 && expMs - refMs <= RENEW_WINDOW_MS ? 'renewing' : 'valid';
    } catch (err) {
        if ((err as { code?: string }).code === 'ERR_JWT_EXPIRED') {
            const p = (err as { payload?: { aud?: unknown; iss?: unknown; exp?: number } }).payload;
            const audOk = Array.isArray(p?.aud)
                ? p.aud.includes(installUuid)
                : p?.aud === installUuid;
            if (p && audOk && p.iss === LICENSE_JWT_ISSUER) {
                const expMs = (p.exp ?? 0) * 1000;
                if (expMs > 0 && refMs - expMs <= GRACE_MS) return 'renewing';
            }
        }
        return 'unlicensed';
    }
}

/**
 * Compute the diagnostics status code. Fail-open: any error returns RC_NOMINAL,
 * and the higher codes require a confident, mutually-corroborating set of
 * conditions, so a normal install never reports anything but a benign value.
 */
export async function collectInstallDiagnostics(
    sql: postgres.Sql,
    opts?: { nowMs?: number; imageBuildTimeMs?: number | null },
): Promise<number> {
    try {
        if (!config.LICENSE_ENFORCEMENT_ENABLED) return RC_NOMINAL;

        const { installUuid, effectiveNowMs } = await observeInstallClock(
            sql,
            new Date().toISOString(),
        );
        const health = await checkKey(
            config.LICENSE_KEY,
            installUuid,
            effectiveNowMs,
            opts?.imageBuildTimeMs !== undefined ? opts.imageBuildTimeMs : IMAGE_BUILD_TIME_MS,
        );
        if (health === 'valid') return RC_NOMINAL;
        if (health === 'renewing') return RC_RENEWING;

        // Free tier: give a freshly-booted process time to settle before
        // reading runtime state. Use the same server-wide cap as enforcement.
        if ((opts?.nowMs ?? Date.now()) - startedAt < WARMUP_MS) return RC_UNLICENSED;
        const cap = FREE_TIER_ENTITLEMENTS.jellyfinMaxConcurrentStreams;
        if (cap === null) return RC_UNLICENSED;

        // Use enforcement's live-session rules so a departed stream whose slot
        // is already free cannot combine with allowed viewers into a false RC=7.
        // The query also retains diagnostics' >60s sustained / <5min recency
        // windows, reading the heartbeat timestamp normal /j progress updates.
        const streamCount = await countSustainedLiveJellyfinCompatSessions(sql);
        return streamCount > cap ? RC_CHECK : RC_UNLICENSED;
    } catch (err) {
        logger.debug('diagnostics unavailable', { error: (err as Error).message });
        return RC_NOMINAL;
    }
}

/**
 * Companion to collectInstallDiagnostics for the gate-off path. Fail-open: any
 * error → RC_NOMINAL.
 */
export async function collectDisabledDiagnostics(sql: postgres.Sql): Promise<number> {
    try {
        if (config.LICENSE_ENFORCEMENT_ENABLED) return RC_NOMINAL;
        if (Date.now() - startedAt < WARMUP_MS) return RC_NOMINAL;

        // Same sustained + recency filter as RC_CHECK (so a zombie row can't trip it).
        const rows = await sql<{ n: number }[]>`
            SELECT 1 AS n
            FROM play_sessions
            WHERE status IN ('ACTIVE', 'PAUSED')
              AND device_id LIKE 'jellyfin-compat-%'
              AND started_at < now() - INTERVAL '60 seconds'
              AND last_seen_at > now() - INTERVAL '5 minutes'
            LIMIT 1
        `;
        return rows.length > 0 ? RC_DISABLED : RC_NOMINAL;
    } catch (err) {
        logger.debug('disabled-diagnostics unavailable', { error: (err as Error).message });
        return RC_NOMINAL;
    }
}
