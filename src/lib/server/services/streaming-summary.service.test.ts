// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildStreamingSummary } from './streaming-summary.service.js';
import type { ActiveStreamRow } from '$lib/server/database/queries/streaming-summary.queries.js';

function row(over: Partial<ActiveStreamRow> = {}): ActiveStreamRow {
    return {
        user_id: 'denis',
        owner_username: 'denis',
        source: 'lumastra',
        device_id: 'web-1',
        media_title: 'Dawn: Part Two',
        series_title: null,
        season_number: null,
        episode_number: null,
        play_method: 'direct',
        bitrate_kbps: 18000,
        position_ms: 600000,
        runtime_ms: 9000000,
        status: 'ACTIVE',
        ...over,
    };
}

describe('buildStreamingSummary', () => {
    it('counts streams, distinct users, and transcodes', () => {
        const s = buildStreamingSummary(
            [
                row({ user_id: 'denis', play_method: 'direct' }),
                row({ user_id: 'denis', play_method: 'full_transcode' }), // same user, 2nd device
                row({ user_id: 'sarah', play_method: 'audio_transcode' }),
            ],
            42,
        );
        expect(s.streamCount).toBe(3);
        expect(s.userCount).toBe(2); // denis counted once
        expect(s.transcodeCount).toBe(2); // both transcode variants collapse
        expect(s.bandwidthMbps).toBe(42); // proxied gauge wins
    });

    it('collapses the 4 wire methods to 3 and converts bitrate to Mbps', () => {
        const s = buildStreamingSummary([row({ play_method: 'remux', bitrate_kbps: 12500 })], 0);
        expect(s.streams[0].method).toBe('remux');
        expect(s.streams[0].bitrateMbps).toBe(12.5);
    });

    it('builds an episode title from series + SxxExx', () => {
        const s = buildStreamingSummary(
            [
                row({
                    series_title: 'The Beacon',
                    season_number: 3,
                    episode_number: 5,
                    media_title: 'Ep',
                }),
            ],
            0,
        );
        expect(s.streams[0].title).toBe('The Beacon · S03E05');
    });

    it('falls back to summed declared bitrate when the proxied gauge is 0/unknown', () => {
        const s = buildStreamingSummary(
            [row({ bitrate_kbps: 10000 }), row({ user_id: 'x', bitrate_kbps: 5000 })],
            null,
        );
        expect(s.bandwidthMbps).toBe(15); // 10 + 5, since proxied is unknown
    });

    it('computes progress and pause; omits bitrate when absent', () => {
        const s = buildStreamingSummary(
            [
                row({
                    status: 'PAUSED',
                    bitrate_kbps: null,
                    position_ms: 4500000,
                    runtime_ms: 9000000,
                }),
            ],
            0,
        );
        expect(s.streams[0].paused).toBe(true);
        expect(s.streams[0].progress).toBeCloseTo(0.5, 5);
        expect(s.streams[0].bitrateMbps).toBeUndefined();
    });

    it('caps the per-stream list but keeps the full counts', () => {
        const rows = Array.from({ length: 12 }, (_, i) => row({ user_id: `u${i}` }));
        const s = buildStreamingSummary(rows, 0, 5);
        expect(s.streamCount).toBe(12);
        expect(s.userCount).toBe(12);
        expect(s.streams).toHaveLength(5);
    });

    it('projects display name, source, and device id for the source badge', () => {
        const s = buildStreamingSummary(
            [
                row({
                    user_id: 'uuid-123',
                    owner_username: 'sarah',
                    source: 'jellyfin',
                    device_id: 'jellyfin-compat-abc',
                }),
            ],
            0,
        );
        expect(s.streams[0].user).toBe('uuid-123'); // avatar key
        expect(s.streams[0].username).toBe('sarah'); // display handle
        expect(s.streams[0].source).toBe('jellyfin');
        expect(s.streams[0].deviceId).toBe('jellyfin-compat-abc');
    });

    it('falls back username to the user id when no handle resolves', () => {
        const s = buildStreamingSummary(
            [row({ user_id: 'uuid-9', owner_username: null, source: null, device_id: null })],
            0,
        );
        expect(s.streams[0].username).toBe('uuid-9');
        expect(s.streams[0].source).toBeUndefined();
        expect(s.streams[0].deviceId).toBeUndefined();
    });

    it('handles an empty session list', () => {
        const s = buildStreamingSummary([], null);
        expect(s).toMatchObject({
            streamCount: 0,
            userCount: 0,
            transcodeCount: 0,
            bandwidthMbps: 0,
            streams: [],
        });
    });
});
