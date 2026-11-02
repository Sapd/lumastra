// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the install diagnostics status code. The most important
 * property is that an honest install NEVER reports the elevated code, and that
 * any error fails open to the benign nominal code.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { cfg } = vi.hoisted(() => ({
    cfg: { LICENSE_ENFORCEMENT_ENABLED: true, LICENSE_KEY: '' },
}));
const INSTALL_UUID = '11111111-2222-4333-8444-555555555555';

vi.mock('$lib/server/config', () => ({ config: cfg, FEATURE_PER_TASK_QUEUES: false }));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}));
// Use the TEST public key so test-signed tokens verify.
vi.mock('./public-key.js', () => ({
    LICENSE_PUBLIC_KEY_PEM: `-----BEGIN PUBLIC KEY-----
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEsWIbzaj759vP1q7JTexli3qu57pBSK2n
YC2c8QYusIrdMQZ5qmSBNKw+gxEXemtEfqv/9XayN4/W51PpxWB3jd1FpWWoBgWB
jT35tmQbeYQFUFRM0yf4AaRDGOIiu3Hx
-----END PUBLIC KEY-----`,
    LICENSE_JWT_ALG: 'ES384',
    LICENSE_JWT_ISSUER: 'lumastra',
}));
vi.mock('$lib/server/database/queries/license-install.queries.js', () => ({
    observeInstallClock: async () => ({ installUuid: INSTALL_UUID, effectiveNowMs: Date.now() }),
}));
// Cut the heavy database import chain pulled in transitively via license.service.
vi.mock('$lib/server/database', () => ({ getDb: () => null }));

import { SignJWT, importPKCS8 } from 'jose';
import {
    collectInstallDiagnostics,
    statusCorrelationId,
    RC_NOMINAL,
    RC_UNLICENSED,
    RC_RENEWING,
    RC_CHECK,
} from './diagnostics';

const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDCxBPx/6L6KGYHVmL3t
F2kZMdfW7tNsKERi+HvrBQod/RKPPS0Wba1xDVUxnZiX6kuhZANiAASxYhvNqPvn
28/WrslN7GWLeq7nukFIradgLZzxBi6wit0xBnmqZIE0rD6DERd6a0R+q//1drI3
j9bnU+nFYHeN3UWlZagGBYGNPfm2ZBt5hAVQVEzTJ/gBpEMY4iK7cfE=
-----END PRIVATE KEY-----`;

const PAST_WARMUP = Date.now() + 20 * 60 * 1000; // beyond the 10-min warmup

async function validKey(expSecondsFromNow: number): Promise<string> {
    const key = await importPKCS8(TEST_PRIVATE_KEY_PEM, 'ES384');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
        tier: 'free',
        ent: { jellyfinMaxConcurrentStreams: null, aiAssistant: true },
    })
        .setProtectedHeader({ alg: 'ES384', typ: 'JWT' })
        .setIssuer('lumastra')
        .setAudience(INSTALL_UUID)
        .setIssuedAt(now)
        .setExpirationTime(now + expSecondsFromNow)
        .sign(key);
}

// Fake sql tagged-template that returns a controllable server-wide stream count.
function fakeSql(streamCount: number): unknown {
    return async () => [{ n: String(streamCount) }];
}

beforeEach(() => {
    cfg.LICENSE_ENFORCEMENT_ENABLED = true;
    cfg.LICENSE_KEY = '';
});

describe('collectInstallDiagnostics', () => {
    it('returns nominal when enforcement is off', async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = false;
        expect(await collectInstallDiagnostics(fakeSql(99) as never)).toBe(RC_NOMINAL);
    });

    it('returns nominal for a valid license', async () => {
        cfg.LICENSE_KEY = await validKey(60 * 24 * 60 * 60);
        expect(await collectInstallDiagnostics(fakeSql(99) as never, { nowMs: PAST_WARMUP })).toBe(
            RC_NOMINAL,
        );
    });

    it('returns renewing for a near-expiry license', async () => {
        cfg.LICENSE_KEY = await validKey(7 * 24 * 60 * 60);
        expect(await collectInstallDiagnostics(fakeSql(99) as never, { nowMs: PAST_WARMUP })).toBe(
            RC_RENEWING,
        );
    });

    it('returns unlicensed (benign) when free-tier with no excess streams', async () => {
        cfg.LICENSE_KEY = '';
        // A server-wide stream count below the free cap is benign.
        expect(await collectInstallDiagnostics(fakeSql(1) as never, { nowMs: PAST_WARMUP })).toBe(
            RC_UNLICENSED,
        );
    });

    it('returns unlicensed at the two-stream free cap', async () => {
        expect(await collectInstallDiagnostics(fakeSql(2) as never, { nowMs: PAST_WARMUP })).toBe(
            RC_UNLICENSED,
        );
    });

    it('counts streams across users while excluding fresh and stale sessions', async () => {
        const sql = vi.fn(async (_query: TemplateStringsArray) => [{ n: '2' }]);
        expect(await collectInstallDiagnostics(sql as never, { nowMs: PAST_WARMUP })).toBe(
            RC_UNLICENSED,
        );
        expect(sql).toHaveBeenCalled();
        const query = sql.mock.calls.map(([parts]) => parts.join('')).join('\n');
        expect(query).not.toMatch(/GROUP BY/);
        expect(query).toContain("surface = 'jellyfin_compat'");
        expect(query).toContain("started_at < now() - INTERVAL '60 seconds'");
        expect(query).toContain("last_heartbeat_at > now() - INTERVAL '5 minutes'");
    });

    it('returns the elevated code only when unlicensed AND the server exceeds the free cap', async () => {
        cfg.LICENSE_KEY = '';
        expect(await collectInstallDiagnostics(fakeSql(3) as never, { nowMs: PAST_WARMUP })).toBe(
            RC_CHECK,
        );
    });

    it('no key INSIDE the build grace window: above-cap streams are legitimate → renewing', async () => {
        cfg.LICENSE_KEY = '';
        const imageBuildTimeMs = Date.now() - 5 * 24 * 60 * 60 * 1000; // built 5 days ago
        expect(
            await collectInstallDiagnostics(fakeSql(3) as never, {
                nowMs: PAST_WARMUP,
                imageBuildTimeMs,
            }),
        ).toBe(RC_RENEWING);
    });

    it('no key AFTER the build grace window: an excess stream still elevates (semantics unchanged)', async () => {
        cfg.LICENSE_KEY = '';
        const imageBuildTimeMs = Date.now() - 45 * 24 * 60 * 60 * 1000; // built 45 days ago
        expect(
            await collectInstallDiagnostics(fakeSql(3) as never, {
                nowMs: PAST_WARMUP,
                imageBuildTimeMs,
            }),
        ).toBe(RC_CHECK);
    });

    it('does not elevate during warmup', async () => {
        cfg.LICENSE_KEY = '';
        // No nowMs override → within warmup → benign even if the server exceeds the cap.
        expect(await collectInstallDiagnostics(fakeSql(5) as never)).toBe(RC_UNLICENSED);
    });

    it('fails open to nominal when the DB query throws', async () => {
        cfg.LICENSE_KEY = '';
        const throwingSql = (() => {
            throw new Error('db down');
        }) as never;
        expect(await collectInstallDiagnostics(throwingSql, { nowMs: PAST_WARMUP })).toBe(
            RC_NOMINAL,
        );
    });
});

describe('statusCorrelationId', () => {
    const UUID = '11111111-2222-4333-8444-555555555555';
    const HEX16 = /^[0-9a-f]{16}$/;

    it('always looks like a 16-hex token', () => {
        expect(statusCorrelationId(UUID, 'valid', RC_NOMINAL)).toMatch(HEX16);
        expect(statusCorrelationId(UUID, 'free-tier', RC_CHECK)).toMatch(HEX16);
    });

    it('is stable per install for the integrity state', () => {
        const a = statusCorrelationId(UUID, 'free-tier', RC_CHECK);
        const b = statusCorrelationId(UUID, 'valid', RC_CHECK);
        expect(a).toBe(b); // depends only on the install, not validity/sequence
    });

    it('varies for benign states and never equals the integrity value', () => {
        const integrity = statusCorrelationId(UUID, 'free-tier', RC_CHECK);
        const benign = new Set<string>();
        for (let i = 0; i < 50; i++)
            benign.add(statusCorrelationId(UUID, 'free-tier', RC_UNLICENSED));
        expect(benign.size).toBeGreaterThan(1); // varies
        expect(benign.has(integrity)).toBe(false); // never collides with the integrity value
    });
});
