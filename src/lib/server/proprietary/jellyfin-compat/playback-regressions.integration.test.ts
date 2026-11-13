// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database';

const h = vi.hoisted(() => ({
    sql: null as postgres.Sql | null,
    access: vi.fn(async () => true),
    stopJob: vi.fn(async () => true),
    stopByItem: vi.fn(async () => true),
    cleanup: vi.fn(async () => undefined),
    stoppedEvent: vi.fn(async () => undefined),
    username: '',
    userId: '',
}));
vi.mock('$lib/server/database/connection', async (original) => ({
    ...(await original<typeof import('$lib/server/database/connection')>()),
    getDb: () => h.sql,
}));
vi.mock('$lib/server/services/database.service', () => ({
    aiDbService: { getSql: async () => h.sql },
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => (event: RequestEvent) =>
        event.locals.user ? handler(event) : new Response(null, { status: 401 }),
}));
vi.mock('$lib/server/middleware/media-access', () => ({ checkMediaAccess: h.access }));
vi.mock('$lib/server/proprietary/jellyfin-compat/silent-start', () => ({
    disarmSilentStart: vi.fn(),
}));
vi.mock('$lib/server/services/session-kill.service', () => ({
    checkSessionKickCooldown: async () => ({ kicked: false }),
}));
vi.mock('$lib/server/services/ffmpeg-transcode.service', () => ({
    getFFmpegTranscodeService: () => ({
        stopJob: h.stopJob,
        stopJobByItemAndUser: h.stopByItem,
        stopJobForUser: h.stopJob,
        recordProgressHeartbeat: vi.fn(),
        getProgress: vi.fn(),
    }),
}));
vi.mock('$lib/server/services/playback-telemetry.service', () => ({
    playbackTelemetryService: { computeSessionQualityOnStop: vi.fn() },
}));
vi.mock('$lib/server/services/watched-cache.service', () => ({
    invalidateAllWatchedCaches: h.cleanup,
}));
vi.mock('$lib/server/plugins/runtime/integration-events', () => ({
    publishIntegrationEvent: h.stoppedEvent,
}));

import { findOrCreateJellyfinSession } from './playback-utils';
import { findActiveSession } from '$lib/server/database/queries/play-sessions.queries';
import { isPolicyError } from '$lib/server/services/play-sessions.service';
import {
    issuePlayToken,
    issueFileToken,
    validatePlayToken,
    revokePlayTokenBySession,
    renewPlayTokenBySession,
} from './play-token';
import { POST as playing } from '../../../../routes/(proprietary)/j/Sessions/Playing/+server';
import { POST as progress } from '../../../../routes/(proprietary)/j/Sessions/Playing/Progress/+server';
import { POST as stopped } from '../../../../routes/(proprietary)/j/Sessions/Playing/Stopped/+server';
import {
    POST as legacyStart,
    DELETE as legacyStop,
} from '../../../../routes/(proprietary)/j/Users/[userId]/PlayingItems/[itemId]/+server';
import { POST as legacyProgress } from '../../../../routes/(proprietary)/j/Users/[userId]/PlayingItems/[itemId]/Progress/+server';

const itemId = randomUUID();
const channelId = randomUUID();
const shortMovieId = randomUUID();
const longMovieId = randomUUID();
const files = [randomUUID(), randomUUID()];
const userId = randomUUID();
const username = `jreg_${userId.slice(0, 8)}`;

function event(
    item: string,
    sessionId?: string,
    method = 'POST',
    positionMs = 42000,
    signedIn = true,
): RequestEvent {
    const url = new URL(
        `https://app.example/j/PlayingItems/${item}?positionTicks=${positionMs * 10000}${sessionId ? `&playSessionId=${sessionId}` : ''}`,
    );
    return {
        params: { itemId: item },
        url,
        request: new Request(url, {
            method,
            headers: { 'content-type': 'application/json', Range: 'bytes=10-19' },
            ...(method === 'POST'
                ? {
                      body: JSON.stringify({
                          ItemId: item,
                          PlaySessionId: sessionId,
                          PositionTicks: positionMs * 10000,
                      }),
                  }
                : {}),
        }),
        locals: signedIn
            ? {
                  user: { userId: toUserId(userId), username },
                  jfDevice: { deviceId: 'jreg-device' },
              }
            : {},
        getClientAddress: () => '127.0.0.1',
    } as unknown as RequestEvent;
}
async function start(
    sessionId?: string,
    mediaId = itemId,
    deviceId = 'android-tv',
): Promise<string> {
    const row = await findOrCreateJellyfinSession(h.sql!, {
        userId: toUserId(userId),
        username,
        itemId: mediaId,
        positionMs: 0,
        ipAddress: '127.0.0.1',
        playSessionId: sessionId,
        device: { deviceId, deviceName: 'Living room', clientName: 'Jellyfin TV' },
    });
    if (isPolicyError(row)) throw new Error(row.kind);
    return row.id;
}
async function row(id: string) {
    const [result] = await h.sql!`SELECT * FROM play_sessions WHERE id = ${id}`;
    return result!;
}

beforeAll(async () => {
    h.sql = await getTestDb();
    const { connectValkey } = await import('$lib/server/cache/valkey');
    expect(await connectValkey()).toBe(true);
    h.userId = userId;
    h.username = username;
    await h.sql`INSERT INTO users (id, username) VALUES (${userId}, ${username})`;
    await h.sql`INSERT INTO media_items (id, title, media_type, has_files, runtime_seconds)
        VALUES (${itemId}, 'Jellyfin regression movie', 'movie', true, 7200),
               (${channelId}, 'Jellyfin regression channel', 'tvchannel', false, null),
               (${shortMovieId}, 'Short resume regression', 'movie', true, 90),
               (${longMovieId}, 'Long resume regression', 'movie', true, 1800)`;
    for (const [i, file] of files.entries()) {
        await h.sql`INSERT INTO media_files (id, file_path, duration_seconds, part_number)
            VALUES (${file}, ${`/tmp/jreg-${file}.mp3`}, 3600, ${i + 1})`;
        await h.sql`INSERT INTO media_streams (file_id, stream_index, stream_type, codec, channels, sample_rate)
            VALUES (${file}, 0, 'audio', 'mp3', 2, 44100)`;
        await h.sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
            VALUES (${file}, ${itemId}, ${i === 0}, ${i})`;
    }
});
beforeEach(async () => {
    vi.clearAllMocks();
    await h.sql!`DELETE FROM user_stream_policies WHERE user_id = ${username}`;
    await h.sql!`DELETE FROM play_sessions WHERE user_id = ${userId}`;
    await h.sql!`DELETE FROM user_media_state WHERE user_id = ${userId}`;
    await h.sql!`DELETE FROM user_media_events WHERE user_id = ${userId}`;
});
afterAll(async () => {
    await h.sql!`DELETE FROM user_stream_policies WHERE user_id = ${username}`;
    await h.sql!`DELETE FROM play_sessions WHERE user_id = ${userId}`;
    await h.sql!`DELETE FROM media_items WHERE id IN (${itemId}, ${channelId}, ${shortMovieId}, ${longMovieId})`;
    await h.sql!`DELETE FROM media_files WHERE id = ANY(${files}::uuid[])`;
    await h.sql!`DELETE FROM users WHERE id = ${userId}`;
    await closeTestDb();
});

describe('third-party client durable resume reports', () => {
    for (const client of ['Findroid', 'Swiftfin', 'Infuse']) {
        for (const withSessionId of [false, true]) {
            for (const [movie, positionMs] of [
                [shortMovieId, 35_000],
                [shortMovieId, 70_000],
                [shortMovieId, 80_000],
                [longMovieId, 720_000],
            ] as const) {
                it(`${client}, explicit session ${withSessionId}, position ${positionMs}: saves resume through /j`, async () => {
                    const sid = withSessionId ? randomUUID() : undefined;
                    const report = (position: number): RequestEvent => {
                        const e = event(movie, sid, 'POST', position);
                        e.locals.jfDevice = {
                            deviceId: `resume-${client}`,
                            clientName: client,
                            deviceName: 'Regression client',
                            clientVersion: '1.0',
                        };
                        return e;
                    };
                    expect((await playing(report(0) as never)).status).toBe(204);
                    const { readUserItemData } = await import('./user-item-data');
                    for (const [handler, expectedMs] of [
                        [progress, positionMs - 2_000],
                        [stopped, positionMs],
                    ] as const) {
                        expect((await handler(report(expectedMs) as never)).status).toBe(204);
                        const [state] = await h.sql!`SELECT resume_position_ms, is_watched
                            FROM user_media_state WHERE user_id = ${userId} AND media_id = ${movie}`;
                        expect(Number(state?.resume_position_ms)).toBe(expectedMs);
                        expect(state?.is_watched).toBe(false);
                        expect(
                            (await readUserItemData(h.sql!, movie, toUserId(userId)))
                                ?.PlaybackPositionTicks,
                        ).toBe(expectedMs * 10_000);
                    }
                    const [session] = await h.sql!`SELECT status FROM play_sessions
                        WHERE user_id = ${userId} AND media_id = ${movie}`;
                    expect(session?.status).toBe('COMPLETED');
                });
            }
        }
    }
});

describe('legacy file-id reports', () => {
    for (const [name, handler] of [
        ['start', legacyStart],
        ['progress', legacyProgress],
    ] as const) {
        it(`${name} resolves part 2 to its owner and whole-movie position`, async () => {
            const response = await handler(event(files[1]!, randomUUID()) as never);
            expect(response.status).toBe(204);
            const session = await findActiveSession(h.sql!, { userId: toUserId(userId), itemId });
            expect(session).not.toBeNull();
            expect(Number(session!.position_ms)).toBe(3_642_000);
            expect(h.access).toHaveBeenCalledWith(h.sql, itemId, expect.anything());
        });
    }
    it('DELETE resolves the file and saves the final whole-movie position', async () => {
        const sid = randomUUID();
        const id = await start(sid);
        expect((await legacyStop(event(files[1]!, sid, 'DELETE') as never)).status).toBe(204);
        expect((await row(id)).status).toBe('COMPLETED');
        expect(Number((await row(id)).position_ms)).toBe(3_642_000);
    });
});

describe('Live TV reports stay in the Live TV session system', () => {
    for (const [name, handler] of [
        ['Playing', playing],
        ['Progress', progress],
        ['Stopped', stopped],
        ['legacy start', legacyStart],
        ['legacy progress', legacyProgress],
        ['legacy stop', legacyStop],
    ] as const) {
        it(`${name} returns 204 without creating/updating ordinary sessions`, async () => {
            const response = await handler(
                event(channelId, randomUUID(), name === 'legacy stop' ? 'DELETE' : 'POST') as never,
            );
            expect(response.status).toBe(204);
            expect(
                await h.sql!`SELECT id FROM play_sessions WHERE user_id = ${userId}`,
            ).toHaveLength(0);
            expect(h.access).not.toHaveBeenCalled();
            expect(h.stoppedEvent).not.toHaveBeenCalled();
        });
    }
});

describe('audio/subtitle switch report race', () => {
    for (const [name, stopHandler] of [
        ['Stopped', stopped],
        ['legacy DELETE', legacyStop],
    ] as const) {
        it(`${name} for the old PlaySessionId leaves the new row active`, async () => {
            const oldSid = randomUUID();
            const newSid = randomUUID();
            const oldId = await start(oldSid);
            const newId = await start(newSid);
            expect(newId).not.toBe(oldId);
            // Late progress from the old stream must also find its own row.
            expect(await start(oldSid)).toBe(oldId);
            await stopHandler(
                event(itemId, oldSid, name === 'legacy DELETE' ? 'DELETE' : 'POST') as never,
            );
            expect((await row(oldId)).status).toBe('COMPLETED');
            expect((await row(newId)).status).toBe('ACTIVE');
            // Duplicate late stop cannot fall back to the new stream.
            await stopHandler(
                event(itemId, oldSid, name === 'legacy DELETE' ? 'DELETE' : 'POST') as never,
            );
            expect((await row(newId)).status).toBe('ACTIVE');
        });
    }
});

describe('play token revocation by session', () => {
    it('revokes all source tokens of a session while preserving another session', async () => {
        const sid = randomUUID();
        const other = await issueFileToken(itemId, files[0]!, username, 7200, {
            playSessionId: randomUUID(),
        });
        const root = await issuePlayToken(itemId, username, sid, 7200);
        const tokens = await Promise.all(
            files.map((file) =>
                issueFileToken(itemId, file, username, 7200, { playSessionId: sid }),
            ),
        );
        await renewPlayTokenBySession(sid, { token: root });
        await revokePlayTokenBySession(sid);
        expect(await validatePlayToken(root)).toBeNull();
        for (const token of tokens) expect(await validatePlayToken(token)).toBeNull();
        expect(await validatePlayToken(other)).not.toBeNull();
    });
});

describe('no concurrent /j stream cap (no paid tier)', () => {
    const others = Array.from({ length: 4 }, () => randomUUID());
    beforeAll(async () => {
        for (const id of others) {
            await h.sql!`INSERT INTO users (id, username) VALUES (${id}, ${`jreg_${id.slice(0, 8)}`})`;
        }
    });
    afterAll(async () => {
        await h.sql!`DELETE FROM play_sessions WHERE user_id = ANY(${others}::uuid[])`;
        await h.sql!`DELETE FROM user_media_state WHERE user_id = ANY(${others}::uuid[])`;
        await h.sql!`DELETE FROM user_media_events WHERE user_id = ANY(${others}::uuid[])`;
        await h.sql!`DELETE FROM user_devices WHERE user_id = ANY(${others}::uuid[])`;
        await h.sql!`DELETE FROM users WHERE id = ANY(${others}::uuid[])`;
    });

    it('five users stream at once through the real routes: none is kicked, all report fine', async () => {
        const viewers = [{ id: userId, name: username }].concat(
            others.map((id) => ({ id, name: `jreg_${id.slice(0, 8)}` })),
        );
        const sids = viewers.map(() => randomUUID());
        function asViewer(index: number, positionMs: number): RequestEvent {
            const e = event(itemId, sids[index]!, 'POST', positionMs);
            e.locals.user = {
                userId: toUserId(viewers[index]!.id),
                username: viewers[index]!.name,
            } as App.Locals['user'];
            e.locals.jfDevice = {
                deviceId: `cap-dev-${index}`,
                deviceName: `Cap device ${index}`,
                clientName: 'Jellyfin TV',
                clientVersion: '1.0',
            };
            return e;
        }
        for (let round = 0; round < 2; round++) {
            for (let i = 0; i < viewers.length; i++) {
                expect((await playing(asViewer(i, 1_000) as never)).status).toBe(204);
                expect((await progress(asViewer(i, 5_000 + round * 5_000) as never)).status).toBe(
                    204,
                );
            }
        }
        const rows = await h.sql!`SELECT status, stop_reason FROM play_sessions
            WHERE user_id = ANY(${viewers.map((v) => v.id)}::uuid[])`;
        expect(rows).toHaveLength(5);
        for (const r of rows) {
            expect(r.status).toBe('ACTIVE');
            expect(r.stop_reason).toBeNull();
        }
    });
});

describe('client session id adoption', () => {
    for (const origin of ['pre-migration row', 'Started without PlaySessionId']) {
        it(`adopts ${origin} without adding a concurrent stream`, async () => {
            let id: string;
            if (origin === 'pre-migration row') {
                id = await start(randomUUID());
                await h.sql!`UPDATE play_sessions SET jellyfin_play_session_id = NULL WHERE id = ${id}`;
            } else {
                expect((await playing(event(itemId) as never)).status).toBe(204);
                id = (await findActiveSession(h.sql!, { userId: toUserId(userId), itemId }))!.id;
            }
            const sid = randomUUID();
            expect((await row(id)).jellyfin_play_session_id).toBeNull();
            // Adoption must also bypass a second concurrent-stream admission.
            await h.sql!`INSERT INTO user_stream_policies (user_id, max_concurrent_streams) VALUES (${username}, 1)`;
            expect((await progress(event(itemId, sid) as never)).status).toBe(204);
            expect(await start(sid)).toBe(id);
            expect((await row(id)).jellyfin_play_session_id).toBe(sid);
            expect(
                await h.sql!`SELECT id FROM play_sessions WHERE user_id = ${userId}`,
            ).toHaveLength(1);
        });
    }
    it('prefers an exact id over a newer NULL row and backfills on lookup', async () => {
        const sid = randomUUID();
        const exact = await start(sid);
        const other = await start(randomUUID());
        await h.sql!`UPDATE play_sessions SET jellyfin_play_session_id = NULL,
            last_heartbeat_at = now() + interval '1 second' WHERE id = ${other}`;
        expect(
            (
                await findActiveSession(h.sql!, {
                    userId: toUserId(userId),
                    itemId,
                    playSessionId: sid,
                })
            )?.id,
        ).toBe(exact);
        expect((await row(other)).jellyfin_play_session_id).toBeNull();
        const adoptedSid = randomUUID();
        expect(
            (
                await findActiveSession(h.sql!, {
                    userId: toUserId(userId),
                    itemId,
                    playSessionId: adoptedSid,
                })
            )?.id,
        ).toBe(other);
        expect((await row(other)).jellyfin_play_session_id).toBe(adoptedSid);
    });
});

it('a shorter version cannot shorten the session token index TTL', async () => {
    const { getCoordinationClient } = await import('$lib/server/cache/valkey');
    const sid = randomUUID();
    const long = await issueFileToken(itemId, files[0]!, username, 30_000, { playSessionId: sid });
    await issueFileToken(itemId, files[1]!, username, 60, { playSessionId: sid });
    const key = `directplay:session-files:v1:${sid}`;
    const ttl = Number(await getCoordinationClient()!.customCommand(['TTL', key]));
    expect(ttl).toBeGreaterThanOrEqual(30_000 + 7200 - 5);
    await revokePlayTokenBySession(sid);
    expect(await validatePlayToken(long)).toBeNull();
});

it('a simultaneous PlaySessionId claim cannot replace another token', async () => {
    const sid = randomUUID();
    const claims = await Promise.allSettled([
        issuePlayToken(itemId, username, sid, 7200),
        issuePlayToken(itemId, 'another-user', sid, 7200),
    ]);
    expect(claims.filter((c) => c.status === 'fulfilled')).toHaveLength(1);
    const winner = claims.find((c) => c.status === 'fulfilled');
    expect(winner?.status).toBe('fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('No winning claim');
    const { cacheGet, getCoordinationClient } = await import('$lib/server/cache/valkey');
    expect(await cacheGet(`directplay:session:${sid}`)).toBe(winner.value);
    const client = getCoordinationClient()!;
    await client.expire(`directplay:token:${winner.value}`, 20);
    await renewPlayTokenBySession(sid, { token: 'unrelated-token' });
    expect(Number(await client.ttl(`directplay:token:${winner.value}`))).toBeLessThanOrEqual(20);
    await renewPlayTokenBySession(sid, { token: winner.value });
    expect(Number(await client.ttl(`directplay:token:${winner.value}`))).toBeGreaterThan(14_000);
    await revokePlayTokenBySession(sid);
});
