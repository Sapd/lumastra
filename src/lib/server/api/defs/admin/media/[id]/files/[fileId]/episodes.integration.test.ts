// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestSeries } from '../../../../../../../../../../tests/integration/fixtures/index.js';
import {
    FileEpisodesResponseSchema,
    SetFileEpisodesRequestSchema,
} from '$lib/schemas/admin-file-episodes.js';

let sql: postgres.Sql;
vi.mock('$lib/server/database/connection.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/database/connection.js')>()),
    getDb: () => sql,
}));
const { def } = await import('./episodes.js');

beforeAll(() => {
    sql = getTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
});
afterAll(async () => {
    await closeTestDb();
});

it('carries typed GET evidence through Save/reset and rejects stale or missing review with 409 and zero mutation', async () => {
    const { seriesId } = await createAndInsertTestSeries(sql, {
        seasonCount: 1,
        episodesPerSeason: 2,
    });
    const episodes = await sql<
        { id: string }[]
    >`SELECT ep.id FROM media_items ep JOIN media_items season ON season.id=ep.parent_id WHERE season.parent_id=${seriesId} AND ep.media_type='episode' ORDER BY ep.episode_number`;
    const fileId = crypto.randomUUID();
    await sql`INSERT INTO media_files(id,file_path,duration_seconds) VALUES(${fileId},'/fictional/reviewed.mkv',60)`;
    const event = {
        params: { id: seriesId, fileId },
        locals: { user: { username: 'endpoint-reviewer' } },
        url: new URL('http://localhost/admin'),
    } as unknown as RequestEvent;
    const response = await def.handlers.GET!(event, {} as never);
    const review = FileEpisodesResponseSchema.parse(await response.json());
    const body = SetFileEpisodesRequestSchema.parse({
        revision: review.revision,
        episodes: [...episodes]
            .reverse()
            .map((ep, i) => ({ mediaItemId: ep.id, startMs: i * 30000, endMs: (i + 1) * 30000 })),
    });
    await sql`UPDATE media_files SET duration_seconds=61 WHERE id=${fileId}`;
    const stale = await def.handlers.PUT!(event, { input: { body } } as never);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'conflict', status: 409 });
    expect(
        (
            await def.handlers.DELETE!(event, {
                input: { body: { revision: review.revision } },
            } as never)
        ).status,
    ).toBe(409);
    expect(
        (await def.handlers.PUT!(event, { input: { body: { episodes: body.episodes } } } as never))
            .status,
    ).toBe(409);
    expect(
        await sql`SELECT media_item_id FROM media_file_items WHERE file_id=${fileId}`,
    ).toHaveLength(0);
    expect(await sql`SELECT id FROM audit_log WHERE target=${fileId}`).toHaveLength(0);
    await sql`UPDATE media_files SET duration_seconds=60 WHERE id=${fileId}`;
    const fresh = FileEpisodesResponseSchema.parse(
        await (await def.handlers.GET!(event, {} as never)).json(),
    );
    const savedResponse = await def.handlers.PUT!(event, {
        input: { body: { ...body, revision: fresh.revision } },
    } as never);
    expect(savedResponse.status).toBe(200);
    const saved = FileEpisodesResponseSchema.parse(await savedResponse.json());
    expect(saved.links.map((l) => l.mediaItemId)).toEqual(
        [...episodes].reverse().map((ep) => ep.id),
    );
    expect(
        (
            await def.handlers.DELETE!(event, {
                input: { body: { revision: fresh.revision } },
            } as never)
        ).status,
    ).toBe(409);
    const reset = await def.handlers.DELETE!(event, {
        input: { body: { revision: saved.revision } },
    } as never);
    expect(reset.status).toBe(200);
    expect(FileEpisodesResponseSchema.parse(await reset.json()).file.manual).toBe(false);
    expect(
        await sql`SELECT id FROM audit_log WHERE target=${fileId} AND actor='endpoint-reviewer'`,
    ).toHaveLength(2);
});

it('passes explicit restoration consent from the admin request and exposes current dismissal evidence', async () => {
    const { seriesId } = await createAndInsertTestSeries(sql, {
        seasonCount: 1,
        episodesPerSeason: 2,
    });
    const episodes = await sql<
        { id: string }[]
    >`SELECT ep.id FROM media_items ep JOIN media_items season ON season.id=ep.parent_id WHERE season.parent_id=${seriesId} AND ep.media_type='episode' ORDER BY ep.episode_number`;
    const fileId = crypto.randomUUID();
    await sql`INSERT INTO media_files(id,file_path,duration_seconds) VALUES(${fileId},'/fictional/dismissed-review.mkv',60)`;
    await sql`UPDATE media_items SET is_dismissed=true,dismissed_at=now() WHERE id=ANY(${episodes.map((ep) => ep.id)}::uuid[])`;
    const event = {
        params: { id: seriesId, fileId },
        locals: { user: { username: 'endpoint-consent' } },
        url: new URL('http://localhost/admin'),
    } as unknown as RequestEvent;
    const review = FileEpisodesResponseSchema.parse(
        await (await def.handlers.GET!(event, {} as never)).json(),
    );
    expect(review.episodes.every((ep) => ep.isDismissed)).toBe(true);
    const body = SetFileEpisodesRequestSchema.parse({
        revision: review.revision,
        episodes: [{ mediaItemId: episodes[0].id }],
    });
    expect((await def.handlers.PUT!(event, { input: { body } } as never)).status).toBe(422);
    expect(await sql`SELECT * FROM media_file_items WHERE file_id=${fileId}`).toHaveLength(0);
    const saved = await def.handlers.PUT!(event, {
        input: { body: { ...body, restoreDismissedEpisodeIds: [episodes[0].id] } },
    } as never);
    expect(saved.status).toBe(200);
    const data = FileEpisodesResponseSchema.parse(await saved.json());
    expect(data.links[0]).toMatchObject({
        mediaItemId: episodes[0].id,
        isDismissed: false,
        dismissedAt: null,
    });
    expect(data.episodes.find((ep) => ep.id === episodes[1].id)?.isDismissed).toBe(true);
});
