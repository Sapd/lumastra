// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for library-paths.queries.ts
 *
 * Tests JavaScript logic around return values (null coalescing, boolean conversion)
 * without a real database connection.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    getAllLibraryPaths,
    getEnabledLibraryPaths,
    getLibraryPathById,
    getLibraryPathsByGroup,
    createLibraryPath,
    updateLibraryPath,
    deleteLibraryPath,
    validateGroupConsistency,
    validateGroupProviderConsistency,
    normalizeLibraryPath,
    FILESYSTEM_LIBRARY_PROVIDERS,
    REMOTE_LIBRARY_PROVIDERS,
    type AssertAllProvidersClassified,
    type LibraryPathProvider,
    type LibraryPathRow,
} from './library-paths.queries.js';
import { LIBRARY_PATH_PROVIDERS } from '$lib/schemas/common';
import { LibraryPathSchema } from '$lib/schemas/api-admin-library-responses';
import { libraryPathCreateBodySchema, libraryPathPatchBodySchema } from '$lib/schemas/admin';
import type postgres from 'postgres';

// Minimal mock for a postgres.Sql tagged-template function
function makeSql(returnValue: unknown): postgres.Sql {
    const fn = vi.fn().mockResolvedValue(returnValue);
    // sql.array() is called for TEXT[] parameters; identity function is sufficient for unit tests
    (fn as unknown as Record<string, unknown>).array = vi.fn((arr: unknown[]) => arr);
    return fn as unknown as postgres.Sql;
}

interface RecordedSqlCall {
    /** Template text with `?` where a parameter was interpolated. */
    text: string;
    values: unknown[];
}

/**
 * A `postgres.Sql` double that models exactly one piece of database behaviour:
 * the `WHERE enabled = true [AND provider = ANY($1)]` predicate that
 * `getEnabledLibraryPaths` builds. Everything else is recorded verbatim.
 *
 * This lets the provider filter be asserted at the row level (which rows a
 * caller ends up holding) instead of only at the SQL-text level, without a
 * database. The equivalent assertion against real Postgres lives in
 * `library-paths.queries.integration.test.ts`.
 */
function makeFilteringSql(rows: LibraryPathRow[]): {
    sql: postgres.Sql;
    calls: RecordedSqlCall[];
} {
    const calls: RecordedSqlCall[] = [];
    let allowedProviders: string[] | null = null;

    const fn = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?');
        calls.push({ text, values });

        // Anything that is not the main SELECT is an interpolated fragment. The
        // only fragment this query builds is the provider allow-list; an empty
        // fragment means "no provider restriction".
        if (!text.includes('FROM library_paths')) {
            const [first] = values;
            if (Array.isArray(first)) allowedProviders = first.map(String);
            return { fragment: text };
        }

        return Promise.resolve(
            rows.filter(
                (row) =>
                    row.enabled &&
                    (allowedProviders === null || allowedProviders.includes(row.provider)),
            ),
        );
    });
    (fn as unknown as Record<string, unknown>).array = vi.fn((arr: unknown[]) => arr);

    return { sql: fn as unknown as postgres.Sql, calls };
}

function makeRow(overrides: Partial<LibraryPathRow> = {}): LibraryPathRow {
    return { ...exampleRow, ...overrides };
}

const exampleRow: LibraryPathRow = {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    path: '/media/movies',
    media_type: 'movie',
    language: 'en',
    provider: 'tmdb',
    enabled: true,
    provider_path: null,
    library_group_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    edition_label: null,
    scan_chapters: false,
    fallback_providers: [],
    source_prefix: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
};

describe('getAllLibraryPaths', () => {
    it('returns array from sql result', async () => {
        const sql = makeSql([exampleRow]);
        const result = await getAllLibraryPaths(sql);
        expect(result).toEqual([exampleRow]);
    });

    it('returns empty array when table is empty', async () => {
        const sql = makeSql([]);
        const result = await getAllLibraryPaths(sql);
        expect(result).toEqual([]);
    });
});

describe('getEnabledLibraryPaths', () => {
    it('returns array from sql result', async () => {
        const sql = makeSql([exampleRow]);
        const result = await getEnabledLibraryPaths(sql);
        expect(result).toEqual([exampleRow]);
    });

    it('returns empty array when no enabled paths', async () => {
        const sql = makeSql([]);
        const result = await getEnabledLibraryPaths(sql);
        expect(result).toEqual([]);
    });
});

describe('getEnabledLibraryPaths provider filtering', () => {
    const audiobookshelfRow = makeRow({
        id: 'c3d4e5f6-a7b8-9012-cdef-234567890123',
        path: 'abs://a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        media_type: 'audiobook',
        provider: 'audiobookshelf',
        provider_path: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    });

    it('excludes audiobookshelf rows by default', async () => {
        const { sql } = makeFilteringSql([exampleRow, audiobookshelfRow]);

        const result = await getEnabledLibraryPaths(sql);

        expect(result).toEqual([exampleRow]);
        expect(result.map((r) => r.provider)).not.toContain('audiobookshelf');
    });

    it('includes audiobookshelf rows with includeRemote: true', async () => {
        const { sql } = makeFilteringSql([exampleRow, audiobookshelfRow]);

        const result = await getEnabledLibraryPaths(sql, { includeRemote: true });

        expect(result).toEqual([exampleRow, audiobookshelfRow]);
    });

    it('treats an explicit includeRemote: false like the default', async () => {
        const { sql } = makeFilteringSql([exampleRow, audiobookshelfRow]);

        const result = await getEnabledLibraryPaths(sql, { includeRemote: false });

        expect(result).toEqual([exampleRow]);
    });

    it('still excludes disabled rows when includeRemote is set', async () => {
        const disabledRemote = { ...audiobookshelfRow, enabled: false };
        const { sql } = makeFilteringSql([exampleRow, disabledRemote]);

        const result = await getEnabledLibraryPaths(sql, { includeRemote: true });

        expect(result).toEqual([exampleRow]);
    });

    it('restricts in SQL (not in JS) using the filesystem allow-list', async () => {
        const { sql, calls } = makeFilteringSql([exampleRow]);

        await getEnabledLibraryPaths(sql);

        const fragment = calls[0];
        expect(fragment.text).toContain('provider = ANY');
        expect(fragment.values[0]).toEqual([...FILESYSTEM_LIBRARY_PROVIDERS]);
    });

    it('emits no provider restriction when includeRemote is set', async () => {
        const { sql, calls } = makeFilteringSql([exampleRow]);

        await getEnabledLibraryPaths(sql, { includeRemote: true });

        expect(calls[0].text).toBe('');
        expect(calls[0].values).toEqual([]);
        expect(calls.some((c) => c.text.includes('provider = ANY'))).toBe(false);
    });
});

describe('library path provider classification', () => {
    it('classifies every provider as either filesystem-backed or remote', () => {
        // Fails to TYPECHECK (AssertAllProvidersClassified resolves to `never`)
        // if a LibraryPathProvider is added without deciding whether its `path`
        // is a real directory — which decides whether the scanner, the native
        // watcher and the read sandbox are allowed to see it.
        const classified: AssertAllProvidersClassified = true;
        expect(classified).toBe(true);
    });

    it('never lists a provider as both filesystem-backed and remote', () => {
        const overlap = FILESYSTEM_LIBRARY_PROVIDERS.filter((p) =>
            (REMOTE_LIBRARY_PROVIDERS as readonly string[]).includes(p),
        );
        expect(overlap).toEqual([]);
    });

    it('keeps audiobookshelf out of the filesystem allow-list', () => {
        expect(FILESYSTEM_LIBRARY_PROVIDERS as readonly string[]).not.toContain('audiobookshelf');
        expect(REMOTE_LIBRARY_PROVIDERS as readonly string[]).toContain('audiobookshelf');
    });
});

describe('library path provider drift guard', () => {
    // The provider list exists in four unlinked places: the DB CHECK
    // `library_paths_provider_check` (pinned by the 16.177.0 migration's
    // integration test), the `LibraryPathProvider` TS union, the shared
    // `LIBRARY_PATH_PROVIDERS` tuple every zod enum is built from, and the
    // admin storage page's local row type. Nothing links them at compile time,
    // and a miss surfaces as an opaque 400 from the API gate or a silently
    // stripped response field — nothing that looks like a constraint
    // violation. These two assertions pin the two lists that live in code.

    it('the shared schema tuple lists exactly the classified providers', () => {
        const classified = [...FILESYSTEM_LIBRARY_PROVIDERS, ...REMOTE_LIBRARY_PROVIDERS].sort();
        expect([...LIBRARY_PATH_PROVIDERS].sort()).toEqual(classified);
    });

    it('every provider the query module accepts also parses in the API schemas', () => {
        // `LibraryPathSchema.provider` is the 200-response schema mounted on
        // /api/admin/library-paths, the one reader that still sees ABS rows.
        const providerSchema = LibraryPathSchema.shape.provider;
        for (const provider of LIBRARY_PATH_PROVIDERS) {
            expect(providerSchema.safeParse(provider).success).toBe(true);
            expect(libraryPathCreateBodySchema.shape.provider.safeParse(provider).success).toBe(
                true,
            );
            expect(libraryPathPatchBodySchema.shape.provider.safeParse(provider).success).toBe(
                true,
            );
        }
        expect(providerSchema.safeParse('not-a-provider').success).toBe(false);
    });

    it('assigns every provider a compile-time-checked classification', () => {
        // Typed as LibraryPathProvider[], so a value in the shared tuple that
        // the union does not know about fails the typecheck rather than a test.
        const asUnion: readonly LibraryPathProvider[] = LIBRARY_PATH_PROVIDERS;
        expect(asUnion).toHaveLength(LIBRARY_PATH_PROVIDERS.length);
    });
});

describe('getLibraryPathById', () => {
    it('returns the row when found', async () => {
        const sql = makeSql([exampleRow]);
        const result = await getLibraryPathById(sql, exampleRow.id);
        expect(result).toEqual(exampleRow);
    });

    it('returns null when not found', async () => {
        const sql = makeSql([]);
        const result = await getLibraryPathById(sql, 'nonexistent-id');
        expect(result).toBeNull();
    });
});

describe('normalizeLibraryPath', () => {
    it('strips a single trailing slash', () => {
        expect(normalizeLibraryPath('/media/movies/')).toBe('/media/movies');
    });

    it('collapses repeated internal slashes and repeated trailing slashes', () => {
        expect(normalizeLibraryPath('/media//movies///')).toBe('/media/movies');
    });

    it('leaves an already-normalized path unchanged', () => {
        expect(normalizeLibraryPath('/media/movies')).toBe('/media/movies');
    });

    it('preserves the bare root path', () => {
        expect(normalizeLibraryPath('/')).toBe('/');
    });

    it('trims surrounding whitespace', () => {
        expect(normalizeLibraryPath('  /media/movies  ')).toBe('/media/movies');
    });

    it('strips trailing whitespace that precedes a trailing slash', () => {
        expect(normalizeLibraryPath('/media/movies /')).toBe('/media/movies');
    });

    // A remote provider's `path` is a synthetic `<scheme>://<opaque-id>` sentinel,
    // not a directory (see REMOTE_LIBRARY_PROVIDERS). The filesystem rules below
    // are actively wrong for it: collapsing `/{2,}` turns `abs://<uuid>` into
    // `abs:/<uuid>`, which matches no existing row and which `resolveTargets`
    // cannot address. `createLibraryPath` normalizes on EVERY insert, so this is
    // the only chokepoint where the sentinel can be protected once.
    describe('remote-provider sentinels', () => {
        const absId = '2231b38d-b79d-439d-aca1-3c3753e31dad';

        it('does not collapse the `//` in a scheme-prefixed sentinel', () => {
            expect(normalizeLibraryPath(`abs://${absId}`)).toBe(`abs://${absId}`);
        });

        it('still trims surrounding whitespace on a sentinel', () => {
            expect(normalizeLibraryPath(`  abs://${absId}  `)).toBe(`abs://${absId}`);
        });

        it('strips a trailing slash from a sentinel without touching the scheme', () => {
            expect(normalizeLibraryPath(`abs://${absId}/`)).toBe(`abs://${absId}`);
        });

        it('lower-cases the scheme so two spellings cannot both be inserted', () => {
            expect(normalizeLibraryPath(`ABS://${absId}`)).toBe(`abs://${absId}`);
        });

        it('leaves a POSIX path with no scheme on the filesystem rules', () => {
            // Guards the regex against over-matching: this must still collapse.
            expect(normalizeLibraryPath('/media//movies')).toBe('/media/movies');
        });

        it('does not treat a UNC-style leading `//` as a scheme', () => {
            expect(normalizeLibraryPath('//server/share')).toBe('/server/share');
        });
    });
});

describe('createLibraryPath', () => {
    it('normalizes a trailing-slash path before insert (dedup consistency with UNIQUE(path))', async () => {
        const fn = vi.fn().mockResolvedValue([exampleRow]);
        (fn as unknown as Record<string, unknown>).array = vi.fn((arr: unknown[]) => arr);
        const sql = fn as unknown as postgres.Sql;

        await createLibraryPath(sql, {
            path: '/media/movies/',
            media_type: 'movie',
            library_group_id: exampleRow.library_group_id,
        });

        expect(fn.mock.calls[0][1]).toBe('/media/movies');
    });

    it('returns the inserted row', async () => {
        const sql = makeSql([exampleRow]);
        const result = await createLibraryPath(sql, {
            path: '/media/movies',
            media_type: 'movie',
            library_group_id: exampleRow.library_group_id,
        });
        expect(result).toEqual(exampleRow);
    });

    it('throws if INSERT returns no row', async () => {
        const sql = makeSql([]);
        await expect(
            createLibraryPath(sql, {
                path: '/media/movies',
                media_type: 'movie',
                library_group_id: exampleRow.library_group_id,
            }),
        ).rejects.toThrow('INSERT library_paths returned no row');
    });
});

describe('updateLibraryPath', () => {
    it('returns updated row when found', async () => {
        const updated = {
            ...exampleRow,
            language: 'fr',
            updated_at: new Date('2026-02-01'),
        };
        const sql = makeSql([updated]);
        const result = await updateLibraryPath(sql, exampleRow.id, {
            language: 'fr',
        });
        expect(result).toEqual(updated);
    });

    it('returns null when id not found', async () => {
        const sql = makeSql([]);
        const result = await updateLibraryPath(sql, 'nonexistent-id', {
            enabled: false,
        });
        expect(result).toBeNull();
    });
});

describe('validateGroupConsistency', () => {
    it('returns null when group has no other paths', async () => {
        const sql = makeSql([]);
        const error = await validateGroupConsistency(sql, 'group-1', 'movie');
        expect(error).toBeNull();
    });

    it('returns null when media_type matches existing paths', async () => {
        const sql = makeSql([makeRow({ media_type: 'movie' })]);
        const error = await validateGroupConsistency(sql, 'group-1', 'movie');
        expect(error).toBeNull();
    });

    it('returns error message when media_type conflicts', async () => {
        const sql = makeSql([makeRow({ media_type: 'tv' })]);
        const error = await validateGroupConsistency(sql, 'group-1', 'movie');
        expect(error).toBe('Library group already contains tv paths — cannot mix media types');
    });

    it('excludes a specific path ID when provided', async () => {
        const row = makeRow({ id: 'path-1', media_type: 'tv' });
        const sql = makeSql([row]);
        // Excluding the only path in group → no conflict
        const error = await validateGroupConsistency(sql, 'group-1', 'movie', 'path-1');
        expect(error).toBeNull();
    });
});

// Names/paths below deliberately DON'T describe their type/provider (e.g. a
// movie library named "Family Vault", folder "/srv/stuff/a") — nothing in
// this function may key off a name or path string, only stored fields.
describe('validateGroupProviderConsistency', () => {
    it('returns null when group has no other paths', async () => {
        const sql = makeSql([]);
        const error = await validateGroupProviderConsistency(sql, 'group-1', 'tmdb', []);
        expect(error).toBeNull();
    });

    it('returns null when provider and fallback_providers match existing paths', async () => {
        const sql = makeSql([makeRow({ provider: 'anidb', fallback_providers: ['tmdb'] })]);
        const error = await validateGroupProviderConsistency(sql, 'group-1', 'anidb', ['tmdb']);
        expect(error).toBeNull();
    });

    it('treats fallback_providers order as insignificant', async () => {
        const sql = makeSql([
            makeRow({ provider: 'anidb', fallback_providers: ['tmdb', 'jellyfin'] }),
        ]);
        const error = await validateGroupProviderConsistency(sql, 'group-1', 'anidb', [
            'jellyfin',
            'tmdb',
        ]);
        expect(error).toBeNull();
    });

    it('returns an error message when provider conflicts', async () => {
        const sql = makeSql([makeRow({ provider: 'jellyfin' })]);
        const error = await validateGroupProviderConsistency(sql, 'group-1', 'tmdb', []);
        expect(error).toBe(
            'Library already uses the jellyfin provider — cannot mix providers within a library',
        );
    });

    it('returns an error message when fallback_providers conflict', async () => {
        const sql = makeSql([makeRow({ provider: 'tmdb', fallback_providers: ['anidb'] })]);
        const error = await validateGroupProviderConsistency(sql, 'group-1', 'tmdb', ['jellyfin']);
        expect(error).toBe(
            "Library's fallback providers are already set to [anidb] — cannot mix fallback providers within a library",
        );
    });

    it('excludes a specific path ID when provided', async () => {
        const row = makeRow({ id: 'path-1', provider: 'jellyfin' });
        const sql = makeSql([row]);
        const error = await validateGroupProviderConsistency(sql, 'group-1', 'tmdb', [], 'path-1');
        expect(error).toBeNull();
    });
});

describe('updateLibraryPath null-handling consistency', () => {
    it('should preserve all fields when params is empty object', async () => {
        const sql = makeSql([exampleRow]);
        const result = await updateLibraryPath(sql, exampleRow.id, {});
        expect(result).toEqual(exampleRow);
    });
});

describe('deleteLibraryPath', () => {
    it('returns true when a row was deleted', async () => {
        const sql = makeSql({ count: 1 });
        const result = await deleteLibraryPath(sql, exampleRow.id);
        expect(result).toBe(true);
    });

    it('returns false when no row was deleted', async () => {
        const sql = makeSql({ count: 0 });
        const result = await deleteLibraryPath(sql, 'nonexistent-id');
        expect(result).toBe(false);
    });
});

describe('getLibraryPathsByGroup', () => {
    it('returns array from sql result', async () => {
        const groupRows = [
            exampleRow,
            {
                ...exampleRow,
                id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
                path: '/media/movies-4k',
                edition_label: '4k',
            },
        ];
        const sql = makeSql(groupRows);
        const result = await getLibraryPathsByGroup(sql, exampleRow.library_group_id);
        expect(result).toEqual(groupRows);
        expect(result).toHaveLength(2);
    });

    it('returns empty array when no paths in group', async () => {
        const sql = makeSql([]);
        const result = await getLibraryPathsByGroup(sql, 'nonexistent-group');
        expect(result).toEqual([]);
    });
});

describe('edition_label handling', () => {
    it('exampleRow with edition_label set', async () => {
        const rowWith4k: LibraryPathRow = {
            ...exampleRow,
            edition_label: '4k',
        };
        const sql = makeSql([rowWith4k]);
        const result = await getLibraryPathById(sql, rowWith4k.id);
        expect(result).not.toBeNull();
        expect(result!.edition_label).toBe('4k');
    });

    it('edition_label null by default', async () => {
        const sql = makeSql([exampleRow]);
        const result = await getLibraryPathById(sql, exampleRow.id);
        expect(result!.edition_label).toBeNull();
    });

    it('updateLibraryPath returns row with updated edition_label', async () => {
        const updated = {
            ...exampleRow,
            edition_label: 'extended',
            updated_at: new Date('2026-02-01'),
        };
        const sql = makeSql([updated]);
        const result = await updateLibraryPath(sql, exampleRow.id, {
            edition_label: 'extended',
        });
        expect(result).not.toBeNull();
        expect(result!.edition_label).toBe('extended');
    });

    it('updateLibraryPath clears edition_label with null', async () => {
        const updated = {
            ...exampleRow,
            edition_label: null,
            updated_at: new Date('2026-02-01'),
        };
        const sql = makeSql([updated]);
        const result = await updateLibraryPath(sql, exampleRow.id, {
            edition_label: null,
        });
        expect(result).not.toBeNull();
        expect(result!.edition_label).toBeNull();
    });
});
