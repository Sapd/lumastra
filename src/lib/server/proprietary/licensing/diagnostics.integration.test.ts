// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

vi.mock('$lib/server/config', () => ({
    config: { LICENSE_ENFORCEMENT_ENABLED: true, LICENSE_KEY: '' },
    FEATURE_PER_TASK_QUEUES: false,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}));
vi.mock('$lib/server/database/queries/license-install.queries.js', () => ({
    observeInstallClock: async () => ({
        installUuid: '11111111-2222-4333-8444-555555555555',
        effectiveNowMs: Date.now(),
    }),
}));
vi.mock('$lib/server/database', () => ({ getDb: () => null }));

import { collectInstallDiagnostics, RC_CHECK, RC_UNLICENSED } from './diagnostics';

const PAST_WARMUP = Date.now() + 20 * 60 * 1000;

describe('install diagnostics server-wide stream count (PostgreSQL)', () => {
    let pool: postgres.Sql;
    let sql: postgres.ReservedSql;

    beforeAll(async () => {
        const url = process.env.TEST_DATABASE_URL;
        if (!url) throw new Error('TEST_DATABASE_URL is required');
        // Reserve one connection so temporary fixtures remain private to this file.
        // Execute the production diagnostics query without persistent fixture writes.
        pool = postgres(url, { max: 1 });
        sql = await pool.reserve();
        await sql`
            CREATE TEMP TABLE play_sessions (
                id text,
                media_id uuid,
                source text DEFAULT 'lumastra',
                purpose text DEFAULT 'play',
                is_preview boolean DEFAULT false,
                paused_at timestamptz,
                external_payload jsonb,
                last_heartbeat_at timestamptz,
                user_id text,
                status text,
                surface text,
                device_id text,
                started_at timestamptz,
                last_seen_at timestamptz
            )
        `;
    });

    beforeEach(async () => {
        await sql`TRUNCATE pg_temp.play_sessions`;
    });

    afterAll(async () => {
        sql?.release();
        await pool?.end();
    });

    async function addStream(
        userId: string,
        ageSeconds = 120,
        lastSeenSeconds = 0,
        surface = 'jellyfin_compat',
        status = 'ACTIVE',
        deviceId = 'jellyfin-compat-test',
        heartbeatSeconds = lastSeenSeconds,
        pausedSeconds = 0,
    ): Promise<void> {
        await sql`
            INSERT INTO pg_temp.play_sessions
                (user_id, status, surface, device_id, started_at, last_seen_at, last_heartbeat_at, paused_at)
            VALUES (${userId}, ${status}, ${surface}, ${deviceId},
                now() - make_interval(secs => ${ageSeconds}),
                now() - make_interval(secs => ${lastSeenSeconds}),
                now() - make_interval(secs => ${heartbeatSeconds}),
                CASE WHEN ${status} = 'PAUSED'
                    THEN now() - make_interval(secs => ${pausedSeconds}) ELSE NULL END)
        `;
    }

    async function diagnosticCode(nowMs = PAST_WARMUP): Promise<number> {
        return collectInstallDiagnostics(sql, { nowMs, imageBuildTimeMs: null });
    }

    it('returns unlicensed when there are no streams', async () => {
        expect(await diagnosticCode()).toBe(RC_UNLICENSED);
    });

    it('allows two sustained bridge streams by one user', async () => {
        await addStream('one');
        await addStream('one', 120, 0, 'jellyfin_compat', 'PAUSED');
        expect(await diagnosticCode()).toBe(RC_UNLICENSED);
    });

    it('allows two sustained bridge streams by different users', async () => {
        await addStream('one');
        await addStream('two');
        expect(await diagnosticCode()).toBe(RC_UNLICENSED);
    });

    it('flags three sustained bridge streams across different users', async () => {
        await addStream('one');
        await addStream('two');
        await addStream('three');
        expect(await diagnosticCode()).toBe(RC_CHECK);
    });

    it('flags three sustained streams by one user, including paused streams', async () => {
        await addStream('one');
        await addStream('one');
        await addStream('one', 120, 0, 'jellyfin_compat', 'PAUSED');
        expect(await diagnosticCode()).toBe(RC_CHECK);
    });

    it('does not flag excess sustained streams during process warmup', async () => {
        for (let i = 0; i < 3; i++) await addStream('one');
        expect(await diagnosticCode(Date.now())).toBe(RC_UNLICENSED);
    });

    it.each([
        ['fresh', 30, 0, 'jellyfin_compat', 'ACTIVE'],
        ['stale', 120, 360, 'jellyfin_compat', 'ACTIVE'],
        ['ended', 120, 0, 'jellyfin_compat', 'STOPPED'],
        ['external mirror', 120, 0, 'jellyfin_mirror', 'ACTIVE'],
        ['native', 120, 0, 'native', 'ACTIVE'],
    ] as const)('excludes %s sessions', async (_label, age, lastSeen, surface, status) => {
        await addStream('one');
        await addStream('two');
        await addStream('three', age, lastSeen, surface, status);
        expect(await diagnosticCode()).toBe(RC_UNLICENSED);
    });

    it('excludes an abandoned stream whose enforcement slot is already free', async () => {
        await addStream(
            'departed',
            240,
            240,
            'jellyfin_compat',
            'ACTIVE',
            'jellyfin-compat-old',
            180,
        );
        await addStream('one', 200, 200, 'jellyfin_compat', 'ACTIVE', 'jellyfin-compat-one', 0);
        await addStream('two', 80, 80);
        expect(await diagnosticCode()).toBe(RC_UNLICENSED);
    });

    it('counts long-running streams with fresh heartbeats despite old last-seen timestamps', async () => {
        for (let i = 0; i < 3; i++) {
            await addStream(
                `user-${i}`,
                600,
                600,
                'jellyfin_compat',
                'ACTIVE',
                'jellyfin-compat-test',
                0,
            );
        }
        expect(await diagnosticCode()).toBe(RC_CHECK);
    });

    it('excludes a long-paused stream even if its keepalive is fresh', async () => {
        await addStream('one');
        await addStream('two');
        await addStream(
            'paused',
            3600,
            0,
            'jellyfin_compat',
            'PAUSED',
            'jellyfin-compat-test',
            0,
            1900,
        );
        expect(await diagnosticCode()).toBe(RC_UNLICENSED);
    });

    it.each([
        [240, RC_CHECK],
        [360, RC_UNLICENSED],
    ])(
        'applies the diagnostics recency window to paused heartbeat age %s',
        async (age, expected) => {
            await addStream('one');
            await addStream('two');
            await addStream(
                'paused',
                600,
                0,
                'jellyfin_compat',
                'PAUSED',
                'jellyfin-compat-test',
                age,
                120,
            );
            expect(await diagnosticCode()).toBe(expected);
        },
    );

    it('identifies bridge streams by the authoritative surface, not the device prefix', async () => {
        for (let i = 0; i < 3; i++) {
            await addStream(`user-${i}`, 120, 0, 'jellyfin_compat', 'ACTIVE', 'another-device');
        }
        expect(await diagnosticCode()).toBe(RC_CHECK);
    });
});
