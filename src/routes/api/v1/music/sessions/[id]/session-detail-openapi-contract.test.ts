// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { PlaybackReportSchema } from '$lib/schemas/session-update.js';
import { ReplayItemSchema, ReplayResponseSchema } from '$lib/schemas/play-session-replay.js';
describe('replacement music reporting contract', () => {
    it('accepts skip, listened audio and all crossfade presence states', () => {
        const base = {
            positionMs: 1000,
            sessionElapsedMs: 500,
            listenedTotalMs: 400,
            status: 'COMPLETED',
            eventSeq: 1,
            endReason: 'skip',
        };
        expect(PlaybackReportSchema.parse(base).crossfade).toBeUndefined();
        expect(PlaybackReportSchema.parse({ ...base, crossfade: null }).crossfade).toBeNull();
        expect(
            PlaybackReportSchema.parse({
                ...base,
                crossfade: {
                    otherTrackId: '11111111-2222-4333-a444-555555555555',
                    role: 'incoming',
                    remainingMs: 100,
                    durationMs: 500,
                },
            }).crossfade?.role,
        ).toBe('incoming');
    });
    it('requires an event id and music kind for replay', () => {
        expect(ReplayItemSchema.safeParse({ kind: 'video' }).success).toBe(false);
        expect(ReplayItemSchema.safeParse({ kind: 'music' }).success).toBe(false);
    });
    it('keeps replay rejection reasons open', () => {
        expect(
            ReplayResponseSchema.parse({
                results: [
                    {
                        index: 0,
                        eventId: null,
                        status: 'rejected',
                        reason: 'future_server_reason',
                        retryable: true,
                        details: [],
                    },
                ],
                summary: { recorded: 0, duplicate: 0, rejected: 1 },
            }).results[0].reason,
        ).toBe('future_server_reason');
    });
});
