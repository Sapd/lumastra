// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { FFmpegJobInfoSchema } from '$lib/schemas/admin-types';
import { TranscodeProgressPayloadSchema } from '$lib/schemas/api-playback-responses';

describe("TranscodeDisplayType 'audio-drop'", () => {
    it('survives the admin job schema', () => {
        expect(FFmpegJobInfoSchema.shape.mode.safeParse('audio-drop').success).toBe(true);
    });

    it('survives the admin job schema transcodeType field', () => {
        expect(FFmpegJobInfoSchema.shape.transcodeType.safeParse('audio-drop').success).toBe(true);
    });

    it('survives the heartbeat transcode-progress payload schema', () => {
        expect(
            TranscodeProgressPayloadSchema.shape.transcodeType.safeParse('audio-drop').success,
        ).toBe(true);
    });
});
