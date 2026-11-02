// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { withTx } from '../with-tx.js';
import { createLibraryPath } from './library-paths.queries.js';
import {
    insertAudiobook,
    updateAudiobookFromRemote,
    setAudiobookFlags,
    type AudiobookshelfMetadata,
} from './audiobooks.queries.js';
import {
    catalogFacets,
    listCatalogBooks,
    listCatalogResources,
} from './audiobook-catalog.queries.js';
import { getAudiobookLanguages } from './audiobook-browse.queries.js';
import { searchMediaFulltext } from './search.queries.js';
import { restrictedAccess, unrestrictedAccess } from './builders/media-access-boundary.js';
import {
    updateLibraryFolder,
    deleteLibraryFolder,
    deleteLibraryGroupChecked,
} from '../../services/library-folder.service.js';
import {
    checkMediaAccess,
    invalidateMediaAgeCache,
    withAgeGate,
} from '../../middleware/media-access.js';
import type { RequestEvent } from '@sveltejs/kit';
import * as connection from '../connection.js';
import type { UserContext } from '../../types.js';
import { toUserId } from '$lib/shared/user-id.js';

import { config } from '../../config.js';

vi.mock('$lib/server/services/library-path-sync.service.js', () => ({
    afterLibraryPathChanged: vi.fn(),
    afterLibraryGroupChanged: vi.fn(),
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { listRuns: async () => ({ runs: [] }) },
}));

const GROUP = '00000000-0000-4000-8000-000000102801';
const PATH = '00000000-0000-4000-8000-000000102802';
const rollback = new Error('fixture rollback');
let db: postgres.Sql;
beforeAll(() => {
    db = getTestDb();
    vi.spyOn(config, 'UNRATED_CONTENT_VISIBLE', 'get').mockReturnValue(true);
});
afterAll(async () => {
    vi.restoreAllMocks();
    await closeTestDb();
});

async function fixture(run: (sql: postgres.Sql) => Promise<void>): Promise<void> {
    await withTx(db, async (sql) => {
        await sql`INSERT INTO library_groups (id, name) VALUES (${GROUP}, '🎧 日本語 — Fantasy / Adult')`;
        await sql`INSERT INTO library_paths (id, path, media_type, language, provider, provider_path, library_group_id)
            VALUES (${PATH}, 'abs://variant-library', 'audiobook', '', 'audiobookshelf', 'variant-library', ${GROUP})`;
        await run(sql);
        throw rollback;
    }).catch((error: unknown) => {
        if (error !== rollback) throw error;
    });
}

async function book(
    sql: postgres.Sql,
    title = 'Der Wolkenkompass',
    pathId = PATH,
): Promise<string> {
    const metadata: AudiobookshelfMetadata = {
        libraryId: 'variant-library',
        libraryPathId: pathId,
        updatedAt: 1,
        mtimeMs: 1,
        addedAt: null,
        relPath: null,
        coverPath: null,
        subtitle: null,
        authors: ['水野 あかり'],
        narrators: ['さくら はる'],
        series: [],
        derivedSeries: { name: 'ねこの冒険', sequence: 1, source: 'abs-series' },
        genres: [],
        publisher: null,
        publishedYear: null,
        language: 'ja',
        isbn: null,
        asin: null,
        explicit: true,
        abridged: false,
        duration: 120,
        audioFiles: [],
        chapters: [],
    };
    return insertAudiobook(sql, {
        title,
        sortTitle: 'der wolkenkompass',
        overview: null,
        year: null,
        runtimeSeconds: 120,
        hasFiles: true,
        libraryGroupId: GROUP,
        libraryAddedAt: null,
        sortOrder: 1000,
        metadata,
    });
}

function options() {
    return {
        access: unrestrictedAccess(),
        viewerId: null,
        surface: 'v1' as const,
        groupId: GROUP,
        limit: 60,
        offset: 0,
    };
}

describe('ABS library organisation variants', () => {
    it.each(['🎧', '𝒜'])(
        'rejects a single non-CJK code point in a direct audiobook search (%s)',
        async (query) => {
            await fixture(async (sql) => {
                await book(sql, query + ' Lantern');
                expect(
                    await searchMediaFulltext(sql, query, unrestrictedAccess(), {
                        mediaTypes: ['audiobook'],
                    }),
                ).toEqual([]);
            });
        },
    );
    it('keeps the two-character minimum for Latin audiobook queries and limits single kana to audiobooks', async () => {
        await fixture(async (sql) => {
            const id = await book(sql, 'こa Lantern');
            await sql`INSERT INTO media_items (title, media_type, status, has_files)
                VALUES ('こa Film', 'movie', 'active', true)`;
            expect(
                await searchMediaFulltext(sql, 'a', unrestrictedAccess(), {
                    mediaTypes: ['audiobook'],
                }),
            ).toEqual([]);
            const rows = await searchMediaFulltext(sql, 'こ', unrestrictedAccess(), {
                mediaTypes: ['audiobook', 'movie'],
            });
            expect(rows.map((row) => row.internal_id)).toEqual([id]);
        });
    });
    it('clearing a declared language restores neutral article sorting on existing books', async () => {
        await fixture(async (sql) => {
            const id = await book(sql, 'The Glass Orchard');
            await sql`UPDATE library_paths SET language = 'en' WHERE id = ${PATH}`;
            await updateLibraryFolder(sql, PATH, { language: '' }, ['admin']);
            const [row] = await sql<
                { sort_title: string }[]
            >`SELECT sort_title FROM media_items WHERE id = ${id}`;
            expect(row.sort_title).toBe('the glass orchard');
        });
    });
    it('retains the age restriction on withdrawn books after their empty library group is deleted', async () => {
        await fixture(async (sql) => {
            const id = await book(sql);
            await sql`UPDATE library_groups SET max_age_rating = 18 WHERE id = ${GROUP}`;
            await deleteLibraryFolder(sql, PATH, { scopes: ['admin'] });
            expect((await deleteLibraryGroupChecked(sql, GROUP, ['admin'])).ok).toBe(true);
            invalidateMediaAgeCache('*');
            const user: UserContext = {
                userId: toUserId('00000000-0000-4000-8000-000000102803'),
                username: 'variants-kids',
                groups: '',
                userGroups: [],
                ownerIsAdmin: false,
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                maxAgeRating: 12,
                isAgeRestricted: true,
                isModerator: false,
                liveTvPriority: 'low',
            };
            expect(await checkMediaAccess(sql, id, user)).toBe(false);
        });
    });
    it('reattaches the same book and progress identity to the new library after removal and re-add', async () => {
        await fixture(async (sql) => {
            const id = await book(sql);
            const [row] = await sql<
                { metadata: AudiobookshelfMetadata }[]
            >`SELECT custom_metadata->'audiobookshelf' AS metadata FROM media_items WHERE id = ${id}`;
            const kid: UserContext = {
                userId: toUserId('00000000-0000-4000-8000-000000102803'),
                username: 'reattach-kid',
                groups: '',
                userGroups: [],
                ownerIsAdmin: false,
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                maxAgeRating: 12,
                isAgeRestricted: true,
                isModerator: false,
                liveTvPriority: 'low',
            };
            // Prime the old group's effective age before the sweep reattaches.
            expect(await checkMediaAccess(sql, id, kid)).toBe(true);
            await deleteLibraryFolder(sql, PATH, { scopes: ['admin'] });
            const group = '00000000-0000-4000-8000-000000102805';
            await sql`INSERT INTO library_groups (id, name, max_age_rating) VALUES (${group}, 'New local shelf', 18)`;
            const path = await createLibraryPath(sql, {
                path: 'abs://variant-library',
                provider: 'audiobookshelf',
                provider_path: 'variant-library',
                media_type: 'audiobook',
                language: 'de',
                library_group_id: group,
            });
            await updateAudiobookFromRemote(sql, id, {
                requireConfiguredLibrary: true,
                title: 'Der Wolkenkompass',
                sortTitle: 'stale',
                overview: null,
                year: null,
                runtimeSeconds: 120,
                hasFiles: true,
                libraryGroupId: group,
                libraryAddedAt: null,
                sortOrder: 1000,
                metadata: { ...row.metadata, libraryPathId: path.id },
            });
            const dbSpy = vi.spyOn(connection, 'getDb').mockReturnValue(sql);
            try {
                // The age-only middleware uses L1 even for a remote book. The
                // sweep must invalidate that cached old floor on all replicas.
                expect(
                    (
                        await withAgeGate(async () => new Response('allowed'))({
                            locals: { user: kid, resolvedIds: { internalId: id } },
                        } as unknown as RequestEvent)
                    ).status,
                ).toBe(404);
            } finally {
                dbSpy.mockRestore();
            }
            expect(await checkMediaAccess(sql, id, kid)).toBe(false);
            const result = await listCatalogBooks(sql, {
                ...options(),
                groupId: group,
                lang: 'de',
            });
            expect(result.items.map((item) => item.id)).toEqual([id]);
            expect((await listCatalogBooks(sql, options())).items).toEqual([]);
        });
    });
    it('unions several same-language libraries without deriving language from names or book tags', async () => {
        await fixture(async (sql) => {
            const second = '00000000-0000-4000-8000-000000102804';
            await sql`UPDATE library_paths SET language = 'de' WHERE id = ${PATH}`;
            await sql`INSERT INTO library_paths (id, path, media_type, language, provider, library_group_id)
                VALUES (${second}, 'abs://odd-name', 'audiobook', 'de', 'audiobookshelf', ${GROUP})`;
            const firstId = await book(sql, 'Fantasy book');
            const secondId = await book(sql, 'Krimi book', second);
            const o = { ...options(), lang: 'de' };
            expect((await listCatalogBooks(sql, o)).items.map((row) => row.id).sort()).toEqual(
                [firstId, secondId].sort(),
            );
            expect((await catalogFacets(sql, options())).languages).toEqual([
                { language: 'de', bookCount: 2 },
            ]);
            expect((await listCatalogBooks(sql, { ...options(), lang: 'ja' })).items).toEqual([]);
        });
    });
    it('enforces library age at playback admission and after a warmed rating cache is invalidated', async () => {
        await fixture(async (sql) => {
            const id = await book(sql);
            const user: UserContext = {
                userId: toUserId('00000000-0000-4000-8000-000000102803'),
                username: 'variants-kids',
                groups: '',
                userGroups: [],
                ownerIsAdmin: false,
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                maxAgeRating: 12,
                isAgeRestricted: true,
                isModerator: false,
                liveTvPriority: 'low',
            };
            expect(await checkMediaAccess(sql, id, user)).toBe(true);
            await sql`UPDATE library_groups SET max_age_rating = 18 WHERE id = ${GROUP}`;
            invalidateMediaAgeCache('*');
            expect(await checkMediaAccess(sql, id, user)).toBe(false);
            expect(await checkMediaAccess(sql, id, { ...user, maxAgeRating: 18 })).toBe(true);
            const rows = await searchMediaFulltext(
                sql,
                'Wolkenkompass',
                restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: true }),
                { mediaTypes: ['audiobook'] },
            );
            expect(rows).toEqual([]);
        });
    });

    it('rejects a late sweep write after its library has been removed', async () => {
        await fixture(async (sql) => {
            await sql`DELETE FROM library_paths WHERE id = ${PATH}`;
            // Build a valid write before simulating the stale in-flight commit.
            const metadata: AudiobookshelfMetadata = {
                libraryId: 'variant-library',
                libraryPathId: PATH,
                updatedAt: 1,
                mtimeMs: 1,
                addedAt: null,
                relPath: null,
                coverPath: null,
                subtitle: null,
                authors: [],
                narrators: [],
                series: [],
                derivedSeries: { name: null, sequence: null, source: 'none' },
                genres: [],
                publisher: null,
                publishedYear: null,
                language: 'ja',
                isbn: null,
                asin: null,
                explicit: false,
                abridged: false,
                duration: 120,
                audioFiles: [],
                chapters: [],
            };
            await expect(
                insertAudiobook(sql, {
                    requireConfiguredLibrary: true,
                    title: 'Late book',
                    sortTitle: 'late book',
                    overview: null,
                    year: null,
                    runtimeSeconds: 120,
                    hasFiles: true,
                    libraryGroupId: GROUP,
                    libraryAddedAt: null,
                    sortOrder: null,
                    metadata,
                }),
            ).rejects.toThrow('removed or disabled');
        });
    });
    it('finds Japanese author, series and one-character kana terms in general search', async () => {
        await fixture(async (sql) => {
            const id = await book(sql, 'ねこの冒険');
            for (const query of ['水野', 'ねこ', 'こ']) {
                const rows = await searchMediaFulltext(sql, query, unrestrictedAccess(), {
                    mediaTypes: ['audiobook'],
                });
                expect(
                    rows.map((row) => row.internal_id),
                    query,
                ).toContain(id);
            }
        });
    });
    it('keeps an omitted ABS language unset while retaining the filesystem default', async () => {
        await fixture(async (sql) => {
            const remote = await createLibraryPath(sql, {
                path: 'abs://another',
                provider: 'audiobookshelf',
                provider_path: 'another',
                media_type: 'audiobook',
                library_group_id: GROUP,
            });
            expect(remote.language).toBe('');
        });
    });

    it('shows untagged mixed libraries in all languages without an empty language chip', async () => {
        await fixture(async (sql) => {
            await book(sql);
            expect((await listCatalogBooks(sql, options())).items).toHaveLength(1);
            expect((await catalogFacets(sql, options())).languages).toEqual([]);
            expect(
                await getAudiobookLanguages(sql, { access: unrestrictedAccess(), groupId: GROUP }),
            ).toEqual([]);
            expect((await listCatalogBooks(sql, { ...options(), lang: 'ja' })).items).toEqual([]);
            await sql`UPDATE library_paths SET language = 'de' WHERE id = ${PATH}`;
            expect((await catalogFacets(sql, options())).languages).toEqual([
                { language: 'de', bookCount: 1 },
            ]);
        });
    });

    it('applies the library age restriction to books and contributor/series resources, including unrated books', async () => {
        await fixture(async (sql) => {
            await book(sql);
            await sql`UPDATE library_groups SET max_age_rating = 18 WHERE id = ${GROUP}`;
            const o = {
                ...options(),
                access: restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: true,
                }),
            };
            expect((await listCatalogBooks(sql, o)).items).toEqual([]);
            expect((await catalogFacets(sql, o)).shelves).toEqual([]);
            expect((await listCatalogResources(sql, { ...o, resource: 'author' })).items).toEqual(
                [],
            );
            expect((await listCatalogResources(sql, { ...o, resource: 'series' })).items).toEqual(
                [],
            );
            expect((await listCatalogBooks(sql, options())).items).toHaveLength(1);
        });
    });

    it('re-sorts existing books immediately when the declared language changes', async () => {
        await fixture(async (sql) => {
            const id = await book(sql);
            const secondId = await book(sql, 'Das Tor');
            const result = await updateLibraryFolder(sql, PATH, { language: 'de' }, ['admin']);
            expect(result.ok).toBe(true);
            const [row] = await sql<
                { sort_title: string }[]
            >`SELECT sort_title FROM media_items WHERE id = ${id}`;
            expect(row.sort_title).toBe('wolkenkompass');
            const [second] = await sql<
                { sort_title: string }[]
            >`SELECT sort_title FROM media_items WHERE id = ${secondId}`;
            expect(second.sort_title).toBe('tor');
        });
    });

    it('retires books when their ABS library is removed, preserving their rows', async () => {
        await fixture(async (sql) => {
            const id = await book(sql);
            const result = await deleteLibraryFolder(sql, PATH, { scopes: ['admin'] });
            expect(result.ok).toBe(true);
            expect((await listCatalogBooks(sql, options())).items).toEqual([]);
            const [row] = await sql<{ has_files: boolean; is_dismissed: boolean }[]>`
                SELECT has_files, is_dismissed FROM media_items WHERE id = ${id}`;
            expect(row).toEqual({ has_files: false, is_dismissed: true });
            expect(
                await setAudiobookFlags(sql, [id], {
                    hasFiles: true,
                    isDismissed: false,
                    requireConfiguredLibrary: true,
                }),
            ).toBe(0);
            expect((await listCatalogBooks(sql, options())).items).toEqual([]);
        });
    });
    it('retires only the disabled ABS library books and revives them when re-enabled', async () => {
        await fixture(async (sql) => {
            const other = '00000000-0000-4000-8000-000000102809';
            await sql`INSERT INTO library_paths (id, path, media_type, language, provider, provider_path, library_group_id)
                VALUES (${other}, 'abs://other-library', 'audiobook', '', 'audiobookshelf', 'other-library', ${GROUP})`;
            const gone = await book(sql, 'Der Wolkenkompass');
            const kept = await book(sql, 'Der Nebelturm', other);
            const flags = async (id: string) =>
                (
                    await sql<{ has_files: boolean; is_dismissed: boolean }[]>`
                        SELECT has_files, is_dismissed FROM media_items WHERE id = ${id}`
                )[0];

            const off = await updateLibraryFolder(sql, PATH, { enabled: false }, undefined);
            expect(off.ok).toBe(true);
            expect(await flags(gone)).toEqual({ has_files: false, is_dismissed: true });
            expect(await flags(kept)).toEqual({ has_files: true, is_dismissed: false });
            expect((await listCatalogBooks(sql, options())).items.map((item) => item.id)).toEqual([
                kept,
            ]);

            // Re-enabled: the next sweep sees the item upstream again and revives it.
            const on = await updateLibraryFolder(sql, PATH, { enabled: true }, undefined);
            expect(on.ok).toBe(true);
            const [row] = await sql<{ metadata: AudiobookshelfMetadata }[]>`
                SELECT custom_metadata->'audiobookshelf' AS metadata FROM media_items WHERE id = ${gone}`;
            await updateAudiobookFromRemote(sql, gone, {
                requireConfiguredLibrary: true,
                title: 'Der Wolkenkompass',
                sortTitle: 'der wolkenkompass',
                overview: null,
                year: null,
                runtimeSeconds: 120,
                hasFiles: true,
                libraryGroupId: GROUP,
                libraryAddedAt: null,
                sortOrder: 1000,
                metadata: row.metadata,
            });
            expect(await flags(gone)).toEqual({ has_files: true, is_dismissed: false });
        });
    });
});
