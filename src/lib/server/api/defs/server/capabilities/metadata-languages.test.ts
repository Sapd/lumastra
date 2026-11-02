// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

vi.mock('$lib/server/server-branding.js', () => ({ getServerFeatures: async () => ({}) }));

import { describe, it, expect, vi, afterEach } from 'vitest';

const { mockConfig } = vi.hoisted(() => ({
    mockConfig: {
        TMDB_LANGUAGE: 'en-US',
        METADATA_ADDITIONAL_LANGUAGES: ['de-DE'] as string[],
        FEATURE_MEDIA_HOVER_VIDEO_PREVIEW: false,
        FEATURE_TOPSHELF_PREVIEWS: false,
        LIVETV_ADAPTIVE_LADDER_ENABLED: false,
        LIVETV_DEFAULT_QUALITY: 'adaptive' as const,
        LIVETV_ADAPTIVE_INCLUDE_ORIGINAL: false,
        // Unconfigured (empty) is a real, common state — jellyseerr.ts's
        // module-level singleton constructs unconditionally on import, and
        // `new JellyseerrClient(undefined, undefined)` throws (`.replace` on
        // undefined), so these must be strings, not absent.
        SEERRURL: '',
        SEERRAPIKEY: '',
    },
}));

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    // Same class of problem as the JELLYSEERR pair above, but a TOP-LEVEL
    // export rather than a `config` key: TaskRegistry imports this binding
    // directly and reads it at module scope (registry.ts ← plugin-context.ts),
    // so a partial mock without it throws on import before any test runs.
    // index.ts reaches that graph via its library-types.queries import.
    FEATURE_PER_TASK_QUEUES: false,
    features: {
        ffmpegAvailable: false,
        aiRecommendations: false,
        aiAssistant: false,
        liveTV: false,
        watchTogether: false,
        social: false,
        deviceAuth: false,
        musicClustering: false,
    },
}));

import { ServerCapabilitiesSchema } from '$lib/schemas/server-info.js';
import { metadataLanguages } from '../capabilities.js';

describe('ServerCapabilitiesSchema.metadata', () => {
    it('accepts a metadata language block', () => {
        const parsed = ServerCapabilitiesSchema.shape.metadata.parse({
            primary: 'en',
            additional: ['de-DE', 'fr'],
        });
        expect(parsed).toEqual({ primary: 'en', additional: ['de-DE', 'fr'] });
    });

    it('accepts an empty additional list (feature disabled)', () => {
        const parsed = ServerCapabilitiesSchema.shape.metadata.parse({
            primary: 'en',
            additional: [],
        });
        expect(parsed.additional).toEqual([]);
    });
});

describe('metadataLanguages() — empty/unnormalizable TMDB_LANGUAGE', () => {
    const originalTmdbLanguage = mockConfig.TMDB_LANGUAGE;

    afterEach(() => {
        mockConfig.TMDB_LANGUAGE = originalTmdbLanguage;
    });

    it('falls back to a sane default instead of advertising an empty primary', () => {
        mockConfig.TMDB_LANGUAGE = '';
        const result = metadataLanguages();
        expect(result.primary).toBe('en');
        expect(result.primary).not.toBe('');

        // Must still parse against the response schema.
        expect(() => ServerCapabilitiesSchema.shape.metadata.parse(result)).not.toThrow();
    });
});
