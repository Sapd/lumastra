// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /playback/session — delivery-flag mapping.
 *
 * The endpoint reports four fields that describe ONE fact (how the stream is
 * being delivered). They used to be derived from two independent expressions:
 * an `isTranscoding` OR-chain that listed the transcoding methods explicitly,
 * and a `playMethod` ternary whose final `else` swept up everything that was
 * neither 'direct' nor 'remux'. `'audio_only'` was in the ternary's fallthrough
 * but missing from the OR-chain, so it produced the contradiction asserted
 * against below: `playMethod: 'Transcode'` alongside `isVideoDirect: true` and
 * `isAudioDirect: true`.
 *
 * What these prove: the mapping is internally consistent for every method the
 * `play_sessions.play_method` CHECK admits, and an unrecognised method lands in
 * the conservative bucket rather than being reported as direct.
 *
 * What they do NOT prove: that a real audio-only session is stored with
 * `play_method = 'audio_only'` in the first place (that is the reporter's
 * `selectedMethod` wiring, covered in play-session-reporter.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { deriveSessionDeliveryFlags } from './session.js';

describe('deriveSessionDeliveryFlags', () => {
    it('reports audio_only as a transcode with NOTHING direct', () => {
        // The exact contradiction the old two-expression form emitted.
        expect(deriveSessionDeliveryFlags('audio_only')).toEqual({
            playMethod: 'Transcode',
            isTranscoding: true,
            isVideoDirect: false,
            isAudioDirect: false,
        });
    });

    it('never claims a direct stream while also claiming Transcode', () => {
        // Method-independent invariant: a Transcode can have no direct stream,
        // and a non-transcoding method must have both. This is what the two
        // separate expressions could violate; one decision point cannot.
        for (const method of [
            'direct',
            'remux',
            'audio_transcode',
            'full_transcode',
            'transcode',
            'audio_only',
        ]) {
            const flags = deriveSessionDeliveryFlags(method);
            expect(
                { method, ok: flags.isTranscoding === (flags.playMethod === 'Transcode') },
                `playMethod/isTranscoding disagree for ${method}`,
            ).toEqual({ method, ok: true });
            if (flags.isTranscoding) {
                expect({ method, video: flags.isVideoDirect }).toEqual({ method, video: false });
            } else {
                expect({ method, video: flags.isVideoDirect, audio: flags.isAudioDirect }).toEqual({
                    method,
                    video: true,
                    audio: true,
                });
            }
        }
    });

    it('keeps the pre-existing mapping for direct and remux', () => {
        expect(deriveSessionDeliveryFlags('direct').playMethod).toBe('DirectPlay');
        expect(deriveSessionDeliveryFlags('remux').playMethod).toBe('DirectStream');
        expect(deriveSessionDeliveryFlags('direct').isTranscoding).toBe(false);
        expect(deriveSessionDeliveryFlags('remux').isTranscoding).toBe(false);
    });

    it('sends an unrecognised method to the conservative bucket, not to direct', () => {
        // A future migration widening the CHECK must not silently be reported
        // as direct play.
        expect(deriveSessionDeliveryFlags('some_future_rung')).toEqual({
            playMethod: 'Transcode',
            isTranscoding: true,
            isVideoDirect: false,
            isAudioDirect: false,
        });
    });
});
