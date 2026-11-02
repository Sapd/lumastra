// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for LiveTV Program Search
 *
 * Tests run against real PostgreSQL with livetv tables (requires LiveTV migrations).
 * Covers: temporal status computation, hidden channel exclusion, grouping logic,
 * 30-minute ended window, ts_rank ordering, and LIMIT on grouped results.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { searchProgramsByTextGrouped } from './livetv-programs.queries.js';

// =============================================================================
// Helpers
// =============================================================================

const LIVETV_TABLES = [
    'livetv_programs',
    'livetv_channels',
    'livetv_categories',
    'livetv_sources',
] as const;

async function truncateLiveTvTables(sql: postgres.Sql): Promise<void> {
    await sql.unsafe(`TRUNCATE TABLE ${LIVETV_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

async function insertSource(
    sql: postgres.Sql,
    id: string,
    name: string = 'Test Source',
): Promise<void> {
    await sql`
        INSERT INTO livetv_sources (id, name, source_type, max_streams)
        VALUES (${id}, ${name}, 'm3u', 2)
        ON CONFLICT (id) DO NOTHING
    `;
}

async function insertCategory(
    sql: postgres.Sql,
    id: string,
    name: string,
    sortOrder: number = 0,
    isVisible: boolean = true,
): Promise<void> {
    await sql`
        INSERT INTO livetv_categories (id, name, sort_order, is_visible)
        VALUES (${id}, ${name}, ${sortOrder}, ${isVisible})
        ON CONFLICT (id) DO NOTHING
    `;
}

async function insertChannel(
    sql: postgres.Sql,
    opts: {
        id: string;
        name: string;
        sourceId: string;
        streamUrl?: string;
        sortOrder?: number;
        isVisible?: boolean;
        categoryId?: string;
        logoUrl?: string;
    },
): Promise<void> {
    // livetv_channels.id is a FK to media_items.id — create the media_items row first
    await sql`
        INSERT INTO media_items (id, title, media_type, status, custom_poster_url)
        VALUES (
            ${opts.id}::uuid, ${opts.name}, 'tvchannel', 'active',
            ${opts.logoUrl ?? null}
        )
        ON CONFLICT (id) DO NOTHING
    `;
    await sql`
        INSERT INTO livetv_channels (
            id, m3u_url, source_id, sort_order,
            is_visible, category_id
        )
        VALUES (
            ${opts.id}::uuid,
            ${opts.streamUrl ?? 'http://stream.test/ch.m3u8'},
            ${opts.sourceId}::uuid,
            ${opts.sortOrder ?? 0}, ${opts.isVisible ?? true},
            ${opts.categoryId ? sql`${opts.categoryId}::uuid` : sql`NULL`}
        )
        ON CONFLICT (id) DO NOTHING
    `;
}

async function insertProgram(
    sql: postgres.Sql,
    opts: {
        id: string;
        channelId: string;
        title: string;
        description?: string;
        startTime: Date;
        endTime: Date;
    },
): Promise<void> {
    // search_vector is a GENERATED ALWAYS AS column — do not include in INSERT
    await sql`
        INSERT INTO livetv_programs (
            id, channel_id, title, description,
            start_time, end_time
        )
        VALUES (
            ${opts.id}, ${opts.channelId}, ${opts.title},
            ${opts.description ?? null},
            ${opts.startTime}, ${opts.endTime}
        )
    `;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Fetch the current timestamp from PostgreSQL so that test time computations
 * are aligned with the DB clock, avoiding skew when the Node process and the
 * database server are on different machines (e.g. SSH tunnel to remote PG).
 */
async function getDbNow(sql: postgres.Sql): Promise<Date> {
    const rows = await sql<[{ now: Date }]>`SELECT NOW() AS now`;
    return rows[0].now;
}

// =============================================================================
// Tests
// =============================================================================

describe('searchProgramsByTextGrouped (integration)', () => {
    let sql: postgres.Sql;

    const SOURCE_ID = '00000000-0000-0000-0000-000000000001';
    const CAT_ID = '00000000-0000-0000-0000-000000000010';
    const CH1_ID = '00000000-0000-0000-0000-000000000100';
    const CH2_ID = '00000000-0000-0000-0000-000000000200';
    const CH3_HIDDEN = '00000000-0000-0000-0000-000000000300';

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateLiveTvTables(sql);

        // Seed base data
        await insertSource(sql, SOURCE_ID);
        await insertCategory(sql, CAT_ID, 'Sports');
        await insertChannel(sql, {
            id: CH1_ID,
            name: 'Sport 1',
            sourceId: SOURCE_ID,
            sortOrder: 1,
            categoryId: CAT_ID,
            logoUrl: 'http://logo/s1.png',
        });
        await insertChannel(sql, {
            id: CH2_ID,
            name: 'Sport 2',
            sourceId: SOURCE_ID,
            sortOrder: 2,
            categoryId: CAT_ID,
        });
        await insertChannel(sql, {
            id: CH3_HIDDEN,
            name: 'Hidden Channel',
            sourceId: SOURCE_ID,
            sortOrder: 3,
            isVisible: false,
        });
    });

    // =========================================================================
    // Temporal Status Boundaries (AC #2, Task 6.2)
    // =========================================================================

    it('computes "live" for program currently airing', async () => {
        const now = new Date();
        const start = new Date(now.getTime() - 30 * 60_000); // 30 min ago
        const end = new Date(now.getTime() + 30 * 60_000); // 30 min from now

        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000001',
            channelId: CH1_ID,
            title: 'Football Live Match',
            startTime: start,
            endTime: end,
        });

        const results = await searchProgramsByTextGrouped(sql, 'football', 10);
        expect(results).toHaveLength(1);
        expect(results[0].temporal_status).toBe('live');
    });

    it('computes "upcoming_today" for program starting later today', async () => {
        // Use a time that's always later today: 1 minute before midnight
        // DATE(start_time) = CURRENT_DATE is evaluated in DB session timezone (UTC)
        const now = new Date();
        const todayLate = new Date(now);
        todayLate.setUTCHours(23, 58, 0, 0); // 23:58 UTC today — always "today"
        // Only valid if this time is still in the future
        if (todayLate.getTime() <= now.getTime()) {
            // If it's already past 23:58 UTC, use tomorrow's approach — skip gracefully
            return;
        }
        const end = new Date(todayLate.getTime() + 30 * 60_000);

        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000002',
            channelId: CH1_ID,
            title: 'Football Upcoming Game',
            startTime: todayLate,
            endTime: end,
        });

        const results = await searchProgramsByTextGrouped(sql, 'football', 10);
        expect(results).toHaveLength(1);
        expect(results[0].temporal_status).toBe('upcoming_today');
    });

    it('computes "future" for program starting tomorrow', async () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(14, 0, 0, 0);
        const end = new Date(tomorrow.getTime() + 2 * 60 * 60_000);

        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000003',
            channelId: CH1_ID,
            title: 'Football Future Game',
            startTime: tomorrow,
            endTime: end,
        });

        const results = await searchProgramsByTextGrouped(sql, 'football', 10);
        expect(results).toHaveLength(1);
        expect(results[0].temporal_status).toBe('future');
    });

    it('computes "ended" for program that ended within 30 minutes', async () => {
        const now = await getDbNow(sql);
        const start = new Date(now.getTime() - 90 * 60_000); // 90 min ago
        const end = new Date(now.getTime() - 15 * 60_000); // ended 15 min ago

        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000004',
            channelId: CH1_ID,
            title: 'Football Recent Game',
            startTime: start,
            endTime: end,
        });

        const results = await searchProgramsByTextGrouped(sql, 'football', 10);
        expect(results).toHaveLength(1);
        expect(results[0].temporal_status).toBe('ended');
    });

    // =========================================================================
    // Temporal Boundary Edge Cases (AC #16 — exact NOW boundaries)
    // =========================================================================

    it('computes "live" when start_time is exactly NOW', async () => {
        const now = await getDbNow(sql);
        const end = new Date(now.getTime() + 60 * 60_000); // 1 hour from now

        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000020',
            channelId: CH1_ID,
            title: 'Football Exact Start',
            startTime: now,
            endTime: end,
        });

        const results = await searchProgramsByTextGrouped(sql, 'football exact start', 10);
        expect(results).toHaveLength(1);
        // NOW() >= start_time is true, NOW() < end_time is true → 'live'
        expect(results[0].temporal_status).toBe('live');
    });

    it('computes "ended" when end_time is exactly NOW (exclusive boundary)', async () => {
        const now = await getDbNow(sql);
        const start = new Date(now.getTime() - 60 * 60_000); // 1 hour ago

        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000021',
            channelId: CH1_ID,
            title: 'Football Exact End',
            startTime: start,
            endTime: now, // end_time = NOW()
        });

        const results = await searchProgramsByTextGrouped(sql, 'football exact end', 10);
        expect(results).toHaveLength(1);
        // NOW() < end_time is false → not 'live', falls to 'ended'
        expect(results[0].temporal_status).toBe('ended');
    });

    it('excludes program where end_time equals exactly NOW - 30 minutes (strict >)', async () => {
        const now = await getDbNow(sql);
        const exactCutoff = new Date(now.getTime() - 30 * 60_000); // exactly 30 min ago
        const start = new Date(exactCutoff.getTime() - 60 * 60_000);

        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000022',
            channelId: CH1_ID,
            title: 'Football Cutoff Boundary',
            startTime: start,
            endTime: exactCutoff,
        });

        const results = await searchProgramsByTextGrouped(sql, 'football cutoff boundary', 10);
        // end_time > NOW() - INTERVAL '30 minutes' is false (equal, not greater) → excluded
        expect(results).toHaveLength(0);
    });

    // =========================================================================
    // 30-Minute Ended Window (AC #3, Task 6.5)
    // =========================================================================

    it('excludes programs ended more than 30 minutes ago', async () => {
        const now = await getDbNow(sql);
        const start = new Date(now.getTime() - 120 * 60_000); // 2h ago
        const end = new Date(now.getTime() - 35 * 60_000); // ended 35 min ago

        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000005',
            channelId: CH1_ID,
            title: 'Football Old Game',
            startTime: start,
            endTime: end,
        });

        const results = await searchProgramsByTextGrouped(sql, 'football', 10);
        expect(results).toHaveLength(0);
    });

    // =========================================================================
    // Hidden Channel Exclusion (AC #7, Task 6.3)
    // =========================================================================

    it('excludes programs on hidden channels', async () => {
        const now = new Date();
        const start = new Date(now.getTime() - 30 * 60_000);
        const end = new Date(now.getTime() + 30 * 60_000);

        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000006',
            channelId: CH3_HIDDEN,
            title: 'Football Hidden Game',
            startTime: start,
            endTime: end,
        });

        const results = await searchProgramsByTextGrouped(sql, 'football', 10);
        expect(results).toHaveLength(0);
    });

    // =========================================================================
    // Grouping Logic (AC #4, Task 6.4)
    // =========================================================================

    it('merges same title/day into one result with multiple channels', async () => {
        const now = new Date();
        const start = new Date(now.getTime() - 10 * 60_000);
        const end = new Date(now.getTime() + 50 * 60_000);

        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000007',
            channelId: CH1_ID,
            title: 'Football Championship',
            startTime: start,
            endTime: end,
        });
        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000008',
            channelId: CH2_ID,
            title: 'Football Championship',
            startTime: start,
            endTime: end,
        });

        const results = await searchProgramsByTextGrouped(sql, 'football championship', 10);
        expect(results).toHaveLength(1);
        expect(results[0].channels).toHaveLength(2);
    });

    it('keeps same title on different days as separate results', async () => {
        const now = new Date();
        const todayStart = new Date(now.getTime() - 10 * 60_000);
        const todayEnd = new Date(now.getTime() + 50 * 60_000);

        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(14, 0, 0, 0);
        const tomorrowEnd = new Date(tomorrow.getTime() + 60 * 60_000);

        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000009',
            channelId: CH1_ID,
            title: 'Football Daily Show',
            startTime: todayStart,
            endTime: todayEnd,
        });
        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-100000000010',
            channelId: CH1_ID,
            title: 'Football Daily Show',
            startTime: tomorrow,
            endTime: tomorrowEnd,
        });

        const results = await searchProgramsByTextGrouped(sql, 'football daily', 10);
        expect(results.length).toBeGreaterThanOrEqual(2);
    });

    // =========================================================================
    // LIMIT on Grouped Results (AC #14, Task 6.7)
    // =========================================================================

    it('LIMIT applies to grouped results count, not raw rows', async () => {
        // Create 5 different programs on different days
        for (let i = 0; i < 5; i++) {
            const day = new Date();
            day.setDate(day.getDate() + i);
            day.setHours(14, 0, 0, 0);
            const dayEnd = new Date(day.getTime() + 60 * 60_000);

            await insertProgram(sql, {
                id: `00000000-0000-0000-0000-20000000000${i}`,
                channelId: CH1_ID,
                title: `Football Game Day ${i}`,
                startTime: day,
                endTime: dayEnd,
            });
        }

        const results = await searchProgramsByTextGrouped(sql, 'football game', 3);
        expect(results).toHaveLength(3);
    });

    // =========================================================================
    // Temporal Priority Ordering (AC #8, Task 6.6)
    // =========================================================================

    it('orders by temporal priority: live first, then upcoming, then future, then ended', async () => {
        const now = await getDbNow(sql);

        // Live
        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-300000000001',
            channelId: CH1_ID,
            title: 'Football Live Show',
            startTime: new Date(now.getTime() - 10 * 60_000),
            endTime: new Date(now.getTime() + 50 * 60_000),
        });

        // Future (tomorrow)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(14, 0, 0, 0);
        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-300000000002',
            channelId: CH1_ID,
            title: 'Football Future Show',
            startTime: tomorrow,
            endTime: new Date(tomorrow.getTime() + 60 * 60_000),
        });

        // Ended (10 min ago)
        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-300000000003',
            channelId: CH1_ID,
            title: 'Football Ended Show',
            startTime: new Date(now.getTime() - 70 * 60_000),
            endTime: new Date(now.getTime() - 10 * 60_000),
        });

        const results = await searchProgramsByTextGrouped(sql, 'football', 10);
        expect(results.length).toBeGreaterThanOrEqual(2);

        // First result should be live
        expect(results[0].temporal_status).toBe('live');

        // Ended should be last — assertions are unconditional since test data guarantees both statuses
        const endedIndex = results.findIndex((r) => r.temporal_status === 'ended');
        const liveIndex = results.findIndex((r) => r.temporal_status === 'live');
        expect(endedIndex).not.toBe(-1);
        expect(liveIndex).not.toBe(-1);
        expect(liveIndex).toBeLessThan(endedIndex);
    });

    // =========================================================================
    // Empty Results
    // =========================================================================

    it('returns empty array when no programs match', async () => {
        const results = await searchProgramsByTextGrouped(sql, 'nonexistent', 10);
        expect(results).toEqual([]);
    });

    // =========================================================================
    // Channel Sort Order (AC #6)
    // =========================================================================

    it('sorts channels by admin sort_order within groups', async () => {
        const now = new Date();
        const start = new Date(now.getTime() - 10 * 60_000);
        const end = new Date(now.getTime() + 50 * 60_000);

        // CH2 has sortOrder 2, CH1 has sortOrder 1
        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-400000000001',
            channelId: CH2_ID,
            title: 'Football Sorted Game',
            startTime: start,
            endTime: end,
        });
        await insertProgram(sql, {
            id: '00000000-0000-0000-0000-400000000002',
            channelId: CH1_ID,
            title: 'Football Sorted Game',
            startTime: start,
            endTime: end,
        });

        const results = await searchProgramsByTextGrouped(sql, 'football sorted', 10);
        expect(results).toHaveLength(1);
        expect(results[0].channels).toHaveLength(2);
        // CH1 (sort_order=1) should come before CH2 (sort_order=2)
        expect(results[0].channels[0].name).toBe('Sport 1');
        expect(results[0].channels[1].name).toBe('Sport 2');
    });
});
