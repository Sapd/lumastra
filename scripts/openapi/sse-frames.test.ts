// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createDocument } from 'zod-openapi';
import {
    SSE_FRAME_SCHEMAS,
    SseDeviceCommandCancelledFrame,
    SseDeviceCommandStatusFrame,
    SseLibraryNewEpisodeFrame,
    SseRequestAvailableFrame,
} from './sse-frames';

describe('global SSE frame schemas', () => {
    it('registers every named frame without duplicate Output frame components', () => {
        const document = createDocument({
            openapi: '3.1.0',
            info: { title: 'SSE contract test', version: '1' },
            paths: {},
            components: { schemas: { ...SSE_FRAME_SCHEMAS } },
        });
        const names = Object.keys(document.components?.schemas ?? {});
        for (const name of Object.keys(SSE_FRAME_SCHEMAS)) expect(names).toContain(name);
        expect(names.filter((name) => /^Sse.*Output$/.test(name))).toEqual([]);
    });

    it('requires the hub envelope and target device for cancellations', () => {
        const data = { id: 'command-id' };
        expect(SseDeviceCommandCancelledFrame.safeParse(data).success).toBe(false);
        const frame = SseDeviceCommandCancelledFrame.safeParse({
            targetUserId: 'recipient',
            targetDeviceSessionId: 'device',
            kind: 'device.command_cancelled',
            data,
        });
        expect(frame.success).toBe(true);
    });

    it('requires replay:false on command status frames', () => {
        expect(SseDeviceCommandStatusFrame.shape.replay.safeParse(undefined).success).toBe(false);
        expect(SseDeviceCommandStatusFrame.shape.replay.safeParse(false).success).toBe(true);
    });

    it('publishes notification data instead of an untyped notification placeholder', () => {
        const envelope = { targetUserId: 'recipient' };
        const episode = SseLibraryNewEpisodeFrame.safeParse({
            ...envelope,
            kind: 'library.new_episode',
            data: {
                mediaId: 'episode',
                seriesId: 'series',
                seriesTitle: 'Series',
                episodeTitle: 'Episode',
                seasonNumber: null,
                episodeNumber: 3,
                posterUrl: '/poster',
                coalesceKey: 'episode:episode',
                reason: 'watching',
            },
        });
        expect(episode.success).toBe(true);
        const request = SseRequestAvailableFrame.safeParse({
            ...envelope,
            kind: 'request.available',
            data: {
                mediaId: 'movie',
                mediaType: 'movie',
                title: 'Movie',
                year: null,
                posterUrl: '/poster',
                requestId: 42,
                coalesceKey: 'request:42',
            },
        });
        expect(request.success).toBe(true);
        const missingData = SseRequestAvailableFrame.safeParse({
            ...envelope,
            kind: 'request.available',
            data: {},
        });
        expect(missingData.success).toBe(false);
    });
});
