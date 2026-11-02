// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { SessionUpdateSchema } from './session-update.js';

describe('SessionUpdateSchema', () => {
    describe('play_method', () => {
        it('accepts audio_only — this validates the heartbeat PUT and its beacon twin', () => {
            const result = SessionUpdateSchema.safeParse({
                position_ms: 30_000,
                status: 'ACTIVE',
                event_seq: 1,
                play_method: 'audio_only',
                session_elapsed_ms: 0,
            });
            expect(result.success).toBe(true);
        });
    });

    describe('session_elapsed_ms validation', () => {
        it('accepts a positive value', () => {
            const result = SessionUpdateSchema.safeParse({
                position_ms: 30_000,
                status: 'COMPLETED',
                event_seq: 5,
                session_elapsed_ms: 60_000,
                end_reason: 'unload',
            });
            expect(result.success).toBe(true);
        });

        it('rejects the field being omitted — the HTTP contract requires it', () => {
            // Inverted from the old contract. A Lumastra player owns a play-time
            // accumulator and must always report it: an omitted field left
            // highest_session_elapsed_ms NULL, so the engagement gate never
            // opened and the series never reached Continue Watching.
            //
            // In-process callers that genuinely have no accumulator (/j compat,
            // the stale-session reaper) are typed against SessionUpdateInternal
            // instead and never pass through this schema.
            const result = SessionUpdateSchema.safeParse({
                position_ms: 30_000,
                status: 'COMPLETED',
                event_seq: 5,
                end_reason: 'unload',
            });
            expect(result.success).toBe(false);
        });

        it('accepts zero — the explicit "no verified playback yet" value', () => {
            // Zero is how the unload-beacon scrub-and-leave path reports "no
            // engagement". It must parse: rejecting it would kill the whole
            // COMPLETED beacon and leave the session row unstopped.
            const result = SessionUpdateSchema.safeParse({
                position_ms: 30_000,
                status: 'COMPLETED',
                event_seq: 5,
                session_elapsed_ms: 0,
                end_reason: 'unload',
            });
            expect(result.success).toBe(true);
        });

        it('rejects negative values', () => {
            const result = SessionUpdateSchema.safeParse({
                position_ms: 30_000,
                status: 'COMPLETED',
                event_seq: 5,
                session_elapsed_ms: -1,
                end_reason: 'unload',
            });
            expect(result.success).toBe(false);
        });

        it('rejects values above the 7-day ceiling', () => {
            const result = SessionUpdateSchema.safeParse({
                position_ms: 30_000,
                status: 'COMPLETED',
                event_seq: 5,
                session_elapsed_ms: 7 * 24 * 60 * 60 * 1000 + 1,
            });
            expect(result.success).toBe(false);
        });
    });
});

it('strips future report fields while keeping known field validation', async () => {
    const { PlaybackReportSchema } = await import('./session-update.js');
    const body = { positionMs: 30000, status: 'ACTIVE', eventSeq: 1, sessionElapsedMs: 25000 };
    expect(PlaybackReportSchema.parse({ ...body, clientVersion: 'tvOS-next' })).toEqual(body);
    expect(PlaybackReportSchema.safeParse({ ...body, listenedMs: -1 }).success).toBe(false);
});

it('uses distinct heard total/delta wire fields and still accepts the legacy listenedMs', async () => {
    const { PlaybackReportSchema, playbackReportToSessionUpdate } =
        await import('./session-update.js');
    const body = { positionMs: 90000, status: 'ACTIVE', eventSeq: 1, sessionElapsedMs: 15000 };
    // Shipped Apple builds send listenedMs (also on video heartbeats): must not 422.
    const legacy = PlaybackReportSchema.safeParse({ ...body, listenedMs: 12000 });
    expect(legacy.success).toBe(true);
    expect(playbackReportToSessionUpdate(PlaybackReportSchema.parse({ ...body, listenedMs: 12000 }), 'movie').listened_ms).toBeUndefined();
    expect(playbackReportToSessionUpdate(PlaybackReportSchema.parse({ ...body, listenedMs: 12000 }), 'episode').listened_ms).toBeUndefined();
    expect(playbackReportToSessionUpdate(PlaybackReportSchema.parse({ ...body, listenedMs: 12000 }), 'track').listened_ms).toBe(12000);
    expect(
        playbackReportToSessionUpdate(
            PlaybackReportSchema.parse({ ...body, listenedMs: 12000, listenedTotalMs: 9000 }),
            'track',
        ).listened_ms,
    ).toBe(9000);
    expect(
        playbackReportToSessionUpdate(
            PlaybackReportSchema.parse({ ...body, listenedTotalMs: 12000 }),
            'track',
        ).listened_ms,
    ).toBe(12000);
    expect(
        playbackReportToSessionUpdate(
            PlaybackReportSchema.parse({ ...body, listenedDeltaMs: 3000 }),
            'audiobook',
        ).listened_ms,
    ).toBe(3000);
});
