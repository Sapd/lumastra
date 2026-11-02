// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import {
    updateItemCustomMetadata,
    countItemsByGroup,
    listItemsByLibraryType,
    getSeriesWithEpisodes,
    bulkUpdateCustomMetadata,
    getDistinctMetadataValues,
} from './non-entertainment-browse.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';

describe('updateItemCustomMetadata', () => {
    it('merges into an empty object when custom_metadata is null', async () => {
        const mockSql = vi.fn().mockResolvedValue({ count: 1 }) as ReturnType<typeof vi.fn> & {
            json: typeof JSON.stringify;
        };
        mockSql.json = ((value: unknown) => value) as typeof JSON.stringify;

        const result = await updateItemCustomMetadata(mockSql as never, 'item-1', {
            chapters: [{ title: 'Intro', start_ms: 0 }],
        });

        expect(result).toBe(true);
        expect(mockSql).toHaveBeenCalledTimes(1);

        const [strings] = mockSql.mock.calls[0] as [TemplateStringsArray];
        expect(strings.join(' ')).toContain("COALESCE(custom_metadata, '{}'::jsonb) ||");
    });
});

describe('countItemsByGroup', () => {
    it('returns group counts from the db result', async () => {
        const mockRows = [
            { group_value: 'Engineering', count: 70 },
            { group_value: 'HR', count: 40 },
        ];
        const mockSql = vi.fn().mockResolvedValue(mockRows) as ReturnType<typeof vi.fn>;

        const result = await countItemsByGroup(mockSql as never, {
            mediaType: 'training',
            groupKey: 'department',
            access: unrestrictedAccess(),
        });

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ group_value: 'Engineering', count: 70 });
        expect(result[1]).toEqual({ group_value: 'HR', count: 40 });
        expect(mockSql).toHaveBeenCalled();
    });

    it('returns empty array when no items match', async () => {
        const mockSql = vi.fn().mockResolvedValue([]) as ReturnType<typeof vi.fn>;

        const result = await countItemsByGroup(mockSql as never, {
            mediaType: 'training',
            groupKey: 'department',
            access: unrestrictedAccess(),
        });

        expect(result).toEqual([]);
    });

    it('generates SQL with CASE WHEN to sort Uncategorized last', async () => {
        const mockSql = vi.fn().mockResolvedValue([]) as ReturnType<typeof vi.fn>;

        await countItemsByGroup(mockSql as never, {
            mediaType: 'training',
            groupKey: 'department',
            access: unrestrictedAccess(),
        });

        expect(mockSql).toHaveBeenCalled();
        // The sql tag function may be called multiple times (once per fragment).
        // Find the call whose joined template strings contain the ORDER BY clause.
        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        // Verify the Uncategorized-last ordering convention is in the SQL
        expect(allQueryText).toContain('CASE WHEN group_value');
        expect(allQueryText).toContain('Uncategorized');
    });

    it('routes JSONB array values (e.g. personal library tags) to Uncategorized bucket via jsonb_typeof guard', async () => {
        // The `personal` library type uses `tags` as its groupKey, and tags is a JSONB array.
        // SQL ->> on an array yields ["travel","family"] (JSON text), while JS
        // String(["travel","family"]) yields "travel,family" — they never match.
        // The fix: use CASE WHEN jsonb_typeof(...) = 'array' THEN 'Uncategorized'.
        const mockSql = vi
            .fn()
            .mockResolvedValue([{ group_value: 'Uncategorized', count: 3 }]) as ReturnType<
            typeof vi.fn
        >;

        const result = await countItemsByGroup(mockSql as never, {
            mediaType: 'personal',
            groupKey: 'tags',
            access: unrestrictedAccess(),
        });

        // The SQL must use jsonb_typeof to detect arrays and route them to Uncategorized
        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        expect(allQueryText).toContain('jsonb_typeof');
        expect(allQueryText).toContain("'array'");
        expect(allQueryText).toContain('Uncategorized');

        // The returned rows flow through unchanged — server returns Uncategorized bucket
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({ group_value: 'Uncategorized', count: 3 });
    });
});

describe('listItemsByLibraryType', () => {
    function makeMockSql(returnValue: unknown = []): ReturnType<typeof vi.fn> {
        const fn = vi.fn().mockResolvedValue(returnValue) as ReturnType<typeof vi.fn>;
        return fn;
    }

    it('uses department ORDER BY when sort=department', async () => {
        const mockSql = makeMockSql([{ count: '0' }]);

        await listItemsByLibraryType(mockSql as never, {
            mediaType: 'training',
            sort: 'department',
            access: unrestrictedAccess(),
        });

        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        expect(allQueryText).toContain("custom_metadata->>'department'");
    });

    it('uses alphabetical ORDER BY when sort=alphabetical', async () => {
        const mockSql = makeMockSql([{ count: '0' }]);

        await listItemsByLibraryType(mockSql as never, {
            mediaType: 'training',
            sort: 'alphabetical',
            access: unrestrictedAccess(),
        });

        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        expect(allQueryText).toContain('mi.title ASC');
    });

    it('exposes completed_count=0 in returned items when userId is not provided', async () => {
        const mockItems = [
            {
                id: 'series-1',
                title: 'Test Course',
                media_type: 'training',
                release_year: null,
                overview: null,
                custom_metadata: {},
                custom_poster_url: null,
                custom_backdrop_url: null,
                episode_count: 5,
                first_episode_id: 'ep-1',
                created_at: '2026-01-01',
                completed_count: 0,
            },
        ];
        // The sql tag is called multiple times: empty fragment calls + count query + items query.
        // Always resolve: empty fragments return [], count returns [{ count: '1' }], items returns mockItems.
        const callResults = [[{ count: '1' }], mockItems];
        let callIndex = 0;
        const mockSql = vi.fn().mockImplementation((...args: unknown[]) => {
            // Identify count vs items query by the template strings content
            const strings = args[0] as TemplateStringsArray | undefined;
            const joined = strings?.raw?.join(' ') ?? '';
            if (joined.includes('COUNT(*)::text AS count')) {
                return Promise.resolve([{ count: '1' }]);
            }
            if (joined.includes('mi.id,')) {
                return Promise.resolve(mockItems);
            }
            // Empty fragment or filter fragments
            return Promise.resolve([]);
        }) as ReturnType<typeof vi.fn>;

        void callResults; // suppress unused warning
        void callIndex;

        const result = await listItemsByLibraryType(mockSql as never, {
            mediaType: 'training',
            access: unrestrictedAccess(),
        });

        expect(result.items[0]).toHaveProperty('completed_count');
        expect(result.items[0]?.completed_count).toBe(0);
    });

    it('includes completed_count LATERAL when userId is provided', async () => {
        const mockSql = makeMockSql([{ count: '0' }]);

        await listItemsByLibraryType(mockSql as never, {
            mediaType: 'training',
            userId: 'user-uuid-1',
            access: unrestrictedAccess(),
        });

        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        expect(allQueryText).toContain('completed_count');
        expect(allQueryText).toContain('is_watched');
    });

    it('does NOT reference cc table alias in SELECT when userId is absent (CRITICAL: avoids missing FROM-clause error)', async () => {
        const mockSql = makeMockSql([{ count: '0' }]);

        await listItemsByLibraryType(mockSql as never, {
            mediaType: 'training',
            access: unrestrictedAccess(),
            // userId intentionally absent
        });

        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        // Must use literal 0, not cc.completed_count
        expect(allQueryText).toContain('0 AS completed_count');
        // Must NOT reference cc.completed_count which would require the cc LATERAL
        expect(allQueryText).not.toContain('cc.completed_count');
        // Must NOT include the cc LATERAL join
        expect(allQueryText).not.toContain('is_watched');
    });

    it('uses oldest (chronological ASC) ORDER BY when sort=oldest', async () => {
        const mockSql = makeMockSql([{ count: '0' }]);

        await listItemsByLibraryType(mockSql as never, {
            mediaType: 'home_video',
            sort: 'oldest',
            access: unrestrictedAccess(),
        });

        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        // Should contain 'date_filmed' ASC for oldest-first sort
        expect(allQueryText).toContain('date_filmed');
        expect(allQueryText).toContain('ASC');
    });

    it('uses safe jsonb_typeof guard for lesson_number ordering (CRITICAL: avoids numeric cast error on non-numeric strings)', async () => {
        const mockSql = makeMockSql([{ count: '0' }]);

        await listItemsByLibraryType(mockSql as never, {
            mediaType: 'educational',
            access: unrestrictedAccess(),
        });

        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        // Must use jsonb_typeof guard, not a bare ->>...::numeric cast
        expect(allQueryText).toContain('jsonb_typeof');
        expect(allQueryText).toContain("lesson_number') = 'number'");
    });
});

describe('getSeriesWithEpisodes', () => {
    it('orders by lesson_number when mediaType=educational', async () => {
        const mockSql = vi
            .fn()
            .mockResolvedValueOnce([
                {
                    id: 'series-1',
                    title: 'Course',
                    media_type: 'educational',
                    release_year: null,
                    overview: null,
                    custom_metadata: {},
                    custom_poster_url: null,
                    custom_backdrop_url: null,
                    episode_count: 4,
                    first_episode_id: 'ep-1',
                    created_at: '2026-01-01',
                    completed_count: 0,
                },
            ])
            .mockResolvedValueOnce([]) as ReturnType<typeof vi.fn>;

        await getSeriesWithEpisodes(mockSql as never, 'series-1', { mediaType: 'educational' });

        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        expect(allQueryText).toContain("custom_metadata->>'lesson_number'");
    });

    it('does NOT order by lesson_number for non-educational types', async () => {
        const mockSql = vi
            .fn()
            .mockResolvedValueOnce([
                {
                    id: 'series-1',
                    title: 'Event',
                    media_type: 'home_video',
                    release_year: null,
                    overview: null,
                    custom_metadata: {},
                    custom_poster_url: null,
                    custom_backdrop_url: null,
                    episode_count: 3,
                    first_episode_id: 'ep-1',
                    created_at: '2026-01-01',
                    completed_count: 0,
                },
            ])
            .mockResolvedValueOnce([]) as ReturnType<typeof vi.fn>;

        await getSeriesWithEpisodes(mockSql as never, 'series-1', { mediaType: 'home_video' });

        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        expect(allQueryText).not.toContain("custom_metadata->>'lesson_number'");
    });

    it('uses jsonb_typeof guard when ordering by lesson_number (CRITICAL: avoids numeric cast error on non-numeric strings)', async () => {
        const mockSql = vi
            .fn()
            .mockResolvedValueOnce([
                {
                    id: 'series-1',
                    title: 'Course',
                    media_type: 'educational',
                    release_year: null,
                    overview: null,
                    custom_metadata: {},
                    custom_poster_url: null,
                    custom_backdrop_url: null,
                    episode_count: 4,
                    first_episode_id: 'ep-1',
                    created_at: '2026-01-01',
                    completed_count: 0,
                },
            ])
            .mockResolvedValueOnce([]) as ReturnType<typeof vi.fn>;

        await getSeriesWithEpisodes(mockSql as never, 'series-1', { mediaType: 'educational' });

        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        // Must use jsonb_typeof guard around the numeric cast, not a bare ->>...::numeric
        expect(allQueryText).toContain('jsonb_typeof');
        expect(allQueryText).toContain("lesson_number') = 'number'");
        // Still references lesson_number
        expect(allQueryText).toContain('lesson_number');
    });
});

describe('bulkUpdateCustomMetadata', () => {
    function makeMockSql(count = 2): ReturnType<typeof vi.fn> & { json: (v: unknown) => unknown } {
        const fn = vi.fn().mockResolvedValue({ count }) as ReturnType<typeof vi.fn> & {
            json: (v: unknown) => unknown;
        };
        fn.json = (v: unknown) => v;
        return fn;
    }

    it('returns 0 without calling sql when ids is empty', async () => {
        const mockSql = makeMockSql();
        const result = await bulkUpdateCustomMetadata(mockSql as never, [], { department: 'HR' });
        expect(result).toBe(0);
        expect(mockSql).not.toHaveBeenCalled();
    });

    it('returns the count of updated rows', async () => {
        const mockSql = makeMockSql(3);
        const result = await bulkUpdateCustomMetadata(mockSql as never, ['id-1', 'id-2', 'id-3'], {
            department: 'Engineering',
        });
        expect(result).toBe(3);
    });

    it('uses COALESCE merge pattern to preserve existing metadata keys', async () => {
        const mockSql = makeMockSql(1);
        await bulkUpdateCustomMetadata(mockSql as never, ['id-1'], { required: true });
        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        expect(allQueryText).toContain("COALESCE(custom_metadata, '{}'::jsonb) ||");
    });

    it('restricts update to non-entertainment media_types only (CRITICAL: prevents entertainment item corruption)', async () => {
        const mockSql = makeMockSql(1);
        await bulkUpdateCustomMetadata(mockSql as never, ['id-1'], { department: 'HR' });
        const allQueryText = (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
        // The WHERE clause must filter by media_type to avoid updating movie/tv/episode rows
        expect(allQueryText).toContain('media_type');
        expect(allQueryText).toContain('ANY(');
    });
});

// ============================================================================
// Access boundary (required-by-shape)
// ============================================================================

describe('access boundary', () => {
    function makeSql(): ReturnType<typeof vi.fn> {
        return vi.fn().mockResolvedValue([{ count: '0' }]) as ReturnType<typeof vi.fn>;
    }

    function queryText(mockSql: ReturnType<typeof vi.fn>): string {
        return (mockSql.mock.calls as [TemplateStringsArray][])
            .map(([strings]) => strings.raw.join(' '))
            .join('\n');
    }

    describe('denyAll short-circuits before issuing SQL', () => {
        it('listItemsByLibraryType returns an empty page', async () => {
            const mockSql = makeSql();
            const result = await listItemsByLibraryType(mockSql as never, {
                mediaType: 'training',
                access: denyAllAccess(),
            });
            expect(result).toEqual({ items: [], total: 0 });
            expect(mockSql).not.toHaveBeenCalled();
        });

        it('countItemsByGroup returns no groups', async () => {
            const mockSql = makeSql();
            const result = await countItemsByGroup(mockSql as never, {
                mediaType: 'training',
                groupKey: 'department',
                access: denyAllAccess(),
            });
            expect(result).toEqual([]);
            expect(mockSql).not.toHaveBeenCalled();
        });

        it('getDistinctMetadataValues returns no values', async () => {
            const mockSql = makeSql();
            const result = await getDistinctMetadataValues(mockSql as never, 'training', 'dept', {
                access: denyAllAccess(),
            });
            expect(result).toEqual([]);
            expect(mockSql).not.toHaveBeenCalled();
        });
    });

    it('emits the library predicate when groups are denied', async () => {
        const mockSql = makeSql();
        await listItemsByLibraryType(mockSql as never, {
            mediaType: 'training',
            access: restrictedAccess({
                deniedGroupIds: [crypto.randomUUID()],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        });
        const text = queryText(mockSql);
        expect(text).toContain('media_file_items');
        expect(text).toContain('library_group_id');
    });

    it('emits NO library predicate under an unrestricted boundary', async () => {
        const mockSql = makeSql();
        await listItemsByLibraryType(mockSql as never, {
            mediaType: 'training',
            access: unrestrictedAccess(),
        });
        expect(queryText(mockSql)).not.toContain('library_group_id');
    });

    // REGRESSION: `{ kind: 'denyGroups', ids: [] }` is representable under the new
    // type. An empty [] interpolated into a postgres.js template becomes a bound
    // parameter ($N) rather than being inlined, so reaching `!= ALL(${[]}::uuid[])`
    // throws "syntax error at or near $N" at RUNTIME — not at compile or lint time.
    // The builder must collapse it to an empty fragment instead.
    it('treats an empty denyGroups id list as no library restriction', async () => {
        const mockSql = makeSql();
        await listItemsByLibraryType(mockSql as never, {
            mediaType: 'training',
            access: { library: { kind: 'denyGroups', ids: [] }, age: { kind: 'any' } },
        });
        expect(queryText(mockSql)).not.toContain('library_group_id');
    });
});
