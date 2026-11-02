// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { boundedMusicReplays, musicReplayStorageKey } from './music-replay-persistence';
const now = Date.parse('2026-10-17T12:00:00Z');
function item(ageDays = 0, positionMs = 0) {
    return {
        eventId: '11111111-1111-4111-8111-111111111111',
        mediaId: '22222222-2222-4222-8222-222222222222', kind: 'music',
        startedAt: new Date(now - ageDays * 86_400_000).toISOString(),
        positionMs, listenedMs: 1000, endReason: 'completion',
    };
}
describe('music replay persistence bounds', () => {
    it('isolates accounts and has no anonymous queue key', () => {
        expect(musicReplayStorageKey('alice')).toBe('music-playback-replays-v1:alice');
        expect(musicReplayStorageKey('bob')).toBe('music-playback-replays-v1:bob');
        expect(musicReplayStorageKey(undefined)).toBeNull();
    });
    it('drops expired and malformed items, preserving the 90-day boundary', () => {
        expect(boundedMusicReplays([item(91), item(90), item(0), null], now)).toHaveLength(2);
    });
    it('keeps at most the newest 500 entries', () => {
        const queue = boundedMusicReplays(Array.from({ length: 501 }, (_, i) => item(0, i)), now);
        expect(queue).toHaveLength(500);
        expect(queue[0].positionMs).toBe(1);
        expect(queue[499].positionMs).toBe(500);
    });
});
