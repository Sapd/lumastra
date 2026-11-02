// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from 'postgres';
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getTestDb,
    getTestDatabaseUrl,
} from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { createCatalogService } from './catalog.service.js';
import { MediaLifecycleService } from './media-lifecycle.service.js';
import * as connection from '$lib/server/database/connection.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { RequestEvent } from '@sveltejs/kit';
import { GET, POST } from '../../../routes/api/admin/media/[id]/external-ids/exchange/+server.js';

describe('reviewed episode TMDB exchange', () => {
    let sql: Sql;
    const series = randomUUID();
    const season = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const outsider = randomUUID();
    const otherSeries = randomUUID();
    const otherSeason = randomUUID();
    const file = randomUUID();
    const user = randomUUID();
    const actor = {
        username: 'fixture-reviewer',
        kind: 'pat' as const,
        credentialId: 'fixture-pat',
    };

    beforeAll(() => {
        sql = getTestDb();
    });
    beforeEach(async () => {
        vi.restoreAllMocks();
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM audit_log WHERE target = ${series}`;
        await sql`INSERT INTO users(id,username) VALUES (${user},'fixture-reviewer') ON CONFLICT (id) DO NOTHING`;
        await sql`INSERT INTO media_items(id,title,media_type,status) VALUES (${series},'Invented Series','tv','active')`;
        await sql`INSERT INTO media_items(id,title,media_type,status) VALUES (${otherSeries},'Other Invented Series','tv','active')`;
        await sql`INSERT INTO media_items(id,title,media_type,status,parent_id,season_number) VALUES (${season},'Season One','season','active',${series},1)`;
        await sql`INSERT INTO media_items(id,title,media_type,status,parent_id,season_number) VALUES (${otherSeason},'Other Season','season','active',${otherSeries},1)`;
        await sql`
            INSERT INTO media_items(id,title,media_type,status,parent_id,season_number,episode_number,overview,metadata_locked,title_binding)
            VALUES (${first},'Pilot A','episode','active',${season},1,1,'Original A',true,'identity'),
                   (${second},'Pilot B','episode','active',${season},1,2,'Original B',false,'position')
        `;
        await sql`INSERT INTO media_items(id,title,media_type,status,parent_id) VALUES (${outsider},'Elsewhere','episode','active',${otherSeason})`;
        await sql`
            INSERT INTO external_ids(media_id,provider,external_id,media_type,is_primary,source)
            VALUES (${first},'tmdb','70101','episode',true,'scanner'),
                   (${second},'tmdb','70202','episode',true,'manual'),
                   (${outsider},'tmdb','70303','episode',true,'scanner')
        `;
        await sql`INSERT INTO media_files(id,file_path) VALUES (${file},'/fictional/episode-a.mkv')`;
        await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default,start_offset_ms,end_offset_ms) VALUES (${file},${first},true,1000,5000)`;
        await sql`INSERT INTO provider_metadata(media_id,provider,metadata) VALUES (${first},'tmdb',${sql.json({ title: 'Do not rewrite' })})`;
        await sql`INSERT INTO user_media_state(user_id,media_id,is_watched,resume_position_ms) VALUES (${user},${first},true,123000)`;
    });
    afterAll(async () => {
        vi.restoreAllMocks();
        await sql`DELETE FROM audit_log WHERE target = ${series}`;
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM users WHERE id = ${user}`;
    });
    afterEach(async () => {
        await sql`UPDATE feature_flags SET value='off' WHERE key='event_outbox_enabled'`;
    });

    const mapping = async (): Promise<
        Array<{ media_id: string; external_id: string; id: number; source: string }>
    > =>
        sql`SELECT media_id,external_id,id,source FROM external_ids WHERE provider='tmdb' AND media_type='episode' ORDER BY media_id`;

    it('exchanges both IDs atomically while preserving rows, links, locks, metadata and watch state', async () => {
        const service = createCatalogService(sql, { skipLifecycleHooks: true });
        const preview = await service.previewEpisodeTmdbExchange(first, second);
        expect(preview).toMatchObject({
            series: { id: series, title: 'Invented Series' },
            first: { id: first, tmdbId: '70101', seasonNumber: 1, episodeNumber: 1 },
            second: { id: second, tmdbId: '70202', seasonNumber: 1, episodeNumber: 2 },
        });
        const [before] = await sql`
            SELECT (SELECT jsonb_agg(to_jsonb(mi) ORDER BY mi.id) FROM media_items mi WHERE mi.id IN (${first},${second})) AS items,
                   (SELECT jsonb_agg(to_jsonb(mfi)) FROM media_file_items mfi WHERE mfi.media_item_id=${first}) AS links,
                   (SELECT jsonb_agg(to_jsonb(pm)) FROM provider_metadata pm WHERE pm.media_id=${first}) AS metadata,
                   (SELECT jsonb_agg(to_jsonb(ums)) FROM user_media_state ums WHERE ums.media_id=${first}) AS watched
        `;
        const old = await mapping();
        await sql`UPDATE feature_flags SET value='on' WHERE key='event_outbox_enabled'`;
        const saved = await service.exchangeEpisodeTmdbIds(first, second, preview.snapshot, actor);
        expect(saved.first.tmdbId).toBe('70202');
        expect(saved.second.tmdbId).toBe('70101');
        const after = await mapping();
        expect(after.find((row) => row.media_id === first)).toMatchObject({
            id: old.find((row) => row.media_id === first)?.id,
            external_id: '70202',
            source: 'manual',
        });
        expect(after.find((row) => row.media_id === second)).toMatchObject({
            id: old.find((row) => row.media_id === second)?.id,
            external_id: '70101',
            source: 'manual',
        });
        expect(after.find((row) => row.media_id === outsider)?.external_id).toBe('70303');
        const [preserved] = await sql`
            SELECT (SELECT jsonb_agg(to_jsonb(mi) ORDER BY mi.id) FROM media_items mi WHERE mi.id IN (${first},${second})) AS items,
                   (SELECT jsonb_agg(to_jsonb(mfi)) FROM media_file_items mfi WHERE mfi.media_item_id=${first}) AS links,
                   (SELECT jsonb_agg(to_jsonb(pm)) FROM provider_metadata pm WHERE pm.media_id=${first}) AS metadata,
                   (SELECT jsonb_agg(to_jsonb(ums)) FROM user_media_state ums WHERE ums.media_id=${first}) AS watched
        `;
        expect(preserved).toEqual(before);
        const [audit] = await sql`
            SELECT actor,principal_kind,credential_id,detail FROM audit_log
            WHERE target=${series} AND action='media.episode-tmdb.exchange'
        `;
        expect(audit).toMatchObject({
            actor: actor.username,
            principal_kind: 'pat',
            credential_id: actor.credentialId,
        });
        expect(audit.detail.first).toMatchObject({ mediaId: first, from: '70101', to: '70202' });
        const events = await sql`
            SELECT event_name,media_item_id FROM event_outbox
            WHERE media_item_id IN (${first},${second}) AND event_name LIKE 'identity.%'
        `;
        expect(events.filter((row) => row.event_name === 'identity.cleared')).toHaveLength(2);
        expect(events.filter((row) => row.event_name === 'identity.assigned')).toHaveLength(2);
    });

    it('undo restores both complete provider rows and refuses a later pair edit', async () => {
        const service = createCatalogService(sql, { skipLifecycleHooks: true });
        const original =
            await sql`SELECT * FROM external_ids WHERE media_id IN (${first},${second}) ORDER BY id`;
        const preview = await service.previewEpisodeTmdbExchange(first, second);
        const swapped = await service.exchangeEpisodeTmdbIds(
            first,
            second,
            preview.snapshot,
            actor,
        );
        expect(swapped.undoId).toBeTruthy();
        expect(swapped.snapshot).not.toBe(preview.snapshot);
        await sql`UPDATE media_items SET overview='Later provider description' WHERE id=${first}`;
        expect((await service.previewEpisodeTmdbExchange(first, second)).undoId).toBe(
            swapped.undoId,
        );
        const restored = await service.exchangeEpisodeTmdbIds(
            first,
            second,
            swapped.snapshot,
            actor,
            swapped.undoId,
        );
        expect((await sql`SELECT overview FROM media_items WHERE id=${first}`)[0].overview).toBe(
            'Later provider description',
        );
        expect(restored.first.tmdbId).toBe(preview.first.tmdbId);
        expect(
            await sql`SELECT * FROM external_ids WHERE media_id IN (${first},${second}) ORDER BY id`,
        ).toEqual(original);
        await service.exchangeEpisodeTmdbIds(
            first,
            second,
            swapped.snapshot,
            actor,
            swapped.undoId,
        );
        const next = await service.exchangeEpisodeTmdbIds(first, second, restored.snapshot, actor);
        await sql`UPDATE media_file_items SET end_offset_ms=7000 WHERE file_id=${file} AND media_item_id=${first}`;
        await expect(
            service.exchangeEpisodeTmdbIds(first, second, next.snapshot, actor, next.undoId),
        ).rejects.toMatchObject({ reason: 'changed' });
    });

    it('rejects stale review and rolls back without audit or partial exchange', async () => {
        const service = createCatalogService(sql, { skipLifecycleHooks: true });
        const preview = await service.previewEpisodeTmdbExchange(first, second);
        await sql`UPDATE media_items SET metadata_locked=true WHERE id=${second}`;
        await expect(
            service.exchangeEpisodeTmdbIds(first, second, preview.snapshot, actor),
        ).rejects.toMatchObject({ reason: 'changed' });
        expect((await mapping()).find((row) => row.media_id === first)?.external_id).toBe('70101');
        expect(
            await sql`SELECT 1 FROM audit_log WHERE target=${series} AND action='media.episode-tmdb.exchange'`,
        ).toHaveLength(0);
    });

    it('rejects a changed file association before changing either ID', async () => {
        const service = createCatalogService(sql, { skipLifecycleHooks: true });
        const preview = await service.previewEpisodeTmdbExchange(first, second);
        await sql`UPDATE media_file_items SET end_offset_ms=6000 WHERE file_id=${file} AND media_item_id=${first}`;
        await expect(
            service.exchangeEpisodeTmdbIds(first, second, preview.snapshot, actor),
        ).rejects.toMatchObject({ reason: 'changed' });
        expect((await mapping()).find((row) => row.media_id === first)?.external_id).toBe('70101');
    });

    it('rolls back both removals if the replacement cannot be inserted', async () => {
        const service = createCatalogService(sql, { skipLifecycleHooks: true });
        const preview = await service.previewEpisodeTmdbExchange(first, second);
        await sql`
            ALTER TABLE external_ids ADD CONSTRAINT test_episode_exchange_reject
            CHECK (NOT (provider = 'tmdb' AND media_type = 'episode'
                       AND source = 'manual' AND external_id = '70101'))
        `;
        try {
            await expect(
                service.exchangeEpisodeTmdbIds(first, second, preview.snapshot, actor),
            ).rejects.toThrow();
        } finally {
            await sql`ALTER TABLE external_ids DROP CONSTRAINT test_episode_exchange_reject`;
        }
        expect((await mapping()).find((row) => row.media_id === first)?.external_id).toBe('70101');
        expect((await mapping()).find((row) => row.media_id === second)?.external_id).toBe('70202');
        expect(
            await sql`SELECT 1 FROM audit_log WHERE target=${series} AND action='media.episode-tmdb.exchange'`,
        ).toHaveLength(0);
    });

    it('rejects other owners and invalid pairs without moving an ID', async () => {
        const service = createCatalogService(sql, { skipLifecycleHooks: true });
        await expect(service.previewEpisodeTmdbExchange(first, first)).rejects.toMatchObject({
            reason: 'invalid_pair',
        });
        await expect(service.previewEpisodeTmdbExchange(first, outsider)).rejects.toMatchObject({
            reason: 'other_series',
        });
        await sql`DELETE FROM external_ids WHERE media_id=${second} AND provider='tmdb'`;
        await expect(service.previewEpisodeTmdbExchange(first, second)).rejects.toMatchObject({
            reason: 'missing_id',
        });
        const ids = await mapping();
        expect(ids.find((row) => row.media_id === outsider)?.external_id).toBe('70303');
    });

    it('serializes racing confirmations and runs lifecycle only after both assignments commit', async () => {
        const preview = await createCatalogService(sql, {
            skipLifecycleHooks: true,
        }).previewEpisodeTmdbExchange(first, second);
        const seen: string[][] = [];
        vi.spyOn(MediaLifecycleService, 'afterExternalIdChanged').mockImplementation(async () => {
            const rows = await mapping();
            seen.push([
                rows.find((row) => row.media_id === first)!.external_id,
                rows.find((row) => row.media_id === second)!.external_id,
            ]);
        });
        const url = getTestDatabaseUrl();
        const a = postgres(url, { max: 1 });
        const b = postgres(url, { max: 1 });
        try {
            const outcomes = await Promise.allSettled([
                createCatalogService(a).exchangeEpisodeTmdbIds(
                    first,
                    second,
                    preview.snapshot,
                    actor,
                ),
                createCatalogService(b).exchangeEpisodeTmdbIds(
                    first,
                    second,
                    preview.snapshot,
                    actor,
                ),
            ]);
            expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
            expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
            expect(
                (outcomes.find((result) => result.status === 'rejected') as PromiseRejectedResult)
                    .reason,
            ).toMatchObject({ reason: 'changed' });
            await vi.waitFor(() => expect(seen).toHaveLength(2));
            expect(seen).toEqual([
                ['70202', '70101'],
                ['70202', '70101'],
            ]);
        } finally {
            await Promise.all([a.end(), b.end()]);
        }
    });

    it('requires admin auth and a current pair snapshot on the mounted route', async () => {
        vi.spyOn(connection, 'getDb').mockReturnValue(sql);
        const admin = buildPrincipal({
            kind: 'pat',
            userId: toUserId(user),
            username: actor.username,
            userGroups: [],
            tokenScopes: ['admin'],
            ownerIsAdmin: true,
        });
        const viewer = buildPrincipal({
            kind: 'pat',
            userId: toUserId(user),
            username: 'fixture-viewer',
            userGroups: [],
            tokenScopes: ['read'],
            ownerIsAdmin: false,
        });
        const request = (
            method: 'GET' | 'POST',
            principal: Principal | null,
            body?: unknown,
        ): RequestEvent => {
            const url = new URL(
                `http://localhost/api/admin/media/${first}/external-ids/exchange?otherId=${second}`,
            );
            return {
                url,
                params: { id: first },
                request: new Request(url, {
                    method,
                    ...(body === undefined
                        ? {}
                        : {
                              headers: { 'content-type': 'application/json' },
                              body: JSON.stringify(body),
                          }),
                }),
                locals: { principal },
                cookies: { get: () => undefined },
            } as unknown as RequestEvent;
        };
        expect((await GET!(request('GET', viewer))).status).toBe(403);
        expect((await GET!(request('GET', null))).status).toBe(403);
        const previewResponse = await GET!(request('GET', admin));
        expect(previewResponse.status).toBe(200);
        const preview = (await previewResponse.json()) as { snapshot: string };
        expect(
            (
                await POST!(
                    request('POST', admin, {
                        otherId: second,
                        snapshot: 'invalid',
                    }),
                )
            ).status,
        ).toBe(422);
        expect(
            (
                await POST!(
                    request('POST', viewer, {
                        otherId: second,
                        snapshot: preview.snapshot,
                    }),
                )
            ).status,
        ).toBe(403);
        const saved = await POST!(
            request('POST', admin, {
                otherId: second,
                snapshot: preview.snapshot,
            }),
        );
        expect(saved.status).toBe(200);
        expect((await saved.json()).first.tmdbId).toBe('70202');
    });
});
