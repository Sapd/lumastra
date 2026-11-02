// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { pickNowNext } from '$lib/shared/livetv-now-next.js';
import { getStationAirings } from '$lib/server/database/queries/livetv-programs.queries.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    resolveStation as queryStation,
    feedStationMap,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import type { ResolvedStation } from '$lib/server/database/queries/livetv-channels.queries.js';
import type {
    LiveTvChannel,
    LiveTvStation,
    LiveTvFeedProgram,
    LiveTvAiring,
    LiveTvNowNext,
} from '$lib/schemas/livetv.js';

export async function resolveStation(stationId: string): Promise<ResolvedStation | null> {
    const sql = getDb();
    if (!sql) throw new Error('Database unavailable');
    return queryStation(sql, stationId);
}

export function stationProgram(program: LiveTvFeedProgram, stationId: string): LiveTvAiring {
    return {
        id: program.id, stationId, title: program.title,
        description: program.description, genres: program.genres,
        officialRating: program.officialRating,
        startTime: program.startTime, endTime: program.endTime,
    };
}

export function stationIdOfFeed(channel: Pick<LiveTvChannel, 'id' | 'backupGroupId'>): string {
    return channel.backupGroupId ?? channel.id;
}

export function stationDto(
    channel: LiveTvChannel,
    nowNext: LiveTvNowNext = { current: null, next: null },
): LiveTvStation {
    const { backupGroupId: _backupGroupId, currentProgram: _currentProgram, ...rest } = channel;
    const stationId = stationIdOfFeed(channel);
    return {
        ...rest,
        id: stationId,
        feedId: channel.id,
        nowNext,
    };
}

export async function mapFeedStations(feedIds: string[]): Promise<Map<string, string>> {
    const sql = getDb();
    if (!sql) throw new Error('Database unavailable');
    return feedStationMap(sql, feedIds);
}

export async function readStationAirings(
    stationIds: string[], from: Date, to: Date,
): Promise<Map<string, LiveTvAiring[]>> {
    if (stationIds.length === 0) return new Map();
    const sql = getDb();
    if (!sql) throw new Error('Database unavailable');
    const rows = await getStationAirings(sql, stationIds, from, to);
    const result = new Map<string, LiveTvAiring[]>(stationIds.map((id) => [id, []]));
    for (const row of rows) {
        result.get(row.station_id)!.push({
            id: row.id, stationId: row.station_id, title: row.title,
            description: row.description ?? undefined, genres: row.genres ?? undefined,
            officialRating: row.official_rating ?? undefined,
            startTime: row.start_time.toISOString(), endTime: row.end_time.toISOString(),
        });
    }
    return result;
}

interface CachedSchedule {
    fetchedAt: number;
    airings: Promise<LiveTvAiring[]>;
    ttl: number;
}
const schedules = new Map<string, CachedSchedule>();

/** Cache airings only: the clock is evaluated by each read after awaiting the schedule. */
export async function readStationSchedules(stationIds: string[]): Promise<Map<string, LiveTvAiring[]>> {
    const now = Date.now();
    for (const [id, entry] of schedules) {
        if (now - entry.fetchedAt >= entry.ttl) schedules.delete(id);
    }
    const missing = [...new Set(stationIds)].filter((id) => !schedules.has(id));
    if (missing.length) {
        const pending = readStationAirings(
            missing, new Date(now - 2 * 60 * 60_000), new Date(now + 12 * 60 * 60_000),
        );
        for (const id of missing) {
            const entry: CachedSchedule = {
                fetchedAt: now,
                ttl: Infinity,
                airings: pending.then((result) => {
                    const airings = result.get(id) ?? [];
                    entry.fetchedAt = Date.now();
                    entry.ttl = airings.length ? 60_000 : 15_000;
                    return airings;
                }).catch((err: unknown) => {
                    if (schedules.get(id) === entry) schedules.delete(id);
                    throw err;
                }),
            };
            schedules.set(id, entry);
        }
    }
    return new Map(await Promise.all(stationIds.map(async (id) =>
        [id, await schedules.get(id)!.airings] as const,
    )));
}

export async function readStationNowNext(stationId: string): Promise<LiveTvNowNext> {
    const schedules = await readStationSchedules([stationId]);
    return pickNowNext(schedules.get(stationId) ?? [], Date.now());
}
