// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Playback Analytics Query Module
 *
 * Tests overall stats, transcoding, device/stream type, trends, and issue queries.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
    createAndInsertTestMovie,
} from '../../../../../tests/integration/fixtures/index.js';
import { PlaybackQualitySessionDetailSchema } from '../../../schemas/api-admin-responses.js';
import { detectFormFactor } from '../../../utils/user-agent.js';

import {
    getOverallStats,
    getTranscodingStats,
    getTranscodeReasons,
    getDeviceTypeStats,
    getStreamTypeStats,
    getClientTypeStats,
    getDailyTrends,
    getDailyByDeviceType,
    getUsersWithIssues,
    getDevicesWithIssues,
    getCommonIssues,
    getCrossTabAnalysis,
    getUserSessionDetails,
    getDeviceSessionDetails,
    getScopedDeliveryPercentiles,
    getSessionsWithoutTranscodeReason,
    clearAllTelemetryData,
} from './playback-analytics.queries.js';

const UA = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    androidPhone:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
    androidTablet:
        'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0',
    shield: 'Mozilla/5.0 (Linux; Android 11; SHIELD Android TV Build/RQ1A) AppleWebKit/537.36 Chrome/89.0 Safari/537.36',
    fireTv: 'Mozilla/5.0 (Linux; Android 9; AFTSS Build/PS7307; wv) AppleWebKit/537.36 Chrome/74.0 Safari/537.36',
    automobile: 'Automobile Player',
} as const;

describe('Playback Analytics Queries', () => {
    let sql: postgres.Sql;
    // playback_session_quality.user_id and user_playback_quality.user_id are
    // uuid REFERENCES users(id) since mig 16.46.0 — must be a valid UUID.
    let userId: string;
    const deviceId = 'test_analytics_device';

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        userId = generateTestUserId('analytics_user');
        await sql`TRUNCATE TABLE playback_session_quality, user_playback_quality, device_playback_quality, playback_telemetry RESTART IDENTITY CASCADE`;
        await ensureTestUser(sql, userId);
    });

    async function insertSession(
        overrides: {
            computedAt?: Date;
            healthScore?: number;
            rebufferCount?: number;
            bandwidthBps?: number;
            playMethod?: string;
            isMobile?: boolean;
            isLive?: boolean;
            clientType?: string;
            serverErrors?: number;
            healthIssues?: string[];
            transcodeReasons?: string[];
            transcodeReasonCodes?: Array<{
                code: string;
                params?: Record<string, string | number>;
            }>;
            isVideoTranscoding?: boolean;
            isAudioTranscoding?: boolean;
            compressionRatio?: number;
            userAgent?: string | null;
            playSessionId?: string;
            deviceId?: string;
        } = {},
    ) {
        const now = overrides.computedAt ?? new Date();
        await sql`
            INSERT INTO playback_session_quality (
                computed_at, health_score, client_avg_bandwidth_bps,
                client_rebuffer_count, server_error_count, health_issues,
                play_method, is_mobile, is_live, client_type,
                user_id, device_id, device_name, user_agent,
                transcode_reasons, transcode_reason_codes,
                is_video_transcoding, is_audio_transcoding, compression_ratio,
                play_session_id
            ) VALUES (
                ${now},
                ${overrides.healthScore ?? 90},
                ${overrides.bandwidthBps ?? 5_000_000},
                ${overrides.rebufferCount ?? 0},
                ${overrides.serverErrors ?? 0},
                ${overrides.healthIssues ?? []},
                ${overrides.playMethod ?? 'directplay'},
                ${overrides.isMobile ?? false},
                ${overrides.isLive ?? false},
                ${overrides.clientType ?? 'web'},
                ${userId},
                ${overrides.deviceId ?? deviceId},
                'Test Browser',
                ${overrides.userAgent === undefined ? 'Mozilla/5.0' : overrides.userAgent},
                ${overrides.transcodeReasons ?? []},
                ${overrides.transcodeReasonCodes ? sql.json(overrides.transcodeReasonCodes) : null},
                ${overrides.isVideoTranscoding ?? false},
                ${overrides.isAudioTranscoding ?? false},
                ${overrides.compressionRatio ?? 1.0},
                ${overrides.playSessionId ?? null}
            )
        `;
    }

    /**
     * A play session plus the owner's device record — the context the
     * analytics queries join in for the real device id and the device class.
     */
    async function insertPlaySession(opts: {
        deviceId: string;
        clientName?: string | null;
        userAgent?: string | null;
        reportedName?: string | null;
        mediaTitle?: string;
        forUserId?: string;
    }): Promise<string> {
        const owner = opts.forUserId ?? userId;
        const { id: mediaId } = await createAndInsertTestMovie(sql, {
            title: opts.mediaTitle,
        });
        const playSessionId = randomUUID();
        await sql`
            INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method, user_agent, client_name)
            VALUES (${playSessionId}, ${mediaId}::uuid, ${owner}, ${opts.deviceId}, '0.0.0.0'::inet, 'direct',
                    ${opts.userAgent ?? null}, ${opts.clientName ?? null})
        `;
        await sql`
            INSERT INTO user_devices (user_id, device_id, reported_name)
            VALUES (${owner}, ${opts.deviceId}, ${opts.reportedName ?? null})
            ON CONFLICT (user_id, device_id) DO NOTHING
        `;
        return playSessionId;
    }

    // ========================================================================
    // getOverallStats
    // ========================================================================

    describe('getOverallStats', () => {
        it('returns aggregated stats for sessions in range', async () => {
            await insertSession({ computedAt: new Date() });
            const stats = await getOverallStats(sql, new Date(Date.now() - 86400_000));
            expect(stats).not.toBeNull();
            expect(Number(stats!.total_sessions)).toBe(1);
        });

        it('counts devices by the play session, not the telemetry placeholder id', async () => {
            // Server telemetry stamps most sessions with the shared
            // `lumastra-player` id; three real devices must count as three.
            for (const dev of ['dev-a', 'dev-b', 'dev-c']) {
                const ps = await insertPlaySession({ deviceId: dev, userAgent: UA.windows });
                await insertSession({
                    playSessionId: ps,
                    deviceId: 'lumastra-player',
                    userAgent: null,
                });
            }
            const stats = await getOverallStats(sql, new Date(Date.now() - 86400_000));
            expect(stats!.unique_devices).toBe(3);
            expect(stats!.desktop_sessions).toBe(3);
            expect(stats!.mobile_sessions).toBe(0);
        });

        it('counts sessions below 70 as poor', async () => {
            await insertSession({ healthScore: 95 });
            await insertSession({ healthScore: 69 });
            await insertSession({ healthScore: 0 });
            const stats = await getOverallStats(sql, new Date(Date.now() - 86400_000));
            expect(stats!.poor_sessions).toBe(2);
        });

        it('returns null when no sessions match', async () => {
            const stats = await getOverallStats(sql, new Date());
            // Count returns 0 but row still exists because COUNT(*)
            expect(stats).not.toBeNull();
            expect(Number(stats!.total_sessions)).toBe(0);
        });
    });

    // ========================================================================
    // getTranscodingStats
    // ========================================================================

    describe('getTranscodingStats', () => {
        it('groups by play_method', async () => {
            await insertSession({ playMethod: 'directplay' });
            await insertSession({ playMethod: 'transcode' });
            const rows = await getTranscodingStats(sql, new Date(Date.now() - 86400_000));
            expect(rows.length).toBeGreaterThanOrEqual(2);
        });
    });

    // ========================================================================
    // getTranscodeReasons
    // ========================================================================

    describe('getTranscodeReasons', () => {
        it('buckets structured reason codes (language-agnostic)', async () => {
            await insertSession({
                transcodeReasonCodes: [
                    { code: 'video_codec_incompatible', params: { codec: 'hevc' } },
                ],
            });
            const rows = await getTranscodeReasons(sql, new Date(Date.now() - 86400_000));
            expect(rows.some((r) => r.reason_bucket === 'video_codec')).toBe(true);
        });

        it('folds equivalent codes into one bucket (no duplicate rows)', async () => {
            // Both video-profile codes collapse to the single `video_profile`
            // bucket, so one session yields exactly one row — not two — which is
            // what stops the "doubled" rows the localized free text produced.
            await insertSession({
                transcodeReasonCodes: [
                    { code: 'video_profile_exceeded', params: { profile: 'high' } },
                    { code: 'video_profile_excluded', params: { profile: 'high' } },
                ],
            });
            const rows = await getTranscodeReasons(sql, new Date(Date.now() - 86400_000));
            const profileRows = rows.filter((r) => r.reason_bucket === 'video_profile');
            expect(profileRows).toHaveLength(1);
        });

        it('ignores sessions without structured codes (legacy free text)', async () => {
            await insertSession({ transcodeReasons: ['codec not supported'] });
            const rows = await getTranscodeReasons(sql, new Date(Date.now() - 86400_000));
            expect(rows).toHaveLength(0);
        });
    });

    // ========================================================================
    // getDeviceTypeStats
    // ========================================================================

    describe('getDeviceTypeStats', () => {
        it('classifies sessions the same way detectFormFactor does (SQL/TS parity)', async () => {
            // The SQL classifier runs the pattern sources FORM_FACTOR_PATTERNS
            // exports; this pins that both engines read them the same way.
            const samples = Object.values(UA);
            for (const ua of samples) {
                await insertSession({ userAgent: ua });
            }
            const rows = await getDeviceTypeStats(sql, new Date(Date.now() - 86400_000));
            const got = Object.fromEntries(rows.map((r) => [r.device_type, r.session_count]));
            const expected: Record<string, number> = {};
            for (const ua of samples) {
                const ff = detectFormFactor(ua);
                expected[ff] = (expected[ff] ?? 0) + 1;
            }
            expect(got).toEqual(expected);
            // And the expectation itself is the intended split, not a vacuous match.
            expect(expected).toEqual({ mobile: 2, tablet: 1, desktop: 1, tv: 2, unknown: 1 });
        });

        it('reads the device class from the session and device records when the row has no UA', async () => {
            // Prod: psq.user_agent / is_mobile were never written; the evidence
            // lives on play_sessions.client_name and user_devices.reported_name.
            const tv = await insertPlaySession({
                deviceId: 'atv',
                clientName: 'Lumastra tvOS',
                reportedName: 'Apple TV',
            });
            const ipad = await insertPlaySession({
                deviceId: 'ipad',
                clientName: 'Lumastra iOS',
                reportedName: 'iPad Pro 13-inch (M5)',
            });
            const phone = await insertPlaySession({
                deviceId: 'phone',
                clientName: 'Lumastra iOS',
                reportedName: 'iPhone 17 Pro',
            });
            for (const ps of [tv, ipad, phone]) {
                await insertSession({ playSessionId: ps, userAgent: null, isMobile: false });
            }
            const rows = await getDeviceTypeStats(sql, new Date(Date.now() - 86400_000));
            const got = Object.fromEntries(rows.map((r) => [r.device_type, r.session_count]));
            expect(got).toEqual({ tv: 1, tablet: 1, mobile: 1 });
        });
    });

    // ========================================================================
    // getStreamTypeStats
    // ========================================================================

    describe('getStreamTypeStats', () => {
        it('separates live and vod', async () => {
            await insertSession({ isLive: true });
            await insertSession({ isLive: false });
            const rows = await getStreamTypeStats(sql, new Date(Date.now() - 86400_000));
            expect(rows.length).toBe(2);
        });
    });

    // ========================================================================
    // getClientTypeStats
    // ========================================================================

    describe('getClientTypeStats', () => {
        it('groups by client_type', async () => {
            await insertSession({ clientType: 'web' });
            await insertSession({ clientType: 'mobile' });
            const rows = await getClientTypeStats(sql, new Date(Date.now() - 86400_000));
            expect(rows.some((r) => r.client_type === 'web')).toBe(true);
            expect(rows.some((r) => r.client_type === 'mobile')).toBe(true);
        });
    });

    // ========================================================================
    // getDailyTrends
    // ========================================================================

    describe('getDailyTrends', () => {
        it('counts the per-session rows, so the days sum to the page total', async () => {
            await insertSession({ healthScore: 80, rebufferCount: 2 });
            await insertSession({ healthScore: 100 });
            // A rollup row that disagrees must not leak in (the rollup lagged
            // the per-session table by one on prod).
            await sql`
                INSERT INTO user_playback_quality (date, user_id, total_sessions, avg_health_score, rebuffer_events, avg_bandwidth_bps)
                VALUES (CURRENT_DATE, ${userId}, 5, 85, 1, 4000000)
            `;
            const cutoff = new Date(Date.now() - 86400_000);
            const rows = await getDailyTrends(sql, cutoff);
            const overall = await getOverallStats(sql, cutoff);
            expect(rows.reduce((sum, r) => sum + r.sessions, 0)).toBe(overall!.total_sessions);
            expect(rows.reduce((sum, r) => sum + r.rebuffers, 0)).toBe(2);
        });
    });

    // ========================================================================
    // getDailyByDeviceType
    // ========================================================================

    describe('getDailyByDeviceType', () => {
        it('returns rows grouped by date and device_type', async () => {
            await insertSession({ isMobile: false });
            const rows = await getDailyByDeviceType(sql, new Date(Date.now() - 86400_000));
            expect(rows.length).toBeGreaterThanOrEqual(1);
        });
    });

    // ========================================================================
    // getUsersWithIssues
    // ========================================================================

    describe('getUsersWithIssues', () => {
        it('returns users with rebuffer events or low health, from the per-session rows', async () => {
            await insertSession({
                healthScore: 70,
                rebufferCount: 5,
                healthIssues: ['rebuffering'],
            });
            await insertSession({ healthScore: 90 });
            await insertSession({ healthScore: 50, healthIssues: ['low_buffer'] });
            const rows = await getUsersWithIssues(sql, new Date(Date.now() - 86400_000), 10);
            const row = rows.find((r) => r.user_id === userId);
            expect(row).toBeDefined();
            expect(row!.total_sessions).toBe(3);
            expect(row!.rebuffers).toBe(5);
            expect(row!.sessions_with_issues).toBe(2);
            expect(row!.avg_health_score).toBeCloseTo(70);
        });

        it('leaves out users with no rebuffers and good health', async () => {
            await insertSession({ healthScore: 95 });
            const rows = await getUsersWithIssues(sql, new Date(Date.now() - 86400_000), 10);
            expect(rows).toHaveLength(0);
        });
    });

    // ========================================================================
    // getDevicesWithIssues
    // ========================================================================

    describe('getDevicesWithIssues', () => {
        it('returns one row per REAL device, named and classified', async () => {
            // Both sessions carry the telemetry placeholder id; they are two
            // different devices and must not merge into one "lumastra-player".
            const phone = await insertPlaySession({
                deviceId: 'dashboard-phone',
                reportedName: UA.iphone,
            });
            const pc = await insertPlaySession({
                deviceId: 'dashboard-pc',
                reportedName: UA.windows,
            });
            await insertSession({
                playSessionId: phone,
                deviceId: 'lumastra-player',
                userAgent: null,
                rebufferCount: 3,
            });
            await insertSession({
                playSessionId: pc,
                deviceId: 'lumastra-player',
                userAgent: null,
                healthScore: 60,
            });
            const rows = await getDevicesWithIssues(sql, new Date(Date.now() - 86400_000), 10);
            expect(rows.map((r) => r.device_id).sort()).toEqual([
                'dashboard-pc',
                'dashboard-phone',
            ]);
            const phoneRow = rows.find((r) => r.device_id === 'dashboard-phone')!;
            expect(phoneRow.form_factor).toBe('mobile');
            expect(phoneRow.is_mobile).toBe(true);
            expect(phoneRow.device_name).toBe(UA.iphone);
            expect(phoneRow.rebuffers).toBe(3);
            expect(rows.find((r) => r.device_id === 'dashboard-pc')!.form_factor).toBe('desktop');
            // Worst health first.
            expect(rows[0].device_id).toBe('dashboard-pc');
        });

        it('leaves out devices with no rebuffers and good health', async () => {
            const ps = await insertPlaySession({ deviceId: 'healthy', userAgent: UA.windows });
            await insertSession({ playSessionId: ps, healthScore: 95 });
            const rows = await getDevicesWithIssues(sql, new Date(Date.now() - 86400_000), 10);
            expect(rows).toHaveLength(0);
        });
    });

    // ========================================================================
    // getScopedDeliveryPercentiles
    // ========================================================================

    describe('getScopedDeliveryPercentiles', () => {
        it("uses only the user's / device's own sessions, not the fleet", async () => {
            const otherUser = generateTestUserId('analytics_other');
            await ensureTestUser(sql, otherUser);
            const mine = await insertPlaySession({ deviceId: 'my-device' });
            const theirs = await insertPlaySession({
                deviceId: 'their-device',
                forUserId: otherUser,
            });
            // Server telemetry carries no user_id on prod — leave it NULL here too.
            for (const [ps, value] of [
                [mine, 10],
                [mine, 20],
                [theirs, 1000],
                [theirs, 2000],
                [theirs, 3000],
            ] as const) {
                await sql`
                    INSERT INTO playback_telemetry (play_session_id, source, metric_type, value)
                    VALUES (${ps}, 'server', 'segment_delivery_ms', ${value})
                `;
            }
            const cutoff = new Date(Date.now() - 86400_000);
            const forUser = await getScopedDeliveryPercentiles(sql, cutoff, { userId });
            expect(forUser.sampleCount).toBe(2);
            expect(forUser.p99Ms).toBeLessThanOrEqual(20);

            const forDevice = await getScopedDeliveryPercentiles(sql, cutoff, {
                deviceId: 'their-device',
            });
            expect(forDevice.sampleCount).toBe(3);
            expect(forDevice.p50Ms).toBe(2000);
        });
    });

    // ========================================================================
    // getSessionsWithoutTranscodeReason
    // ========================================================================

    describe('getSessionsWithoutTranscodeReason', () => {
        it('counts remuxes and transcodes that carry no reason code', async () => {
            await insertSession({ playMethod: 'Transcode' });
            await insertSession({ playMethod: 'DirectStream' });
            await insertSession({
                playMethod: 'Transcode',
                transcodeReasonCodes: [{ code: 'audio_codec_incompatible' }],
            });
            // Direct play needs no reason; neither counts.
            await insertSession({ playMethod: 'DirectPlay' });
            const count = await getSessionsWithoutTranscodeReason(
                sql,
                new Date(Date.now() - 86400_000),
            );
            expect(count).toBe(2);
        });
    });

    // ========================================================================
    // getCommonIssues
    // ========================================================================

    describe('getCommonIssues', () => {
        it('aggregates health_issues array elements', async () => {
            await insertSession({ healthIssues: ['rebuffer', 'high bitrate'] });
            const rows = await getCommonIssues(sql, new Date(Date.now() - 86400_000), 10);
            expect(rows.some((r) => r.issue === 'rebuffer')).toBe(true);
            expect(rows.some((r) => r.issue === 'high bitrate')).toBe(true);
        });
    });

    // ========================================================================
    // getCrossTabAnalysis
    // ========================================================================

    describe('getCrossTabAnalysis', () => {
        it('returns device x play_method cross tab', async () => {
            await insertSession({ isMobile: false, playMethod: 'directplay' });
            const rows = await getCrossTabAnalysis(sql, new Date(Date.now() - 86400_000));
            expect(rows.length).toBeGreaterThanOrEqual(1);
        });
    });

    // ========================================================================
    // getUserSessionDetails / getDeviceSessionDetails
    // ========================================================================

    /**
     * playback_session_quality.play_session_id FKs to play_sessions(id), which
     * in turn requires a real media_items row — build the full chain so a row
     * with a NULL play_method (a legitimate, unremarkable state) can exist.
     */
    async function insertSessionQualityWithNullPlayMethod(): Promise<string> {
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        const playSessionId = randomUUID();
        await sql`
            INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
            VALUES (${playSessionId}, ${mediaId}::uuid, ${userId}, ${deviceId}, '0.0.0.0'::inet, 'direct')
        `;
        await sql`
            INSERT INTO playback_session_quality (
                computed_at, health_score, play_session_id, play_method,
                is_mobile, user_id, device_id
            ) VALUES (
                now(), 90, ${playSessionId}, NULL, false, ${userId}, ${deviceId}
            )
        `;
        return playSessionId;
    }

    describe('getUserSessionDetails', () => {
        it('normalizes a NULL play_method to undefined so PlaybackQualitySessionDetailSchema.parse succeeds', async () => {
            await insertSessionQualityWithNullPlayMethod();

            const rows = await getUserSessionDetails(sql, userId, new Date(Date.now() - 86400_000));

            expect(rows).toHaveLength(1);
            expect(rows[0].playMethod).toBeUndefined();
            expect(rows[0].rootCause).toBeUndefined();
            expect(() => PlaybackQualitySessionDetailSchema.parse(rows[0])).not.toThrow();
        });

        it('carries what was played, the device name and its class', async () => {
            const ps = await insertPlaySession({
                deviceId: 'drawer-device',
                clientName: 'Lumastra tvOS',
                reportedName: 'Apple TV',
                mediaTitle: 'Drawer Test Movie',
            });
            await insertSession({ playSessionId: ps, userAgent: null });
            const rows = await getUserSessionDetails(sql, userId, new Date(Date.now() - 86400_000));
            expect(rows).toHaveLength(1);
            expect(rows[0].mediaTitle).toBe('Drawer Test Movie');
            expect(rows[0].deviceName).toBe('Apple TV');
            expect(rows[0].deviceType).toBe('tv');
            expect(() => PlaybackQualitySessionDetailSchema.parse(rows[0])).not.toThrow();
        });
    });

    describe('getDeviceSessionDetails', () => {
        it('matches the real device id, not the telemetry placeholder', async () => {
            const ps = await insertPlaySession({ deviceId: 'real-device' });
            await insertSession({ playSessionId: ps, deviceId: 'lumastra-player' });
            const cutoff = new Date(Date.now() - 86400_000);
            expect(await getDeviceSessionDetails(sql, 'real-device', cutoff)).toHaveLength(1);
            expect(await getDeviceSessionDetails(sql, 'lumastra-player', cutoff)).toHaveLength(0);
        });

        it('normalizes a NULL play_method to undefined so PlaybackQualitySessionDetailSchema.parse succeeds', async () => {
            await insertSessionQualityWithNullPlayMethod();

            const rows = await getDeviceSessionDetails(
                sql,
                deviceId,
                new Date(Date.now() - 86400_000),
            );

            expect(rows).toHaveLength(1);
            expect(rows[0].playMethod).toBeUndefined();
            expect(rows[0].rootCause).toBeUndefined();
            expect(() => PlaybackQualitySessionDetailSchema.parse(rows[0])).not.toThrow();
        });
    });

    // ========================================================================
    // clearAllTelemetryData
    // ========================================================================

    describe('clearAllTelemetryData', () => {
        it('truncates all telemetry tables', async () => {
            await insertSession();
            await clearAllTelemetryData(sql);

            const rows = await sql`SELECT COUNT(*)::int AS c FROM playback_session_quality`;
            expect(rows[0].c).toBe(0);
        });
    });
});
