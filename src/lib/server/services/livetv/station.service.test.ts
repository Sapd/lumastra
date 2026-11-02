// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
vi.mock('$lib/server/database/connection.js', () => ({ getDb: vi.fn() }));
vi.mock('$lib/server/database/queries/livetv-programs.queries.js', () => ({ getStationAirings: vi.fn() }));
import { getStationAirings } from '$lib/server/database/queries/livetv-programs.queries.js';
import { readStationNowNext, readStationSchedules, stationDto, stationProgram, resolveStation } from './station.service.js';
import { getDb } from '$lib/server/database/connection.js';
import { stationIdsOfFeeds } from '$lib/server/database/queries/livetv-channels.queries.js';

const program = {
    id: 'p',
    channelId: 'feed',
    title: 'News',
    startTime: '2026-10-16T10:00:00Z',
    endTime: '2026-10-16T11:00:00Z',
};
describe('station resolver', () => {
    it('resolves a group to the SQL lineup representative', async () => {
        const sql = vi.fn((parts: TemplateStringsArray) =>
            parts.join('').includes(' AS shown_feed_id')
                ? Promise.resolve([
                      { station_id: '11111111-1111-4111-8111-111111111111', shown_feed_id: 'backup', group_id: '11111111-1111-4111-8111-111111111111' },
                  ])
                : {},
        );
        vi.mocked(getDb).mockReturnValue(sql as unknown as postgres.Sql);
        expect(await resolveStation('11111111-1111-4111-8111-111111111111')).toEqual({
            stationId: '11111111-1111-4111-8111-111111111111',
            shownFeedId: 'backup',
            groupId: '11111111-1111-4111-8111-111111111111',
        });
    });
    it('does not resolve a station with no shown feed or an obsolete feed id', async () => {
        let reads = 0;
        const sql = vi.fn((parts: TemplateStringsArray) =>
            parts.join('').includes(' AS shown_feed_id')
                ? Promise.resolve(
                      ++reads === 1
                          ? [{ station_id: 'hidden', shown_feed_id: null, group_id: 'hidden' }]
                          : [],
                  )
                : {},
        );
        vi.mocked(getDb).mockReturnValue(sql as unknown as postgres.Sql);
        expect(await resolveStation('hidden')).toBeNull();
        expect(await resolveStation('obsolete')).toBeNull();
    });
    it('converts grouped and ungrouped feeds without leaking backupGroupId or program.channelId', () => {
        const channel = {
            id: 'feed',
            backupGroupId: 'group',
            name: 'News',
            images: {},
            sortOrder: 0,
            isVisible: true,
            currentProgram: program,
        };
        const station = stationDto(channel);
        expect(station).toMatchObject({
            id: 'group',
            feedId: 'feed',
            nowNext: { current: null, next: null },
        });
        expect(station).not.toHaveProperty('backupGroupId');
        expect(station).not.toHaveProperty('currentProgram');
        expect(stationProgram({ ...program, epgId: 'epg', sourceId: 'source' }, 'group')).not.toHaveProperty('sourceId');
        expect(stationProgram(program, 'group')).not.toHaveProperty('channelId');
        expect(stationDto({ ...channel, backupGroupId: undefined }).id).toBe('feed');
        expect(stationProgram(program, 'group').stationId).toBe('group');
    });
    it('maps stored feeds to stations, drops deleted feeds, deduplicates in caller order', async () => {
        const sql = vi.fn().mockResolvedValue([
            { id: 'a', station_id: 'group' },
            { id: 'b', station_id: 'group' },
            { id: 'lone', station_id: 'lone' },
        ]);
        expect(
            await stationIdsOfFeeds(sql as unknown as postgres.Sql, [
                'lone',
                'b',
                'deleted',
                'a',
                'lone',
            ]),
        ).toEqual(['lone', 'group']);
        expect(await stationIdsOfFeeds(sql as unknown as postgres.Sql, [])).toEqual([]);
        expect(sql).toHaveBeenCalledTimes(1);
    });
});

describe('station schedule caching', () => {
    afterEach(() => { vi.useRealTimers(); });
    it('shares one in-flight query across concurrent callers', async () => {
        const stationId = 'in-flight-station';
        type Rows = Awaited<ReturnType<typeof getStationAirings>>;
        let resolveQuery!: (rows: Rows) => void;
        const pending = new Promise<Rows>((resolve) => { resolveQuery = resolve; });
        vi.mocked(getDb).mockReturnValue(vi.fn() as unknown as postgres.Sql);
        vi.mocked(getStationAirings).mockReset().mockReturnValueOnce(pending);
        const first = readStationSchedules([stationId]);
        const second = readStationSchedules([stationId]);
        expect(getStationAirings).toHaveBeenCalledTimes(1);
        resolveQuery([{
            id: 'shared-airing', station_id: stationId, channel_id: 'feed', title: 'Shared',
            description: null, genres: null, official_rating: null, epg_id: 'epg', source_id: 'source',
            start_time: new Date('2026-10-17T10:00:00Z'),
            end_time: new Date('2026-10-17T11:00:00Z'),
        }]);
        const [a, b] = await Promise.all([first, second]);
        expect(a.get(stationId)).toMatchObject([{ id: 'shared-airing', stationId }]);
        expect(b).toEqual(a);
        expect(b.get(stationId)).toBe(a.get(stationId));
        expect(getStationAirings).toHaveBeenCalledTimes(1);
    });

    it('evicts rejected in-flight schedules so a later caller retries', async () => {
        const stationId = 'rejected-station';
        type Rows = Awaited<ReturnType<typeof getStationAirings>>;
        let rejectQuery!: (error: Error) => void;
        const pending = new Promise<Rows>((_resolve, reject) => { rejectQuery = reject; });
        vi.mocked(getDb).mockReturnValue(vi.fn() as unknown as postgres.Sql);
        vi.mocked(getStationAirings).mockReset().mockReturnValueOnce(pending)
            .mockResolvedValueOnce([]);
        const first = readStationSchedules([stationId]);
        const second = readStationSchedules([stationId]);
        const failure = new Error('database unavailable');
        const results = Promise.allSettled([first, second]);
        expect(getStationAirings).toHaveBeenCalledTimes(1);
        rejectQuery(failure);
        expect(await results).toEqual([
            { status: 'rejected', reason: failure },
            { status: 'rejected', reason: failure },
        ]);
        expect(await readStationSchedules([stationId])).toEqual(new Map([[stationId, []]]));
        expect(getStationAirings).toHaveBeenCalledTimes(2);
    });

    it('caches the collapsed schedule, reevaluates a boundary and expires within 60 seconds', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const now = Date.parse('2026-10-17T10:00:00Z');
        vi.setSystemTime(now);
        const stationId = 'cached-station';
        const row = (id: string, start: number, end: number) => ({
            id, station_id: stationId, channel_id: 'feed', title: id,
            description: null, genres: null, official_rating: null, epg_id: 'private', source_id: 'private',
            start_time: new Date(start), end_time: new Date(end),
        });
        vi.mocked(getDb).mockReturnValue(vi.fn() as unknown as postgres.Sql);
        vi.mocked(getStationAirings).mockReset().mockResolvedValue([
            row('current', now - 1000, now + 1000), row('next', now + 1000, now + 100_000),
        ]);
        const first = await readStationNowNext(stationId);
        expect(first.current?.id).toBe('current');
        expect(first.next?.id).toBe('next');
        expect(first.current).not.toHaveProperty('epgId');
        expect(first.current).not.toHaveProperty('sourceId');
        expect(getStationAirings).toHaveBeenCalledWith(expect.anything(), [stationId],
            new Date(now - 2 * 60 * 60_000), new Date(now + 12 * 60 * 60_000));
        vi.setSystemTime(now + 1000);
        expect(await readStationNowNext(stationId)).toMatchObject({ current: { id: 'next' }, next: null });
        expect(getStationAirings).toHaveBeenCalledTimes(1);
        vi.setSystemTime(now + 60_000);
        await readStationSchedules([stationId]);
        expect(getStationAirings).toHaveBeenCalledTimes(2);
    });
});
