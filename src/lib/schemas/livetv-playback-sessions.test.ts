// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    PlaybackSessionStartSchema,
    PlaybackSessionEndedSchema,
} from './livetv-playback-sessions.js';
import {
    LiveTvStationSchema,
    LiveTvProgramSchema,
    LiveTvFavoriteUpdateSchema,
    LiveTvFavoritesResponseSchema,
    LiveTvFavoritesOrderSchema,
} from './livetv.js';
import { LiveTvSimpleModeUpdateSchema } from './livetv-simple-mode.js';
const stationId = '550e8400-e29b-41d4-a716-446655440000';
describe('station and playback contracts', () => {
    it('requires a station id and validates optional feed, quality and HEVC capability', () => {
        expect(PlaybackSessionStartSchema.parse({ stationId })).toEqual({ stationId });
        expect(PlaybackSessionStartSchema.safeParse({ channelId: stationId }).success).toBe(false);
        for (const fields of [
            { feedId: 'bad' },
            { quality: 'bad' },
            { maxBitrate: 0 },
            { hevc: 'bad' },
        ]) {
            expect(PlaybackSessionStartSchema.safeParse({ stationId, ...fields }).success).toBe(
                false,
            );
        }
    });
    it('uses station ids in public program and favorite schemas', () => {
        const program = { id: 'p', title: 'News', startTime: 'now', endTime: 'later' };
        expect(LiveTvProgramSchema.safeParse({ ...program, stationId }).success).toBe(true);
        expect(LiveTvProgramSchema.safeParse({ ...program, channelId: stationId }).success).toBe(
            false,
        );
        expect(LiveTvFavoriteUpdateSchema.parse({ stationId, favorite: true })).toEqual({
            stationId,
            favorite: true,
        });
        expect(LiveTvFavoritesResponseSchema.parse({ stationIds: [stationId] }).stationIds).toEqual(
            [stationId],
        );
        expect(LiveTvFavoritesOrderSchema.parse({ stationIds: [] }).stationIds).toEqual([]);
    });
    it('station DTO exposes the shown feed and drops backupGroupId', () => {
        const value = LiveTvStationSchema.parse({
            id: stationId,
            feedId: stationId,
            name: 'News',
            images: {},
            sortOrder: 0,
            isVisible: true,
            nowNext: { current: null, next: null },
            backupGroupId: stationId,
        });
        expect(value).not.toHaveProperty('backupGroupId');
        expect(value.feedId).toBe(stationId);
    });
    it('accepts partial simple-mode patches with validated station fields and PINs', () => {
        expect(LiveTvSimpleModeUpdateSchema.parse({ enabled: true })).toEqual({ enabled: true });
        expect(
            LiveTvSimpleModeUpdateSchema.parse({
                stationIds: [stationId],
                startStationId: stationId,
                clearStartStation: false,
            }).stationIds,
        ).toEqual([stationId]);
        expect(LiveTvSimpleModeUpdateSchema.safeParse({ stationIds: ['bad'] }).success).toBe(false);
        expect(LiveTvSimpleModeUpdateSchema.safeParse({ pin: '12' }).success).toBe(false);
    });
    it.each(['evicted', 'superseded', 'expired', 'left'])(
        'documents terminal reason %s',
        (reason) => {
            expect(
                PlaybackSessionEndedSchema.safeParse({
                    code: 'gone',
                    error: 'playback_session_ended',
                    status: 410,
                    reason,
                }).success,
            ).toBe(true);
        },
    );
});
