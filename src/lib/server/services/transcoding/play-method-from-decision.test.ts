// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { playMethodFromDecision } from './types.js';

describe('playMethodFromDecision', () => {
    // play_sessions.play_method is written from the client's REQUESTED method at
    // session start. The Lumastra tvOS client reports full_transcode for every
    // session, so stream copies were stored (and costed) as full transcodes. This
    // maps the server's real decision onto the same vocabulary so it can be
    // corrected once the transcode job resolves.

    it('reports a stream copy as remux, not full_transcode', () => {
        expect(playMethodFromDecision({ videoAction: 'copy', audioAction: 'copy' })).toBe('remux');
    });

    it('reports video copy + audio re-encode as audio_transcode', () => {
        expect(playMethodFromDecision({ videoAction: 'copy', audioAction: 'transcode' })).toBe(
            'audio_transcode',
        );
    });

    it('reports a video re-encode as full_transcode regardless of audio', () => {
        expect(playMethodFromDecision({ videoAction: 'transcode', audioAction: 'copy' })).toBe(
            'full_transcode',
        );
        expect(playMethodFromDecision({ videoAction: 'transcode', audioAction: 'transcode' })).toBe(
            'full_transcode',
        );
    });

    // A transcode job only exists when we are serving HLS, so the floor is remux —
    // direct play spawns no job and keeps the client-reported value.
    it('never reports direct', () => {
        const all = (['copy', 'transcode'] as const).flatMap((v) =>
            (['copy', 'transcode'] as const).map((a) =>
                playMethodFromDecision({ videoAction: v, audioAction: a }),
            ),
        );
        expect(all).not.toContain('direct');
    });
});
