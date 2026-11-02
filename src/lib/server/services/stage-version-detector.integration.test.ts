// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { z } from 'zod';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { detectVersionBumps } from './stage-version-detector.js';
import { TaskRegistry } from '$lib/server/tasks/registry.js';
import {
    setObservedVersion,
    allObservedVersions,
} from '$lib/server/database/queries/stage-version-state.queries.js';
import {
    insertPendingRow,
    markCompleted,
    markFailedPermanent,
    findRowsByItem,
} from '$lib/server/database/queries/stage-state.queries.js';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry as builtinRegistry } from '$lib/server/tasks/registry.js';
import { loadBuiltins, _resetLoadedForTests } from '$lib/server/tasks/builtin/index.js';
import { stageProcessingVersion } from '$lib/server/tasks/stage-processing-version.js';
import type { AnyTaskDefinition, CoversStagesDeclaration } from '@sapd/lumastra-plugin-sdk';

function mkTask(
    id: string,
    opts: {
        version?: number;
        coversStages?: ReadonlyArray<CoversStagesDeclaration>;
    },
): AnyTaskDefinition {
    return defineTask({
        id,
        name: id,
        version: '1.0.0',
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        processingVersion: opts.version ?? 1,
        inputSchema: z.object({}),
        identityFor: () => id,
        manualOnly: true,
        coversStages: opts.coversStages,
        execute: async () => ({ success: true as const }),
    });
}

describe('detectVersionBumps', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state, stage_version_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'svd-test-%'`;
    });

    it('marks old-version completed rows as obsolete; leaves skipped_permanent + failed_permanent alone', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('t', {
                version: 3,
                coversStages: [{ id: 'stage-a', appliesTo: ['movie'] as const }],
            }),
        );
        await setObservedVersion(sql, 'stage-a', 1);

        const idCompleted = await insertItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: idCompleted,
            stageId: 'stage-a',
            processingVersion: 1,
        });
        await markCompleted(sql, {
            mediaItemId: idCompleted,
            stageId: 'stage-a',
        });

        const idSkipped = await insertItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: idSkipped,
            stageId: 'stage-a',
            processingVersion: 1,
            initialStatus: 'skipped_permanent',
            skippedReason: 'predicate-false',
        });

        const idFailed = await insertItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: idFailed,
            stageId: 'stage-a',
            processingVersion: 1,
        });
        await markFailedPermanent(sql, {
            mediaItemId: idFailed,
            stageId: 'stage-a',
            error: {
                code: 'test-error',
                message: 'test failure',
                retryable: false,
            },
        });

        await detectVersionBumps(sql, reg);

        const r1 = await findRowsByItem(sql, idCompleted);
        expect(r1[0]?.status).toBe('obsolete');
        const r2 = await findRowsByItem(sql, idSkipped);
        expect(r2[0]?.status).toBe('skipped_permanent');
        const r3 = await findRowsByItem(sql, idFailed);
        expect(r3[0]?.status).toBe('failed_permanent');
    });

    it('records observed version when stage is first seen (no prior row)', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('t', {
                version: 5,
                coversStages: [{ id: 'stage-b', appliesTo: ['movie'] as const }],
            }),
        );

        await detectVersionBumps(sql, reg);

        const all = await allObservedVersions(sql);
        expect(all).toContainEqual({
            stage_id: 'stage-b',
            observed_version: 5,
        });
    });

    it('does nothing when declared version equals observed version', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('t', {
                version: 2,
                coversStages: [{ id: 'stage-c', appliesTo: ['movie'] as const }],
            }),
        );
        await setObservedVersion(sql, 'stage-c', 2);

        const id = await insertItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: id,
            stageId: 'stage-c',
            processingVersion: 2,
        });
        await markCompleted(sql, { mediaItemId: id, stageId: 'stage-c' });

        await detectVersionBumps(sql, reg);

        const rows = await findRowsByItem(sql, id);
        expect(rows[0]?.status).toBe('completed');
    });

    it('only updates rows at strictly older versions, not equal or newer', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('t', {
                version: 3,
                coversStages: [{ id: 'stage-d', appliesTo: ['movie'] as const }],
            }),
        );
        await setObservedVersion(sql, 'stage-d', 1);

        const idV1 = await insertItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: idV1,
            stageId: 'stage-d',
            processingVersion: 1,
        });
        await markCompleted(sql, { mediaItemId: idV1, stageId: 'stage-d' });

        const idV3 = await insertItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: idV3,
            stageId: 'stage-d',
            processingVersion: 3,
        });
        await markCompleted(sql, { mediaItemId: idV3, stageId: 'stage-d' });

        await detectVersionBumps(sql, reg);

        expect((await findRowsByItem(sql, idV1))[0]?.status).toBe('obsolete');
        expect((await findRowsByItem(sql, idV3))[0]?.status).toBe('completed');
    });

    it('detectVersionBumps is idempotent — calling twice with the same registry is safe', async () => {
        // The leader-acquired hook fires detectVersionBumps on every fresh
        // acquisition. This test verifies the function is safe to call
        // concurrently/sequentially (same outcome, no duplicate errors).
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('t', {
                version: 2,
                coversStages: [{ id: 'stage-idem', appliesTo: ['movie'] as const }],
            }),
        );
        await setObservedVersion(sql, 'stage-idem', 1);

        const id = await insertItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: id,
            stageId: 'stage-idem',
            processingVersion: 1,
        });
        await markCompleted(sql, { mediaItemId: id, stageId: 'stage-idem' });

        await detectVersionBumps(sql, reg);
        await detectVersionBumps(sql, reg); // second call — must not throw or corrupt state

        const rows = await findRowsByItem(sql, id);
        expect(rows[0]?.status).toBe('obsolete');
    });

    // Regression for the prod "Stage version ledger drift" alert: the ledger of
    // album-enrichment (1) and artist-enrichment (4) never followed the bumped
    // task versions, so completed rows below the declared version were never
    // marked stale and the coverage-table drain never retried them.
    it('a failing stage does not stop later stages from advancing', async () => {
        const reg = new TaskRegistry();
        const broken: CoversStagesDeclaration = { id: 'stage-broken', appliesTo: ['movie'] };
        Object.defineProperty(broken, 'processingVersion', {
            get() {
                throw new Error('boom');
            },
        });
        reg.registerTask(mkTask('t-broken', { coversStages: [broken] }));
        reg.registerTask(
            mkTask('t-ok', {
                version: 2,
                coversStages: [{ id: 'stage-after', appliesTo: ['movie'] as const }],
            }),
        );

        await expect(detectVersionBumps(sql, reg)).rejects.toThrow(/stage-broken/);

        const ledger = new Map(
            (await allObservedVersions(sql)).map((r) => [r.stage_id, r.observed_version]),
        );
        expect(ledger.get('stage-after')).toBe(2);
    });

    it('registered builtin stages: a bump advances the ledger and marks lower completed rows obsolete', async () => {
        _resetLoadedForTests();
        await loadBuiltins();
        const declared = new Map<string, number>();
        for (const task of builtinRegistry.getAllTasks()) {
            for (const stage of task.coversStages ?? []) {
                declared.set(stage.id, stageProcessingVersion(task, stage));
            }
        }
        const album = declared.get('album-enrichment');
        const artist = declared.get('artist-enrichment');
        expect(album).toBeGreaterThan(1);
        expect(artist).toBeGreaterThan(1);

        // Ledger as it stood on prod: stamped once, never advanced.
        await setObservedVersion(sql, 'album-enrichment', 1);
        await setObservedVersion(sql, 'artist-enrichment', artist! - 1);
        const staleAlbum = await insertItem(sql, 'album');
        const staleArtist = await insertItem(sql, 'artist');
        const currentArtist = await insertItem(sql, 'artist');
        for (const [id, stageId, pv] of [
            [staleAlbum, 'album-enrichment', 1],
            [staleArtist, 'artist-enrichment', artist! - 1],
            [currentArtist, 'artist-enrichment', artist!],
        ] as const) {
            await insertPendingRow(sql, { mediaItemId: id, stageId, processingVersion: pv });
            await markCompleted(sql, { mediaItemId: id, stageId });
        }

        await detectVersionBumps(sql, builtinRegistry);

        const ledger = new Map(
            (await allObservedVersions(sql)).map((r) => [r.stage_id, r.observed_version]),
        );
        for (const [stageId, version] of declared) {
            expect(ledger.get(stageId), stageId).toBe(version);
        }
        expect((await findRowsByItem(sql, staleAlbum))[0]?.status).toBe('obsolete');
        expect((await findRowsByItem(sql, staleArtist))[0]?.status).toBe('obsolete');
        expect((await findRowsByItem(sql, currentArtist))[0]?.status).toBe('completed');
    });
});

async function insertItem(sql: postgres.Sql, mediaType: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`INSERT INTO media_items (id, media_type, title) VALUES (${id}::uuid, ${mediaType}, ${'svd-test-' + id.slice(0, 6)})`;
    return id;
}
