// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/** Real install-clock observations must reach the offline verifier unchanged. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    getInstallUuid,
    observeInstallClock,
    type InstallClockObservation,
} from '$lib/server/database/queries/license-install.queries.js';
import { FREE_TIER_ENTITLEMENTS } from '$lib/server/licensing/entitlements.js';
import { LICENSE_JWT_ALG, LICENSE_JWT_ISSUER } from './public-key.js';
import { GRACE_MS, clearLicenseCache, getStatus, verifyLicenseKey } from './license.service.js';

/** The admin switch, read live like the real getter (settings.json can change it). */
const flags = vi.hoisted(() => ({ contact: true }));
vi.mock('$lib/server/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get(target, key, receiver) {
                if (key === 'LICENSE_ENFORCEMENT_ENABLED') return true;
                if (key === 'LICENSE_KEY') return '';
                if (key === 'LICENSE_SERVER_CONTACT_ENABLED') return flags.contact;
                return Reflect.get(target, key, receiver);
            },
        }),
    };
});
// getStatus resolves the install through the real query on the test database.
vi.mock('$lib/server/database', async () => {
    const { getTestDb } = await import('../../../../../tests/integration/setup/test-database.js');
    return { getDb: () => getTestDb() };
});

describe('install clock → offline license verification', () => {
    const NOW_MS = Date.parse('2027-02-16T12:00:00Z');
    const DAY_MS = 24 * 60 * 60 * 1000;
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    async function firstClockObservation(): Promise<InstallClockObservation> {
        return await sql.begin(async (tx) => {
            await tx`CREATE TEMP TABLE license_install
                (LIKE public.license_install INCLUDING ALL) ON COMMIT DROP`;
            await getInstallUuid(tx);
            return await observeInstallClock(tx, new Date(NOW_MS).toISOString());
        });
    }

    it('an old keyless image loses build grace', async () => {
        const observation = await firstClockObservation();
        const nowMs = NOW_MS;
        const status = await verifyLicenseKey(
            '',
            observation.installUuid,
            undefined,
            observation.effectiveNowMs,
            nowMs - 31 * DAY_MS,
        );

        // The old NULL→epoch+6h query returned 1970, keeping this image in grace.
        expect(status.validity).toBe('free-tier');
        expect(status.reasonCode).toBe('grace-ended-free');
        expect(status.verified).toBe(false);
        expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
    });

    it('an early-access key past expiry + 14 days loses access', async () => {
        const observation = await firstClockObservation();
        const nowMs = NOW_MS;
        const { publicKey, privateKey } = await generateKeyPair(LICENSE_JWT_ALG);
        const key = await new SignJWT({
            tier: 'early_access',
            ent: {
                modules: ['jellyfin_compat', 'ai_assistant', 'branding_removal', 'push'],
                jellyfinMaxConcurrentStreams: null,
                maxSeats: null,
                seatOverflowPolicy: 'observe',
            },
        })
            .setProtectedHeader({ alg: LICENSE_JWT_ALG, typ: 'JWT' })
            .setIssuer(LICENSE_JWT_ISSUER)
            .setAudience(observation.installUuid)
            .setExpirationTime(Math.floor((nowMs - GRACE_MS - DAY_MS) / 1000))
            .sign(privateKey);
        const status = await verifyLicenseKey(
            key,
            observation.installUuid,
            publicKey,
            observation.effectiveNowMs,
            nowMs - DAY_MS,
        );

        // The epoch floor previously classified this authentic expired key as valid.
        expect(GRACE_MS).toBe(14 * DAY_MS);
        expect(status.validity).toBe('expired');
        expect(status.reasonCode).toBe('expired-beyond-grace');
        expect(status.verified).toBe(false);
        expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
    });

    it('getStatus follows the contact switch at once, not after the 2h verify cache', async () => {
        flags.contact = true;
        clearLicenseCache();
        try {
            // vitest has no baked image build time, so contact on + no key is
            // the plain no-key free tier; off names the switch as the reason.
            const on = await getStatus();
            expect(on.reasonCode).toBe('no-key-free');

            flags.contact = false;
            const off = await getStatus();
            expect(off.validity).toBe('free-tier');
            expect(off.reasonCode).toBe('contact-off-free');
            expect(off.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);

            flags.contact = true;
            expect((await getStatus()).reasonCode).toBe('no-key-free');
        } finally {
            flags.contact = true;
            clearLicenseCache();
        }
    });
});
