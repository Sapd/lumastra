// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAnalyzerInputSnapshot } from '../database/queries/media-segment-input.queries.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { PipelineRemediationService } from './pipeline-remediation.service.js';
import {
    countReidentifyItems,
    loadReidentifyQueue,
    loadDeadLetterItems,
} from '../database/queries/ingest-map.queries.js';
import {
    countUnresolvedFailuresByPlugin,
    getFailureAggregates,
    markFailureEventsResolved,
    recordFailure,
} from '../database/queries/plugin-failure-events.queries.js';
import { countDeadLetterItemsByStage } from '../database/queries/attention.queries.js';
import { adaptDeadLetter } from './attention/adapters.js';
import { searchAdminQuickNav } from '../database/queries/search.queries.js';
import { unrestrictedAccess } from '../database/queries/builders/media-access-boundary.js';
import { setManualFileEpisodes } from './manual-file-links.service.js';
import { ensureTestUser } from '../../../../tests/integration/fixtures/user.fixtures.js';
import { MediaDeletionService } from './media-deletion.service.js';
import { CatalogService } from './catalog.service.js';
import {
    recordFailureAndMaybeQuarantine,
    POISON_FAILURE_THRESHOLD,
    ANALYZER_VISUAL_STAGE_ID,
    VISUAL_PROCESSING_VERSION,
} from '../tasks/builtin/native/lumastra-intro-analyzer.js';

const prefix = 'remediation-parity-';
let sql: postgres.Sql;
let directory: string;
const inputFileIds: string[] = [];
async function currentInput(id: string) {
    const fileId = crypto.randomUUID();
    inputFileIds.push(fileId);
    const filePath = join(directory, fileId + '.mkv');
    await writeFile(filePath, 'fictional remediation media');
    await sql`INSERT INTO media_files(id,file_path,duration_seconds) VALUES (${fileId},${filePath},1200)`;
    await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES (${fileId},${id},true)`;
    await sql`INSERT INTO media_streams(file_id,stream_type,stream_index) VALUES (${fileId},'video',0)`;
    return (await getAnalyzerInputSnapshot(sql, id))!;
}
async function item(
    type = 'movie',
    title = prefix + crypto.randomUUID(),
    parentId?: string,
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`INSERT INTO media_items (id, media_type, title, parent_id, has_files, season_number, episode_number)
        VALUES (${id}, ${type}, ${title}, ${parentId ?? null}, true, ${type === 'season' || type === 'episode' ? 1 : null}, ${type === 'episode' ? 1 : null})`;
    return id;
}
async function stage(
    id: string,
    stageId: string,
    status: string,
    reason: string | null = null,
    error: object = {},
): Promise<void> {
    await sql`INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, attempt, skipped_reason, last_error)
        VALUES (${id}, ${stageId}, ${stageId === ANALYZER_VISUAL_STAGE_ID ? VISUAL_PROCESSING_VERSION : 1}, ${status}, 7, ${reason}, ${sql.json(error as postgres.JSONValue)})`;
}
beforeAll(async () => {
    sql = getTestDb();
    directory = await mkdtemp(join(tmpdir(), prefix));
});
afterAll(async () => {
    await sql`DELETE FROM plugin_failure_events WHERE item_id IN (SELECT id::text FROM media_items WHERE title LIKE ${prefix + '%'})`;
    await sql`DELETE FROM media_items WHERE title LIKE ${prefix + '%'}`;
    await sql`DELETE FROM media_files WHERE file_path LIKE ${prefix + '%'}`;
    await sql`DELETE FROM media_files WHERE id=ANY(${inputFileIds}::uuid[])`;
    await rm(directory, { recursive: true, force: true });
    await closeTestDb();
});

describe('admin remediation parity', () => {
    it('bulk retry restores only failed/automatic poison rows and grants fresh budget without resolving history', async () => {
        const stageId = ANALYZER_VISUAL_STAGE_ID;
        const statuses = [
            ['failed_permanent', null],
            ['skipped_permanent', 'poison-episode: 5 failures'],
            ['skipped_permanent', 'operator-gave-up'],
            ['skipped_permanent', 'ineligible'],
            ['skipped_permanent', 'rule-specials'],
            ['completed', null],
            ['running', null],
        ];
        const ids: string[] = [];
        for (const [status, reason] of statuses) {
            const id = await item();
            ids.push(id);
            await stage(id, stageId, status!, reason, {
                message: 'ffmpeg failed',
                retryable: false,
            });
        }
        await stage(
            ids[1],
            prefix + 'other-stage',
            'skipped_permanent',
            'poison-episode: 5 failures',
        );
        const input = await currentInput(ids[1]);
        await sql`INSERT INTO plugin_failure_events (plugin_id,item_id,reason,stage_id,analysis_stage_id,processing_version,file_id,input_identity,occurred_at)
            SELECT 'lumastra-intro-analyzer',${ids[1]},'decode error',${stageId},${stageId},${VISUAL_PROCESSING_VERSION},${input.fileId},${input.inputIdentity},now()-interval '1 hour' FROM generate_series(1,5)`;
        await recordFailure(
            sql,
            'lumastra-intro-analyzer',
            ids[1],
            'unverified legacy',
            'legacy-run',
            stageId,
        );
        await recordFailure(
            sql,
            'lumastra-intro-analyzer',
            ids[1],
            'earlier detector',
            'earlier-run',
            stageId,
            {
                ...input,
                analysisStageId: stageId,
                processingVersion: VISUAL_PROCESSING_VERSION - 1,
            },
        );
        expect(
            (
                await getFailureAggregates(sql, 'lumastra-intro-analyzer', [ids[1]], stageId, false)
            ).get(ids[1])?.failure_count,
        ).toBe(5);
        const service = new PipelineRemediationService(sql);
        expect(await service.resetFailedForStage(stageId)).toBe(2);
        expect(await service.resetFailedForStage(stageId)).toBe(0);
        const rows =
            await sql`SELECT media_item_id, status, attempt, last_error, retry_budget_started_at FROM media_item_stage_state WHERE stage_id = ${stageId}`;
        expect(rows.filter((r) => r.status === 'pending')).toHaveLength(2);
        for (let i = 2; i < ids.length; i++) {
            const row = rows.find((r) => r.media_item_id === ids[i]);
            expect(row?.status).toBe(statuses[i][0]);
            expect(row?.attempt).toBe(7);
            expect(row?.retry_budget_started_at).toBeNull();
        }
        const [otherStage] =
            await sql`SELECT status, retry_budget_started_at FROM media_item_stage_state WHERE media_item_id = ${ids[1]} AND stage_id = ${prefix + 'other-stage'}`;
        expect(otherStage.status).toBe('skipped_permanent');
        expect(otherStage.retry_budget_started_at).toBeNull();
        expect(rows.find((r) => r.media_item_id === ids[1])?.attempt).toBe(0);
        expect(rows.find((r) => r.media_item_id === ids[1])?.last_error.message).toBe(
            'ffmpeg failed',
        );
        const [history] =
            await sql`SELECT count(*)::int AS count FROM plugin_failure_events WHERE item_id = ${ids[1]} AND resolved_at IS NULL`;
        expect(history.count).toBe(7);
        expect(
            (await getFailureAggregates(sql, 'lumastra-intro-analyzer', [ids[1]], stageId, true))
                .size,
        ).toBe(0);
        await recordFailure(
            sql,
            'lumastra-intro-analyzer',
            ids[1],
            'still broken',
            'fresh-run',
            stageId,
            { ...input, analysisStageId: stageId, processingVersion: VISUAL_PROCESSING_VERSION },
        );
        expect(
            (
                await getFailureAggregates(sql, 'lumastra-intro-analyzer', [ids[1]], stageId, true)
            ).get(ids[1])?.failure_count,
        ).toBe(1);
        await markFailureEventsResolved(
            sql,
            'lumastra-intro-analyzer',
            ids[1],
            stageId,
            input.inputIdentity,
        );
        expect(
            await sql`SELECT 1 FROM plugin_failure_events WHERE item_id=${ids[1]} AND reason IN ('unverified legacy','earlier detector') AND resolved_at IS NULL`,
        ).toHaveLength(2);
        expect(
            (await getFailureAggregates(sql, 'lumastra-intro-analyzer', [ids[1]], stageId, true))
                .size,
        ).toBe(0);
    });

    it('queue/count/accept share conservative identity semantics and operational failures remain visible once', async () => {
        const stageId = prefix + 'plugin-stage';
        const countBefore = await countReidentifyItems(sql, {});
        const cases = [
            {
                message: 'Plugin lookup identity is stale',
                remediation: 'identity',
            },
            {
                message: 'TMDB series id 42 no longer exists (404) while refreshing artwork',
                retryable: false,
            },
            { message: 'unsupported codec', retryable: false },
            { message: 'encrypted bytes', retryable: false },
            { message: 'generic permanent error', retryable: false },
            { message: '404 Not Found', retryable: false },
            { message: 'Provider returned 404 for an image', retryable: false },
            { message: 'TMDB 404 while reading encrypted codec file', retryable: false },
            { message: 'TMDB 404', remediation: 'operational', retryable: false },
            { message: 'truncated unreadable physical media', retryable: false },
            { message: 'TMDB image URL returned 404', retryable: false },
        ];
        const ids: string[] = [];
        for (const error of cases) {
            const id = await item();
            ids.push(id);
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${id}, 'custom-provider', ${id}, 'movie', true)`;
            await stage(id, stageId, 'failed_permanent', null, error);
        }
        const queue = await loadReidentifyQueue(sql, { limit: 1000, offset: 0 });
        expect(
            queue
                .filter((r) => ids.includes(r.media_item_id))
                .map((r) => r.media_item_id)
                .sort(),
        ).toEqual(ids.slice(0, 2).sort());
        const counts = await countReidentifyItems(sql, {});
        expect(counts).toBe(countBefore + 2);
        const totals = await countDeadLetterItemsByStage(sql);
        expect(totals.get('transient:' + stageId)).toBe(9);
        const alerts = adaptDeadLetter(await loadDeadLetterItems(sql, 1000), totals).filter(
            (a) => a.id === 'dead-letter:' + stageId,
        );
        expect(alerts).toHaveLength(1);
        expect(alerts[0].count).toBe(9);
        expect(alerts[0].actions?.some((a) => 'href' in a && a.href?.includes('fix-matches'))).toBe(
            false,
        );
        await sql`INSERT INTO plugin_failure_events (plugin_id, item_id, reason, stage_id) VALUES (${stageId}, ${ids[2]}, 'unsupported codec', ${stageId})`;
        expect(
            (await countUnresolvedFailuresByPlugin(sql)).some((r) => r.pluginId === stageId),
        ).toBe(false);
        const service = new PipelineRemediationService(sql);
        expect(await service.acceptReidentifyItem(ids[2], stageId)).toBe(0);
        expect(await service.acceptReidentifyForStage(stageId)).toBe(2);
        expect(await countReidentifyItems(sql, {})).toBe(countBefore);
    });

    it('series filtering happens before pagination', async () => {
        const title = prefix + 'Needle';
        const canonical = await item('tv', title);
        for (let i = 0; i < 35; i++) await item('movie', title);
        const results = await searchAdminQuickNav(sql, title, unrestrictedAccess(), 1, 'tv');
        expect(results.map((r) => r.id)).toEqual([canonical]);
    });

    it('cross-series reassignment preserves files/watch/manual links and remaining source files keep merge blocked', async () => {
        const source = await item('tv');
        const target = await item('tv');
        await sql`UPDATE media_items SET has_files = false WHERE id = ${target}`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary) VALUES (${source}, 'tmdb', '90041801', 'tv', true), (${target}, 'tmdb', '90041802', 'tv', true)`;
        const sourceSeason = await item('season', undefined, source);
        const targetSeason = await item('season', undefined, target);
        const oldEpisode = await item('episode', undefined, sourceSeason);
        const newEpisode = await item('episode', undefined, targetSeason);
        const userId = crypto.randomUUID();
        await ensureTestUser(sql, userId);
        const canonicalUserId = crypto.randomUUID();
        await ensureTestUser(sql, canonicalUserId);
        await sql`INSERT INTO user_media_state (user_id, media_id, resume_position_ms) VALUES (${canonicalUserId}, ${oldEpisode}, 1000), (${canonicalUserId}, ${newEpisode}, 85000)`;
        await sql`INSERT INTO user_media_state (user_id, media_id, resume_position_ms, watch_count) VALUES (${userId}, ${oldEpisode}, 42000, 3), (${userId}, ${source}, 12000, 1)`;
        await sql`INSERT INTO user_media_events (user_id, media_id, event_type, source, source_event_id, occurred_at)
            VALUES (${userId}, ${oldEpisode}, 'progress', 'lumastra-player', NULL, now() - interval '2 hours'),
                   (${userId}, ${newEpisode}, 'progress', 'lumastra-player', NULL, now() - interval '1 hour'),
                   (${userId}, ${oldEpisode}, 'progress', 'lumastra-player', 'same-identified-session', now() - interval '4 hours'),
                   (${userId}, ${newEpisode}, 'progress', 'lumastra-player', 'same-identified-session', now() - interval '3 hours')`;
        const [canonicalEvent] =
            await sql`SELECT id FROM user_media_events WHERE media_id = ${newEpisode} AND source_event_id = 'same-identified-session'`;

        const [file] =
            await sql`INSERT INTO media_files (file_path, duration_seconds) VALUES (${prefix + crypto.randomUUID()}, 100) RETURNING id`;
        const [remaining] =
            await sql`INSERT INTO media_files (file_path, duration_seconds) VALUES (${prefix + crypto.randomUUID()}, 100) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file.id}, ${oldEpisode}, true), (${remaining.id}, ${oldEpisode}, false)`;
        expect(
            (await setManualFileEpisodes(sql, file.id, [newEpisode], null, { seriesId: source }))
                .ok,
        ).toBe(false);
        const [unchanged] =
            await sql`SELECT media_item_id, offset_source FROM media_file_items WHERE file_id = ${file.id}`;
        expect(unchanged.media_item_id).toBe(oldEpisode);
        expect(unchanged.offset_source).toBeNull();
        expect(
            (await setManualFileEpisodes(sql, file.id, [newEpisode], null, { seriesId: target }))
                .ok,
        ).toBe(true);
        await expect(
            MediaDeletionService.mergeInto(sql, target, source, { guard: 'adminPair' }),
        ).rejects.toThrow();
        expect(
            (
                await setManualFileEpisodes(sql, remaining.id, [newEpisode], null, {
                    seriesId: target,
                })
            ).ok,
        ).toBe(true);
        const result = await MediaDeletionService.mergeInto(sql, target, source, {
            guard: 'adminPair',
        });
        expect(result.itemsDeleted).toBe(3);
        const [identity] =
            await sql`SELECT external_id FROM external_ids WHERE media_id = ${target} AND provider = 'tmdb'`;
        expect(identity.external_id).toBe('90041802');
        const links =
            await sql`SELECT file_id, offset_source FROM media_file_items WHERE media_item_id = ${newEpisode}`;
        expect(links.map((l) => l.file_id).sort()).toEqual([file.id, remaining.id].sort());
        expect(links.every((l) => l.offset_source === 'manual')).toBe(true);
        const watched =
            await sql`SELECT resume_position_ms FROM user_media_state WHERE user_id = ${userId} AND media_id = ${newEpisode}`;
        expect(Number(watched[0]?.resume_position_ms)).toBe(42000);
        const keptWatch =
            await sql`SELECT resume_position_ms FROM user_media_state WHERE user_id = ${userId} AND media_id = ${target}`;
        expect(Number(keptWatch[0]?.resume_position_ms)).toBe(12000);
        const [canonicalWatch] =
            await sql`SELECT resume_position_ms FROM user_media_state WHERE user_id = ${canonicalUserId} AND media_id = ${newEpisode}`;
        expect(Number(canonicalWatch.resume_position_ms)).toBe(85000);
        const events =
            await sql`SELECT id, source_event_id FROM user_media_events WHERE user_id = ${userId} AND media_id = ${newEpisode}`;
        expect(events.filter((e) => e.source_event_id === null)).toHaveLength(2);
        expect(
            events.filter((e) => e.source_event_id === 'same-identified-session').map((e) => e.id),
        ).toEqual([canonicalEvent.id]);

        await sql`DELETE FROM users WHERE id IN (${userId}, ${canonicalUserId})`;
        expect(
            await sql`SELECT id FROM media_files WHERE id IN (${file.id}, ${remaining.id})`,
        ).toHaveLength(2);
    });
    it('manual movie identify replaces a stale keeper provider ID after the guarded merge', async () => {
        const source = await item('movie');
        const target = await item('movie');
        await sql`UPDATE media_items SET has_files = false WHERE id = ${target}`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary) VALUES (${source}, 'tmdb', '90041801', 'movie', true), (${target}, 'tmdb', '90041802', 'movie', true)`;
        const [file] =
            await sql`INSERT INTO media_files (file_path) VALUES (${prefix + crypto.randomUUID()}) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file.id}, ${source}, true)`;
        await MediaDeletionService.mergeInto(sql, source, target, { guard: 'adminPair' });
        const [before] =
            await sql`SELECT external_id FROM external_ids WHERE media_id = ${source} AND provider = 'tmdb'`;
        expect(before.external_id).toBe('90041801');
        // The manual-match endpoint uses this exact source=manual contract.
        expect(
            await new CatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(
                source,
                {
                    provider: 'tmdb',
                    id: '90041802',
                    mediaType: 'movie',
                    source: 'manual',
                    confidence: 1,
                },
                true,
            ),
        ).toBe(true);
        const [after] =
            await sql`SELECT external_id FROM external_ids WHERE media_id = ${source} AND provider = 'tmdb'`;
        expect(after.external_id).toBe('90041802');
        expect(
            await sql`SELECT file_id FROM media_file_items WHERE media_item_id = ${source} AND file_id = ${file.id}`,
        ).toHaveLength(1);
    });
    it('actual analyzer helper counts only fresh strikes after an operator retry and quarantines at its threshold', async () => {
        const episode = await item('episode');
        const stageId = ANALYZER_VISUAL_STAGE_ID;
        const input = await currentInput(episode);
        await stage(episode, stageId, 'skipped_permanent', 'poison-episode: old strikes');
        await sql`INSERT INTO plugin_failure_events (plugin_id,item_id,reason,stage_id,analysis_stage_id,processing_version,file_id,input_identity,occurred_at)
            SELECT 'lumastra-intro-analyzer',${episode},'old strike',${stageId},${stageId},${VISUAL_PROCESSING_VERSION},${input.fileId},${input.inputIdentity},now()-interval '1 hour' FROM generate_series(1,5)`;
        expect(await new PipelineRemediationService(sql).resetFailedForStage(stageId)).toBe(1);
        const logger: Parameters<typeof recordFailureAndMaybeQuarantine>[1] = {
            info: () => undefined,
            debug: () => undefined,
            warn: () => undefined,
            error: () => undefined,
            child: () => logger,
        };
        await recordFailureAndMaybeQuarantine(
            sql,
            logger,
            episode,
            'first fresh codec failure',
            stageId,
            VISUAL_PROCESSING_VERSION,
            input,
        );
        const [first] =
            await sql`SELECT status FROM media_item_stage_state WHERE media_item_id = ${episode} AND stage_id = ${stageId}`;
        expect(first.status).toBe('pending');
        expect(
            (
                await getFailureAggregates(sql, 'lumastra-intro-analyzer', [episode], stageId, true)
            ).get(episode)?.failure_count,
        ).toBe(1);
        for (let i = 1; i < POISON_FAILURE_THRESHOLD; i++)
            await recordFailureAndMaybeQuarantine(
                sql,
                logger,
                episode,
                'fresh failure',
                stageId,
                VISUAL_PROCESSING_VERSION,
                input,
            );
        const [last] =
            await sql`SELECT status, skipped_reason FROM media_item_stage_state WHERE media_item_id = ${episode} AND stage_id = ${stageId}`;
        expect(last.status).toBe('skipped_permanent');
        expect(last.skipped_reason).toContain(
            `poison-episode: ${POISON_FAILURE_THRESHOLD} failures`,
        );
        const [history] =
            await sql`SELECT count(*)::int AS count FROM plugin_failure_events WHERE item_id = ${episode} AND resolved_at IS NULL`;
        expect(history.count).toBe(5 + POISON_FAILURE_THRESHOLD);
    });
});
