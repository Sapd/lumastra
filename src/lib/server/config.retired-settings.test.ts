// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin settings retired because nothing read them. Each one rendered as a
 * live control (or was documented as an env var) and changed nothing, so
 * neither the schema entry nor the getter may come back without a consumer.
 */

import { describe, it, expect } from 'vitest';
import { configSchema } from '$lib/config/schema.js';
import { config, features } from './config.js';

/** Key → why it went (2026-10-06). */
const RETIRED: Record<string, string> = {
    FEATURE_SECTIONS_TOGGLE: 'no user-menu control to hide home-page sections exists',
    MAX_BITRATE_MBPS: 'no transcode path applied a server-wide output cap',
    SUBTITLE_EXTRACTION: 'embedded-subtitle extraction has no off switch',
    TONEMAPPING_RANGE: 'tonemapx always emits limited range (r=tv), which the encoders need',
    VIDEO_CODECS_ALLOWED: 'direct play follows each client profile, not a server list',
    VIDEO_CODEC_FALLBACK: 'never read; the encoder comes from VIDEO_CODEC',
    VIDEO_CRF: 'software encoders use H264_CRF / H265_CRF',
    VIDEO_PRESET: 'software encoders use ENCODING_PRESET',
};

describe('retired settings', () => {
    it.each(Object.entries(RETIRED))('%s is not in the schema (%s)', (key) => {
        expect(configSchema.find((s) => s.key === key)).toBeUndefined();
    });

    it.each(Object.keys(RETIRED))('%s has no config getter', (key) => {
        expect(Object.prototype.hasOwnProperty.call(config, key)).toBe(false);
    });

    it('features has no sectionsToggle flag', () => {
        expect(Object.prototype.hasOwnProperty.call(features, 'sectionsToggle')).toBe(false);
    });
});
