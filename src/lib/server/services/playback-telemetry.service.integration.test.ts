// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration coverage for the delivery-window aggregate inside
 * `computeSessionQuality`, against real Postgres.
 *
 * Why this cannot be a unit test: the thing under test is a regex guard inside
 * SQL. `playback_telemetry.metadata` is client-controlled jsonb, so one row with
 * `overdue: 'abc'` — or with an OBJECT there, which `->>` renders as JSON text —
 * would make a bare `::numeric` raise 22P02. In Postgres that aborts the whole
 * SELECT, which makes `computeSessionQualityLocked` return null, which costs that
 * session its quality row permanently. No mock reproduces 22P02; only a real
 * driver against a real jsonb column proves the CASE guard actually stands
 * between a malformed client build and a lost session.
 *
 * Run: npm run test:integration src/lib/server/services/playback-telemetry.service.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
    createAndInsertTestMovie,
} from '../../../../tests/integration/fixtures/index.js';
import type { UserId } from '$lib/shared/user-id';
import { playbackTelemetryService } from './playback-telemetry.service.js';

const DEVICE_ID = 'delivery_window_device';

describe('playbackTelemetryService.computeSessionQuality — delivery windows', () => {
    let sql: postgres.Sql;
    let userId: UserId;
    let playSessionId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    /**
     * `playback_telemetry.play_session_id` and, once `computeSessionQuality`
     * upserts, `playback_session_quality.play_session_id` both FK to
     * `play_sessions(id)`, which in turn requires a real `media_items` row —
     * build the full chain so neither insert 23503s against an orphan session.
     */
    async function seedPlaySession(): Promise<void> {
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        await sql`
            INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
            VALUES (
                ${playSessionId}::uuid,
                ${mediaId}::uuid,
                ${userId},
                ${DEVICE_ID},
                '0.0.0.0'::inet,
                'direct'
            )
        `;
    }

    beforeEach(async () => {
        userId = generateTestUserId('delivery_window_user');
        playSessionId = randomUUID();
        await sql`TRUNCATE TABLE playback_session_quality, user_playback_quality, device_playback_quality, playback_telemetry, play_sessions RESTART IDENTITY CASCADE`;
        await ensureTestUser(sql, userId);
        await seedPlaySession();
    });

    /** One client-side telemetry row, metadata bound through `sql.json`. */
    async function record(
        metricType: string,
        value: number,
        metadata?: Record<string, unknown>,
    ): Promise<void> {
        await sql`
            INSERT INTO playback_telemetry (play_session_id, user_id, source, metric_type, value, metadata)
            VALUES (
                ${playSessionId}::uuid,
                ${userId}::uuid,
                'client',
                ${metricType},
                ${value},
                ${metadata === undefined ? null : sql.json(metadata as unknown as postgres.JSONValue)}
            )
        `;
    }

    it('sums only the numeric `overdue` values and still writes p10/p50', async () => {
        // 8 Mbit/s of media, four receiver-timed windows: a collapse at 4 Mbit/s
        // and three ample ones. Only the FIRST window's overdue is a plain
        // number; 'abc' and the object are the 22P02 triggers.
        await record('media_bitrate', 8_000_000);
        await record('rebuffer_event', 0); // makes hasPlaybackIssue true
        await record('delivery_window', 4_000_000, { bytes: '1000', overdue: '3' });
        await record('delivery_window', 20_000_000, { bytes: '9000', overdue: 'abc' });
        await record('delivery_window', 22_000_000, {
            bytes: '9500',
            overdue: { delta: 2, note: 'a client build that sent an object' },
        });
        await record('delivery_window', 25_000_000, { bytes: '9900' });

        const quality = await playbackTelemetryService.computeSessionQuality(
            playSessionId,
            userId,
            false,
        );

        // The guard held: the aggregate ran to completion, so a row exists at all.
        expect(quality).not.toBeNull();

        const [row] = await sql<
            {
                client_delivery_window_count: number;
                client_delivery_p10_bps: number | null;
                client_delivery_p50_bps: number | null;
                client_delivery_overdue_count: number;
                health_issues: string[] | null;
                health_score: number | null;
            }[]
        >`
            SELECT client_delivery_window_count,
                   client_delivery_p10_bps,
                   client_delivery_p50_bps,
                   client_delivery_overdue_count,
                   health_issues,
                   health_score
            FROM playback_session_quality
            WHERE play_session_id = ${playSessionId}::uuid
        `;

        expect(row).toBeDefined();
        expect(row.client_delivery_window_count).toBe(4);
        // Exactly the one parseable value — NOT 3 + 2 (the object's `delta` is
        // not a number this SQL may read) and NOT 0 (which is what a guard that
        // rejected everything would give).
        expect(row.client_delivery_overdue_count).toBe(3);
        expect(row.client_delivery_p10_bps).not.toBeNull();
        expect(row.client_delivery_p50_bps).not.toBeNull();
        expect(row.client_delivery_p10_bps!).toBeLessThan(row.client_delivery_p50_bps!);

        // 3 overdue downloads is the classifier's own threshold, so the cause
        // fires and must bring its penalty — asserted here through real SQL
        // because the issues array round-trips a text[] column.
        expect(row.health_issues).toContain('cause:delivery_interruptions');
        expect(row.health_issues).toContain('delivery_interruptions');
        expect(row.health_score!).toBeLessThan(100);
    });

    it('takes the device from the play session, not the telemetry placeholder, and classifies it', async () => {
        // Prod (2026-09-27): server telemetry stamps sessions with the shared
        // `lumastra-player` id, and nothing ever wrote is_mobile / user_agent,
        // so every session read as one "desktop" device.
        await sql`
            UPDATE play_sessions
            SET user_agent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
                client_name = 'Lumastra Web'
            WHERE id = ${playSessionId}::uuid
        `;
        await sql`
            INSERT INTO user_devices (user_id, device_id, reported_name, custom_name)
            VALUES (${userId}, ${DEVICE_ID}, 'reported', 'Kitchen phone')
        `;
        await sql`
            INSERT INTO playback_telemetry (play_session_id, device_id, source, metric_type, value)
            VALUES (${playSessionId}::uuid, 'lumastra-player', 'server', 'segment_delivery_ms', 12)
        `;
        await record('media_bitrate', 8_000_000);

        const quality = await playbackTelemetryService.computeSessionQuality(
            playSessionId,
            userId,
            false,
        );
        expect(quality).not.toBeNull();

        const [row] = await sql<
            {
                device_id: string | null;
                device_name: string | null;
                user_agent: string | null;
                is_mobile: boolean | null;
            }[]
        >`
            SELECT device_id, device_name, user_agent, is_mobile
            FROM playback_session_quality
            WHERE play_session_id = ${playSessionId}::uuid
        `;
        expect(row.device_id).toBe(DEVICE_ID);
        expect(row.device_name).toBe('Kitchen phone');
        expect(row.user_agent).toContain('iPhone');
        expect(row.is_mobile).toBe(true);
    });

    it('leaves is_mobile NULL when nothing identifies the device', async () => {
        await record('media_bitrate', 8_000_000);
        await playbackTelemetryService.computeSessionQuality(playSessionId, userId, false);
        const [row] = await sql<{ is_mobile: boolean | null }[]>`
            SELECT is_mobile FROM playback_session_quality
            WHERE play_session_id = ${playSessionId}::uuid
        `;
        // Unknown is not "desktop" — the old default of false made it so.
        expect(row.is_mobile).toBeNull();
    });

    it('writes a row with no delivery evidence at all rather than failing', async () => {
        await record('media_bitrate', 8_000_000);
        await record('bandwidth_estimate', 30_000_000);

        const quality = await playbackTelemetryService.computeSessionQuality(
            playSessionId,
            userId,
            false,
        );
        expect(quality).not.toBeNull();

        const [row] = await sql<
            {
                client_delivery_window_count: number;
                client_delivery_p10_bps: number | null;
                client_delivery_overdue_count: number;
            }[]
        >`
            SELECT client_delivery_window_count, client_delivery_p10_bps, client_delivery_overdue_count
            FROM playback_session_quality
            WHERE play_session_id = ${playSessionId}::uuid
        `;

        expect(row.client_delivery_window_count).toBe(0);
        // No windows means UNKNOWN, not zero throughput.
        expect(row.client_delivery_p10_bps).toBeNull();
        // The overdue SUM is COALESCEd to 0 for the NOT NULL integer column.
        expect(row.client_delivery_overdue_count).toBe(0);
    });
});
