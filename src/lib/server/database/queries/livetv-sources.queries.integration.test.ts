// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for LiveTV Sources Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { recordLiveTvFailureEvent } from './livetv-failure-events.queries.js';

import {
    getAllSources,
    getSourceById,
    getSourceByIdWithCredentials,
    createSource,
    updateSource,
    deleteSource,
    updateRefreshStatus,
    getSourceChannelCount,
    getSourcesWithRefreshCron,
    getAllSourcesWithChannelCounts,
} from './livetv-sources.queries.js';

describe('LiveTV Sources Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE livetv_channels, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
    });

    // ========================================================================
    // createSource
    // ========================================================================

    describe('createSource', () => {
        it('inserts an m3u source and returns safe row', async () => {
            const source = await createSource(sql, {
                name: 'Test M3U',
                source_type: 'm3u',
                m3u_url: 'http://test/m3u',
                max_streams: 3,
            });

            expect(source.id).toBeTruthy();
            expect(source.name).toBe('Test M3U');
            expect(source.source_type).toBe('m3u');
            expect(source.max_streams).toBe(3);
            // Safe row must not leak the upstream URL; assert absence at runtime.
            expect((source as unknown as Record<string, unknown>).m3u_url).toBeUndefined();
        });

        it('defaults max_streams to 1', async () => {
            const source = await createSource(sql, {
                name: 'Default Streams',
                source_type: 'xtream',
            });
            expect(source.max_streams).toBe(1);
        });
    });

    // ========================================================================
    // getAllSources / getSourceById / getSourceByIdWithCredentials
    // ========================================================================

    describe('getAllSources', () => {
        it('returns all sources ordered by created_at', async () => {
            const s1 = await createSource(sql, {
                name: 'A',
                source_type: 'm3u',
            });
            await new Promise((r) => setTimeout(r, 10));
            const s2 = await createSource(sql, {
                name: 'B',
                source_type: 'm3u',
            });

            const all = await getAllSources(sql);
            const ids = all.map((s) => s.id);
            expect(ids).toEqual([s1.id, s2.id]);
        });

        it('returns empty array when no sources', async () => {
            const all = await getAllSources(sql);
            expect(all).toEqual([]);
        });
    });

    describe('getSourceById', () => {
        it('returns the source with m3u_url and xmltv_url', async () => {
            const created = await createSource(sql, {
                name: 'Test',
                source_type: 'm3u',
                m3u_url: 'http://m3u',
                xmltv_url: 'http://xmltv',
            });

            const found = await getSourceById(sql, created.id);
            expect(found).not.toBeNull();
            expect(found!.name).toBe('Test');
            expect(found!.m3u_url).toBe('http://m3u');
            expect(found!.xmltv_url).toBe('http://xmltv');
        });

        it('returns null for non-existent source', async () => {
            const found = await getSourceById(sql, '00000000-0000-0000-0000-000000000000');
            expect(found).toBeNull();
        });
    });

    describe('getSourceByIdWithCredentials', () => {
        it('returns xtream credentials when present', async () => {
            const created = await createSource(sql, {
                name: 'Xtream',
                source_type: 'xtream',
                xtream_server: 'http://server',
                xtream_username: 'user',
                xtream_password: 'pass',
            });

            const found = await getSourceByIdWithCredentials(sql, created.id);
            expect(found).not.toBeNull();
            expect(found!.xtream_username).toBe('user');
            expect(found!.xtream_password).toBe('pass');
        });
    });

    // ========================================================================
    // updateSource
    // ========================================================================

    describe('updateSource', () => {
        it('updates name and returns updated row', async () => {
            const created = await createSource(sql, {
                name: 'Old',
                source_type: 'm3u',
            });
            const updated = await updateSource(sql, created.id, {
                name: 'New',
            });

            expect(updated).not.toBeNull();
            expect(updated!.name).toBe('New');
            expect(updated!.source_type).toBe('m3u'); // unchanged
        });

        it('returns null when source does not exist', async () => {
            const result = await updateSource(sql, '00000000-0000-0000-0000-000000000000', {
                name: 'X',
            });
            expect(result).toBeNull();
        });

        it('does not overwrite unset fields', async () => {
            const created = await createSource(sql, {
                name: 'Test',
                source_type: 'm3u',
                m3u_url: 'http://m3u',
            });
            const updated = await updateSource(sql, created.id, {
                max_streams: 5,
            });

            // updateSource returns LiveTvSourceSafeRow which excludes m3u_url
            const full = await getSourceByIdWithCredentials(sql, created.id);
            expect(full!.m3u_url).toBe('http://m3u');
            expect(updated!.max_streams).toBe(5);
        });
    });

    // ========================================================================
    // deleteSource
    // ========================================================================

    describe('deleteSource', () => {
        it('deletes an existing source and reports it', async () => {
            const created = await createSource(sql, {
                name: 'ToDelete',
                source_type: 'm3u',
            });
            const result = await deleteSource(sql, created.id);
            expect(result.deleted).toBe(true);
            expect(result.channelsDeleted).toBe(0);
            expect(await getSourceById(sql, created.id)).toBeNull();
        });

        it('returns deleted=false for a non-existent source', async () => {
            const result = await deleteSource(sql, '00000000-0000-0000-0000-000000000000');
            expect(result.deleted).toBe(false);
            expect(result.channelsDeleted).toBe(0);
        });

        it("cascade-deletes the source's channels and all dependent data", async () => {
            const source = await createSource(sql, { name: 'Cascade', source_type: 'm3u' });
            const other = await createSource(sql, { name: 'Keep', source_type: 'm3u' });

            // A backup group owned by the source.
            const [group] = await sql<{ id: string }[]>`
                INSERT INTO livetv_backup_groups (name, source_id)
                VALUES ('grp', ${source.id}::uuid)
                RETURNING id
            `;

            // Two channels for the source (media_items + livetv_channels) — one assigned
            // to the backup group — each with a program and a watch-history row.
            const channelIds: string[] = [];
            for (let i = 0; i < 2; i++) {
                const chId = crypto.randomUUID();
                channelIds.push(chId);
                await sql`
                    INSERT INTO media_items (id, title, media_type, status)
                    VALUES (${chId}::uuid, ${'Ch ' + i}, 'tvchannel', 'active')
                `;
                await sql`
                    INSERT INTO livetv_channels (id, m3u_url, source_id, backup_group_id)
                    VALUES (${chId}::uuid, ${'http://ch' + i}, ${source.id}::uuid, ${
                        i === 0 ? group.id : null
                    }::uuid)
                `;
                await sql`
                    INSERT INTO livetv_programs (channel_id, title, start_time, end_time)
                    VALUES (${chId}::uuid, 'Prog', NOW(), NOW() + INTERVAL '1 hour')
                `;
            }
            // (livetv_channel_watch_history also cascades via the same
            // channel_id → livetv_channels ON DELETE CASCADE FK as programs, but its
            // user_id is FK-constrained to a real user, so we don't seed it here.)

            // An active HLS playback token on the first channel. Its media_item_id FK
            // has no ON DELETE rule, so without explicit cleanup it would FK-block the
            // whole delete (channel being watched at delete time).
            const [watcher] = await sql<{ id: string }[]>`
                INSERT INTO users (username)
                VALUES (${'watcher-' + crypto.randomUUID()})
                RETURNING id
            `;
            await sql`
                INSERT INTO hls_playback_tokens (token_hash, username, user_id, client_ip, expires_at, media_item_id)
                VALUES (${'tok-' + crypto.randomUUID()}, 'watcher', ${watcher.id}::uuid, '127.0.0.1',
                        NOW() + INTERVAL '1 hour', ${channelIds[0]}::uuid)
            `;

            // A channel belonging to the OTHER source — must survive the delete.
            const keepId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${keepId}::uuid, 'Keep Ch', 'tvchannel', 'active')
            `;
            await sql`
                INSERT INTO livetv_channels (id, m3u_url, source_id)
                VALUES (${keepId}::uuid, 'http://keep', ${other.id}::uuid)
            `;

            // Stream failures on a deleted channel, on a channel id an earlier
            // re-import already replaced, and on the surviving channel.
            for (const [uid, channelId] of [
                [`gone-${source.id}`, channelIds[0]],
                [`orphan-${source.id}`, crypto.randomUUID()],
                [`kept-${source.id}`, keepId],
            ]) {
                await recordLiveTvFailureEvent(sql, {
                    eventUid: uid,
                    channelId,
                    occurredAt: new Date().toISOString(),
                    source: 'ingest',
                    outcome: 'crashed',
                    exitCode: 1,
                    signal: null,
                    rungId: null,
                    stderrTail: 'Connection timed out',
                    probe: null,
                    decision: null,
                });
            }

            const result = await deleteSource(sql, source.id);

            expect(result.deleted).toBe(true);
            expect(result.channelsDeleted).toBe(2);

            // The deleted source's stream failures are gone; the other source's stay.
            const failures = await sql<{ event_uid: string }[]>`
                SELECT event_uid FROM livetv_stream_failure_events
                WHERE event_uid IN (${`gone-${source.id}`}, ${`orphan-${source.id}`}, ${`kept-${source.id}`})
            `;
            expect(failures.map((f) => f.event_uid)).toEqual([`kept-${source.id}`]);

            // Source gone.
            expect(await getSourceById(sql, source.id)).toBeNull();

            // Channels gone — both the media_items and livetv_channels rows.
            expect(
                (await sql`SELECT id FROM media_items WHERE id = ANY(${channelIds}::uuid[])`)
                    .length,
            ).toBe(0);
            expect(
                (await sql`SELECT id FROM livetv_channels WHERE id = ANY(${channelIds}::uuid[])`)
                    .length,
            ).toBe(0);

            // Programs gone (cascaded from the deleted channels).
            expect(
                (
                    await sql`SELECT id FROM livetv_programs WHERE channel_id = ANY(${channelIds}::uuid[])`
                ).length,
            ).toBe(0);

            // Backup group gone (would otherwise orphan via SET NULL).
            expect(
                (await sql`SELECT id FROM livetv_backup_groups WHERE id = ${group.id}::uuid`)
                    .length,
            ).toBe(0);

            // The HLS token was cleared (otherwise its NO-ACTION FK would have
            // blocked the media_items delete and rolled the whole transaction back).
            expect(
                (
                    await sql`SELECT id FROM hls_playback_tokens WHERE media_item_id = ANY(${channelIds}::uuid[])`
                ).length,
            ).toBe(0);

            // The other source and its channel are untouched.
            expect(await getSourceById(sql, other.id)).not.toBeNull();
            expect((await sql`SELECT id FROM media_items WHERE id = ${keepId}::uuid`).length).toBe(
                1,
            );
        });
    });

    // ========================================================================
    // updateRefreshStatus
    // ========================================================================

    describe('updateRefreshStatus', () => {
        it('updates last refresh status', async () => {
            const created = await createSource(sql, {
                name: 'Test',
                source_type: 'm3u',
            });
            const ok = await updateRefreshStatus(sql, created.id, 'success', {
                channels: 10,
            });
            expect(ok).toBe(true);

            const found = await getSourceById(sql, created.id);
            expect(found!.last_refresh_status).toBe('success');
            expect(found!.last_refresh_summary).toEqual({ channels: 10 });
        });
    });

    // ========================================================================
    // getSourceChannelCount
    // ========================================================================

    describe('getSourceChannelCount', () => {
        it('returns 0 for source with no channels', async () => {
            const source = await createSource(sql, {
                name: 'Empty',
                source_type: 'm3u',
            });
            const count = await getSourceChannelCount(sql, source.id);
            expect(count).toBe(0);
        });

        it('returns the number of channels for a source', async () => {
            const source = await createSource(sql, {
                name: 'WithChannels',
                source_type: 'm3u',
            });
            // Insert media_items + livetv_channels manually
            for (let i = 0; i < 3; i++) {
                const chId = crypto.randomUUID();
                await sql`
                    INSERT INTO media_items (id, title, media_type, status)
                    VALUES (${chId}::uuid, ${'Ch ' + i}, 'tvchannel', 'active')
                `;
                await sql`
                    INSERT INTO livetv_channels (id, m3u_url, source_id)
                    VALUES (${chId}::uuid, ${'http://ch' + i}, ${source.id}::uuid)
                `;
            }
            const count = await getSourceChannelCount(sql, source.id);
            expect(count).toBe(3);
        });
    });

    // ========================================================================
    // getSourcesWithRefreshCron
    // ========================================================================

    describe('getSourcesWithRefreshCron', () => {
        it('returns only sources with a refresh cron', async () => {
            await createSource(sql, {
                name: 'Scheduled',
                source_type: 'm3u',
                refresh_cron: '0 4 * * *',
            });
            await createSource(sql, {
                name: 'Manual',
                source_type: 'm3u',
            });

            const cronSources = await getSourcesWithRefreshCron(sql);
            expect(cronSources).toHaveLength(1);
            expect(cronSources[0].name).toBe('Scheduled');
            expect(cronSources[0].refresh_cron).toBe('0 4 * * *');
        });
    });

    // ========================================================================
    // getAllSourcesWithChannelCounts
    // ========================================================================

    describe('getAllSourcesWithChannelCounts', () => {
        it('includes channel_count for each source', async () => {
            const s1 = await createSource(sql, {
                name: 'S1',
                source_type: 'm3u',
            });
            const chId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${chId}::uuid, 'Ch1', 'tvchannel', 'active')
            `;
            await sql`
                INSERT INTO livetv_channels (id, m3u_url, source_id)
                VALUES (${chId}::uuid, 'http://ch1', ${s1.id}::uuid)
            `;

            const all = await getAllSourcesWithChannelCounts(sql);
            const row = all.find((s) => s.id === s1.id);
            expect(row).toBeDefined();
            expect(row!.channel_count).toBe(1);
        });
    });
});
