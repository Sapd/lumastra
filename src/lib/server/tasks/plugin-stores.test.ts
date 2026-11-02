// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The typed stores a plugin reaches through `ctx`.
 *
 * The segment store's vocabulary is the thing under test. Plugins speak
 * lowercase (`'intro'`), the `media_segments` table has always stored
 * capitalized values (`'Intro'`) and its CHECK constraint accepts nothing else,
 * so the boundary has to translate in both directions. Getting that wrong is
 * invisible to typecheck and to any test that mocks the database loosely: the
 * writes fail at the constraint, and the reads come back in a casing the
 * plugin's own comparisons never match.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    buildMediaSegmentStore,
    buildPlaylistStore,
    DB_SEGMENT_TYPE,
    toPluginSegmentType,
} from './plugin-stores.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

/** Captures the interpolated values of each tagged-template call. */
function makeSql(rows: unknown[] = []) {
    const calls: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(values);
        return Promise.resolve(rows);
    }) as unknown as import('postgres').Sql;
    return { sql, calls };
}

beforeEach(() => vi.clearAllMocks());

describe('the DB vocabulary', () => {
    it('maps every plugin-facing type to a value the CHECK constraint accepts', () => {
        // These five are the entire constraint. If this drifts, every write
        // from every segment plugin starts failing with a 23514.
        expect(Object.values(DB_SEGMENT_TYPE).sort()).toEqual([
            'Commercial',
            'Intro',
            'Outro',
            'Preview',
            'Recap',
        ]);
    });

    it('round-trips each type', () => {
        for (const [plugin, db] of Object.entries(DB_SEGMENT_TYPE)) {
            expect(toPluginSegmentType(db)).toBe(plugin);
        }
    });

    it('reads back a capitalized row as the lowercase the plugin compares against', () => {
        expect(toPluginSegmentType('Intro')).toBe('intro');
        expect(toPluginSegmentType('Outro')).toBe('outro');
    });

    it('leaves an unrecognised stored value alone rather than inventing one', () => {
        expect(toPluginSegmentType('Something')).toBeNull();
    });
});

describe('upsert', () => {
    it('writes the CAPITALIZED value, not what the plugin said', async () => {
        const { sql, calls } = makeSql();
        await buildMediaSegmentStore(sql, 'p1').upsert('11111111-1111-1111-1111-111111111111', [
            { type: 'intro', startTime: 0, endTime: 90 },
        ]);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('Intro');
        expect(calls[0]).not.toContain('intro');
    });

    it('drops a type the table cannot store instead of failing the whole batch', async () => {
        const { sql, calls } = makeSql();
        await buildMediaSegmentStore(sql, 'p1').upsert('11111111-1111-1111-1111-111111111111', [
            { type: 'credits' as never, startTime: 0, endTime: 90 },
            { type: 'outro', startTime: 100, endTime: 200 },
        ]);
        // One INSERT, for the outro. A single unsupported entry must not cost a
        // detector the rest of its findings.
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('Outro');
    });

    it('still rejects a zero-length or reversed segment', async () => {
        const { sql, calls } = makeSql();
        await buildMediaSegmentStore(sql, 'p1').upsert('11111111-1111-1111-1111-111111111111', [
            { type: 'intro', startTime: 90, endTime: 90 },
            { type: 'outro', startTime: 200, endTime: 100 },
            { type: 'recap', startTime: -5, endTime: 10 },
        ]);
        expect(calls).toHaveLength(0);
    });

    it('tags every row with the plugin id as its source', async () => {
        const { sql, calls } = makeSql();
        await buildMediaSegmentStore(sql, 'my-plugin').upsert(
            '11111111-1111-1111-1111-111111111111',
            [{ type: 'intro', startTime: 0, endTime: 90 }],
        );
        expect(calls[0]).toContain('my-plugin');
    });
});

describe('list', () => {
    it('translates stored rows back into the plugin vocabulary', async () => {
        const { sql } = makeSql([
            { type: 'Intro', start_time: '0', end_time: '90', source: 'other' },
            { type: 'Outro', start_time: '100', end_time: '200', source: 'p1' },
        ]);
        const out = await buildMediaSegmentStore(sql, 'p1').list(
            '11111111-1111-1111-1111-111111111111',
        );
        expect(out.map((s) => s.type)).toEqual(['intro', 'outro']);
        expect(out[0].startTime).toBe(0);
        expect(out[1].endTime).toBe(200);
    });

    it('omits a row whose stored type has no plugin equivalent', async () => {
        const { sql } = makeSql([
            { type: 'Mystery', start_time: '0', end_time: '9', source: 'x' },
            { type: 'Intro', start_time: '0', end_time: '90', source: 'x' },
        ]);
        const out = await buildMediaSegmentStore(sql, 'p1').list(
            '11111111-1111-1111-1111-111111111111',
        );
        expect(out).toHaveLength(1);
        expect(out[0].type).toBe('intro');
    });
});

describe('playlist ownership', () => {
    it('records the creating plugin', async () => {
        const { sql, calls } = makeSql([{ id: 7 }]);
        await buildPlaylistStore(sql, 'my-plugin').create({
            userId: '11111111-1111-1111-1111-111111111111',
            name: 'Smart Mix',
        });
        expect(calls[0]).toContain('my-plugin');
    });

    it('REFUSES to replace a playlist this plugin did not create', async () => {
        // The delete and refill commit together, so an off-by-one or stale id
        // destroys a user's hand-curated playlist with no undo. `playlists.id`
        // is a small sequential integer, which makes that an easy mistake.
        const { sql } = makeSql([{ created_by_plugin: null }]);
        await expect(buildPlaylistStore(sql, 'my-plugin').replaceItems(7, ['a'])).rejects.toThrow(
            /did not create/i,
        );
    });

    it('REFUSES one created by a DIFFERENT plugin', async () => {
        const { sql } = makeSql([{ created_by_plugin: 'other-plugin' }]);
        await expect(buildPlaylistStore(sql, 'my-plugin').replaceItems(7, ['a'])).rejects.toThrow(
            /did not create/i,
        );
    });

    it('refuses a playlist that does not exist rather than silently doing nothing', async () => {
        const { sql } = makeSql([]);
        await expect(
            buildPlaylistStore(sql, 'my-plugin').replaceItems(999, ['a']),
        ).rejects.toThrow();
    });

    it('checks ownership before an EMPTY replacement too', async () => {
        // The empty branch is the one that clears a playlist outright, so it is
        // the most destructive path, not the least.
        const { sql } = makeSql([{ created_by_plugin: 'other-plugin' }]);
        await expect(buildPlaylistStore(sql, 'my-plugin').replaceItems(7, [])).rejects.toThrow(
            /did not create/i,
        );
    });
});
