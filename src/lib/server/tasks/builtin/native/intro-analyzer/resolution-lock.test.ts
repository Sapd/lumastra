// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
    acquireExclusiveMediaSegmentWriteGate,
    acquireMediaSegmentResolutionLock,
    acquireMediaSegmentResolutionLocks,
    bumpGlobalMediaSegmentAnalysisGeneration,
    bumpMediaSegmentAnalysisGeneration,
    getGlobalMediaSegmentAnalysisGeneration,
} from './resolution-lock.js';

function recordingSql(): {
    sql: postgres.Sql;
    calls: Array<{ text: string; values: unknown[] }>;
} {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.join('?'), values });
        return [];
    }) as unknown as postgres.Sql;
    return { sql, calls };
}

describe('media-segment resolution locks', () => {
    it('uses the bulk lock path for a single media item', async () => {
        const { sql, calls } = recordingSql();

        await acquireMediaSegmentResolutionLock(sql, 'media-b');

        expect(calls).toHaveLength(2);
        expect(calls[0].text).toContain('pg_advisory_xact_lock_shared');
        expect(calls[1].text).toContain('pg_advisory_xact_lock');
        expect(calls[1].values[1]).toEqual(['media-b']);
    });

    it('deduplicates and sorts bulk lock targets before acquiring them', async () => {
        const { sql, calls } = recordingSql();

        await acquireMediaSegmentResolutionLocks(sql, ['media-c', 'media-a', 'media-b', 'media-a']);

        expect(calls).toHaveLength(2);
        expect(calls[0].text).toContain('pg_advisory_xact_lock_shared');
        expect(calls[1].values[1]).toEqual(['media-a', 'media-b', 'media-c']);
    });

    it('does not query PostgreSQL for an empty lock set', async () => {
        const { sql, calls } = recordingSql();

        await acquireMediaSegmentResolutionLocks(sql, []);

        expect(calls).toHaveLength(0);
    });

    it('uses the exclusive global gate for a wipe', async () => {
        const { sql, calls } = recordingSql();

        await acquireExclusiveMediaSegmentWriteGate(sql);

        expect(calls).toHaveLength(1);
        expect(calls[0].text).toContain('pg_advisory_xact_lock');
        expect(calls[0].text).not.toContain('pg_advisory_xact_lock_shared');
    });

    it('bumps the analyzer generation for unique media items', async () => {
        const { sql, calls } = recordingSql();

        await bumpMediaSegmentAnalysisGeneration(sql, ['media-a', 'media-a']);

        expect(calls).toHaveLength(1);
        expect(calls[0].text).toContain('UPDATE media_items');
        expect(calls[0].text).toContain('clock_timestamp()');
        expect(calls[0].values).toContainEqual(['media-a']);
    });

    it('persists and reads a global analyzer generation', async () => {
        const { sql, calls } = recordingSql();

        await bumpGlobalMediaSegmentAnalysisGeneration(sql);
        const generation = await getGlobalMediaSegmentAnalysisGeneration(sql);

        expect(generation).toBeNull();
        expect(calls[0].text).toContain('INSERT INTO plugin_settings');
        expect(calls[0].text).toContain('ON CONFLICT');
        expect(calls[1].text).toContain('SELECT updated_at::text AS generation');
    });
});
