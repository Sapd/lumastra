// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the `videoCodec`/`audioCodec` query-param allowlist on the
 * HLS playback route (security review 2026-09-12, C17). Before this fix the
 * raw query value reached transcode-decision.ts's plan-hints path unchecked
 * and could end up as an ffmpeg encoder name.
 *
 * Importing `+server.ts` here would pull in the full auth/id-resolution/
 * ffmpeg pipeline, so this exercises the exported allowlist helper directly
 * rather than the wrapped `GET` handler.
 */

import { describe, it, expect } from 'vitest';
import {
    resolveCodecOverride,
    ALLOWED_VIDEO_CODEC_OVERRIDES,
    ALLOWED_AUDIO_CODEC_OVERRIDES,
} from './codec-override.js';

describe('resolveCodecOverride', () => {
    it('ignores an unrecognised videoCodec value instead of forwarding it', () => {
        expect(resolveCodecOverride('foo;rm', ALLOWED_VIDEO_CODEC_OVERRIDES)).toBeUndefined();
    });

    it('lets a known videoCodec value through unchanged', () => {
        expect(resolveCodecOverride('h264', ALLOWED_VIDEO_CODEC_OVERRIDES)).toBe('h264');
    });

    it('accepts the video sentinel values (none, copy)', () => {
        expect(resolveCodecOverride('none', ALLOWED_VIDEO_CODEC_OVERRIDES)).toBe('none');
        expect(resolveCodecOverride('copy', ALLOWED_VIDEO_CODEC_OVERRIDES)).toBe('copy');
    });

    it('ignores an unrecognised audioCodec value instead of forwarding it', () => {
        expect(resolveCodecOverride('foo;rm', ALLOWED_AUDIO_CODEC_OVERRIDES)).toBeUndefined();
    });

    it('lets a known audioCodec value through unchanged', () => {
        expect(resolveCodecOverride('aac', ALLOWED_AUDIO_CODEC_OVERRIDES)).toBe('aac');
    });

    it('returns undefined when the query param is absent', () => {
        expect(resolveCodecOverride(null, ALLOWED_VIDEO_CODEC_OVERRIDES)).toBeUndefined();
    });
});
