// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    SETUP_PREFERENCE_FIELDS,
    SETUP_PREFERENCE_KEYS,
    preferencesFromConfig,
    type SetupPreferenceValues,
} from '$lib/config/setup-preferences.js';

const languageConfig = vi.hoisted(() => ({ current: 'en-US', locked: false }));
vi.mock('$lib/server/config.js', () => ({
    config: {
        get TMDB_LANGUAGE() {
            return languageConfig.current;
        },
    },
}));

const mockSaveConfig = vi.fn().mockResolvedValue(undefined);
const mockApplyDefault = vi.fn().mockResolvedValue(1);
const mockDefaultSharing = vi.fn(() => true);
const mockGetDb = vi.fn<() => object | null>(() => ({}));
const mockAuditLog = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockGetDb(),
}));
vi.mock('$lib/server/config/activity-sharing.js', () => ({
    defaultActivitySharing: () => mockDefaultSharing(),
}));
vi.mock('$lib/server/database/queries/activity-sharing.queries.js', () => ({
    applyActivitySharingDefault: (...args: unknown[]) => mockApplyDefault(...args),
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditActor: () => ({ username: 'owner' }),
    auditLog: (...args: unknown[]) => mockAuditLog(...args),
}));

vi.mock('$lib/server/config/config.service.js', () => ({
    saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
    isEnvOverridden: (key: string) => key === 'TMDB_LANGUAGE' && languageConfig.locked,
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));

function call(body: unknown) {
    return import('./+server.js').then(({ POST }) =>
        (POST as (event: unknown) => Promise<Response>)({
            request: new Request('http://localhost/test', {
                method: 'POST',
                body: JSON.stringify(body),
            }),
        }),
    );
}

describe('POST /api/setup/preferences', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDefaultSharing.mockReturnValue(true);
        languageConfig.current = 'en-US';
        languageConfig.locked = false;
    });

    it.each([true, false])(
        'round-trips every wizard field through the shared mapping (share=%s)',
        async (share) => {
            // A resumed wizard hydrates step 3 with preferencesFromConfig(); if the
            // endpoint and that inverse ever disagree on a key or an encoding, the
            // wizard shows (and re-saves) the wrong value.
            const values: SetupPreferenceValues = {
                appName: 'Home Cinema',
                gpuAcceleration: 'qsv',
                metadataStorageLocation: 'alongside',
                trickplayEnabled: true,
                autoLyrics: false,
                introAnalyzer: false,
                gravatar: true,
                unratedContentVisible: true,
                shareActivityBetweenUsers: share,
                defaultActivitySharing: share,
                showUnavailableMedia: true,
                backchannelLogoutCascade: true,
                jellyfinCompat: false,
                subsonicCompat: true,
                publicApi: false,
                licenseServerContact: false,
            };
            expect(Object.keys(values).sort()).toEqual([...SETUP_PREFERENCE_FIELDS].sort());

            await call(values);
            const saved = mockSaveConfig.mock.calls[0][0] as Record<string, unknown>;

            expect(preferencesFromConfig(saved)).toEqual(values);
            // The only key outside the mapping: sharing OFF also hides live streams.
            const extra = Object.keys(saved).filter(
                (k) => !(Object.values(SETUP_PREFERENCE_KEYS) as string[]).includes(k),
            );
            expect(extra).toEqual(share ? [] : ['FEATURE_SESSIONS_PUBLIC']);
        },
    );

    it.each([false, true])('applies the saved sharing=%s default after saving', async (sharing) => {
        mockDefaultSharing.mockReturnValue(sharing);
        mockSaveConfig.mockImplementationOnce(async () => {
            expect(mockApplyDefault).not.toHaveBeenCalled();
        });
        const response = await call({ defaultActivitySharing: sharing });
        expect(response.status).toBe(200);
        expect(mockApplyDefault).toHaveBeenCalledWith(expect.anything(), sharing);
        expect(mockAuditLog).toHaveBeenCalledWith(
            'users.apply_activity_sharing_default',
            'users',
            { username: 'owner' },
            { sharing, changedCount: 1, source: 'setup' },
        );
    });

    it('uses the effective saved default when an environment lock keeps sharing on', async () => {
        mockDefaultSharing.mockReturnValue(true);
        expect((await call({ defaultActivitySharing: false })).status).toBe(200);
        expect(mockApplyDefault).toHaveBeenCalledWith(expect.anything(), true);
    });

    it('reports an unavailable database instead of claiming the default was applied', async () => {
        mockGetDb.mockReturnValueOnce(null);
        expect((await call({ defaultActivitySharing: false })).status).toBe(503);
        expect(mockApplyDefault).not.toHaveBeenCalled();
        expect(mockAuditLog).not.toHaveBeenCalled();
    });

    it('does not apply sharing when saving fails or the field is omitted', async () => {
        mockSaveConfig.mockRejectedValueOnce(new Error('save failed'));
        await expect(call({ defaultActivitySharing: false })).rejects.toThrow('save failed');
        expect(mockApplyDefault).not.toHaveBeenCalled();
        await call({ gravatar: false });
        expect(mockApplyDefault).not.toHaveBeenCalled();
        expect(mockAuditLog).not.toHaveBeenCalled();
    });

    it('rejects malformed defaults without saving and leaves omitted defaults alone', async () => {
        expect((await call({ defaultActivitySharing: 'true' })).status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
        await call({ gravatar: false });
        expect(mockSaveConfig.mock.calls[0][0]).not.toHaveProperty('DEFAULT_ACTIVITY_SHARING');
    });

    it('maps a full body to whitelisted config keys', async () => {
        const res = await call({
            appName: 'My Server',
            gpuAcceleration: 'nvenc',
            trickplayEnabled: true,
            introAnalyzer: false,
            autoLyrics: false,
            metadataStorageLocation: 'alongside-prefer',
            gravatar: true,
            unratedContentVisible: true,
        });
        const body = await res.json();

        expect(body.saved).toBe(true);
        expect(mockSaveConfig).toHaveBeenCalledWith(
            {
                APP_NAME: 'My Server',
                GPU_ACCELERATION: 'nvenc',
                TRICKPLAY_ENABLED: true,
                PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED: false,
                FEATURE_AUTO_LYRICS: false,
                METADATA_STORAGE_LOCATION: 'alongside-prefer',
                FEATURE_GRAVATAR: true,
                UNRATED_CONTENT_VISIBLE: true,
            },
            {
                // The answers the use-case projection also sets stay pinned.
                pinKeys: [
                    'FEATURE_AUTO_LYRICS',
                    'FEATURE_GRAVATAR',
                    'PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED',
                ],
            },
        );
    });

    it('maps jellyfinCompat to FEATURE_JELLYFIN_COMPAT', async () => {
        const res = await call({ jellyfinCompat: false });
        const body = await res.json();

        expect(body.saved).toBe(true);
        expect(mockSaveConfig).toHaveBeenCalledWith({ FEATURE_JELLYFIN_COMPAT: false });
    });

    it('maps subsonicCompat to FEATURE_SUBSONIC_COMPAT', async () => {
        const res = await call({ subsonicCompat: true });
        const body = await res.json();

        expect(body.saved).toBe(true);
        expect(mockSaveConfig).toHaveBeenCalledWith({ FEATURE_SUBSONIC_COMPAT: true });
    });

    it('only writes fields present in the body', async () => {
        const res = await call({ trickplayEnabled: true });
        const body = await res.json();

        expect(body.saved).toBe(true);
        expect(mockSaveConfig).toHaveBeenCalledWith({ TRICKPLAY_ENABLED: true });
    });

    it('ignores a blank instance name instead of overwriting the default', async () => {
        await call({ appName: '   ', trickplayEnabled: false });

        expect(mockSaveConfig).toHaveBeenCalledWith({ TRICKPLAY_ENABLED: false });
    });

    it('no-ops on an empty body without calling saveConfig', async () => {
        const res = await call({});
        const body = await res.json();

        expect(body.saved).toBe(false);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it.each(['german', 'https://user:secret@example.com', 42, { key: 'secret' }])(
        'rejects invalid language without echoing input while still saving other preferences',
        async (tmdbLanguage) => {
            const res = await call({ tmdbLanguage, appName: 'Cinema' });
            expect(res.status).toBe(422);
            const text = await res.text();
            expect(text).toMatch(/language code.*de-DE/i);
            expect(text).toMatch(/other preferences were saved/i);
            expect(text).not.toMatch(/german|secret|example.com/);
            expect(mockSaveConfig).toHaveBeenCalledWith({ APP_NAME: 'Cinema' });
        },
    );

    it('normalizes the primary metadata language before saving', async () => {
        expect((await call({ tmdbLanguage: '  DE-de  ' })).status).toBe(200);
        expect(mockSaveConfig).toHaveBeenCalledWith({ TMDB_LANGUAGE: 'de-DE' });
    });

    it('maps tmdbLanguage to TMDB_LANGUAGE', async () => {
        const res = await call({ tmdbLanguage: 'de-DE' });
        const body = await res.json();

        expect(body.saved).toBe(true);
        expect(mockSaveConfig).toHaveBeenCalledWith({ TMDB_LANGUAGE: 'de-DE' });
    });

    it('ignores a blank tmdbLanguage instead of overwriting the default', async () => {
        await call({ tmdbLanguage: '   ', trickplayEnabled: false });

        expect(mockSaveConfig).toHaveBeenCalledWith({ TRICKPLAY_ENABLED: false });
    });

    it('maps metadataAdditionalLanguages to METADATA_ADDITIONAL_LANGUAGES', async () => {
        const res = await call({ metadataAdditionalLanguages: 'de, fr-FR' });
        const body = await res.json();

        expect(body.saved).toBe(true);
        expect(mockSaveConfig).toHaveBeenCalledWith({
            METADATA_ADDITIONAL_LANGUAGES: 'de, fr-FR',
        });
    });

    it('ignores a blank metadataAdditionalLanguages instead of overwriting the existing value', async () => {
        await call({ metadataAdditionalLanguages: '   ', trickplayEnabled: false });

        expect(mockSaveConfig).toHaveBeenCalledWith({ TRICKPLAY_ENABLED: false });
    });

    it('rejects an invalid GPU acceleration value', async () => {
        const res = await call({ gpuAcceleration: 'magic' });

        expect(res.status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('rejects an invalid metadata storage location', async () => {
        const res = await call({ metadataStorageLocation: 'somewhere' });

        expect(res.status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('rejects an over-long instance name', async () => {
        const res = await call({ appName: 'x'.repeat(51) });

        expect(res.status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('rejects a non-object body', async () => {
        const res = await call('not-json');

        expect(res.status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });
});

describe('setup primary metadata language compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        languageConfig.current = 'en-US';
        languageConfig.locked = false;
    });
    it.each(['es-419', 'zh-Hans', 'en-001', 'zh-Hant-TW'])(
        'accepts %s alongside other preferences',
        async (tmdbLanguage) => {
            expect((await call({ tmdbLanguage, gravatar: true })).status).toBe(200);
            expect(mockSaveConfig).toHaveBeenCalledWith(
                {
                    TMDB_LANGUAGE: tmdbLanguage,
                    FEATURE_GRAVATAR: true,
                },
                { pinKeys: ['FEATURE_GRAVATAR'] },
            );
        },
    );
    it('leaves an unchanged legacy language alone while saving other preferences', async () => {
        languageConfig.current = 'legacy-language';
        expect((await call({ tmdbLanguage: 'legacy-language', gravatar: true })).status).toBe(200);
        expect(mockSaveConfig).toHaveBeenCalledWith(
            { FEATURE_GRAVATAR: true },
            { pinKeys: ['FEATURE_GRAVATAR'] },
        );
    });
    it('ignores environment-owned language input while saving other preferences', async () => {
        languageConfig.locked = true;
        expect((await call({ tmdbLanguage: 'german', gravatar: true })).status).toBe(200);
        expect(mockSaveConfig).toHaveBeenCalledWith(
            { FEATURE_GRAVATAR: true },
            { pinKeys: ['FEATURE_GRAVATAR'] },
        );
    });
});
