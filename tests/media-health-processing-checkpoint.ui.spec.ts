// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { GlideClient } from '@valkey/valkey-glide';
import postgres from 'postgres';
import { assertValkeyEndpointConfiguration } from '../src/lib/server/config/valkey-endpoints.js';
import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';

const PIPELINE_PAGE_CACHE_KEY = 'admin:ingest:page:v4';

function requireDisposableDatabase(): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || !/lumastra_(?:t_|tests)/.test(new URL(databaseUrl).pathname)) {
        throw new Error(
            'Media-health browser checks require an isolated lumastra_t_* test database',
        );
    }
    return databaseUrl;
}

async function clearPipelinePageCache(): Promise<void> {
    const url = new URL(process.env.CACHE_URL || 'redis://localhost:6379/0');
    if (!['localhost', '127.0.0.1', '::1', 'valkey', 'redis'].includes(url.hostname)) {
        throw new Error(
            'Pipeline browser checks may clear this cache key only on a local test Valkey',
        );
    }
    const databaseId = Number(url.pathname.replace(/^\//, '') || '0');
    const client = await GlideClient.createClient({
        addresses: [{ host: url.hostname, port: Number(url.port || '6379') }],
        requestTimeout: 5000,
        clientName: 'e2e-pipeline-page-cache-reset',
        ...(Number.isInteger(databaseId) && databaseId > 0 ? { databaseId } : {}),
        ...(url.password
            ? {
                  credentials: {
                      username: url.username || 'default',
                      password: url.password,
                  },
              }
            : {}),
    });
    try {
        await client.del([PIPELINE_PAGE_CACHE_KEY]);
    } finally {
        client.close();
    }
}

async function openTaskValkey(clientName: string): Promise<GlideClient> {
    const { task } = assertValkeyEndpointConfiguration({
        TASK_CACHE_URL: process.env.TASK_CACHE_URL,
        CACHE_URL: process.env.CACHE_URL,
    });
    if (
        !['localhost', '127.0.0.1', '::1', 'valkey', 'redis', 'lumastra-valkey'].includes(task.host)
    ) {
        throw new Error(
            'Admission browser fixtures may write only to the private test task Valkey',
        );
    }
    return GlideClient.createClient({
        addresses: [{ host: task.host, port: task.port }],
        requestTimeout: 5000,
        clientName,
        databaseId: task.database,
        useTLS: task.tls,
        ...(task.password
            ? {
                  credentials: {
                      username: task.username || 'default',
                      password: task.password,
                  },
              }
            : {}),
    });
}

interface BacklogSnapshot {
    remaining: number;
    waiting: number;
    ineligible: number;
}

async function readTrickplayBacklog(page: Page): Promise<BacklogSnapshot> {
    const result = await page.evaluate(async () => {
        const response = await fetch('/api/tasks/trickplay-params-sync/backlog');
        return { status: response.status, body: await response.json() };
    });
    expect(result.status).toBe(200);
    const stages = Array.isArray(result.body?.stages) ? result.body.stages : [];
    const count = (id: string): number =>
        stages.reduce(
            (total: number, stage: { id?: unknown; count?: unknown }) =>
                stage.id === id && typeof stage.count === 'number' ? total + stage.count : total,
            0,
        );
    const waiting = stages.reduce(
        (total: number, stage: { id?: unknown; count?: unknown }) =>
            stage.id !== 'ineligible' &&
            !(stage.id === 'failed' && result.body?.unitLabel === 'file links') &&
            typeof stage.count === 'number'
                ? total + stage.count
                : total,
        0,
    );
    return { remaining: count('remaining'), waiting, ineligible: count('ineligible') };
}

async function expectOverviewTrickplayBacklog(page: Page, count: number): Promise<void> {
    // The task summary deliberately caches display counts for 30 seconds;
    // the backlog endpoint is live. Direct SQL fixtures bypass application
    // invalidation, so wait for the display read to refresh before navigation.
    await expect
        .poll(
            async () => {
                const response = await page.request.get('/api/tasks/trickplay-params-sync');
                expect(response.status(), await response.text()).toBe(200);
                return ((await response.json()) as { backlogRemaining: number }).backlogRemaining;
            },
            { timeout: 40_000, intervals: [500, 1000] },
        )
        .toBe(count);
    await page.reload();
    await expectHydrated(page);
    const card = page.getByRole('heading', { name: 'Backlog', exact: true }).locator('../../..');
    await expect(card.locator('p').first()).toHaveText(count.toLocaleString());
    await expect(card).toContainText('file links remaining');
}

async function expectTrickplayBacklogTab(page: Page, snapshot: BacklogSnapshot): Promise<void> {
    await expect(page.getByRole('tab', { name: 'Backlog', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    const panel = page.getByRole('main');
    await expect(panel).toContainText(`${snapshot.waiting.toLocaleString()} file links waiting`);
    if (snapshot.ineligible > 0) {
        await expect(
            panel.getByText(
                `${snapshot.ineligible.toLocaleString()} file links will not be processed:`,
                { exact: true },
            ),
        ).toBeVisible();
        await expect(panel.getByText('Ineligible', { exact: true })).toBeVisible();
    } else {
        await expect(panel.getByText(/file links will not be processed:/)).toHaveCount(0);
        await expect(panel.getByText('Ineligible', { exact: true })).toHaveCount(0);
    }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
}

interface RangeGraphFile {
    id: string;
    path: string;
    size: string;
    mtimeMs: string;
    generation: string;
}

interface RangeGraph {
    root: { path: string };
    files: RangeGraphFile[];
}

interface RangeFixture {
    groupId: string;
    seriesId: string;
    seasonId: string;
    episodeIds: [string, string];
    combinedId: string;
    dedicatedIds: [string, string];
    unprovenId: string;
    root: string;
    files: { combined: string; first: string; second: string; unproven: string };
}

async function seedRangeMappingFixture(
    sql: postgres.Sql,
    onCreated: (fixture: RangeFixture) => void,
): Promise<RangeFixture> {
    const fixture: RangeFixture = {
        groupId: randomUUID(),
        seriesId: randomUUID(),
        seasonId: randomUUID(),
        episodeIds: [randomUUID(), randomUUID()],
        combinedId: randomUUID(),
        dedicatedIds: [randomUUID(), randomUUID()],
        unprovenId: randomUUID(),
        root: await mkdtemp(join(tmpdir(), 'lumastra-range-proof-e2e-')),
        files: {
            combined: '',
            first: '',
            second: '',
            unproven: '',
        },
    };
    fixture.files = {
        combined: join(fixture.root, 'Lantern Station S01E01E02.mkv'),
        first: join(fixture.root, 'Lantern Station S01E01.mkv'),
        second: join(fixture.root, 'Lantern Station S01E02.mkv'),
        unproven: join(fixture.root, 'Lantern Station S01E03E04.mkv'),
    };
    onCreated(fixture);

    const names = [
        fixture.files.combined,
        fixture.files.first,
        fixture.files.second,
        fixture.files.unproven,
    ];
    for (const filePath of names) {
        await mkdir(resolve(filePath, '..'), { recursive: true });
        await writeFile(filePath, Buffer.from('invented disposable range-observation fixture\n'));
    }

    const titleSuffix = fixture.seriesId.slice(0, 8);
    const warningAt = new Date().toISOString();
    const combinedWarning = {
        type: 'range_superseded',
        detected_at: warningAt,
        superseded_by: [fixture.files.first, fixture.files.second],
    };
    const unprovenWarning = {
        type: 'range_superseded',
        detected_at: warningAt,
        superseded_by: [],
    };

    await sql`INSERT INTO library_groups (id, name)
        VALUES (${fixture.groupId}, ${`Lantern Station range fixture ${titleSuffix}`})`;
    await sql`INSERT INTO library_paths (path, media_type, library_group_id, enabled)
        VALUES (${fixture.root}, 'tv', ${fixture.groupId}, TRUE)`;
    await sql`
        INSERT INTO media_items (
            id, title, media_type, status, has_files, library_group_id
        )
        VALUES (
            ${fixture.seriesId}, ${`Lantern Station ${titleSuffix}`},
            'tv', 'active', TRUE, ${fixture.groupId}
        )
    `;
    await sql`
        INSERT INTO media_items (
            id, title, media_type, parent_id, season_number, status, has_files, library_group_id
        )
        VALUES (
            ${fixture.seasonId}, 'Season 1', 'season', ${fixture.seriesId},
            1, 'active', TRUE, ${fixture.groupId}
        )
    `;
    await sql`
        INSERT INTO media_items (
            id, title, media_type, parent_id, season_number, episode_number,
            status, has_files, library_group_id
        )
        VALUES (
            ${fixture.episodeIds[0]}, 'A Lantern in the Fog', 'episode',
            ${fixture.seasonId}, 1, 1, 'active', TRUE, ${fixture.groupId}
        ), (
            ${fixture.episodeIds[1]}, 'The Crossing Light', 'episode',
            ${fixture.seasonId}, 1, 2, 'active', TRUE, ${fixture.groupId}
        )
    `;

    const fileRows = [
        { id: fixture.combinedId, path: fixture.files.combined, issues: [combinedWarning] },
        { id: fixture.dedicatedIds[0], path: fixture.files.first, issues: [] },
        { id: fixture.dedicatedIds[1], path: fixture.files.second, issues: [] },
        { id: fixture.unprovenId, path: fixture.files.unproven, issues: [unprovenWarning] },
    ];
    for (const file of fileRows) {
        const fileStat = await stat(file.path);
        if (!fileStat.isFile() || fileStat.size <= 0) {
            throw new Error(`Range fixture was not written as a nonempty file: ${file.path}`);
        }
        await sql`
            INSERT INTO media_files
            (
                id, file_path, library_group_id, is_missing, file_mtime,
                file_size_bytes, container_format, health_issues
            )
            VALUES (
                ${file.id}, ${file.path}, ${fixture.groupId}, FALSE, ${fileStat.mtime},
                ${fileStat.size}, 'matroska', ${sql.json(file.issues)}
            )
        `;
    }
    await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
        VALUES (${fixture.dedicatedIds[0]}, ${fixture.episodeIds[0]}, TRUE),
               (${fixture.dedicatedIds[1]}, ${fixture.episodeIds[1]}, TRUE)`;

    const [snapshot] = await sql<{ graph: RangeGraph | null }[]>`
        SELECT range_mapping_graph(
            ${fixture.combinedId}::uuid,
            ${fixture.seasonId}::uuid,
            1,
            2,
            ${fixture.dedicatedIds}::uuid[]
        ) AS graph
    `;
    const graph = snapshot?.graph;
    if (
        !graph ||
        graph.files.length !== 3 ||
        graph.files[0]?.id !== fixture.combinedId ||
        graph.files[1]?.id !== fixture.dedicatedIds[0] ||
        graph.files[2]?.id !== fixture.dedicatedIds[1]
    ) {
        throw new Error(
            'Range fixture graph did not match the selected combined and dedicated files',
        );
    }

    const realRoot = await realpath(graph.root.path);
    const participants = [];
    for (const file of graph.files) {
        const realPath = await realpath(file.path);
        const expectedRealPath = resolve(
            realRoot,
            relative(resolve(graph.root.path), resolve(file.path)),
        );
        if (realPath !== expectedRealPath) {
            throw new Error(`Range fixture path escaped its library root: ${file.path}`);
        }
        const fileStat = await stat(realPath, { bigint: true });
        if (
            !fileStat.isFile() ||
            String(fileStat.size) !== file.size ||
            fileStat.mtimeNs - BigInt(file.mtimeMs) * 1_000_000n > 999_999n ||
            BigInt(file.mtimeMs) * 1_000_000n - fileStat.mtimeNs > 999_999n
        ) {
            throw new Error(`Range fixture physical witness no longer matches ${file.path}`);
        }
        participants.push({
            fileId: file.id,
            path: file.path,
            generation: file.generation,
            root: graph.root.path,
            realRoot,
            realPath,
            regularFile: true,
            dev: String(fileStat.dev),
            ino: String(fileStat.ino),
            size: String(fileStat.size),
            mtimeMs: file.mtimeMs,
            mtimeNs: String(fileStat.mtimeNs),
            ctimeNs: String(fileStat.ctimeNs),
        });
    }
    const proof = { version: 1, observedAt: new Date().toISOString(), participants };
    await sql`INSERT INTO file_range_mapping_proofs
        (file_id, season_id, first_episode, last_episode, dedicated_ids, graph, proof)
        VALUES (
            ${fixture.combinedId}::uuid,
            ${fixture.seasonId}::uuid,
            1,
            2,
            ${fixture.dedicatedIds}::uuid[],
            ${sql.json(graph as unknown as postgres.JSONValue)},
            ${sql.json(proof as unknown as postgres.JSONValue)}
        )`;

    const [current] = await sql<{ current: boolean }[]>`
        SELECT current_range_mapping_proof(${fixture.combinedId}::uuid) AS current
    `;
    const [unproven] = await sql<{ current: boolean }[]>`
        SELECT current_range_mapping_proof(${fixture.unprovenId}::uuid) AS current
    `;
    expect(current?.current).toBe(true);
    expect(unproven?.current).toBe(false);
    return fixture;
}

async function deleteRangeMappingFixture(sql: postgres.Sql, fixture: RangeFixture): Promise<void> {
    await sql`DELETE FROM file_range_mapping_proofs
        WHERE file_id IN (${fixture.combinedId}, ${fixture.unprovenId})`;
    const fileIds = [fixture.combinedId, ...fixture.dedicatedIds, fixture.unprovenId];
    const mediaIds = [...fixture.episodeIds, fixture.seasonId, fixture.seriesId];
    await sql`DELETE FROM media_file_items WHERE file_id = ANY(${sql.array(fileIds)}::uuid[])`;
    await sql`DELETE FROM media_files WHERE id = ANY(${sql.array(fileIds)}::uuid[])`;
    await sql`DELETE FROM media_items WHERE id = ANY(${sql.array(mediaIds)}::uuid[])`;
    await sql`DELETE FROM library_paths WHERE library_group_id = ${fixture.groupId}`;
    await sql`DELETE FROM library_groups WHERE id = ${fixture.groupId}`;
    await rm(fixture.root, { recursive: true, force: true });
}

interface AdmissionFixture {
    runId: string;
    valkeyKey: string;
    startedAt: string;
    executionStartedAt: string;
}

async function seedAdmissionFixture(sql: postgres.Sql): Promise<AdmissionFixture> {
    const runId = `run_${randomUUID()}`;
    const startedAt = new Date(Date.now() - 4 * 60_000);
    const executionStartedAt = new Date(Date.now() - 2 * 60_000);
    const valkeyKey = `task:run:active:${runId}`;
    await sql`INSERT INTO task_history
        (id, task_id, label, state, input, trigger, actor, processing_version,
         started_at, execution_started_at, stages)
        VALUES (
            ${runId}, 'lumastra-intro-analyzer', ${`Admission fixture ${runId.slice(-8)}`},
            'active', ${sql.json({})}, ${sql.json({ kind: 'manual' })},
            ${sql.json({ type: 'user', id: 'e2e-admin' })}, '1',
            ${startedAt}, ${executionStartedAt},
            ${sql.json([{ id: 'main', label: 'Intro analysis', state: 'active', processed: 1, total: 3 }])}
        )`;
    return {
        runId,
        valkeyKey,
        startedAt: startedAt.toISOString(),
        executionStartedAt: executionStartedAt.toISOString(),
    };
}

interface TrickplayCoverageFixture {
    mediaItemId: string;
    fileIds: [string, string];
    root: string;
}

async function seedTrickplayCoverageFixture(sql: postgres.Sql): Promise<TrickplayCoverageFixture> {
    const mediaItemId = randomUUID();
    const fileIds: [string, string] = [randomUUID(), randomUUID()];
    const root = await mkdtemp(join(tmpdir(), 'lumastra-trickplay-coverage-e2e-'));
    const paths = [join(root, 'Lantern-params.mkv'), join(root, 'Lantern-no-provider.mkv')];
    try {
        for (const filePath of paths) {
            await writeFile(
                filePath,
                Buffer.from('invented disposable trickplay coverage fixture\n'),
            );
        }
        await sql`INSERT INTO media_items
            (id, title, media_type, status, has_files, processing_state)
            VALUES (
                ${mediaItemId}, ${`Invented trickplay coverage ${mediaItemId.slice(0, 8)}`},
                'movie', 'active', TRUE,
                ${sql.json({ [`trickplay-params:${fileIds[1]}`]: { version: 3, status: 'no-provider' } })}
            )`;
        for (const [index, fileId] of fileIds.entries()) {
            const fileStat = await stat(paths[index]);
            await sql`INSERT INTO media_files (id, file_path, file_size_bytes, is_missing)
                VALUES (${fileId}, ${paths[index]}, ${fileStat.size}, FALSE)`;
        }
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${fileIds[0]}, ${mediaItemId}, TRUE), (${fileIds[1]}, ${mediaItemId}, FALSE)`;
        await sql`INSERT INTO trickplay_params
            (media_item_id, file_id, width, height, interval_ms, tile_width, tile_height,
             thumbnail_count, bandwidth, source)
            VALUES (${mediaItemId}, ${fileIds[0]}, 320, 180, 1000, 10, 10, 100, 500, 'local')`;
        await sql`INSERT INTO media_item_stage_state
            (media_item_id, stage_id, processing_version, status, attempt, updated_at)
            VALUES (${mediaItemId}, 'trickplay-params-sync', 3, 'pending', 0, now())`;
        return { mediaItemId, fileIds, root };
    } catch (error) {
        await sql`DELETE FROM media_item_stage_state WHERE media_item_id = ${mediaItemId}`;
        await sql`DELETE FROM trickplay_params WHERE media_item_id = ${mediaItemId}`;
        await sql`DELETE FROM media_file_items WHERE media_item_id = ${mediaItemId}`;
        await sql`DELETE FROM media_files WHERE id = ANY(${sql.array(fileIds)}::uuid[])`;
        await sql`DELETE FROM media_items WHERE id = ${mediaItemId}`;
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}

async function deleteTrickplayCoverageFixture(
    sql: postgres.Sql,
    fixture: TrickplayCoverageFixture,
): Promise<void> {
    await sql`DELETE FROM media_item_stage_state
        WHERE media_item_id = ${fixture.mediaItemId} AND stage_id = 'trickplay-params-sync'`;
    await sql`DELETE FROM trickplay_params WHERE media_item_id = ${fixture.mediaItemId}`;
    await sql`DELETE FROM media_file_items WHERE media_item_id = ${fixture.mediaItemId}`;
    await sql`DELETE FROM media_files WHERE id = ANY(${sql.array(fixture.fileIds)}::uuid[])`;
    await sql`DELETE FROM media_items WHERE id = ${fixture.mediaItemId}`;
    await rm(fixture.root, { recursive: true, force: true });
}

for (const width of [1280, 390]) {
    test(`trickplay run result keeps frame units and continuation evidence at ${width}px`, async ({
        page,
    }) => {
        const sql = postgres(requireDisposableDatabase(), { max: 1 });
        const runId = `run_${randomUUID()}`;
        const mediaItemId = randomUUID();
        const startedAt = new Date(Date.now() - 90_000);
        const completedAt = new Date();
        const runLabel = `Trickplay generation fixture ${runId.slice(-8)}`;
        try {
            await sql`INSERT INTO task_history
                (id, task_id, label, state, input, trigger, actor, processing_version,
                 started_at, completed_at, stages, result)
                VALUES (
                    ${runId},
                    'trickplay-generation',
                    ${runLabel},
                    'completed',
                    ${sql.json({ mediaItemId })},
                    ${sql.json({ kind: 'manual' })},
                    ${sql.json({ type: 'user', id: 'e2e-admin' })},
                    '1',
                    ${startedAt},
                    ${completedAt},
                    ${sql.json([
                        {
                            id: 'main',
                            label: 'Source checks',
                            state: 'completed',
                            processed: 1,
                            total: 2,
                        },
                    ])},
                    ${sql.json({
                        success: false,
                        itemsProcessed: 663,
                        stopReason: 'budget',
                        result: {
                            generated: 663,
                            countUnit: 'frames',
                            sourcesRemaining: 1,
                            skipped: 4,
                        },
                    })}
                )`;

            await page.setViewportSize({ width, height: 900 });
            await page.goto('/admin/tasks/runs?view=all&status=completed');
            await expectHydrated(page);
            const runRow = page.getByRole('button', { name: new RegExp(runLabel) });
            await expect(runRow).toBeVisible();
            await expect(runRow).toContainText('663 frames');
            await runRow.click();

            const runProgress = page.getByRole('region', { name: 'Run progress' });
            await expect(runProgress).toBeVisible();
            await expect(runProgress).toContainText('663 frames');
            await expect(runProgress).toContainText('1 / 2');
            await expect(runProgress).toContainText(
                /Source checks still to come in a later pass: 1/,
            );
            await expect(page.locator('body')).not.toContainText(/663 items/);
            await expectNoHorizontalOverflow(page);
            await page.screenshot({
                path: test.info().outputPath('checkpoint.png'),
                animations: 'disabled',
            });
        } finally {
            try {
                await sql`DELETE FROM task_history WHERE id = ${runId}`;
            } finally {
                await sql.end();
            }
        }
    });

    test(
        `pipeline keeps the selected dormant-pending reason on first paint, refetch, ` +
            `and return at ${width}px`,
        async ({ page }) => {
            const sql = postgres(requireDisposableDatabase(), { max: 1 });
            const mediaItemId = randomUUID();
            const stageId = `e2e-dormant-${randomUUID()}`;
            const title = `Invented pending stage ${mediaItemId.slice(0, 8)}`;
            const writeRequests: string[] = [];
            page.on('request', (request) => {
                if (
                    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) &&
                    /\/api\/admin\/(?:ingest|task-system|media)\//.test(request.url())
                ) {
                    writeRequests.push(`${request.method()} ${request.url()}`);
                }
            });
            try {
                await sql`INSERT INTO media_items (id, title, media_type, status, has_files)
                    VALUES (${mediaItemId}, ${title}, 'movie', 'active', TRUE)`;
                await sql`INSERT INTO media_item_stage_state
                    (media_item_id, stage_id, processing_version, status, attempt, updated_at)
                    VALUES (
                        ${mediaItemId}, ${stageId}, 1, 'pending', 0, now() - interval '31 minutes'
                    )`;
                const [scheduled] = await sql<{ count: number }[]>`
                    SELECT count(*)::int AS count FROM scheduler_state WHERE task_id = ${stageId}
                `;
                expect(scheduled?.count).toBe(0);

                // The server caches the first-paint pipeline payload for one minute. Clear only
                // that disposable test cache key so the page proves the selected SQL reason.
                await clearPipelinePageCache();
                await page.setViewportSize({ width, height: 900 });
                await page.goto('/admin/tasks/pipeline#stuck-items');
                await expectHydrated(page);
                const stuckPanel = page.getByRole('region', { name: 'Stuck items' });
                const stuckItem = stuckPanel.getByRole('listitem').filter({ hasText: title });
                const selectedReason =
                    'Pending over 30 minutes; no completion in the last 30 minutes and no future ' +
                    'unpaused scheduled run.';
                await expect(stuckItem).toBeVisible();
                await expect(stuckItem).toContainText(`Selected reason: ${selectedReason}`);

                const diagnosticsRefetch = page.waitForResponse(
                    (response) =>
                        response.request().method() === 'GET' &&
                        response.url().includes('/api/admin/ingest/diagnostics'),
                );
                await page.getByLabel('Time window').selectOption('7d');
                expect((await diagnosticsRefetch).status()).toBe(200);
                await expect(stuckItem).toContainText(`Selected reason: ${selectedReason}`);

                await page.goto('/admin/tasks');
                await expectHydrated(page);
                await page.goto('/admin/tasks/pipeline#stuck-items');
                await expectHydrated(page);
                const returnedPanel = page.getByRole('region', { name: 'Stuck items' });
                const returnedItem = returnedPanel.getByRole('listitem').filter({ hasText: title });
                await expect(returnedItem).toBeVisible();
                await expect(returnedItem).toContainText(`Selected reason: ${selectedReason}`);
                expect(writeRequests).toEqual([]);
                await expectNoHorizontalOverflow(page);
                await page.screenshot({
                    path: test.info().outputPath('checkpoint.png'),
                    animations: 'disabled',
                });
            } finally {
                try {
                    await sql`DELETE FROM media_item_stage_state
                        WHERE media_item_id = ${mediaItemId} AND stage_id = ${stageId}`;
                    await sql`DELETE FROM media_items WHERE id = ${mediaItemId}`;
                } finally {
                    try {
                        await sql.end();
                    } finally {
                        await clearPipelinePageCache();
                    }
                }
            }
        },
    );

    test(`Health distinguishes current and unproven range observations at ${width}px`, async ({
        page,
    }) => {
        const sql = postgres(requireDisposableDatabase(), { max: 1 });
        let fixture: RangeFixture | undefined;
        try {
            fixture = await seedRangeMappingFixture(sql, (created) => (fixture = created));
            await page.setViewportSize({ width, height: 900 });
            const fileHealthResponse = page.waitForResponse(
                (response) =>
                    response.request().method() === 'GET' &&
                    response.url().includes('/api/admin/media/file-health'),
            );
            await page.goto('/admin/system/health#files');
            await expectHydrated(page);
            expect((await fileHealthResponse).status()).toBe(200);

            const filesPanel = page.locator('#files');
            const combinedName = fixture.files.combined.split('/').at(-1) ?? '';
            const unprovenName = fixture.files.unproven.split('/').at(-1) ?? '';
            // A current proof is an informational mapping observation; its paired
            // unproven warning remains in the actionable review filter.
            const mappingScope = filesPanel.getByRole('button', { name: /Mapping observations/ });
            const reviewScope = filesPanel.getByRole('button', { name: /Needs review/ });
            await mappingScope.click();
            await expect(mappingScope).toHaveAttribute('aria-pressed', 'true');
            await expect(reviewScope).toHaveAttribute('aria-pressed', 'false');
            const combinedDiagnosis = filesPanel
                .getByText(combinedName, { exact: true })
                .locator('../../..')
                .getByTestId('range-mapping-diagnosis');
            const unprovenDiagnosis = filesPanel
                .getByText(unprovenName, { exact: true })
                .locator('../../..')
                .getByTestId('range-mapping-diagnosis');

            await expect(combinedDiagnosis).toContainText(/Dedicated episode mappings observed on/);
            await expect(combinedDiagnosis).toContainText(
                'Observed file presence and current recorded mappings; ' +
                    'content completeness is unverified.',
            );
            const recordedDetails = combinedDiagnosis.locator('details');
            await expect(recordedDetails).not.toHaveAttribute('open');
            await page.screenshot({
                path: test.info().outputPath('range-mapping-details-collapsed.png'),
                animations: 'disabled',
            });
            await recordedDetails.getByText('Recorded mapping details', { exact: true }).click();
            await expect(recordedDetails.locator('pre')).toContainText(
                'Lantern Station S01E01.mkv',
            );
            await expect(recordedDetails.locator('pre')).toContainText(
                'Lantern Station S01E02.mkv',
            );

            await reviewScope.click();
            await expect(reviewScope).toHaveAttribute('aria-pressed', 'true');
            await expect(mappingScope).toHaveAttribute('aria-pressed', 'false');
            await expect(unprovenDiagnosis).toContainText(
                'Dedicated episode mappings are unproven. Review this recorded warning.',
            );
            await expect(unprovenDiagnosis).not.toContainText(/observed on/i);
            await expectNoHorizontalOverflow(page);
            await page.screenshot({
                path: test.info().outputPath('checkpoint.png'),
                animations: 'disabled',
            });
        } finally {
            try {
                if (fixture) await deleteRangeMappingFixture(sql, fixture);
            } finally {
                await sql.end();
            }
        }
    });

    test(`admitted run guards catalog and scoped rerun controls at ${width}px`, async ({
        page,
    }) => {
        const sql = postgres(requireDisposableDatabase(), { max: 1 });
        let fixture: AdmissionFixture | undefined;
        let valkey: GlideClient | undefined;
        const writeRequests: string[] = [];
        page.on('request', (request) => {
            // Client diagnostics may report an environmental module abort;
            // they do not start or alter a task. Every other write stays guarded.
            if (
                ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) &&
                new URL(request.url()).pathname !== '/api/client-errors'
            ) {
                writeRequests.push(`${request.method()} ${request.url()}`);
            }
        });
        try {
            valkey = await openTaskValkey('e2e-admission-checkpoint');
            fixture = await seedAdmissionFixture(sql);
            await valkey.hset(fixture.valkeyKey, {
                state: 'active',
                taskId: 'lumastra-intro-analyzer',
                startedAt: fixture.executionStartedAt,
                updatedAt: new Date().toISOString(),
            });
            await valkey.pexpire(fixture.valkeyKey, 5 * 60_000);
            expect(await valkey.customCommand(['HGET', fixture.valkeyKey, 'state'])).toBe('active');
            expect(await valkey.customCommand(['HGET', fixture.valkeyKey, 'startedAt'])).toBe(
                fixture.executionStartedAt,
            );

            await page.setViewportSize({ width, height: 900 });
            const taskListResponse = page.waitForResponse(
                (response) =>
                    response.request().method() === 'GET' &&
                    new URL(response.url()).pathname === '/api/tasks',
            );
            await page.goto('/admin/tasks');
            await expectHydrated(page);
            const taskList = await (await taskListResponse).json();
            const taskSummary = taskList.items.find(
                (item: { id?: string }) => item.id === 'lumastra-intro-analyzer',
            );
            expect(taskSummary).toMatchObject({ activeCount: 1, observedActiveCount: 1 });
            const runResponse = await page.request.get(`/api/runs/${fixture.runId}`);
            expect(runResponse.status()).toBe(200);
            expect(await runResponse.json()).toMatchObject({
                startedAt: fixture.startedAt,
                executionStartedAt: fixture.executionStartedAt,
            });
            const taskLink = page.locator('a[href="/admin/tasks/lumastra-intro-analyzer"]');
            await expect(taskLink).toBeVisible();
            const taskRow = taskLink.locator('xpath=ancestor::tr');
            await expect(taskRow.getByRole('img', { name: 'Running' })).toBeVisible();
            await expect(taskRow.getByRole('button')).toBeDisabled();

            await page.goto('/admin/tasks/lumastra-intro-analyzer');
            await expectHydrated(page);
            const fullRun = page.getByRole('button', { name: 'Process all pending', exact: true });
            const segmentRefresh = page.getByRole('button', {
                name: 'Re-detect segments…',
                exact: true,
            });
            await expect(fullRun).toBeDisabled();
            await expect(segmentRefresh).toBeDisabled();

            await page.getByRole('tab', { name: 'Recent Runs', exact: true }).click();
            const recentRun = page.locator(`a[href="/admin/tasks/runs?run=${fixture.runId}"]`);
            await expect(recentRun).toBeVisible();
            await expect(recentRun).toContainText('Running');
            await expect(recentRun).toContainText('Started by hand');
            await expectNoHorizontalOverflow(page);
            await page.screenshot({
                path: test.info().outputPath('checkpoint.png'),
                animations: 'disabled',
            });
            expect(writeRequests).toEqual([]);
        } finally {
            try {
                if (fixture && valkey) await valkey.del([fixture.valkeyKey]);
                if (fixture) await sql`DELETE FROM task_history WHERE id = ${fixture.runId}`;
            } finally {
                valkey?.close();
                await sql.end();
            }
        }
    });

    test(`trickplay backlog separates remaining file links from ineligible at ${width}px`, async ({
        page,
    }) => {
        test.setTimeout(120_000);
        const sql = postgres(requireDisposableDatabase(), { max: 1 });
        let fixture: TrickplayCoverageFixture | undefined;
        try {
            await page.setViewportSize({ width, height: 900 });
            await page.goto('/admin/tasks/trickplay-params-sync');
            await expectHydrated(page);
            const baseline = await readTrickplayBacklog(page);
            await expectOverviewTrickplayBacklog(page, baseline.remaining);

            fixture = await seedTrickplayCoverageFixture(sql);
            const [physical] = await sql<{ count: number }[]>`
                SELECT count(*)::int AS count FROM media_file_items
                WHERE media_item_id = ${fixture.mediaItemId}
            `;
            expect(physical?.count).toBe(2);

            await page.goto('/admin/tasks/trickplay-params-sync');
            await expectHydrated(page);
            const withFixture = await readTrickplayBacklog(page);
            expect(withFixture).toEqual({
                remaining: baseline.remaining,
                waiting: baseline.waiting,
                ineligible: baseline.ineligible + 1,
            });
            await expectOverviewTrickplayBacklog(page, withFixture.remaining);

            await page.getByRole('tab', { name: 'Backlog', exact: true }).click();
            await expectTrickplayBacklogTab(page, withFixture);

            await sql`UPDATE media_items
                SET processing_state = COALESCE(processing_state, '{}'::jsonb)
                    - ${`trickplay-params:${fixture.fileIds[1]}`}
                WHERE id = ${fixture.mediaItemId}`;
            const afterMarkerRemoval = await readTrickplayBacklog(page);
            expect(afterMarkerRemoval).toEqual({
                remaining: baseline.remaining + 1,
                waiting: baseline.waiting + 1,
                ineligible: baseline.ineligible,
            });
            await page.goto('/admin/tasks/trickplay-params-sync');
            await expectHydrated(page);
            await expectOverviewTrickplayBacklog(page, afterMarkerRemoval.remaining);
            await page.getByRole('tab', { name: 'Backlog', exact: true }).click();
            await expectTrickplayBacklogTab(page, afterMarkerRemoval);
            await page.goto('/admin/tasks');
            await expectHydrated(page);
            const catalogRow = page
                .locator('a[href="/admin/tasks/trickplay-params-sync"]')
                .locator('xpath=ancestor::tr');
            await expect(
                catalogRow.getByText(
                    `${afterMarkerRemoval.waiting.toLocaleString()} file links waiting`,
                    { exact: true },
                ),
            ).toBeVisible();
            await expectNoHorizontalOverflow(page);
            await page.screenshot({
                path: test.info().outputPath('checkpoint.png'),
                animations: 'disabled',
            });
        } finally {
            try {
                if (fixture) await deleteTrickplayCoverageFixture(sql, fixture);
            } finally {
                await sql.end();
            }
        }
    });
}
