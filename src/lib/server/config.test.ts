// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    validateLiveTvConfig,
    resolveInstanceId,
    getAuthoritativeStageIds,
    DEFAULT_AUTHORITATIVE_STAGES,
    validateAuthoritativeStageIds,
    parseAuthoritativeStageIds,
    PLAYBACK_INCIDENT_RETENTION_DAYS,
    PLAYBACK_INCIDENT_MAX_ROWS_PER_USER,
} from './config.js';

describe('validateLiveTvConfig', () => {
    it('warns when standalone mode has no proxy URL', () => {
        const warn = vi.fn();
        validateLiveTvConfig(true, 'standalone', '', 'secret123', warn);

        expect(warn).toHaveBeenCalledWith(
            'LIVETV_SOURCE is "standalone" but STREAM_PROXY_URL is not set — LiveTV will not work',
        );
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('warns when standalone mode has no proxy secret', () => {
        const warn = vi.fn();
        validateLiveTvConfig(true, 'standalone', 'http://proxy:3000', '', warn);

        expect(warn).toHaveBeenCalledWith(
            'STREAM_PROXY_SECRET is empty — proxy requests will be unauthenticated',
        );
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('warns for both missing proxy URL and secret', () => {
        const warn = vi.fn();
        validateLiveTvConfig(true, 'standalone', '', '', warn);

        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('STREAM_PROXY_URL is not set'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('STREAM_PROXY_SECRET is empty'));
    });

    it('does not warn when the feature is disabled, even in standalone mode', () => {
        // LIVETV_SOURCE defaults to 'standalone', so a feature-off install must stay
        // silent despite missing proxy config — FEATURE_LIVETV is the real gate.
        const warn = vi.fn();
        validateLiveTvConfig(false, 'standalone', '', '', warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn when source is disabled', () => {
        const warn = vi.fn();
        validateLiveTvConfig(true, 'disabled', '', '', warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn when source is jellyfin', () => {
        const warn = vi.fn();
        validateLiveTvConfig(true, 'jellyfin', '', '', warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn when standalone with all config provided', () => {
        const warn = vi.fn();
        validateLiveTvConfig(true, 'standalone', 'http://proxy:3000', 'secret123456789', warn);

        expect(warn).not.toHaveBeenCalled();
    });
});

// -----------------------------------------------------------------------------
// N-INSTANCE-ID: validate INSTANCE_ID so it's safe to embed in Valkey keys
// and admin UI labels.
// -----------------------------------------------------------------------------

describe('resolveInstanceId (N-INSTANCE-ID)', () => {
    const RE_FALLBACK = /^[A-Za-z0-9._-]+-[0-9a-z]+$/;

    it('accepts a plain alphanumeric id', () => {
        expect(resolveInstanceId('web-1')).toBe('web-1');
    });

    it('accepts dots, underscores, and hyphens', () => {
        expect(resolveInstanceId('node_1.replica-A')).toBe('node_1.replica-A');
    });

    it('falls back when the value is undefined or empty', () => {
        expect(resolveInstanceId(undefined)).toMatch(RE_FALLBACK);
        expect(resolveInstanceId('')).toMatch(RE_FALLBACK);
    });

    it('falls back when the value contains a colon', () => {
        expect(resolveInstanceId('web:1')).toMatch(RE_FALLBACK);
    });

    it('falls back when the value contains a newline', () => {
        expect(resolveInstanceId('web\n1')).toMatch(RE_FALLBACK);
    });

    it('falls back when the value contains whitespace', () => {
        expect(resolveInstanceId('web 1')).toMatch(RE_FALLBACK);
        expect(resolveInstanceId('\tweb-1')).toMatch(RE_FALLBACK);
    });

    it('falls back when the value contains control chars', () => {
        expect(resolveInstanceId('web\u0000-1')).toMatch(RE_FALLBACK);
    });

    it('falls back for values over 64 chars', () => {
        const tooLong = 'a'.repeat(65);
        expect(resolveInstanceId(tooLong)).toMatch(RE_FALLBACK);
    });

    it('accepts exactly 64 chars', () => {
        const maxLen = 'a'.repeat(64);
        expect(resolveInstanceId(maxLen)).toBe(maxLen);
    });
});

// -----------------------------------------------------------------------------
// Pipeline Coverage — authoritative stage IDs
// -----------------------------------------------------------------------------

// trickplay-params-sync is intentionally excluded from DEFAULT_AUTHORITATIVE_STAGES
// due to a per-file/per-item granularity mismatch in the backlog query. See
// src/lib/server/config.ts and trickplay-params-sync.ts for the explanation.
const EXPECTED_STAGE_IDS: readonly string[] = [
    // The analyzer's coverage stage was split when its visual and acoustic
    // detector groups became independently versioned. Only the visual half is
    // here: it is the per-episode stage the framework sweeps. The acoustic half
    // is season-scoped, owned by the task's own drain loop, and its eligibility
    // comes from row ABSENCE rather than seeded pending rows -- so it is
    // deliberately not an authoritative coverage stage.
    'lumastra-intro-analyzer:visual',
    'music-analysis',
    'album-enrichment',
    'artist-enrichment',
    'music-popularity',
    'mdblist-sync',
    'library-embeddings',
    'discovery-embeddings',
    'music-embedding-generation',
    'acoustid-fingerprint',
    'tmdb-metadata-sync',
    'series-sync',
    'image-sync',
    'chapter-sync',
    'metadata-update',
    'fribb-anime-sync',
    'mal-anime-id-enrichment',
];

describe('DEFAULT_AUTHORITATIVE_STAGES', () => {
    it('contains all 17 expected stage IDs', () => {
        expect(DEFAULT_AUTHORITATIVE_STAGES).toHaveLength(17);
        for (const id of EXPECTED_STAGE_IDS) {
            expect(DEFAULT_AUTHORITATIVE_STAGES).toContain(id);
        }
    });

    it('does not include trickplay-params-sync (disabled by default; opt-in only)', () => {
        expect(DEFAULT_AUTHORITATIVE_STAGES).not.toContain('trickplay-params-sync');
    });
});

describe('getAuthoritativeStageIds (default)', () => {
    let savedEnv: string | undefined;

    beforeEach(() => {
        savedEnv = process.env.PIPELINE_COVERAGE_AUTHORITATIVE_STAGES;
    });

    afterEach(() => {
        if (savedEnv === undefined) {
            delete process.env.PIPELINE_COVERAGE_AUTHORITATIVE_STAGES;
        } else {
            process.env.PIPELINE_COVERAGE_AUTHORITATIVE_STAGES = savedEnv;
        }
    });

    it('default set contains all 17 expected stage IDs', () => {
        const ids = getAuthoritativeStageIds();
        for (const id of EXPECTED_STAGE_IDS) {
            expect(ids.has(id)).toBe(true);
        }
        expect(ids.size).toBe(17);
    });
});

// -----------------------------------------------------------------------------
// parseAuthoritativeStageIds — empty-env semantics (P2-1)
// -----------------------------------------------------------------------------

describe('parseAuthoritativeStageIds', () => {
    it('returns default Set when env var is undefined (unset)', () => {
        const result = parseAuthoritativeStageIds(undefined);
        expect(result.size).toBe(DEFAULT_AUTHORITATIVE_STAGES.length);
        for (const id of DEFAULT_AUTHORITATIVE_STAGES) {
            expect(result.has(id)).toBe(true);
        }
    });

    it('returns empty Set when env var is set to empty string', () => {
        const result = parseAuthoritativeStageIds('');
        expect(result.size).toBe(0);
    });

    it('returns a single-entry Set when env var is set to one stage', () => {
        const result = parseAuthoritativeStageIds('music-analysis');
        expect(result.size).toBe(1);
        expect(result.has('music-analysis')).toBe(true);
    });

    it('returns all listed stages when env var has multiple comma-separated values', () => {
        const result = parseAuthoritativeStageIds(
            'music-analysis,album-enrichment,artist-enrichment',
        );
        expect(result.size).toBe(3);
        expect(result.has('music-analysis')).toBe(true);
        expect(result.has('album-enrichment')).toBe(true);
        expect(result.has('artist-enrichment')).toBe(true);
    });
});

describe('validateAuthoritativeStageIds', () => {
    it('does not warn when all configured IDs are known and all known IDs are configured', () => {
        const warn = vi.fn();
        const info = vi.fn();
        const ids = new Set(EXPECTED_STAGE_IDS);
        validateAuthoritativeStageIds(ids, [...EXPECTED_STAGE_IDS], warn, info);

        expect(warn).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
    });

    it('warns on configured stage IDs not present in the registry', () => {
        const warn = vi.fn();
        const info = vi.fn();
        const ids = new Set([...EXPECTED_STAGE_IDS, 'typo-stage', 'removed-plugin']);
        validateAuthoritativeStageIds(ids, [...EXPECTED_STAGE_IDS], warn, info);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('typo-stage');
        expect(warn.mock.calls[0][0]).toContain('removed-plugin');
        expect(info).not.toHaveBeenCalled();
    });

    it('logs INFO for known stage IDs absent from the configured set', () => {
        const warn = vi.fn();
        const info = vi.fn();
        const subset = new Set(EXPECTED_STAGE_IDS.filter((id) => id !== 'music-analysis'));
        validateAuthoritativeStageIds(subset, [...EXPECTED_STAGE_IDS], warn, info);

        expect(warn).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledTimes(1);
        expect(info.mock.calls[0][1]).toMatchObject({
            stages: ['music-analysis'],
        });
    });

    it('does not warn or info when both sets are empty', () => {
        const warn = vi.fn();
        const info = vi.fn();
        validateAuthoritativeStageIds(new Set(), [], warn, info);

        expect(warn).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
    });
});

// -----------------------------------------------------------------------------
// isUnavailableMediaVisible / isUnavailableMediaVisibleInSearch /
// isDiscoveryCatalogEnabled / features.requestsConfigured
//
// config.ts snapshots `process.env` into a module-level `env` object at
// import time, so exercising different env combinations requires a fresh
// module instance per case: `vi.resetModules()` + a dynamic `import()` AFTER
// setting `process.env`. No ConfigService is initialized in this test
// process, so the getters fall through to the env-var / default tier of the
// precedence chain (see `getConfig` in config.ts).
// -----------------------------------------------------------------------------

describe('discovery-catalog gate (isUnavailableMediaVisible / isUnavailableMediaVisibleInSearch / isDiscoveryCatalogEnabled / features.requestsConfigured)', () => {
    const GATE_ENV_KEYS = [
        'SHOW_UNAVAILABLE_MEDIA',
        'SHOW_UNAVAILABLE_MEDIA_IN_SEARCH',
        'FEATURE_REQUEST_MODAL',
        'SEERRURL',
        'SEERRAPIKEY',
        'PUBLIC_REQUESTURL',
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of GATE_ENV_KEYS) savedEnv[key] = process.env[key];
    });

    afterEach(() => {
        for (const key of GATE_ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        vi.resetModules();
    });

    /** Load a fresh config module instance under the given env overrides. */
    async function loadConfigWith(
        overrides: Partial<Record<(typeof GATE_ENV_KEYS)[number], string>>,
    ) {
        for (const key of GATE_ENV_KEYS) delete process.env[key];
        Object.assign(process.env, overrides);
        vi.resetModules();
        return import('./config.js');
    }

    it('features.requestsConfigured is false with neither Jellyseerr nor PUBLIC_REQUESTURL configured', async () => {
        const { features } = await loadConfigWith({});
        expect(features.requestsConfigured).toBe(false);
    });

    it('features.requestsConfigured is true when Jellyseerr requests are fully configured', async () => {
        const { features } = await loadConfigWith({
            FEATURE_REQUEST_MODAL: 'true',
            SEERRURL: 'https://jellyseerr.internal',
            SEERRAPIKEY: 'secret-key',
        });
        expect(features.requestsConfigured).toBe(true);
    });

    it('features.requestsConfigured is true when only PUBLIC_REQUESTURL is set', async () => {
        const { features } = await loadConfigWith({
            PUBLIC_REQUESTURL: 'https://requests.example.com',
        });
        expect(features.requestsConfigured).toBe(true);
    });

    it('isUnavailableMediaVisible is false when SHOW_UNAVAILABLE_MEDIA is off, even with a request path configured', async () => {
        const { isUnavailableMediaVisible } = await loadConfigWith({
            SHOW_UNAVAILABLE_MEDIA: 'false',
            PUBLIC_REQUESTURL: 'https://requests.example.com',
        });
        expect(isUnavailableMediaVisible()).toBe(false);
    });

    it('isUnavailableMediaVisible is false when SHOW_UNAVAILABLE_MEDIA is on but no request path is configured', async () => {
        const { isUnavailableMediaVisible } = await loadConfigWith({
            SHOW_UNAVAILABLE_MEDIA: 'true',
        });
        expect(isUnavailableMediaVisible()).toBe(false);
    });

    it('isUnavailableMediaVisible is true when SHOW_UNAVAILABLE_MEDIA is on and a request path is configured', async () => {
        const { isUnavailableMediaVisible } = await loadConfigWith({
            SHOW_UNAVAILABLE_MEDIA: 'true',
            PUBLIC_REQUESTURL: 'https://requests.example.com',
        });
        expect(isUnavailableMediaVisible()).toBe(true);
    });

    it('isUnavailableMediaVisibleInSearch mirrors the same requests-configured coupling via SHOW_UNAVAILABLE_MEDIA_IN_SEARCH', async () => {
        const off = await loadConfigWith({
            SHOW_UNAVAILABLE_MEDIA_IN_SEARCH: 'true',
        });
        expect(off.isUnavailableMediaVisibleInSearch()).toBe(false);

        const on = await loadConfigWith({
            SHOW_UNAVAILABLE_MEDIA_IN_SEARCH: 'true',
            PUBLIC_REQUESTURL: 'https://requests.example.com',
        });
        expect(on.isUnavailableMediaVisibleInSearch()).toBe(true);
    });

    it('isDiscoveryCatalogEnabled is false when neither toggle is on', async () => {
        const { isDiscoveryCatalogEnabled } = await loadConfigWith({
            PUBLIC_REQUESTURL: 'https://requests.example.com',
        });
        expect(isDiscoveryCatalogEnabled()).toBe(false);
    });

    it('isDiscoveryCatalogEnabled is true when only the search toggle is on (with a request path)', async () => {
        const { isDiscoveryCatalogEnabled } = await loadConfigWith({
            SHOW_UNAVAILABLE_MEDIA_IN_SEARCH: 'true',
            PUBLIC_REQUESTURL: 'https://requests.example.com',
        });
        expect(isDiscoveryCatalogEnabled()).toBe(true);
    });

    it('isDiscoveryCatalogEnabled is true when only the display toggle is on (with a request path)', async () => {
        const { isDiscoveryCatalogEnabled } = await loadConfigWith({
            SHOW_UNAVAILABLE_MEDIA: 'true',
            PUBLIC_REQUESTURL: 'https://requests.example.com',
        });
        expect(isDiscoveryCatalogEnabled()).toBe(true);
    });
});

// -----------------------------------------------------------------------------
// METADATA_ADDITIONAL_LANGUAGES — excludes the primary language (finding 4)
//
// Same module-reset requirement as the block above: `config.ts` snapshots
// `process.env` at import time, so a fresh `import()` after setting
// `process.env` is required to observe a different TMDB_LANGUAGE /
// METADATA_ADDITIONAL_LANGUAGES combination.
// -----------------------------------------------------------------------------

describe('METADATA_ADDITIONAL_LANGUAGES excludes the primary language', () => {
    const LANG_ENV_KEYS = ['TMDB_LANGUAGE', 'METADATA_ADDITIONAL_LANGUAGES'] as const;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of LANG_ENV_KEYS) savedEnv[key] = process.env[key];
    });

    afterEach(() => {
        for (const key of LANG_ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        vi.resetModules();
    });

    /** Load a fresh config module instance under the given env overrides. */
    async function loadConfigWith(
        overrides: Partial<Record<(typeof LANG_ENV_KEYS)[number], string>>,
    ) {
        for (const key of LANG_ENV_KEYS) delete process.env[key];
        Object.assign(process.env, overrides);
        vi.resetModules();
        return import('./config.js');
    }

    it("drops an additional entry equal to the primary language's full tag", async () => {
        const { config } = await loadConfigWith({
            TMDB_LANGUAGE: 'en-US',
            METADATA_ADDITIONAL_LANGUAGES: 'en-US, de',
        });
        expect(config.METADATA_ADDITIONAL_LANGUAGES).toEqual(['de']);
    });

    it("drops an additional entry equal to the primary language's bare tag", async () => {
        const { config } = await loadConfigWith({
            TMDB_LANGUAGE: 'en-US',
            METADATA_ADDITIONAL_LANGUAGES: 'en, de',
        });
        expect(config.METADATA_ADDITIONAL_LANGUAGES).toEqual(['de']);
    });

    it('keeps additional languages that do not collide with the primary', async () => {
        const { config } = await loadConfigWith({
            TMDB_LANGUAGE: 'en-US',
            METADATA_ADDITIONAL_LANGUAGES: 'de, ja',
        });
        expect(config.METADATA_ADDITIONAL_LANGUAGES).toEqual(['de', 'ja']);
    });
});

// -----------------------------------------------------------------------------
// Playback incident retention/row-cap defaults
// -----------------------------------------------------------------------------

describe('PLAYBACK_INCIDENT_RETENTION_DAYS / PLAYBACK_INCIDENT_MAX_ROWS_PER_USER', () => {
    it('PLAYBACK_INCIDENT_RETENTION_DAYS defaults to 30', () => {
        expect(PLAYBACK_INCIDENT_RETENTION_DAYS).toBe(30);
    });

    it('PLAYBACK_INCIDENT_MAX_ROWS_PER_USER defaults to 500', () => {
        expect(PLAYBACK_INCIDENT_MAX_ROWS_PER_USER).toBe(500);
    });
});
