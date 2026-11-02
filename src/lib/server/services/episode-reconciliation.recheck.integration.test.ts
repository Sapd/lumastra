// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { truncateAllTestTables } from '../../../../tests/integration/helpers/cleanup.js';

const seam = vi.hoisted(() => ({
    beforeLock: null as (() => Promise<void>) | null,
    beforeEligibility: null as (() => Promise<void>) | null,
    beforeProvider: null as (() => Promise<void>) | null,
    beforeMetadataWrite: null as (() => Promise<void>) | null,
    beforeWarningFence: null as (() => Promise<void>) | null,
    warningReads: 0,
    forbidProviders: false,
    providerCalls: 0,
    localized: {} as Record<string, string>,
    languages: [] as string[],
    catalog: null as
        | {
              id: number;
              name: string;
              seasonNumber: number;
              episodeNumber: number;
              stillPath: string;
              overview?: string;
          }[]
        | null,
}));
vi.mock('$lib/server/database/queries/episode-reconciliation.queries.js', async (actualImport) => {
    const actual =
        await actualImport<
            typeof import('$lib/server/database/queries/episode-reconciliation.queries.js')
        >();
    return {
        ...actual,
        getLockedHeldTmdbIds: async (
            sql: postgres.Sql,
            id: string,
            targetIds: string[],
        ): Promise<Set<string>> => {
            const hook = seam.beforeEligibility;
            seam.beforeEligibility = null;
            await hook?.();
            return actual.getLockedHeldTmdbIds(sql, id, targetIds);
        },
        lockQuarantineEvidence: async (
            sql: postgres.Sql,
            evidence: Parameters<typeof actual.lockQuarantineEvidence>[1],
        ): Promise<void> => {
            const hook = seam.beforeLock;
            seam.beforeLock = null;
            await hook?.();
            await actual.lockQuarantineEvidence(sql, evidence);
        },
        lockReconciliationEvidence: async (sql: postgres.Sql, id: string): Promise<void> => {
            const hook = seam.beforeLock;
            seam.beforeLock = null;
            await hook?.();
            await actual.lockReconciliationEvidence(sql, id);
        },
    };
});

vi.mock('$lib/server/database/queries/sync-quarantine.queries.js', async (actualImport) => {
    const actual =
        await actualImport<
            typeof import('$lib/server/database/queries/sync-quarantine.queries.js')
        >();
    return {
        ...actual,
        listQuarantineSnapshots: (...args: Parameters<typeof actual.listQuarantineSnapshots>) => {
            seam.warningReads++;
            return actual.listQuarantineSnapshots(...args);
        },
        lockQuarantineSnapshots: async (
            ...args: Parameters<typeof actual.lockQuarantineSnapshots>
        ) => {
            const hook = seam.beforeWarningFence;
            seam.beforeWarningFence = null;
            await hook?.();
            return actual.lockQuarantineSnapshots(...args);
        },
    };
});

vi.mock('$lib/server/database/queries/media-upsert.js', async (actualImport) => {
    const actual =
        await actualImport<typeof import('$lib/server/database/queries/media-upsert.js')>();
    return {
        ...actual,
        upsertProviderMetadataUnlessLocked: async (
            ...args: Parameters<typeof actual.upsertProviderMetadataUnlessLocked>
        ) => {
            const hook = seam.beforeMetadataWrite;
            seam.beforeMetadataWrite = null;
            await hook?.();
            return actual.upsertProviderMetadataUnlessLocked(...args);
        },
    };
});

vi.mock('$lib/server/tasks/plugin-context.js', async (actualImport) => {
    const actual = await actualImport<typeof import('$lib/server/tasks/plugin-context.js')>();
    return {
        ...actual,
        getProvidersByPriority: (...args: Parameters<typeof actual.getProvidersByPriority>) => {
            seam.providerCalls++;
            if (seam.forbidProviders) throw new Error('Provider resolver called during recheck');
            return actual.getProvidersByPriority(...args);
        },
        invokeProviderChildList: (...args: Parameters<typeof actual.invokeProviderChildList>) => {
            seam.providerCalls++;
            if (seam.forbidProviders) throw new Error('Provider invocation called during recheck');
            return actual.invokeProviderChildList(...args);
        },
    };
});

vi.mock('$lib/server/providers/implementations/tmdb/index.js', async (actualImport) => {
    const actual =
        await actualImport<typeof import('$lib/server/providers/implementations/tmdb/index.js')>();
    const client = {
        isAvailable: () => {
            seam.providerCalls++;
            if (seam.forbidProviders) throw new Error('Provider called during recheck');
            return true;
        },
        getTVShowSeasons: async () => {
            seam.providerCalls++;
            if (seam.forbidProviders) throw new Error('Provider called during recheck');
            return [{ seasonNumber: 1 }];
        },
        getSeasonEpisodes: async () => {
            seam.providerCalls++;
            if (seam.forbidProviders) throw new Error('Provider called during recheck');
            const hook = seam.beforeProvider;
            seam.beforeProvider = null;
            await hook?.();
            if (seam.catalog) return seam.catalog;
            return [
                {
                    id: 870001,
                    name: 'The Decision',
                    seasonNumber: 1,
                    episodeNumber: 1,
                    stillPath: '/decision.jpg',
                },
                {
                    id: 870002,
                    name: 'Second Decision',
                    seasonNumber: 1,
                    episodeNumber: 2,
                    stillPath: '/second.jpg',
                },
            ];
        },
        getSeasonEpisodesInLanguage: async (_id: string, _season: number, language: string) => {
            seam.languages.push(language);
            seam.providerCalls++;
            if (seam.forbidProviders) throw new Error('Localized provider called during recheck');
            return seam.localized[language]
                ? [
                      {
                          id: 870001,
                          name: seam.localized[language],
                          seasonNumber: 1,
                          episodeNumber: 1,
                      },
                  ]
                : [];
        },
    };
    return { ...actual, tmdbApi: client, createTMDBApi: () => client };
});

import {
    loadTmdbCatalog,
    recheckQuarantinedMatchesForSeries,
    confirmQuarantinedCurrentMatchesForSeries,
    acceptQuarantinedMatchesForSeries as acceptService,
    backfillReconcileSeries,
    reevaluateQuarantineBacklog,
} from './episode-reconciliation.service.js';
import {
    quarantineWrite,
    getQuarantineById,
    listUnresolvedQuarantineBySeries,
} from '$lib/server/database/queries/sync-quarantine.queries.js';

import {
    inspectQuarantineGroup,
    dismissReviewedQuarantine,
} from './quarantine-inspection.service.js';
const url = getTestDatabaseUrl();
interface Fixture {
    seriesId: string;
    seasonId: string;
    episodeId: string;
    fileId: string;
    warningId: string;
}

describe('completed ordinary episode decisions (real PostgreSQL)', () => {
    let sql: postgres.Sql;
    let rival: postgres.Sql;
    beforeAll(async () => {
        sql = postgres(url, { max: 1, onnotice: () => {} });
        rival = postgres(url, { max: 1, onnotice: () => {} });
    });
    beforeEach(async () => {
        seam.beforeLock = null;
        seam.beforeEligibility = null;
        seam.beforeProvider = null;
        seam.beforeMetadataWrite = null;
        seam.beforeWarningFence = null;
        seam.warningReads = 0;
        seam.forbidProviders = false;
        seam.providerCalls = 0;
        seam.catalog = null;
        seam.localized = {};
        seam.languages = [];
        await truncateAllTestTables(sql);
    });
    afterAll(async () => {
        await Promise.all([sql.end(), rival.end()]);
    });

    async function seed(identity = '870001', title = 'The Decision'): Promise<Fixture> {
        const [{ id: seriesId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status) VALUES ('Series', 'tv', 'active') RETURNING id`;
        const [{ id: seasonId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status, parent_id, season_number) VALUES ('Season', 'season', 'active', ${seriesId}, 1) RETURNING id`;
        const [{ id: episodeId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, title_binding, media_type, status, parent_id, season_number, episode_number) VALUES (${title}, 'identity', 'episode', 'active', ${seasonId}, 1, 1) RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${episodeId}, 'tmdb', ${identity}, 'episode')`;
        const [{ id: fileId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_files (file_path) VALUES (${`/test/${episodeId}.mkv`}) RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${episodeId}, ${fileId}, true)`;
        const warningId = await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: episodeId,
            mediaType: 'episode',
            expectedSeriesId: seriesId,
            payload: {
                seriesMediaId: seriesId,
                seasonNumber: 1,
                episodeNumber: 1,
                matchedTmdbEpisodeId: identity,
                proposedTitle: title,
            },
            reason: 'reconcile-backfill:matched',
            source: 'test',
        });
        return { seriesId, seasonId, episodeId, fileId, warningId };
    }

    async function acceptQuarantinedMatchesForSeries(
        db: postgres.Sql,
        series: string,
        actor: string,
    ): Promise<Awaited<ReturnType<typeof acceptService>>> {
        const preview = await acceptService(db, series, actor, { preview: true });
        return acceptService(db, series, actor, {
            reviewed: preview.review ?? [],
            reviewedPage: preview.reviewedPage,
        });
    }

    async function preserved(): Promise<unknown> {
        return Promise.all([
            sql`SELECT to_jsonb(m) AS row FROM media_items m ORDER BY id`,
            sql`SELECT to_jsonb(e) AS row FROM external_ids e ORDER BY media_id, provider, media_type`,
            sql`SELECT to_jsonb(f) AS row FROM media_files f ORDER BY id`,
            sql`SELECT to_jsonb(l) AS row FROM media_file_items l ORDER BY file_id, media_item_id`,
            sql`SELECT to_jsonb(s) AS row FROM media_segments s ORDER BY id`,
            sql`SELECT to_jsonb(w) AS row FROM user_media_state w ORDER BY user_id, media_id`,
            sql`SELECT to_jsonb(h) AS row FROM watch_history h ORDER BY id`,
            sql`SELECT to_jsonb(p) AS row FROM provider_metadata p ORDER BY media_id, provider`,
        ]);
    }

    async function positional(): Promise<Fixture> {
        const fixture = await seed();
        await sql`UPDATE media_items SET title_binding = 'position' WHERE id = ${fixture.episodeId}`;
        return fixture;
    }

    async function previewCurrent(seriesId: string, after?: string, limit?: number) {
        return confirmQuarantinedCurrentMatchesForSeries(sql, seriesId, 'admin', {
            preview: true,
            after,
            limit,
        });
    }

    async function confirmCurrent(
        seriesId: string,
        preview: Awaited<ReturnType<typeof previewCurrent>>,
        selected = preview.review?.filter((row) => row.eligible) ?? [],
        after?: string,
        limit?: number,
    ) {
        return confirmQuarantinedCurrentMatchesForSeries(sql, seriesId, 'admin', {
            preview: false,
            after,
            limit,
            reviewedPage: preview.reviewedPage,
            reviewed: selected.map(({ id, fingerprint }) => ({ id, fingerprint })),
        });
    }

    it('confirms an exact positional proposal only after selected review, preserving all media', async () => {
        const f = await positional();
        await sql`UPDATE sync_quarantine SET expected_series_id = NULL WHERE id = ${f.warningId}`;
        const before = await preserved();
        seam.forbidProviders = true;
        expect((await recheckQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')).resolved).toBe(
            0,
        );
        const preview = await previewCurrent(f.seriesId);
        expect(preview).toMatchObject({ examined: 1, resolved: 0, retained: 1 });
        expect(preview.review).toMatchObject([
            { id: f.warningId, eligible: true, titleBinding: 'position' },
        ]);
        expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
        expect(await confirmCurrent(f.seriesId, preview)).toMatchObject({
            examined: 1,
            resolved: 1,
            retained: 0,
        });
        expect(await preserved()).toEqual(before);
        expect(seam.providerCalls).toBe(0);
        const warning = await getQuarantineById(sql, f.warningId);
        expect(warning).toMatchObject({
            resolution: 'dismissed',
            resolvedBy: 'admin',
            reason: 'reconcile-backfill:matched',
            source: 'test',
        });
        const [audit] = await sql<
            { actor: string; action: string; detail: Record<string, unknown> }[]
        >`
            SELECT actor, action, detail FROM audit_log WHERE target = ${f.warningId}
        `;
        expect(audit).toMatchObject({
            actor: 'admin',
            action: 'confirmed_current_match',
            detail: { operation: 'confirmed_current_match' },
        });
        expect(audit.detail).toHaveProperty('before');
        expect(audit.detail).toHaveProperty('after');
        expect((await confirmCurrent(f.seriesId, preview)).pageChanged).toBe(true);
    });

    it('closes only selected warnings and continues through bounded pages', async () => {
        const f = await positional();
        const [{ id: secondId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, title_binding, media_type, status, parent_id, season_number, episode_number)
            VALUES ('Second Decision', 'position', 'episode', 'active', ${f.seasonId}, 1, 2) RETURNING id
        `;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${secondId}, 'tmdb', '870002', 'episode')`;
        const [{ id: secondFile }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES (${`/test/${secondId}.mkv`}) RETURNING id
        `;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
            VALUES (${secondId}, ${secondFile}, true)`;
        const secondWarning = await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: secondId,
            mediaType: 'episode',
            expectedSeriesId: f.seriesId,
            reason: 'reconcile-backfill:matched',
            source: 'test',
            payload: {
                seriesMediaId: f.seriesId,
                seasonNumber: 1,
                episodeNumber: 2,
                matchedTmdbEpisodeId: '870002',
                proposedTitle: 'Second Decision',
            },
        });
        const before = await preserved();
        const firstPage = await previewCurrent(f.seriesId, undefined, 1);
        expect(firstPage).toMatchObject({ examined: 1 });
        expect(firstPage.continuation).toBeDefined();
        const secondPage = await previewCurrent(f.seriesId, firstPage.continuation, 1);
        expect(secondPage).toMatchObject({ examined: 1 });
        expect(secondPage.review?.[0]?.id).not.toBe(firstPage.review?.[0]?.id);
        const preview = await previewCurrent(f.seriesId);
        expect(preview.review).toHaveLength(2);
        const first = preview.review!.find((row) => row.id === f.warningId)!;
        expect(await confirmCurrent(f.seriesId, preview, [first])).toMatchObject({
            examined: 2,
            resolved: 1,
            retained: 1,
        });
        expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).not.toBeNull();
        expect((await getQuarantineById(sql, secondWarning))?.resolvedAt).toBeNull();
        expect(await preserved()).toEqual(before);
        const nextPage = await previewCurrent(f.seriesId);
        expect(nextPage.review).toHaveLength(1);
        const limited = await previewCurrent(f.seriesId, undefined, 1);
        expect(limited.examined).toBe(1);
        expect(limited.continuation).toBeUndefined();
    });

    it.each([
        'title',
        'identity',
        'season',
        'episode',
        'series',
        'file',
        'protection',
        'historical target',
        'historical series',
        'binding',
    ])('retains a positional warning when %s differs', async (kind) => {
        const f = await positional();
        if (kind === 'title')
            await sql`UPDATE media_items SET title = 'Other' WHERE id = ${f.episodeId}`;
        if (kind === 'identity')
            await sql`UPDATE external_ids SET external_id = '870002' WHERE media_id = ${f.episodeId}`;
        if (kind === 'season')
            await sql`UPDATE media_items SET season_number = 2 WHERE id = ${f.seasonId}`;
        if (kind === 'episode')
            await sql`UPDATE media_items SET episode_number = 2 WHERE id = ${f.episodeId}`;
        if (kind === 'series')
            await sql`UPDATE media_items SET parent_id = NULL WHERE id = ${f.seasonId}`;
        if (kind === 'file')
            await sql`DELETE FROM media_file_items WHERE media_item_id = ${f.episodeId}`;
        if (kind === 'protection')
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${f.episodeId}`;
        if (kind === 'historical target')
            await sql`UPDATE sync_quarantine SET payload = payload - 'matchedTmdbEpisodeId', reason = 'reconcile-backfill:below-threshold' WHERE id = ${f.warningId}`;
        if (kind === 'historical series')
            await sql`UPDATE sync_quarantine SET payload = jsonb_set(payload, '{seriesMediaId}', ${sql.json(randomUUID())}::jsonb) WHERE id = ${f.warningId}`;
        if (kind === 'binding')
            await sql`UPDATE media_items SET title_binding = 'identity' WHERE id = ${f.episodeId}`;
        const before = await preserved();
        const preview = await previewCurrent(f.seriesId);
        expect(preview.review?.[0]?.eligible).toBe(false);
        if (kind === 'historical target')
            expect(preview.review?.[0]?.retainedReason).toBe('historical-target-unconfirmed');
        expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
        expect(await preserved()).toEqual(before);
    });

    it.each(['title', 'identity', 'parent', 'file', 'protection', 'warning', 'revival'])(
        'rejects a stale selected page after a concurrent %s rewrite',
        async (kind) => {
            const f = await positional();
            const preview = await previewCurrent(f.seriesId);
            seam.beforeLock = async (): Promise<void> => {
                if (kind === 'title')
                    await rival`UPDATE media_items SET title='New title' WHERE id=${f.episodeId}`;
                if (kind === 'identity')
                    await rival`UPDATE external_ids SET external_id='870002' WHERE media_id=${f.episodeId}`;
                if (kind === 'parent')
                    await rival`UPDATE media_items SET parent_id=NULL WHERE id=${f.episodeId}`;
                if (kind === 'file')
                    await rival`DELETE FROM media_file_items WHERE media_item_id=${f.episodeId}`;
                if (kind === 'protection')
                    await rival`UPDATE media_items SET metadata_locked=true WHERE id=${f.episodeId}`;
                if (kind === 'warning')
                    await rival`UPDATE sync_quarantine SET source='concurrent' WHERE id=${f.warningId}`;
                if (kind === 'revival') {
                    await rival`UPDATE sync_quarantine SET resolved_at=NOW() WHERE id=${f.warningId}`;
                    await rival`UPDATE sync_quarantine SET resolved_at=NULL WHERE id=${f.warningId}`;
                }
            };
            expect((await confirmCurrent(f.seriesId, preview)).pageChanged).toBe(true);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
            expect(await sql`SELECT id FROM audit_log WHERE target=${f.warningId}`).toHaveLength(0);
        },
    );

    it('closes exact completed evidence with authenticated attribution and no catalog writes', async () => {
        const f = await seed();
        const [{ id: userId }] = await sql<
            { id: string }[]
        >`INSERT INTO users (username) VALUES (${`viewer-${randomUUID()}`}) RETURNING id`;
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, watch_count) VALUES (${userId}, ${f.episodeId}, true, 123456, 2)`;
        await sql`INSERT INTO media_segments (media_id, type, start_time, end_time, source) VALUES (${f.episodeId}, 'Intro', 1, 30, 'manual')`;
        const before = await preserved();
        seam.forbidProviders = true;
        expect(
            await recheckQuarantinedMatchesForSeries(sql, f.seriesId, 'authenticated-admin'),
        ).toMatchObject({ examined: 1, resolved: 1, retained: 0 });
        expect(await preserved()).toEqual(before);
        expect(seam.providerCalls).toBe(0);
        expect(await getQuarantineById(sql, f.warningId)).toMatchObject({
            resolution: 'reattached',
            resolvedBy: 'authenticated-admin',
        });
    });

    it('supports the historical payload series fallback without weakening evidence', async () => {
        const f = await seed();
        await sql`UPDATE sync_quarantine SET expected_series_id = NULL WHERE id = ${f.warningId}`;
        expect((await recheckQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')).resolved).toBe(
            1,
        );
    });

    const cases = [
        'pending title',
        'position binding',
        'different identity',
        'protected different identity',
        'moved parent',
        'inactive episode',
        'inactive season',
        'inactive series',
        'no file',
        'wrong season',
        'wrong ordinal',
        'conflicting series',
        'malformed series',
        'numeric id',
        'malformed id',
        'empty title',
        'overflow season',
        'negative episode',
        'overflow episode',
        'no candidate',
        'ambiguous',
        'other provider',
    ] as const;
    it.each(cases)('retains %s with no media changes', async (kind) => {
        const f = await seed();
        if (kind === 'pending title')
            await sql`UPDATE media_items SET title = 'Pending' WHERE id = ${f.episodeId}`;
        if (kind === 'position binding')
            await sql`UPDATE media_items SET title_binding = 'position' WHERE id = ${f.episodeId}`;
        if (kind === 'protected different identity')
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${f.episodeId}`;
        if (kind === 'different identity' || kind === 'protected different identity')
            await sql`UPDATE external_ids SET external_id = '870002' WHERE media_id = ${f.episodeId}`;
        if (kind === 'moved parent')
            await sql`UPDATE media_items SET parent_id = NULL WHERE id = ${f.episodeId}`;
        if (kind.startsWith('inactive'))
            await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${kind === 'inactive episode' ? f.episodeId : kind === 'inactive season' ? f.seasonId : f.seriesId}`;
        if (kind === 'no file')
            await sql`DELETE FROM media_file_items WHERE media_item_id = ${f.episodeId}`;
        if (kind === 'wrong season')
            await sql`UPDATE media_items SET season_number = 2 WHERE id = ${f.seasonId}`;
        if (kind === 'wrong ordinal')
            await sql`UPDATE media_items SET episode_number = 2 WHERE id = ${f.episodeId}`;
        if (kind === 'conflicting series' || kind === 'malformed series')
            await sql`UPDATE sync_quarantine SET payload = jsonb_set(payload, '{seriesMediaId}', ${sql.json(kind === 'conflicting series' ? randomUUID() : 'bad')}::jsonb) WHERE id = ${f.warningId}`;
        if (kind === 'numeric id' || kind === 'malformed id')
            await sql`UPDATE sync_quarantine SET payload = jsonb_set(payload, '{matchedTmdbEpisodeId}', ${sql.json(kind === 'numeric id' ? 870001 : ' 870001')}::jsonb) WHERE id = ${f.warningId}`;
        if (kind === 'overflow season')
            await sql`UPDATE sync_quarantine SET payload = jsonb_set(payload, '{seasonNumber}', '2147483648') WHERE id = ${f.warningId}`;
        if (kind === 'negative episode' || kind === 'overflow episode')
            await sql`UPDATE sync_quarantine SET payload = jsonb_set(payload, '{episodeNumber}', ${sql.json(kind === 'negative episode' ? -1 : 2147483648)}) WHERE id = ${f.warningId}`;
        if (kind === 'empty title')
            await sql`UPDATE sync_quarantine SET payload = jsonb_set(payload, '{proposedTitle}', '""') WHERE id = ${f.warningId}`;
        if (kind === 'no candidate' || kind === 'ambiguous')
            await sql`UPDATE sync_quarantine SET reason = ${kind === 'no candidate' ? 'reconcile-backfill:below-threshold' : 'reconcile-backfill:duplicate-match'} WHERE id = ${f.warningId}`;
        if (kind === 'other provider')
            await sql`UPDATE sync_quarantine SET provider = 'absolute-numbering' WHERE id = ${f.warningId}`;
        const before = await preserved();
        expect((await recheckQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')).resolved).toBe(
            0,
        );
        expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
        expect(await preserved()).toEqual(before);
    });

    it.each([
        'title',
        'identity',
        'parent',
        'protection',
        'payload',
        'revival',
        'microsecond timestamp',
    ])('fences a concurrent %s edit on another connection', async (kind) => {
        const f = await seed();
        await sql`UPDATE sync_quarantine SET created_at = '2026-10-24 00:00:00.123456+00' WHERE id = ${f.warningId}`;
        seam.beforeLock = async (): Promise<void> => {
            if (kind === 'title')
                await rival`UPDATE media_items SET title = 'Edited' WHERE id = ${f.episodeId}`;
            if (kind === 'identity')
                await rival`UPDATE external_ids SET external_id = '870003' WHERE media_id = ${f.episodeId}`;
            if (kind === 'parent')
                await rival`UPDATE media_items SET parent_id = NULL WHERE id = ${f.episodeId}`;
            if (kind === 'protection')
                await rival`UPDATE media_items SET metadata_locked = true WHERE id = ${f.episodeId}`;
            if (kind === 'payload')
                await rival`UPDATE sync_quarantine SET payload = payload || '{"proposedTitle":"New warning"}' WHERE id = ${f.warningId}`;
            if (kind === 'microsecond timestamp')
                await rival`UPDATE sync_quarantine SET created_at = '2026-10-24 00:00:00.123457+00' WHERE id = ${f.warningId}`;
            if (kind === 'revival') {
                await rival`UPDATE sync_quarantine SET resolved_at = NOW() WHERE id = ${f.warningId}`;
                await rival`UPDATE sync_quarantine SET resolved_at = NULL WHERE id = ${f.warningId}`;
            }
        };
        expect((await recheckQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')).resolved).toBe(
            0,
        );
        expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
    });

    it.each(
        (['accept', 'backfill'] as const).flatMap((caller) =>
            (['episode', 'season', 'series'] as const).map((kind) => ({ caller, kind })),
        ),
    )(
        '$caller keeps a warning and identity when $kind protection commits after preview',
        async ({ caller, kind }) => {
            const f = await seed();
            await sql`UPDATE media_items SET title_binding = 'position', title = 'Old positional title' WHERE id = ${f.episodeId}`;
            await sql`UPDATE external_ids SET external_id = '870099', created_at = NOW() - INTERVAL '1 day' WHERE media_id = ${f.episodeId}`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${f.seriesId}, 'tmdb', '770099', 'tv')`;
            await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${f.fileId}, 0, 'The Decision', 0, 'file')`;
            seam.beforeEligibility = async (): Promise<void> => {
                await rival`UPDATE media_items SET metadata_locked = true WHERE id = ${kind === 'episode' ? f.episodeId : kind === 'season' ? f.seasonId : f.seriesId}`;
            };
            const result =
                caller === 'accept'
                    ? await acceptQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')
                    : await backfillReconcileSeries(sql, f.seriesId, {
                          minConfidence: 0.9,
                          actor: 'backfill',
                      });
            expect(result.appliedExternalIds).toBe(0);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
            const [identity] = await sql<
                { external_id: string }[]
            >`SELECT external_id FROM external_ids WHERE media_id = ${f.episodeId}`;
            expect(identity.external_id).toBe('870099');
        },
    );

    it.each(['accept', 'backfill'] as const)(
        '%s does not resolve a same-row warning rewritten during apply',
        async (caller) => {
            const f = await seed();
            await sql`UPDATE media_items SET title_binding = 'position', title = 'Old positional title' WHERE id = ${f.episodeId}`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${f.seriesId}, 'tmdb', '770099', 'tv')`;
            await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${f.fileId}, 0, 'The Decision', 0, 'file')`;
            seam.beforeEligibility = async (): Promise<void> => {
                await rival`UPDATE sync_quarantine SET payload = payload || '{"newEvidence":true}' WHERE id = ${f.warningId}`;
            };
            const result =
                caller === 'accept'
                    ? await acceptQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')
                    : await backfillReconcileSeries(sql, f.seriesId, {
                          minConfidence: 0.9,
                          actor: 'backfill',
                      });
            expect(result.appliedExternalIds).toBe(caller === 'accept' ? 0 : 1);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
        },
    );

    it.each(['accept', 'backfill'] as const)(
        '%s rolls back rejected identity writes without resolving warnings or counting applications',
        async (caller) => {
            const f = await seed();
            await sql`UPDATE media_items SET title_binding = 'position', title = 'Old positional title' WHERE id = ${f.episodeId}`;
            await sql`UPDATE external_ids SET external_id = '870099', created_at = NOW() - INTERVAL '1 day' WHERE media_id = ${f.episodeId}`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${f.seriesId}, 'tmdb', '770099', 'tv')`;
            await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${f.fileId}, 0, 'The Decision', 0, 'file')`;
            const { CatalogService } = await import('./catalog.service.js');
            const reject = vi
                .spyOn(CatalogService.prototype, 'upsertExternalId')
                .mockResolvedValueOnce(false);
            try {
                const result =
                    caller === 'accept'
                        ? await acceptQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')
                        : await backfillReconcileSeries(sql, f.seriesId, {
                              minConfidence: 0.9,
                              actor: 'backfill',
                          });
                expect(result.appliedExternalIds).toBe(0);
                expect(result.updatedTitles).toBe(0);
                expect(reject).toHaveBeenCalledOnce();
                expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
                const [identity] = await sql<
                    { external_id: string }[]
                >`SELECT external_id FROM external_ids WHERE media_id = ${f.episodeId}`;
                expect(identity.external_id).toBe('870099');
            } finally {
                reject.mockRestore();
            }
        },
    );

    it.each(['episode', 'season', 'series'] as const)(
        'retains a locked %s warning without changing any protection',
        async (kind) => {
            const f = await seed();
            const id =
                kind === 'episode' ? f.episodeId : kind === 'season' ? f.seasonId : f.seriesId;
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${id}`;
            const before = await preserved();
            expect(
                (await recheckQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')).resolved,
            ).toBe(0);
            expect(await preserved()).toEqual(before);
        },
    );

    it.each(['accept', 'backfill'] as const)(
        '%s keeps a superficially eligible file replacement and sibling edit',
        async (caller) => {
            const f = await seed();
            await sql`UPDATE media_items SET title_binding = 'position', title = 'Before' WHERE id = ${f.episodeId}`;
            await sql`UPDATE external_ids SET external_id = '870099', created_at = NOW() - INTERVAL '1 day' WHERE media_id = ${f.episodeId}`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${f.seriesId}, 'tmdb', '770099', 'tv')`;
            await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${f.fileId}, 0, 'The Decision', 0, 'file')`;
            seam.beforeEligibility = async (): Promise<void> => {
                const [{ id }] = await rival<
                    { id: string }[]
                >`INSERT INTO media_files (file_path) VALUES ('/test/replacement.mkv') RETURNING id`;
                await rival`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${id}, 0, 'The Decision', 0, 'file')`;
                await rival`UPDATE media_file_items SET file_id = ${id} WHERE media_item_id = ${f.episodeId}`;
            };
            const result =
                caller === 'accept'
                    ? await acceptQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')
                    : await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 });
            expect(result.appliedExternalIds).toBe(0);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
            const [identity] = await sql<
                { external_id: string }[]
            >`SELECT external_id FROM external_ids WHERE media_id = ${f.episodeId}`;
            expect(identity.external_id).toBe('870099');
        },
    );

    it('continues past ambiguous oldest rows and more than 1000 candidates despite shrinking results', async () => {
        const f = await seed();
        await sql`INSERT INTO sync_quarantine (provider, external_id, media_type, expected_series_id, reason, source, payload)
            SELECT 'lumastra-reconcile', gen_random_uuid()::text, 'episode', ${f.seriesId}, 'reconcile-backfill:matched', 'test', '{}' FROM generate_series(1, 1004)`;
        const first = await recheckQuarantinedMatchesForSeries(sql, f.seriesId, 'admin', {
            limit: 1000,
        });
        expect(first.examined).toBe(1000);
        expect(first.continuation).toBeDefined();
        const second = await recheckQuarantinedMatchesForSeries(sql, f.seriesId, 'admin', {
            limit: 1000,
            after: first.continuation,
        });
        expect(second.examined).toBe(5);
        expect(second.continuation).toBeUndefined();
        expect(first.resolved + second.resolved).toBe(1);
    });

    it.each(['accept', 'backfill'] as const)(
        '%s fences a changed series identity during provider I/O, including still writes',
        async (caller) => {
            const f = await seed();
            await sql`UPDATE media_items SET title_binding = 'position', title = 'Before' WHERE id = ${f.episodeId}`;
            await sql`UPDATE external_ids SET external_id = '870099', created_at = NOW() - INTERVAL '1 day' WHERE media_id = ${f.episodeId}`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${f.seriesId}, 'tmdb', '770099', 'tv')`;
            await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${f.fileId}, 0, 'The Decision', 0, 'file')`;
            seam.beforeProvider = async (): Promise<void> => {
                await rival`UPDATE external_ids SET external_id = '770100' WHERE media_id = ${f.seriesId}`;
            };
            const result =
                caller === 'accept'
                    ? await acceptQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')
                    : await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 });
            expect(result.appliedExternalIds).toBe(0);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
            expect(
                await sql`SELECT media_id FROM provider_metadata WHERE media_id = ${f.episodeId}`,
            ).toHaveLength(0);
            const [identity] = await sql<
                { external_id: string }[]
            >`SELECT external_id FROM external_ids WHERE media_id = ${f.episodeId}`;
            expect(identity.external_id).toBe('870099');
        },
    );

    it.each(['accept', 'backfill'] as const)(
        '%s preserves a fileless target holder changed on a separate connection',
        async (caller) => {
            const f = await seed();
            await sql`UPDATE media_items SET title_binding = 'position', title = 'Before' WHERE id = ${f.episodeId}`;
            await sql`UPDATE external_ids SET external_id = '870099', created_at = NOW() - INTERVAL '1 day' WHERE media_id = ${f.episodeId}`;
            const [{ id: holder }] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title, media_type, status, parent_id, season_number, episode_number) VALUES ('Holder', 'episode', 'active', ${f.seasonId}, 1, 2) RETURNING id`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, created_at) VALUES (${holder}, 'tmdb', '870001', 'episode', NOW() - INTERVAL '1 day'), (${f.seriesId}, 'tmdb', '770099', 'tv', NOW() - INTERVAL '1 day')`;
            await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${f.fileId}, 0, 'The Decision', 0, 'file')`;
            seam.beforeEligibility = async (): Promise<void> => {
                await rival`UPDATE media_items SET title = 'Changed Holder' WHERE id = ${holder}`;
                await rival`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${holder}, ${f.fileId}, true)`;
            };
            const result =
                caller === 'accept'
                    ? await acceptQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')
                    : await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 });
            expect(result.appliedExternalIds).toBe(0);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
            const ids = await sql<
                { media_id: string; external_id: string }[]
            >`SELECT media_id, external_id FROM external_ids WHERE media_id IN (${holder}, ${f.episodeId}) ORDER BY media_id`;
            expect(ids).toEqual(
                [
                    { media_id: f.episodeId, external_id: '870099' },
                    { media_id: holder, external_id: '870001' },
                ].sort((a, b) => a.media_id.localeCompare(b.media_id)),
            );
        },
    );

    it('Recheck does not lock unrelated episode rows in the same series', async () => {
        const f = await seed();
        const [{ id }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status, parent_id) VALUES ('Unrelated', 'episode', 'active', ${f.seasonId}) RETURNING id`;
        let ready!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            ready = resolve;
        });
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const holding = rival.begin(async (tx) => {
            await tx`SELECT id FROM media_items WHERE id = ${id} FOR UPDATE`;
            ready();
            await held;
        });
        await started;
        try {
            expect(
                (await recheckQuarantinedMatchesForSeries(sql, f.seriesId, 'admin', { limit: 1 }))
                    .resolved,
            ).toBe(1);
        } finally {
            release();
            await holding;
        }
    });

    it.each(
        (['accept', 'backfill'] as const).flatMap((caller) =>
            (['protection', 'title'] as const).map((kind) => ({ caller, kind })),
        ),
    )(
        '$caller preserves a partial permutation after a sibling $kind edit',
        async ({ caller, kind }) => {
            const f = await seed();
            await sql`UPDATE media_items SET title_binding = 'position', title = 'Before' WHERE id = ${f.episodeId}`;
            await sql`UPDATE external_ids SET external_id = '870002', created_at = NOW() - INTERVAL '1 day' WHERE media_id = ${f.episodeId}`;
            const [{ id: sibling }] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title, media_type, status, parent_id, season_number, episode_number) VALUES ('Sibling Before', 'episode', 'active', ${f.seasonId}, 1, 2) RETURNING id`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, created_at) VALUES (${sibling}, 'tmdb', '870001', 'episode', NOW() - INTERVAL '1 day'), (${f.seriesId}, 'tmdb', '770099', 'tv', NOW() - INTERVAL '1 day')`;
            await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${sibling}, ${f.fileId}, true)`;
            await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${f.fileId}, 0, 'The Decision', 0, 'file'), (${f.fileId}, 1, 'Second Decision', 10, 'file')`;
            seam.beforeEligibility = async (): Promise<void> => {
                if (kind === 'protection')
                    await rival`UPDATE media_items SET metadata_locked = true WHERE id = ${sibling}`;
                else
                    await rival`UPDATE media_items SET title = 'Changed positional title' WHERE id = ${sibling}`;
            };
            const result =
                caller === 'accept'
                    ? await acceptQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')
                    : await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 });
            expect(result.appliedExternalIds).toBe(0);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
            expect(
                await sql`SELECT external_id FROM external_ids WHERE media_id = ${f.episodeId}`,
            ).toEqual([{ external_id: '870002' }]);
            expect(
                await sql`SELECT external_id FROM external_ids WHERE media_id = ${sibling}`,
            ).toEqual([{ external_id: '870001' }]);
        },
    );

    it('traverses multiple shrinking pages of completed rows exactly once beyond 1000 rows', async () => {
        const f = await seed();
        await sql`WITH episodes AS (
            INSERT INTO media_items (title, title_binding, media_type, status, parent_id, season_number, episode_number)
            SELECT 'The Decision', 'identity', 'episode', 'active', ${f.seasonId}, 1, n FROM generate_series(2, 1006) n RETURNING id, episode_number
        ), identities AS (
            INSERT INTO external_ids (media_id, provider, external_id, media_type)
            SELECT id, 'tmdb', (880000+episode_number)::text, 'episode' FROM episodes
        ), links AS (
            INSERT INTO media_file_items (media_item_id, file_id, is_default) SELECT id, ${f.fileId}, true FROM episodes
        )
        INSERT INTO sync_quarantine (provider, external_id, media_type, expected_series_id, reason, source, payload)
        SELECT 'lumastra-reconcile', id::text, 'episode', ${f.seriesId}, 'reconcile-backfill:matched', 'test',
            jsonb_build_object('seasonNumber',1, 'episodeNumber',episode_number, 'matchedTmdbEpisodeId',(880000+episode_number)::text,'proposedTitle','The Decision') FROM episodes`;
        let after: string | undefined;
        let count = 0;
        const seen = new Set<string>();
        do {
            const result = await recheckQuarantinedMatchesForSeries(sql, f.seriesId, 'admin', {
                limit: 250,
                after,
            });
            count += result.examined;
            expect(result.resolved).toBe(result.examined);
            const rows = await sql<
                { id: string }[]
            >`SELECT id FROM sync_quarantine WHERE resolved_at IS NOT NULL`;
            expect(rows.length - seen.size).toBe(result.resolved);
            for (const row of rows) seen.add(row.id);
            after = result.continuation;
        } while (after);
        expect(count).toBe(1006);
        expect(seen.size).toBe(1006);
    });

    it('backfills existing bound stills alongside its own validated application', async () => {
        const f = await seed();
        await sql`UPDATE media_items SET title_binding = 'position', title = 'Before' WHERE id = ${f.episodeId}`;
        await sql`UPDATE external_ids SET external_id = '870099', created_at = NOW() - INTERVAL '1 day' WHERE media_id = ${f.episodeId}`;
        const [{ id: sibling }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, title_binding, media_type, status, parent_id, season_number, episode_number) VALUES ('Second Decision', 'identity', 'episode', 'active', ${f.seasonId}, 1, 2) RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${f.seriesId}, 'tmdb', '770099', 'tv'), (${sibling}, 'tmdb', '870002', 'episode')`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${sibling}, ${f.fileId}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${f.fileId}, 0, 'The Decision', 0, 'file'), (${f.fileId}, 1, 'Second Decision', 10, 'file')`;
        expect(
            (await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 }))
                .appliedExternalIds,
        ).toBe(1);
        expect(
            await sql`SELECT metadata->>'still_path' AS still FROM provider_metadata WHERE media_id = ${sibling} AND provider = 'tmdb'`,
        ).toEqual([{ still: '/second.jpg' }]);
    });

    it('backfill resolves actual applications hidden by duplicate demotion at the quarantine threshold', async () => {
        const f = await seed();
        await sql`UPDATE media_items SET title_binding = 'position', title = 'Before' WHERE id = ${f.episodeId}`;
        await sql`UPDATE external_ids SET external_id = '870099', created_at = NOW() - INTERVAL '1 day' WHERE media_id = ${f.episodeId}`;
        const [{ id: sibling }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status, parent_id, season_number, episode_number) VALUES ('Weak match', 'episode', 'active', ${f.seasonId}, 1, 2) RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${f.seriesId}, 'tmdb', '770099', 'tv')`;
        const [{ id: file }] = await sql<
            { id: string }[]
        >`INSERT INTO media_files (file_path) VALUES ('/test/weak.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${sibling}, ${file}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${f.fileId}, 0, 'The Decision', 0, 'file'), (${file}, 0, 'The Decisio', 0, 'file')`;
        const result = await backfillReconcileSeries(sql, f.seriesId, {
            minConfidence: 0.99,
            quarantineFloor: 0.5,
        });
        expect(result.appliedExternalIds).toBe(1);
        expect(result.resolvedQuarantineIds).toContain(f.warningId);
        expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).not.toBeNull();
    });

    it('backfill snapshots a prospective application warning after an arbitrary 1000-row prefix', async () => {
        const f = await seed();
        const last = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        await sql`UPDATE sync_quarantine SET id = ${last} WHERE id = ${f.warningId}`;
        await sql`INSERT INTO sync_quarantine (provider, external_id, media_type, expected_series_id, reason, source, payload)
            SELECT 'lumastra-reconcile', gen_random_uuid()::text, 'episode', ${f.seriesId}, 'reconcile-backfill:duplicate-match', 'test', '{}' FROM generate_series(1,1001)`;
        await sql`UPDATE media_items SET title_binding = 'position', title = 'Before' WHERE id = ${f.episodeId}`;
        await sql`UPDATE external_ids SET external_id = '870099', created_at = NOW() - INTERVAL '1 day' WHERE media_id = ${f.episodeId}`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${f.seriesId}, 'tmdb', '770099', 'tv')`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${f.fileId}, 0, 'The Decision', 0, 'file')`;
        const result = await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 });
        expect(result.appliedExternalIds).toBe(1);
        expect(result.resolvedQuarantineIds).toContain(last);
        expect((await getQuarantineById(sql, last))?.resolvedAt).not.toBeNull();
    });

    it('real backlog continuation passes a retained prefix on successive calls', async () => {
        const f = await seed();
        const last = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        await sql`UPDATE sync_quarantine SET id = ${last} WHERE id = ${f.warningId}`;
        const [{ id }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status, parent_id) VALUES ('Ambiguous', 'episode', 'active', ${f.seasonId}) RETURNING id`;
        await sql`INSERT INTO sync_quarantine (id, provider, external_id, media_type, expected_series_id, reason, source, payload) VALUES ('00000000-0000-4000-8000-000000000001', 'lumastra-reconcile', ${id}, 'episode', ${f.seriesId}, 'reconcile-backfill:duplicate-match', 'test', '{}')`;
        const first = await reevaluateQuarantineBacklog(sql, { cap: 1 });
        expect(first.rowsExamined).toBe(1);
        expect(first.reattached).toBe(0);
        expect(first.continuation).toBeDefined();
        const second = await reevaluateQuarantineBacklog(sql, {
            cap: 1,
            after: first.continuation,
        });
        expect(second.rowsExamined).toBe(1);
        expect(second.reattached).toBe(1);
        expect((await getQuarantineById(sql, last))?.resolvedAt).not.toBeNull();
    });

    it('groups every row beyond the former 5000-row cap, including malformed fallback payloads', async () => {
        const f = await seed();
        await sql`INSERT INTO sync_quarantine (provider, external_id, media_type, expected_series_id, reason, source, payload)
            SELECT 'lumastra-reconcile', gen_random_uuid()::text, 'episode', ${f.seriesId}, 'reconcile-backfill:below-threshold', 'test', '{}' FROM generate_series(1, 5001)`;
        await sql`INSERT INTO sync_quarantine (provider, external_id, media_type, reason, source, payload) VALUES ('jellyfin', 'unknown', 'episode', 'unknown', 'test', '{"seriesMediaId":"bad"}')`;
        const groups = await listUnresolvedQuarantineBySeries(sql);
        expect(groups.find((g) => g.seriesId === f.seriesId)?.totalUnresolved).toBe(5002);
        expect(groups.reduce((n, g) => n + g.totalUnresolved, 0)).toBe(5003);
    });
    async function makeApplicable(f: Fixture, chapter = 'The Decision'): Promise<void> {
        await sql`UPDATE media_items SET title_binding = 'position', title = 'Before' WHERE id = ${f.episodeId}`;
        await sql`UPDATE external_ids SET external_id = '870099', created_at = NOW() - INTERVAL '1 day' WHERE media_id = ${f.episodeId}`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${f.seriesId}, 'tmdb', '770099', 'tv')`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${f.fileId}, 0, ${chapter}, 0, 'file')`;
    }

    it('iteration2 previews and applies a complete permutation across a one-warning page', async () => {
        const f = await seed();
        await makeApplicable(f);
        await sql`UPDATE external_ids SET external_id = '870002' WHERE media_id = ${f.episodeId}`;
        const [{ id: second }] = await sql<{ id: string }[]>`INSERT INTO media_items
            (title, title_binding, media_type, status, parent_id, season_number, episode_number)
            VALUES ('Second before', 'position', 'episode', 'active', ${f.seasonId}, 1, 2) RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, created_at)
            VALUES (${second}, 'tmdb', '870001', 'episode', NOW() - INTERVAL '1 day')`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${second}, ${f.fileId}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
            VALUES (${f.fileId}, 1, 'Second Decision', 10, 'file')`;
        await sql`UPDATE sync_quarantine SET id = '00000000-0000-4000-8000-000000000001' WHERE id = ${f.warningId}`;
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: second,
            mediaType: 'episode',
            expectedSeriesId: f.seriesId,
            payload: {
                seriesMediaId: f.seriesId,
                seasonNumber: 1,
                episodeNumber: 2,
                matchedTmdbEpisodeId: '870002',
                proposedTitle: 'Second Decision',
            },
            reason: 'reconcile-backfill:matched',
            source: 'test',
        });
        const preview = await acceptService(sql, f.seriesId, 'admin', { limit: 1, preview: true });
        expect(preview.review).toHaveLength(2);
        expect(preview.appliedExternalIds).toBe(0);
        const before = await preserved();
        const unauthorized = await acceptService(sql, f.seriesId, 'admin', {
            limit: 1,
            reviewed: preview.review!.slice(0, 1),
            reviewedPage: preview.reviewedPage,
        });
        expect(unauthorized.appliedExternalIds).toBe(0);
        expect(await preserved()).toEqual(before);
        const result = await acceptService(sql, f.seriesId, 'admin', {
            limit: 1,
            reviewed: preview.review,
            reviewedPage: preview.reviewedPage,
        });
        expect(result.accepted).toBe(2);
        expect(result.appliedExternalIds).toBe(2);
        expect(
            await sql`SELECT media_id, external_id FROM external_ids WHERE media_type='episode' ORDER BY external_id`,
        ).toEqual([
            { media_id: f.episodeId, external_id: '870001' },
            { media_id: second, external_id: '870002' },
        ]);
    });

    it('iteration2 retains changed historical proposal rather than accepting its replacement', async () => {
        const f = await seed();
        await makeApplicable(f);
        await sql`UPDATE sync_quarantine SET payload = payload || '{"matchedTmdbEpisodeId":"870002","proposedTitle":"Second Decision"}' WHERE id = ${f.warningId}`;
        const before = await preserved();
        const preview = await acceptService(sql, f.seriesId, 'admin', { preview: true });
        expect(preview.review).toHaveLength(0);
        expect((await acceptService(sql, f.seriesId, 'admin', { reviewed: [] })).accepted).toBe(0);
        expect(await preserved()).toEqual(before);
        expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
    });

    it.each(['rewrite', 'revival'])(
        'iteration2 fences suspect warning %s on another connection',
        async (kind) => {
            const f = await seed();
            await makeApplicable(f, 'The Decisio');
            seam.beforeLock = async () => {
                if (kind === 'rewrite')
                    await rival`UPDATE sync_quarantine SET payload = payload || '{"newEvidence":true}' WHERE id=${f.warningId}`;
                else {
                    await rival`UPDATE sync_quarantine SET resolved_at=NOW() WHERE id=${f.warningId}`;
                    await rival`UPDATE sync_quarantine SET resolved_at=NULL WHERE id=${f.warningId}`;
                }
            };
            const result = await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.99 });
            expect(result.quarantined).toBe(0);
            expect((await getQuarantineById(sql, f.warningId))?.reason).toBe(
                'reconcile-backfill:matched',
            );
            if (kind === 'rewrite')
                expect((await getQuarantineById(sql, f.warningId))?.payload['newEvidence']).toBe(
                    true,
                );
        },
    );

    it('iteration2 does not stamp a completion watermark after ancillary evidence changes', async () => {
        const f = await seed();
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${f.seriesId},'tmdb','770099','tv')`;
        seam.beforeLock = async () => {
            await rival`UPDATE media_items SET title='Concurrent edit' WHERE id=${f.episodeId}`;
        };
        await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 });
        const [series] = await sql<
            { reconcile_backfill_at: Date | null }[]
        >`SELECT reconcile_backfill_at FROM media_items WHERE id=${f.seriesId}`;
        expect(series.reconcile_backfill_at).toBeNull();
        expect(
            await sql`SELECT media_id FROM provider_metadata WHERE media_id=${f.episodeId}`,
        ).toHaveLength(0);
    });

    it.each(['episode', 'season', 'series'])(
        'iteration2 skips missing still under inactive %s',
        async (kind) => {
            const f = await seed();
            await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${f.seriesId},'tmdb','770099','tv')`;
            await sql`UPDATE media_items SET status='deleted' WHERE id=${kind === 'episode' ? f.episodeId : kind === 'season' ? f.seasonId : f.seriesId}`;
            await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 });
            expect(
                await sql`SELECT media_id FROM provider_metadata WHERE media_id=${f.episodeId}`,
            ).toHaveLength(0);
        },
    );

    it.each(['match', 'mismatch', 'missing', 'wrong type'])(
        'iteration2 enforces dedicated parent_tmdb_id: %s',
        async (kind) => {
            const f = await seed();
            await sql`UPDATE sync_quarantine SET parent_tmdb_id='770099' WHERE id=${f.warningId}`;
            if (kind !== 'missing')
                await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type)
            VALUES (${f.seriesId},'tmdb',${kind === 'mismatch' ? '770098' : '770099'},${kind === 'wrong type' ? 'movie' : 'tv'})`;
            expect(
                (await recheckQuarantinedMatchesForSeries(sql, f.seriesId, 'admin')).resolved,
            ).toBe(kind === 'match' ? 1 : 0);
        },
    );

    it('iteration4 reports an inner-series backlog failure with its warning retained', async () => {
        const f = await seed();
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${f.seriesId},'tmdb','770099','tv')`;
        seam.beforeLock = async () => {
            throw new Error('actual inner-series lock failure');
        };
        expect(await reevaluateQuarantineBacklog(sql, { cap: 1 })).toMatchObject({
            failedSeries: 1,
            reattached: 0,
        });
        expect((await reevaluateQuarantineBacklog(sql, { cap: 1 })).rowsExamined).toBe(1);
    });
    it('iteration2 keeps provider snapshots immutable including entries and alt names', async () => {
        const f = await seed();
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${f.seriesId},'tmdb','770099','tv')`;
        const catalog = await loadTmdbCatalog(sql, f.seriesId);
        expect(() => {
            catalog[0].name = 'Forged';
        }).toThrow();
        expect(() => {
            catalog[0].altNames.push('Forged');
        }).toThrow();
        expect(() => {
            catalog.pop();
        }).toThrow();
    });

    it('iteration2 keeps a warning reviewed during provider I/O unchanged', async () => {
        const f = await seed();
        await makeApplicable(f, 'The Decisio');
        seam.beforeProvider = async () => {
            await rival`UPDATE sync_quarantine SET payload=payload || '{"operatorReview":true}' WHERE id=${f.warningId}`;
        };
        expect(
            (await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.99 })).quarantined,
        ).toBe(0);
        expect((await getQuarantineById(sql, f.warningId))?.payload['operatorReview']).toBe(true);
    });

    it('iteration2 keeps a newly inserted suspect warning rather than overwriting captured absence', async () => {
        const f = await seed();
        await makeApplicable(f, 'The Decisio');
        await sql`DELETE FROM sync_quarantine WHERE id=${f.warningId}`;
        seam.beforeProvider = async () => {
            await quarantineWrite(rival, {
                provider: 'lumastra-reconcile',
                externalId: f.episodeId,
                mediaType: 'episode',
                expectedSeriesId: f.seriesId,
                payload: { operatorReview: true },
                reason: 'reconcile-backfill:matched',
                source: 'operator',
            });
        };
        expect(
            (await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.99 })).quarantined,
        ).toBe(0);
        expect(
            await sql`SELECT source,payload FROM sync_quarantine WHERE external_id=${f.episodeId}`,
        ).toEqual([{ source: 'operator', payload: { operatorReview: true } }]);
    });

    it.each(['title', 'protection'])('iteration2 fences suspect media %s edits', async (kind) => {
        const f = await seed();
        await makeApplicable(f, 'The Decisio');
        seam.beforeLock = async () => {
            if (kind === 'title')
                await rival`UPDATE media_items SET title='Reviewed title' WHERE id=${f.episodeId}`;
            else await rival`UPDATE media_items SET metadata_locked=true WHERE id=${f.episodeId}`;
        };
        expect(
            (await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.99 })).quarantined,
        ).toBe(0);
        expect((await getQuarantineById(sql, f.warningId))?.reason).toBe(
            'reconcile-backfill:matched',
        );
    });

    it('iteration2 reports an ancillary database rejection and leaves no completion watermark', async () => {
        const f = await seed();
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${f.seriesId},'tmdb','770099','tv')`;
        await sql`CREATE FUNCTION pg_temp.quarantine_reject_still() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected ancillary database rejection'; END $$`;
        await sql`CREATE TRIGGER quarantine_reject_still BEFORE INSERT ON provider_metadata FOR EACH ROW EXECUTE FUNCTION pg_temp.quarantine_reject_still()`;
        try {
            await expect(
                backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 }),
            ).rejects.toThrow('injected ancillary database rejection');
            expect(
                await sql`SELECT reconcile_backfill_at FROM media_items WHERE id=${f.seriesId}`,
            ).toEqual([{ reconcile_backfill_at: null }]);
            expect(
                await sql`SELECT media_id FROM provider_metadata WHERE media_id=${f.episodeId}`,
            ).toHaveLength(0);
        } finally {
            await sql`DROP TRIGGER quarantine_reject_still ON provider_metadata`;
        }
    });

    it('iteration2 real Accept continuation reaches a later applicable decision after a retained prefix', async () => {
        const f = await seed();
        await makeApplicable(f);
        await sql`UPDATE sync_quarantine SET id='ffffffff-ffff-4fff-8fff-ffffffffffff' WHERE id=${f.warningId}`;
        await sql`INSERT INTO sync_quarantine (id,provider,external_id,media_type,expected_series_id,reason,source,payload)
            VALUES ('00000000-0000-4000-8000-000000000001','lumastra-reconcile','not-an-episode','episode',${f.seriesId},'reconcile-backfill:matched','test','{}')`;
        const first = await acceptService(sql, f.seriesId, 'admin', { limit: 1, preview: true });
        expect(first.review).toHaveLength(0);
        expect(first.continuation).toBeDefined();
        const firstApplied = await acceptService(sql, f.seriesId, 'admin', {
            limit: 1,
            reviewed: first.review,
            reviewedPage: first.reviewedPage,
        });
        expect(firstApplied.accepted).toBe(0);
        expect(firstApplied.continuation).toBe(first.continuation);
        const second = await acceptService(sql, f.seriesId, 'admin', {
            limit: 1,
            after: first.continuation,
            preview: true,
        });
        expect(second.review).toHaveLength(1);
        const result = await acceptService(sql, f.seriesId, 'admin', {
            limit: 1,
            after: first.continuation,
            reviewed: second.review,
            reviewedPage: second.reviewedPage,
        });
        expect(result.accepted).toBe(1);
    });
    it('iteration2 exposes oversized dependency decisions for bounded review without applying an unreviewed component', async () => {
        const f = await seed();
        await sql`DELETE FROM sync_quarantine WHERE id=${f.warningId}`;
        await sql`DELETE FROM media_items WHERE id=${f.episodeId}`;
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${f.seriesId},'tmdb','770099','tv')`;
        const size = 1001;
        seam.catalog = Array.from({ length: size }, (_, i) => ({
            id: 880001 + i,
            name: `Decision ${i + 1}`,
            seasonNumber: 1,
            episodeNumber: i + 1,
            stillPath: '',
        }));
        await sql`WITH episodes AS (
            INSERT INTO media_items (title,title_binding,media_type,status,parent_id,season_number,episode_number)
            SELECT 'Before','position','episode','active',${f.seasonId},1,n FROM generate_series(1,${size}) n RETURNING id,episode_number
        ), identities AS (
            INSERT INTO external_ids(media_id,provider,external_id,media_type,created_at)
            SELECT id,'tmdb',(880001+(episode_number % ${size}))::text,'episode',NOW()-INTERVAL '1 day' FROM episodes
        ), links AS (
            INSERT INTO media_file_items(media_item_id,file_id,is_default) SELECT id,${f.fileId},true FROM episodes
        ) INSERT INTO sync_quarantine(provider,external_id,media_type,expected_series_id,reason,source,payload)
            SELECT 'lumastra-reconcile',id::text,'episode',${f.seriesId},'reconcile-backfill:matched','test',
                jsonb_build_object('seriesMediaId',${f.seriesId}::text,'seasonNumber',1,'episodeNumber',episode_number,
                    'matchedTmdbEpisodeId',(880000+episode_number)::text,'proposedTitle','Decision '||episode_number) FROM episodes`;
        await sql`INSERT INTO episode_chapters(file_id,chapter_index,chapter_name,start_ticks,source)
            SELECT ${f.fileId},n-1,'Decision '||n,n*10,'file' FROM generate_series(1,${size}) n`;
        const before = await preserved();
        const first = await acceptService(sql, f.seriesId, 'admin', { limit: 1, preview: true });
        expect(first.review).toHaveLength(0);
        expect(first.blockedReview).toHaveLength(1);
        expect(first.continuation).toBeDefined();
        const second = await acceptService(sql, f.seriesId, 'admin', {
            limit: 1,
            after: first.continuation,
            preview: true,
        });
        expect(second.review).toHaveLength(0);
        expect(second.blockedReview).toHaveLength(1);
        expect(second.blockedReview![0].episodeId).not.toBe(first.blockedReview![0].episodeId);
        expect(
            (await acceptService(sql, f.seriesId, 'admin', { limit: 1, reviewed: [] }))
                .appliedExternalIds,
        ).toBe(0);
        expect(await preserved()).toEqual(before);
    });
    it('iteration2 preserves a still committed between the ancillary missing-still read and write', async () => {
        const f = await seed();
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${f.seriesId},'tmdb','770099','tv')`;
        await sql`INSERT INTO provider_metadata (media_id,provider,metadata,fetched_at) VALUES (${f.episodeId},'tmdb','{}',NOW())`;
        const [{ pid }] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        const observer = postgres(url, { max: 1, onnotice: () => {} });
        let release!: () => void;
        let ready!: () => void;
        const hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        const started = new Promise<void>((resolve) => {
            ready = resolve;
        });
        const writer = rival.begin(async (tx) => {
            await tx`UPDATE provider_metadata SET metadata='{"still_path":"/latest-user-still.jpg"}' WHERE media_id=${f.episodeId} AND provider='tmdb'`;
            ready();
            await hold;
        });
        await started;
        const operation = backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 });
        try {
            let waiting = false;
            for (let attempt = 0; attempt < 500; attempt++) {
                const [row] = await observer<
                    { waiting: boolean }[]
                >`SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=${pid}`;
                if (row?.waiting) {
                    waiting = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(waiting).toBe(true);
            release();
            await writer;
            await operation;
            expect(
                await sql`SELECT metadata->>'still_path' AS still FROM provider_metadata WHERE media_id=${f.episodeId} AND provider='tmdb'`,
            ).toEqual([{ still: '/latest-user-still.jpg' }]);
        } finally {
            release();
            await Promise.allSettled([writer, operation]);
            await observer.end();
        }
    });
    it.each(['fileless', 'file-backed'] as const)(
        'iteration3 retains stable unreviewed %s identity holders',
        async (kind) => {
            const f = await seed();
            await makeApplicable(f);
            const [{ id: holder }] = await sql<{ id: string }[]>`INSERT INTO media_items
            (title,title_binding,media_type,status,parent_id,season_number,episode_number)
            VALUES ('Unreviewed holder','position','episode','active',${f.seasonId},1,2) RETURNING id`;
            await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type,created_at)
            VALUES (${holder},'tmdb','870001','episode',NOW()-INTERVAL '1 day')`;
            if (kind === 'file-backed') {
                const [{ id: file }] = await sql<
                    { id: string }[]
                >`INSERT INTO media_files(file_path) VALUES('/test/unmatchable.mkv') RETURNING id`;
                await sql`INSERT INTO media_file_items(media_item_id,file_id,is_default) VALUES (${holder},${file},true)`;
            }
            const before = await preserved();
            const preview = await acceptService(sql, f.seriesId, 'admin', { preview: true });
            expect(preview.review).toHaveLength(0);
            expect(preview.blocked).toBe(1);
            const result = await acceptService(sql, f.seriesId, 'admin', {
                reviewed: preview.review,
                reviewedPage: preview.reviewedPage,
            });
            expect(result).toMatchObject({
                accepted: 0,
                appliedExternalIds: 0,
                examined: 1,
                blocked: 1,
                skipped: 0,
            });
            expect(await preserved()).toEqual(before);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
        },
    );

    it.each(['overview', 'stillPath'] as const)(
        'iteration3 binds provider %s values to confirmation',
        async (field) => {
            const f = await seed();
            await makeApplicable(f);
            const preview = await acceptService(sql, f.seriesId, 'admin', { preview: true });
            expect(preview.review).toHaveLength(1);
            seam.catalog = [
                {
                    id: 870001,
                    name: 'The Decision',
                    seasonNumber: 1,
                    episodeNumber: 1,
                    stillPath: '/decision.jpg',
                    ...{ [field]: field === 'overview' ? 'Changed overview' : '/changed.jpg' },
                },
            ];
            const before = await preserved();
            const result = await acceptService(sql, f.seriesId, 'admin', {
                reviewed: preview.review,
                reviewedPage: preview.reviewedPage,
            });
            expect(result).toMatchObject({ accepted: 0, appliedExternalIds: 0, pageChanged: true });
            expect(result.continuation).toBeUndefined();
            expect(await preserved()).toEqual(before);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
        },
    );

    it('iteration3 keeps the exact preview page when another connection resolves a seed', async () => {
        const f = await seed();
        await makeApplicable(f);
        await sql`UPDATE sync_quarantine SET id='00000000-0000-4000-8000-000000000001' WHERE id=${f.warningId}`;
        await sql`INSERT INTO sync_quarantine(id,provider,external_id,media_type,expected_series_id,reason,source,payload)
            VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff','lumastra-reconcile','unreviewed','episode',${f.seriesId},'reconcile-backfill:matched','test','{}')`;
        const preview = await acceptService(sql, f.seriesId, 'admin', { preview: true, limit: 1 });
        await rival`UPDATE sync_quarantine SET resolved_at=NOW(),resolved_by='other-admin' WHERE id='00000000-0000-4000-8000-000000000001'`;
        const before = await preserved();
        const result = await acceptService(sql, f.seriesId, 'admin', {
            limit: 1,
            reviewed: preview.review,
            reviewedPage: preview.reviewedPage,
        });
        expect(result).toMatchObject({
            accepted: 0,
            appliedExternalIds: 0,
            pageChanged: true,
            examined: 0,
        });
        expect(result.continuation).toBeUndefined();
        expect(await preserved()).toEqual(before);
        expect(
            await sql`SELECT resolved_at FROM sync_quarantine WHERE external_id='unreviewed'`,
        ).toEqual([{ resolved_at: null }]);
        const next = await acceptService(sql, f.seriesId, 'admin', { preview: true, limit: 1 });
        expect(next.reviewedPage?.ids).toEqual(['ffffffff-ffff-4fff-8fff-ffffffffffff']);
    });

    it.each(['payload', 'revival'] as const)(
        'iteration3 fences %s between completed preview and confirmation',
        async (kind) => {
            const f = await seed();
            await makeApplicable(f);
            const preview = await acceptService(sql, f.seriesId, 'admin', { preview: true });
            if (kind === 'payload')
                await rival`UPDATE sync_quarantine SET payload=payload || '{"extra":"rewritten"}' WHERE id=${f.warningId}`;
            else {
                await rival`UPDATE sync_quarantine SET resolved_at=NOW() WHERE id=${f.warningId}`;
                await rival`UPDATE sync_quarantine SET resolved_at=NULL WHERE id=${f.warningId}`;
            }
            const before = await preserved();
            const result = await acceptService(sql, f.seriesId, 'admin', {
                reviewed: preview.review,
                reviewedPage: preview.reviewedPage,
            });
            expect(result).toMatchObject({ accepted: 0, appliedExternalIds: 0, pageChanged: true });
            expect(await preserved()).toEqual(before);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
        },
    );

    it.each([
        'season-number',
        'season-lock',
        'series-lock',
        'inactive-season',
        'inactive-series',
    ] as const)('iteration3 preview truthfully blocks %s', async (kind) => {
        const f = await seed();
        await makeApplicable(f);
        if (kind === 'season-number')
            await sql`UPDATE media_items SET season_number=2 WHERE id=${f.seasonId}`;
        if (kind === 'season-lock' || kind === 'series-lock')
            await sql`UPDATE media_items SET metadata_locked=true WHERE id=${kind === 'season-lock' ? f.seasonId : f.seriesId}`;
        if (kind === 'inactive-season' || kind === 'inactive-series')
            await sql`UPDATE media_items SET status='deleted' WHERE id=${kind === 'inactive-season' ? f.seasonId : f.seriesId}`;
        const before = await preserved();
        const preview = await acceptService(sql, f.seriesId, 'admin', { preview: true });
        expect(preview.review).toHaveLength(0);
        expect(preview).toMatchObject({ examined: 1, blocked: 1 });
        expect(await preserved()).toEqual(before);
    });

    it('iteration3 accounts for every matched, below-threshold and duplicate seed exactly once', async () => {
        const f = await seed();
        await makeApplicable(f);
        await sql`INSERT INTO sync_quarantine(provider,external_id,media_type,expected_series_id,reason,source,payload)
            VALUES ('lumastra-reconcile','low','episode',${f.seriesId},'reconcile-backfill:below-threshold','test','{}'),
                   ('lumastra-reconcile','duplicate','episode',${f.seriesId},'reconcile-backfill:duplicate-match','test','{}')`;
        const preview = await acceptService(sql, f.seriesId, 'admin', { preview: true });
        expect(preview).toMatchObject({ examined: 3, blocked: 2 });
        expect(preview.review).toHaveLength(1);
        const result = await acceptService(sql, f.seriesId, 'admin', {
            reviewed: preview.review,
            reviewedPage: preview.reviewedPage,
        });
        expect(result).toMatchObject({ examined: 3, accepted: 1, blocked: 2, skipped: 0 });
        const retained = await acceptService(sql, f.seriesId, 'admin', { preview: true });
        expect(retained).toMatchObject({ examined: 2, blocked: 2 });
        expect(retained.review).toHaveLength(0);
    });

    it.each([false, true])(
        'iteration3 accounts for malformed media warnings by warning ID (paged=%s)',
        async (paged) => {
            const f = await seed();
            await makeApplicable(f);
            const malformedId = '00000000-0000-4000-8000-000000000001';
            await sql`UPDATE sync_quarantine SET id='ffffffff-ffff-4fff-8fff-ffffffffffff' WHERE id=${f.warningId}`;
            await sql`INSERT INTO sync_quarantine(id,provider,external_id,media_type,expected_series_id,reason,source,payload)
            SELECT ${malformedId},provider,external_id,'movie',expected_series_id,reason,source,payload FROM sync_quarantine WHERE external_id=${f.episodeId} AND media_type='episode'`;
            const malformedBefore = await getQuarantineById(sql, malformedId);
            const before = await preserved();
            const preview = await acceptService(sql, f.seriesId, 'admin', {
                preview: true,
                ...(paged ? { limit: 1 } : {}),
            });
            expect(preview).toMatchObject({ examined: paged ? 1 : 2, blocked: 1 });
            expect(preview.review).toHaveLength(paged ? 0 : 1);
            const result = await acceptService(sql, f.seriesId, 'admin', {
                ...(paged ? { limit: 1 } : {}),
                reviewed: preview.review,
                reviewedPage: preview.reviewedPage,
            });
            expect(result).toMatchObject({
                examined: paged ? 1 : 2,
                accepted: paged ? 0 : 1,
                blocked: 1,
                skipped: 0,
            });
            if (paged) {
                expect(await preserved()).toEqual(before);
                expect(preview.continuation).toBeDefined();
                const next = await acceptService(sql, f.seriesId, 'admin', {
                    preview: true,
                    limit: 1,
                    after: preview.continuation,
                });
                expect(next.review).toHaveLength(1);
                expect(
                    await acceptService(sql, f.seriesId, 'admin', {
                        limit: 1,
                        after: preview.continuation,
                        reviewed: next.review,
                        reviewedPage: next.reviewedPage,
                    }),
                ).toMatchObject({ examined: 1, accepted: 1, blocked: 0, skipped: 0 });
            }
            expect(await getQuarantineById(sql, malformedId)).toEqual(malformedBefore);
        },
    );

    it('iteration3 applies the unchanged complete provider write plan shown in confirmation', async () => {
        const f = await seed();
        await makeApplicable(f);
        seam.catalog = [
            {
                id: 870001,
                name: 'The Decision',
                seasonNumber: 1,
                episodeNumber: 1,
                overview: 'Reviewed overview',
                stillPath: '/reviewed.jpg',
            },
        ];
        const preview = await acceptService(sql, f.seriesId, 'admin', { preview: true });
        expect(preview.review?.[0]).toMatchObject({
            episodeId: f.episodeId,
            currentTitle: 'Before',
            currentTmdbEpisodeId: '870099',
            title: 'The Decision',
            tmdbEpisodeId: '870001',
            overview: 'Reviewed overview',
            stillPath: '/reviewed.jpg',
        });
        const result = await acceptService(sql, f.seriesId, 'admin', {
            reviewed: preview.review,
            reviewedPage: preview.reviewedPage,
        });
        expect(result).toMatchObject({
            accepted: 1,
            appliedExternalIds: 1,
            updatedTitles: 1,
            examined: 1,
            blocked: 0,
            skipped: 0,
        });
        expect(
            await sql`SELECT title,overview,title_binding FROM media_items WHERE id=${f.episodeId}`,
        ).toEqual([
            { title: 'The Decision', overview: 'Reviewed overview', title_binding: 'identity' },
        ]);
        expect(
            await sql`SELECT metadata->>'still_path' AS still FROM provider_metadata WHERE media_id=${f.episodeId} AND provider='tmdb'`,
        ).toEqual([{ still: '/reviewed.jpg' }]);
    });
    it.each([
        ['retained', 'provider'],
        ['actionable', 'provider'],
        ['retained', 'locks'],
        ['actionable', 'locks'],
    ] as const)(
        'iteration4 invalidates the complete reviewed page when its %s seed changes during %s',
        async (kind, stage) => {
            const f = await seed();
            await makeApplicable(f);
            const extra = randomUUID();
            if (kind === 'retained')
                await sql`INSERT INTO sync_quarantine (id,provider,external_id,media_type,expected_series_id,reason,source,payload)
                    VALUES (${extra},'lumastra-reconcile',${randomUUID()},'episode',${f.seriesId},'reconcile-backfill:below-threshold','test','{}')`;
            const preview = await acceptService(sql, f.seriesId, 'admin', { preview: true });
            expect(preview.review).toHaveLength(1);
            seam[stage === 'provider' ? 'beforeProvider' : 'beforeLock'] = async () => {
                await rival`UPDATE sync_quarantine SET source='independent edit' WHERE id=${kind === 'retained' ? extra : f.warningId}`;
            };
            const before = await preserved();
            const result = await acceptService(sql, f.seriesId, 'admin', {
                reviewed: preview.review,
                reviewedPage: preview.reviewedPage,
            });
            expect(result).toMatchObject({ accepted: 0, pageChanged: true });
            expect(result.continuation).toBeUndefined();
            expect(await preserved()).toEqual(before);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
        },
    );

    it.each(['accept', 'backfill'] as const)(
        'iteration4 fences consumed audio language edits during %s provider loading',
        async (caller) => {
            const f = await seed();
            await makeApplicable(f);
            await sql`INSERT INTO media_streams (file_id,stream_type,stream_index,language) VALUES (${f.fileId},'audio',0,'de')`;
            const preview =
                caller === 'accept'
                    ? await acceptService(sql, f.seriesId, 'admin', { preview: true })
                    : undefined;
            seam.beforeProvider = async () => {
                await rival`UPDATE media_streams SET language='fr' WHERE file_id=${f.fileId} AND stream_type='audio'`;
            };
            const before = await preserved();
            const result =
                caller === 'accept'
                    ? await acceptService(sql, f.seriesId, 'admin', {
                          reviewed: preview!.review,
                          reviewedPage: preview!.reviewedPage,
                      })
                    : await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 });
            expect(result.appliedExternalIds).toBe(0);
            expect(result.updatedTitles).toBe(0);
            expect(await preserved()).toEqual(before);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
        },
    );

    it('iteration4 binds an existing metadata edit to the reviewed authorization', async () => {
        const f = await seed();
        await makeApplicable(f);
        await sql`INSERT INTO provider_metadata (media_id,provider,metadata,fetched_at) VALUES (${f.episodeId},'tmdb','{}',NOW())`;
        const preview = await acceptService(sql, f.seriesId, 'admin', { preview: true });
        await rival`UPDATE provider_metadata SET metadata='{"still_path":"/admin-choice.jpg"}' WHERE media_id=${f.episodeId} AND provider='tmdb'`;
        const before = await preserved();
        const result = await acceptService(sql, f.seriesId, 'admin', {
            reviewed: preview.review,
            reviewedPage: preview.reviewedPage,
        });
        expect(result.appliedExternalIds).toBe(0);
        expect(await preserved()).toEqual(before);
        expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
    });

    it.each(['empty', 'retained'] as const)(
        'iteration4 avoids providers for an entirely %s reviewed page',
        async (kind) => {
            const f = await seed();
            await makeApplicable(f);
            if (kind === 'empty') await sql`DELETE FROM sync_quarantine WHERE id=${f.warningId}`;
            else
                await sql`UPDATE sync_quarantine SET reason='reconcile-backfill:below-threshold' WHERE id=${f.warningId}`;
            seam.forbidProviders = true;
            const preview = await acceptService(sql, f.seriesId, 'admin', { preview: true });
            const result = await acceptService(sql, f.seriesId, 'admin', {
                reviewed: preview.review,
                reviewedPage: preview.reviewedPage,
            });
            expect(result.accepted).toBe(0);
            expect(result.examined).toBe(kind === 'empty' ? 0 : 1);
            expect(seam.providerCalls).toBe(0);
        },
    );

    it.each(['accept', 'backfill'] as const)(
        'iteration4 fences the scoped library language during %s provider loading',
        async (caller) => {
            const f = await seed();
            await makeApplicable(f);
            const [{ id: groupId }] = await sql<
                { id: string }[]
            >`INSERT INTO library_groups (name) VALUES (${randomUUID()}) RETURNING id`;
            await sql`UPDATE media_items SET library_group_id=${groupId} WHERE id=${f.seriesId}`;
            await sql`INSERT INTO library_paths (path,media_type,language,library_group_id) VALUES (${`/fixtures/${randomUUID()}`},'tv','de',${groupId})`;
            const preview =
                caller === 'accept'
                    ? await acceptService(sql, f.seriesId, 'admin', { preview: true })
                    : undefined;
            seam.beforeProvider = async () => {
                await rival`UPDATE library_paths SET language='fr' WHERE library_group_id=${groupId}`;
            };
            const before = await preserved();
            const result =
                caller === 'accept'
                    ? await acceptService(sql, f.seriesId, 'admin', {
                          reviewed: preview!.review,
                          reviewedPage: preview!.reviewedPage,
                      })
                    : await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 });
            expect(result.appliedExternalIds).toBe(0);
            expect(await preserved()).toEqual(before);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
        },
    );

    it('iteration4 advances independent backlog pages, retains persistent failures and retries them after wrapping', async () => {
        const first = await seed();
        await sql`UPDATE sync_quarantine SET id='00000000-0000-4000-8000-000000000001' WHERE id=${first.warningId}`;
        const second = await seed('870002', 'Second Decision');
        await sql`UPDATE sync_quarantine SET id='ffffffff-ffff-4fff-8fff-ffffffffffff',payload=jsonb_set(jsonb_set(payload,'{proposedTitle}','"Second Decision"'),'{matchedTmdbEpisodeId}','"870002"') WHERE id=${second.warningId}`;
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${first.seriesId},'tmdb','770001','tv'), (${second.seriesId},'tmdb','770002','tv')`;
        await sql`UPDATE media_items SET title='Persistent failure fixture' WHERE id=${first.seriesId}`;
        await sql`CREATE FUNCTION pg_temp.quarantine_persistent_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Persistent real database series failure'; END $$`;
        await sql`CREATE TRIGGER quarantine_persistent_failure BEFORE UPDATE ON media_items FOR EACH ROW WHEN (OLD.title = 'Persistent failure fixture') EXECUTE FUNCTION pg_temp.quarantine_persistent_failure()`;
        try {
            const start = await reevaluateQuarantineBacklog(sql, { cap: 1 });
            expect(start).toMatchObject({ rowsExamined: 1, failedSeries: 1, reattached: 0 });
            expect(start.continuation).toBe('00000000-0000-4000-8000-000000000001');
            const tail = await reevaluateQuarantineBacklog(sql, {
                cap: 1,
                after: start.continuation,
            });
            expect(tail).toMatchObject({ reattached: 1, failedSeries: 0 });
            expect(tail.continuation).toBeUndefined();
            const failedAgain = await reevaluateQuarantineBacklog(sql, { cap: 1 });
            expect(failedAgain).toMatchObject({ failedSeries: 1, reattached: 0 });
            await sql`DROP TRIGGER quarantine_persistent_failure ON media_items`;
            const recovered = await reevaluateQuarantineBacklog(sql, { cap: 1 });
            expect(recovered).toMatchObject({ failedSeries: 0, reattached: 1 });
            expect(
                (await getQuarantineById(sql, '00000000-0000-4000-8000-000000000001'))?.resolvedAt,
            ).not.toBeNull();
        } finally {
            await sql`DROP TRIGGER IF EXISTS quarantine_persistent_failure ON media_items`;
        }
    });

    it('iteration4 proves the existing media locks fence an artwork edit strictly after the ancillary missing-still read', async () => {
        const f = await seed();
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${f.seriesId},'tmdb','770099','tv')`;
        await sql`INSERT INTO provider_metadata (media_id,provider,metadata,fetched_at) VALUES (${f.episodeId},'tmdb','{}',NOW())`;
        let writer: Promise<unknown> | undefined;
        let writerOutcome: 'committed' | 'blocked' | 'failed' = 'blocked';
        let writerError: unknown;
        seam.beforeMetadataWrite = async () => {
            // This seam is entered only AFTER needStill was selected. The rival
            // uses its own real connection and the existing row really is empty.
            expect(
                await rival`SELECT metadata FROM provider_metadata WHERE media_id=${f.episodeId}`,
            ).toEqual([{ metadata: {} }]);
            writer = rival
                .begin(async (tx) => {
                    await tx`SELECT set_config('lock_timeout', '500ms', true)`;
                    await tx`UPDATE provider_metadata SET metadata='{"still_path":"/after-read.jpg"}' WHERE media_id=${f.episodeId} AND provider='tmdb'`;
                })
                .then(
                    () => {
                        writerOutcome = 'committed';
                    },
                    (error: unknown) => {
                        writerOutcome = 'failed';
                        writerError = error;
                    },
                );
            await writer;
        };
        await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 });
        await writer;
        expect(writerOutcome).toBe('failed');
        expect(writerError).toMatchObject({ code: '55P03' });
        expect(
            await sql`SELECT metadata->>'still_path' AS still FROM provider_metadata WHERE media_id=${f.episodeId} AND provider='tmdb'`,
        ).toEqual([{ still: '/decision.jpg' }]);
        // After the validated backfill commits, the independent edit succeeds
        // and remains visible. No missing-still overwrite patch is justified.
        await rival`UPDATE provider_metadata SET metadata='{"still_path":"/after-read.jpg"}' WHERE media_id=${f.episodeId} AND provider='tmdb'`;
        expect(
            await sql`SELECT metadata->>'still_path' AS still FROM provider_metadata WHERE media_id=${f.episodeId} AND provider='tmdb'`,
        ).toEqual([{ still: '/after-read.jpg' }]);
    });

    it.each(['retained-only', 'ordinary-no-action', 'missing-catalog'] as const)(
        'iteration4 fences a changed %s page even without an actionable proposal',
        async (kind) => {
            const f = await seed();
            if (kind === 'retained-only')
                await sql`UPDATE sync_quarantine SET reason='reconcile-backfill:below-threshold' WHERE id=${f.warningId}`;
            if (kind !== 'missing-catalog')
                await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${f.seriesId},'tmdb','770099','tv')`;
            const preview = await acceptService(sql, f.seriesId, 'admin', { preview: true });
            expect(preview.review).toHaveLength(0);
            seam.beforeWarningFence = async () => {
                await rival`UPDATE sync_quarantine SET source='changed no-action page' WHERE id=${f.warningId}`;
            };
            const before = await preserved();
            const result = await acceptService(sql, f.seriesId, 'admin', {
                reviewed: preview.review,
                reviewedPage: preview.reviewedPage,
            });
            expect(result).toMatchObject({ pageChanged: true, accepted: 0 });
            expect(result.continuation).toBeUndefined();
            expect(await preserved()).toEqual(before);
        },
    );

    it('iteration4 caches shared missing dependencies per request and preserves an independently valid suffix', async () => {
        const f = await seed();
        await makeApplicable(f);
        const later: string[] = [];
        for (const [number, title] of [
            [2, 'Second Decision'],
            [3, 'Third Decision'],
        ] as const) {
            const [{ id }] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title,title_binding,media_type,status,parent_id,season_number,episode_number)
                VALUES (${`Before ${number}`},'position','episode','active',${f.seasonId},1,${number}) RETURNING id`;
            later.push(id);
            await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type,created_at) VALUES (${id},'tmdb',${String(869999 + number)},'episode',NOW()-INTERVAL '1 day')`;
            await sql`INSERT INTO media_file_items (media_item_id,file_id,is_default) VALUES (${id},${f.fileId},true)`;
            await sql`INSERT INTO episode_chapters (file_id,chapter_index,chapter_name,start_ticks,source) VALUES (${f.fileId},${number - 1},${title},${number * 100000000},'file')`;
        }
        const writeWarning = async (id: string, number: number, title: string): Promise<void> => {
            await quarantineWrite(sql, {
                provider: 'lumastra-reconcile',
                externalId: id,
                mediaType: 'episode',
                expectedSeriesId: f.seriesId,
                reason: 'reconcile-backfill:matched',
                source: 'test',
                payload: {
                    seriesMediaId: f.seriesId,
                    seasonNumber: 1,
                    episodeNumber: number,
                    proposedTitle: title,
                    matchedTmdbEpisodeId: String(870000 + number),
                },
            });
        };
        await writeWarning(later[0], 2, 'Second Decision');
        seam.catalog = [1, 2, 3].map((number) => ({
            id: 870000 + number,
            name: ['The Decision', 'Second Decision', 'Third Decision'][number - 1],
            seasonNumber: 1,
            episodeNumber: number,
            stillPath: `/decision-${number}.jpg`,
        }));
        const blocked = await acceptService(sql, f.seriesId, 'admin', { preview: true });
        expect(blocked.review).toHaveLength(0);
        expect(blocked.blocked).toBe(2);
        expect(blocked.blockedReview?.map((entry) => entry.blockingEpisodeId)).toEqual([
            later[1],
            later[1],
        ]);
        expect(seam.warningReads).toBe(2); // one seed query + one known-absent dependency
        await writeWarning(later[1], 3, 'Changed historical decision');
        const changedDependency = await acceptService(sql, f.seriesId, 'admin', { preview: true });
        expect(
            changedDependency.blockedReview?.find((entry) => entry.episodeId === f.episodeId),
        ).toEqual(
            expect.objectContaining({
                episodeId: f.episodeId,
                reason: 'changed-proposal',
                blockingEpisodeId: later[1],
            }),
        );
        await sql`UPDATE sync_quarantine SET payload=jsonb_set(payload,'{proposedTitle}','"Third Decision"') WHERE external_id=${later[1]}`;
        await sql`UPDATE sync_quarantine SET payload=jsonb_set(payload,'{proposedTitle}','"Changed historical decision"') WHERE id=${f.warningId}`;
        seam.warningReads = 0;
        const suffix = await acceptService(sql, f.seriesId, 'admin', { preview: true });
        expect(suffix.blocked).toBe(1);
        expect(suffix.review?.map((entry) => entry.episodeId).sort()).toEqual([...later].sort());
        expect(seam.warningReads).toBe(1);
    });
    it.each(['recheck', 'accept-matched', 'accept-ineligible'] as const)(
        'iteration5 retains arbitrary JSON and reaches later decisions through %s',
        async (caller) => {
            const f = await seed();
            if (caller !== 'recheck') await makeApplicable(f);
            await sql`UPDATE sync_quarantine SET id='ffffffff-ffff-4fff-8fff-ffffffffffff' WHERE id=${f.warningId}`;
            const payloads = [
                null,
                [],
                'scalar',
                7,
                { proposedTitle: { toString: {} }, matchedTmdbEpisodeId: { toString: {} } },
            ];
            for (let i = 0; i < payloads.length; i++) {
                const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
                await sql`INSERT INTO sync_quarantine(id,provider,external_id,media_type,expected_series_id,reason,source,payload)
                    VALUES (${id},'lumastra-reconcile',${randomUUID()},'episode',${f.seriesId},${caller === 'accept-ineligible' ? 'reconcile-backfill:below-threshold' : 'reconcile-backfill:matched'},'test',${payloads[i] === null ? sql`'null'::jsonb` : sql.json(payloads[i] as never)})`;
            }
            expect(
                await sql`SELECT jsonb_typeof(payload) AS kind FROM sync_quarantine WHERE id <> 'ffffffff-ffff-4fff-8fff-ffffffffffff' ORDER BY id`,
            ).toEqual(['null', 'array', 'string', 'number', 'object'].map((kind) => ({ kind })));
            const warnings =
                await sql`SELECT to_jsonb(q) AS row FROM sync_quarantine q WHERE id <> 'ffffffff-ffff-4fff-8fff-ffffffffffff' ORDER BY id`;
            let after: string | undefined;
            let examined = 0;
            let completed = 0;
            do {
                if (caller === 'recheck') {
                    const result = await recheckQuarantinedMatchesForSeries(
                        sql,
                        f.seriesId,
                        'admin',
                        { after, limit: 1 },
                    );
                    examined += result.examined;
                    completed += result.resolved;
                    after = result.continuation;
                } else {
                    const preview = await acceptService(sql, f.seriesId, 'admin', {
                        after,
                        limit: 1,
                        preview: true,
                    });
                    const result = await acceptService(sql, f.seriesId, 'admin', {
                        after,
                        limit: 1,
                        reviewed: preview.review,
                        reviewedPage: preview.reviewedPage,
                    });
                    expect(result.pageChanged).not.toBe(true);
                    examined += result.examined;
                    completed += result.accepted;
                    after = result.continuation;
                }
            } while (after);
            expect(examined).toBe(6);
            expect(completed).toBe(1);
            expect(
                await sql`SELECT to_jsonb(q) AS row FROM sync_quarantine q WHERE id <> 'ffffffff-ffff-4fff-8fff-ffffffffffff' ORDER BY id`,
            ).toEqual(warnings);
        },
    );
    it.each(['provider', 'media-before-provider', 'media-under-lock'] as const)(
        'iteration5 stale %s authorization never advances its reviewed page',
        async (kind) => {
            const f = await seed();
            await makeApplicable(f);
            await sql`UPDATE sync_quarantine SET id='00000000-0000-4000-8000-000000000001' WHERE id=${f.warningId}`;
            await sql`INSERT INTO sync_quarantine(id,provider,external_id,media_type,expected_series_id,reason,source,payload)
                VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff','lumastra-reconcile',${randomUUID()},'episode',${f.seriesId},'reconcile-backfill:below-threshold','test','{}')`;
            const preview = await acceptService(sql, f.seriesId, 'admin', {
                limit: 1,
                preview: true,
            });
            expect(preview.review).toHaveLength(1);
            expect(preview.continuation).toBeDefined();
            if (kind === 'provider')
                seam.catalog = [
                    {
                        id: 870001,
                        name: 'The Decision',
                        seasonNumber: 1,
                        episodeNumber: 1,
                        stillPath: '/changed.jpg',
                        overview: 'Changed provider text',
                    },
                ];
            if (kind === 'media-before-provider')
                await rival`UPDATE media_items SET overview='independent edit' WHERE id=${f.episodeId}`;
            if (kind === 'media-under-lock')
                seam.beforeLock = async () => {
                    await rival`UPDATE media_items SET overview='independent edit' WHERE id=${f.episodeId}`;
                };
            const result = await acceptService(sql, f.seriesId, 'admin', {
                limit: 1,
                reviewed: preview.review,
                reviewedPage: preview.reviewedPage,
            });
            expect(result).toMatchObject({ accepted: 0, appliedExternalIds: 0, pageChanged: true });
            expect(result.continuation).toBeUndefined();
            expect(
                await sql`SELECT title,title_binding FROM media_items WHERE id=${f.episodeId}`,
            ).toEqual([{ title: 'Before', title_binding: 'position' }]);
        },
    );

    it.each(['library', 'audio'] as const)(
        'iteration5 consumes stable %s language alternatives for matching while preserving the primary title',
        async (source) => {
            const f = await seed();
            await makeApplicable(f, 'Die Entscheidung');
            seam.localized = { de: 'Die Entscheidung' };
            if (source === 'audio')
                await sql`INSERT INTO media_streams(file_id,stream_type,stream_index,language) VALUES (${f.fileId},'audio',0,'deu')`;
            else {
                const [{ id }] = await sql<
                    { id: string }[]
                >`INSERT INTO library_groups(name) VALUES (${randomUUID()}) RETURNING id`;
                await sql`UPDATE media_items SET library_group_id=${id} WHERE id=${f.seriesId}`;
                await sql`INSERT INTO library_paths(path,media_type,language,library_group_id) VALUES (${`/test/${randomUUID()}`},'tv','de-DE',${id})`;
            }
            const result = await backfillReconcileSeries(sql, f.seriesId, { minConfidence: 0.9 });
            expect(seam.languages).toContain('de');
            expect(result.appliedExternalIds).toBe(1);
            expect(
                await sql`SELECT title,title_binding FROM media_items WHERE id=${f.episodeId}`,
            ).toEqual([{ title: 'The Decision', title_binding: 'identity' }]);
            expect(
                await sql`SELECT external_id FROM external_ids WHERE media_id=${f.episodeId} AND provider='tmdb' AND media_type='episode'`,
            ).toEqual([{ external_id: '870001' }]);
        },
    );

    it('iteration5 gives an arbitrary unregistered caller catalog no write authority or replacement provider I/O', async () => {
        const f = await seed();
        await makeApplicable(f);
        const before = await preserved();
        seam.forbidProviders = true;
        const { applyReconciliation } = await import('./episode-reconciliation.service.js');
        const result = await applyReconciliation(sql, f.seriesId, 0.9, undefined, [
            {
                tmdbEpisodeId: '870001',
                name: 'The Decision',
                altNames: [],
                overview: null,
                stillPath: '/spoof.jpg',
                seasonNumber: 1,
                episodeNumber: 1,
            },
        ]);
        expect(result.appliedExternalIds).toBe(0);
        expect(seam.providerCalls).toBe(0);
        expect(await preserved()).toEqual(before);
    });
    it('iteration5 reevaluation retains arbitrary JSON on live subjects and reaches a later completed warning', async () => {
        const payloads = [
            null,
            [],
            'scalar',
            7,
            { proposedTitle: { toString: {} }, matchedTmdbEpisodeId: { toString: {} } },
        ];
        for (let i = 0; i < payloads.length; i++) {
            const f = await seed(String(870010 + i), 'Malformed subject');
            const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
            await sql`UPDATE sync_quarantine SET id=${id},payload=${payloads[i] === null ? sql`'null'::jsonb` : sql.json(payloads[i] as never)} WHERE id=${f.warningId}`;
        }
        const good = await seed();
        await sql`UPDATE sync_quarantine SET id='ffffffff-ffff-4fff-8fff-ffffffffffff' WHERE id=${good.warningId}`;
        const warnings =
            await sql`SELECT to_jsonb(q) AS row FROM sync_quarantine q WHERE id <> 'ffffffff-ffff-4fff-8fff-ffffffffffff' ORDER BY id`;
        const before = await preserved();
        let after: string | undefined;
        let examined = 0;
        let resolved = 0;
        do {
            const result = await reevaluateQuarantineBacklog(sql, { cap: 1, after });
            expect(result.failedSeries).toBe(0);
            examined += result.rowsExamined;
            resolved += result.reattached;
            after = result.continuation;
        } while (after);
        expect(examined).toBe(6);
        expect(resolved).toBe(1);
        expect(await preserved()).toEqual(before);
        expect(
            await sql`SELECT to_jsonb(q) AS row FROM sync_quarantine q WHERE id <> 'ffffffff-ffff-4fff-8fff-ffffffffffff' ORDER BY id`,
        ).toEqual(warnings);
    });
    it('inspects a below-threshold subject and its current files without inventing a proposal', async () => {
        const f = await seed();
        await sql`UPDATE sync_quarantine SET reason='reconcile-backfill:below-threshold',payload='{"confidence":0}' WHERE id=${f.warningId}`;
        const before = await preserved();
        const result = await inspectQuarantineGroup(sql, f.seriesId);
        expect(result.total).toBe(1);
        expect(result.items[0]).toMatchObject({
            id: f.warningId,
            proposedTitle: null,
            proposedTmdbEpisodeId: null,
            subjectState: 'current',
            current: { id: f.episodeId, fileCount: 1 },
        });
        expect(result.items[0]).not.toHaveProperty('rowImage');
        expect(await preserved()).toEqual(before);
    });
    it('inspects current subjects independently of a missing historical group series and reports moved/deleted subjects honestly', async () => {
        const f = await seed();
        const missingSeries = randomUUID();
        await sql`UPDATE sync_quarantine SET expected_series_id=NULL,payload=${sql.json({ seriesMediaId: missingSeries })} WHERE id=${f.warningId}`;
        let result = await inspectQuarantineGroup(sql, missingSeries);
        expect(result.items[0]).toMatchObject({
            historicalSeriesId: missingSeries,
            subjectState: 'moved',
            current: { id: f.episodeId, seriesId: f.seriesId },
        });
        await sql`DELETE FROM external_ids WHERE media_id=${f.episodeId}`;
        await sql`DELETE FROM media_file_items WHERE media_item_id=${f.episodeId}`;
        await sql`DELETE FROM media_items WHERE id=${f.episodeId}`;
        result = await inspectQuarantineGroup(sql, missingSeries);
        expect(result.items[0]).toMatchObject({ subjectState: 'unavailable', current: null });
    });
    it('keeps null/malformed history visible in the exact unknown group without proposal rows or other groups', async () => {
        const f = await seed();
        await sql`UPDATE sync_quarantine SET expected_series_id=NULL,payload='null'::jsonb WHERE id=${f.warningId}`;
        const other = await seed('870002');
        await sql`UPDATE sync_quarantine SET provider='lumastra-reconcile-absolute',expected_series_id=NULL,payload='{}' WHERE id=${other.warningId}`;
        const result = await inspectQuarantineGroup(sql, 'unknown');
        expect(result.total).toBe(1);
        expect(result.items[0]).toMatchObject({
            id: f.warningId,
            payload: null,
            current: { id: f.episodeId },
        });
        await sql`UPDATE sync_quarantine SET payload='{"seriesMediaId":"not-a-uuid"}' WHERE id=${f.warningId}`;
        expect((await inspectQuarantineGroup(sql, 'unknown')).total).toBe(1);
    });
    it('pages exact groups by stable UUID even after an earlier page is resolved', async () => {
        const f = await seed();
        const ids = [
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000002',
            '00000000-0000-4000-8000-000000000003',
        ];
        await sql`UPDATE sync_quarantine SET id=${ids[0]} WHERE id=${f.warningId}`;
        for (const id of ids.slice(1))
            await sql`INSERT INTO sync_quarantine(id,provider,external_id,media_type,expected_series_id,reason,source,payload) VALUES(${id},'lumastra-reconcile',${id},'episode',${f.seriesId},'reconcile-backfill:below-threshold','test','{}')`;
        const page = await inspectQuarantineGroup(sql, f.seriesId, { limit: 1 });
        expect(page.total).toBe(3);
        expect(page.continuation).toBe(ids[0]);
        await sql`UPDATE sync_quarantine SET resolved_at=NOW() WHERE id=${ids[0]}`;
        const next = await inspectQuarantineGroup(sql, f.seriesId, {
            limit: 1,
            after: page.continuation,
        });
        expect(next.total).toBe(2);
        expect(next.items.map((e) => e.id)).toEqual([ids[1]]);
        const last = await inspectQuarantineGroup(sql, f.seriesId, {
            limit: 1,
            after: next.continuation,
        });
        expect(last.items.map((e) => e.id)).toEqual([ids[2]]);
        expect(last.continuation).toBeUndefined();
    });
    it('dismisses only one deliberately reviewed warning and preserves its siblings and media', async () => {
        const f = await seed();
        const other = await seed('870002');
        await sql`UPDATE sync_quarantine SET expected_series_id=${f.seriesId} WHERE id=${other.warningId}`;
        const inspected = (await inspectQuarantineGroup(sql, f.seriesId)).items.find(
            (entry) => entry.id === f.warningId,
        )!;
        const before = await preserved();
        expect(
            await dismissReviewedQuarantine(sql, f.warningId, inspected.fingerprint, 'reviewer'),
        ).toBe(true);
        expect(await getQuarantineById(sql, f.warningId)).toMatchObject({
            resolution: 'dismissed',
            resolvedBy: 'reviewer',
        });
        expect((await getQuarantineById(sql, other.warningId))?.resolvedAt).toBeNull();
        expect(await preserved()).toEqual(before);
    });
    it.each(['payload', 'revival', 'subject', 'files'] as const)(
        'refuses individual dismissal after changed %s',
        async (kind) => {
            const f = await seed();
            const inspected = (await inspectQuarantineGroup(sql, f.seriesId)).items[0];
            if (kind === 'payload')
                await rival`UPDATE sync_quarantine SET reason='rewritten' WHERE id=${f.warningId}`;
            if (kind === 'revival') {
                await rival`UPDATE sync_quarantine SET resolved_at=NOW() WHERE id=${f.warningId}`;
                await rival`UPDATE sync_quarantine SET resolved_at=NULL WHERE id=${f.warningId}`;
            }
            if (kind === 'subject')
                await rival`UPDATE media_items SET title='Changed current title' WHERE id=${f.episodeId}`;
            if (kind === 'files')
                await rival`UPDATE media_files SET file_path='/test/changed.mkv' WHERE id=${f.fileId}`;
            expect(
                await dismissReviewedQuarantine(
                    sql,
                    f.warningId,
                    inspected.fingerprint,
                    'reviewer',
                ),
            ).toBe(false);
            expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
        },
    );
    it.each([
        ['episode-lock', 'manually-locked'],
        ['identity', 'identity-bound'],
        ['episode-status', 'inactive-episode'],
        ['season-status', 'inactive-season'],
        ['series-status', 'inactive-series'],
        ['season-lock', 'locked-season'],
        ['series-lock', 'locked-series'],
        ['season-number', 'inconsistent-season'],
    ])(
        'explains the authoritative %s blocker without relaxing eligibility',
        async (kind, reason) => {
            const f = await seed();
            await makeApplicable(f);
            if (kind === 'episode-lock')
                await sql`UPDATE media_items SET metadata_locked=true WHERE id=${f.episodeId}`;
            if (kind === 'identity')
                await sql`UPDATE media_items SET title_binding='identity' WHERE id=${f.episodeId}`;
            if (kind.endsWith('-status'))
                await sql`UPDATE media_items SET status='deleted' WHERE id=${kind === 'episode-status' ? f.episodeId : kind === 'season-status' ? f.seasonId : f.seriesId}`;
            if (kind === 'season-lock' || kind === 'series-lock')
                await sql`UPDATE media_items SET metadata_locked=true WHERE id=${kind === 'season-lock' ? f.seasonId : f.seriesId}`;
            if (kind === 'season-number')
                await sql`UPDATE media_items SET season_number=2 WHERE id=${f.seasonId}`;
            const preview = await acceptService(sql, f.seriesId, 'reviewer', { preview: true });
            expect(preview.review).toHaveLength(0);
            expect(preview.blockedReview?.[0].reason).toBe(reason);
        },
    );
    it('keeps a contradictory combined-file proposal blocked after an identity holder is removed', async () => {
        const f = await seed();
        await makeApplicable(f);
        await sql`DELETE FROM episode_chapters WHERE file_id=${f.fileId}`;
        await sql`UPDATE media_files SET file_path='/test/Invented.S01E01-02-03.The.Decision.mkv' WHERE id=${f.fileId}`;
        const before = await preserved();
        const preview = await acceptService(sql, f.seriesId, 'reviewer', { preview: true });
        expect(preview.review).toHaveLength(0);
        expect(preview.blocked).toBe(1);
        const result = await acceptService(sql, f.seriesId, 'reviewer', {
            reviewed: preview.review,
            reviewedPage: preview.reviewedPage,
        });
        expect(result.accepted).toBe(0);
        expect(await preserved()).toEqual(before);
    });

    it('preserves a demonstrably consistent combined filename window in actual preview and apply', async () => {
        const f = await seed();
        await makeApplicable(f);
        await sql`DELETE FROM episode_chapters WHERE file_id=${f.fileId}`;
        await sql`UPDATE media_files SET file_path='/test/Invented.S01E01E02.The.Decision.-.Second.Decision.German.mkv' WHERE id=${f.fileId}`;
        const [{ id: second }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title,title_binding,media_type,status,parent_id,season_number,episode_number) VALUES ('Second before','position','episode','active',${f.seasonId},1,2) RETURNING id`;
        await sql`INSERT INTO media_file_items(media_item_id,file_id,is_default) VALUES(${second},${f.fileId},true)`;
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: second,
            mediaType: 'episode',
            expectedSeriesId: f.seriesId,
            payload: {
                seriesMediaId: f.seriesId,
                seasonNumber: 1,
                episodeNumber: 2,
                matchedTmdbEpisodeId: '870002',
                proposedTitle: 'Second Decision',
                currentTitle: 'Second before',
                source: 'filename',
            },
            reason: 'reconcile-backfill:matched',
            source: 'test',
        });
        await sql`UPDATE sync_quarantine SET payload=payload || '{"currentTitle":"Before","source":"filename"}'::jsonb WHERE id=${f.warningId}`;
        const preview = await acceptService(sql, f.seriesId, 'reviewer', { preview: true });
        expect(preview.review).toHaveLength(2);
        const result = await acceptService(sql, f.seriesId, 'reviewer', {
            reviewed: preview.review,
            reviewedPage: preview.reviewedPage,
        });
        expect(result.accepted).toBe(2);
    });
    it('refuses a busy subject without waiting or dismissing its warning', async () => {
        const f = await seed();
        const inspected = (await inspectQuarantineGroup(sql, f.seriesId)).items[0];
        let unlock!: () => void;
        let announce!: () => void;
        const unlocked = new Promise<void>((resolve) => {
            unlock = resolve;
        });
        const locked = new Promise<void>((resolve) => {
            announce = resolve;
        });
        const writer = rival.begin(async (tx) => {
            await tx`SELECT id FROM media_items WHERE id=${f.episodeId} FOR UPDATE`;
            announce();
            await unlocked;
        });
        await locked;
        const action = dismissReviewedQuarantine(
            sql,
            f.warningId,
            inspected.fingerprint,
            'reviewer',
        );
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                action,
                new Promise<'still-waiting'>((resolve) => {
                    deadline = setTimeout(() => resolve('still-waiting'), 750);
                }),
            ]);
            expect(result).toBe(false);
        } finally {
            clearTimeout(deadline);
            unlock();
            await writer;
            await action;
        }
        expect((await getQuarantineById(sql, f.warningId))?.resolvedAt).toBeNull();
    });
    it('resolves actual Jellyfin keys with the stored media type and leaves synthetic missing-child keys unavailable', async () => {
        const f = await seed();
        const externalId = 'invented-jellyfin-key';
        await sql`INSERT INTO external_ids(media_id,provider,external_id,media_type) VALUES(${f.episodeId},'jellyfin',${externalId},'episode'),(${f.seriesId},'jellyfin',${externalId},'tv')`;
        await sql`UPDATE sync_quarantine SET provider='jellyfin',external_id=${externalId},payload='{}' WHERE id=${f.warningId}`;
        const synthetic = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: externalId + '#S1E2',
            mediaType: 'episode',
            expectedSeriesId: f.seriesId,
            payload: { seasonNumber: 1, episodeNumber: 2 },
            reason: 'missing episode',
            source: 'test',
        });
        const inspected = await inspectQuarantineGroup(sql, f.seriesId);
        expect(inspected.items.find((entry) => entry.id === f.warningId)).toMatchObject({
            subjectState: 'current',
            current: { id: f.episodeId, mediaType: 'episode', fileCount: 1 },
        });
        expect(inspected.items.find((entry) => entry.id === synthetic)).toMatchObject({
            subjectState: 'unavailable',
            current: null,
        });
    });
    it('previews only positively resolved navigable links and omits missing, deleted and malformed subjects', async () => {
        const f = await seed();
        const gone = '11111111-1111-4111-8111-111111111111';
        await sql`UPDATE sync_quarantine SET reason='reconcile-backfill:below-threshold',payload='{}' WHERE id=${f.warningId}`;
        for (const externalId of [gone, 'malformed-key'])
            await quarantineWrite(sql, {
                provider: 'lumastra-reconcile',
                externalId,
                mediaType: 'episode',
                expectedSeriesId: f.seriesId,
                payload: {},
                reason: 'reconcile-backfill:below-threshold',
                source: 'test',
            });
        const preview = await acceptService(sql, f.seriesId, 'reviewer', { preview: true });
        expect(preview.inspectableEpisodeIds).toEqual([f.episodeId]);
        await sql`UPDATE media_items SET status='deleted' WHERE id=${f.episodeId}`;
        expect(
            (await acceptService(sql, f.seriesId, 'reviewer', { preview: true }))
                .inspectableEpisodeIds,
        ).toEqual([]);
        await sql`UPDATE media_items SET status='active' WHERE id=${f.episodeId}`;
        await sql`UPDATE sync_quarantine SET media_type='movie' WHERE id=${f.warningId}`;
        expect(
            (await acceptService(sql, f.seriesId, 'reviewer', { preview: true }))
                .inspectableEpisodeIds,
        ).toEqual([]);
    });
});
