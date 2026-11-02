// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { saveConfig, upsert, invalidate, getConfigValue, isEnvOverridden, getActiveNonEntLibs } =
    vi.hoisted(() => ({
        saveConfig: vi.fn<
            (
                config: Record<string, unknown>,
                options?: { pinKeys?: readonly string[] },
            ) => Promise<void>
        >(async () => {}),
        upsert: vi.fn<
            (sql: unknown, setting: { mediaType: string; reveal: boolean }) => Promise<boolean>
        >(async () => true),
        invalidate: vi.fn(),
        getConfigValue: vi.fn<(key: string) => unknown>((_key: string) => undefined),
        isEnvOverridden: vi.fn<(key: string) => boolean>((_key: string) => false),
        getActiveNonEntLibs: vi.fn(
            async () =>
                [] as { media_type: string; sidebar_visible: boolean; sort_order?: number }[],
        ),
    }));

vi.mock('$lib/server/config/config.service', () => ({
    saveConfig,
    get: getConfigValue,
    isEnvOverridden,
}));
vi.mock('$lib/server/database/queries/library-type-settings.queries', () => ({
    ensureLibraryTypeSetting: upsert,
}));
vi.mock('$lib/server/database/queries/library-types.queries', () => ({
    getActiveNonEntertainmentLibraries: getActiveNonEntLibs,
}));
vi.mock('$lib/server/services/database.service', () => ({
    aiDbService: { getSql: async () => (s: unknown) => s },
}));
vi.mock('../../../+layout.server', () => ({ _invalidateNonEntLibraryCache: invalidate }));
vi.mock('$lib/server/config', () => ({
    config: {
        // Effective values, as the config service mock reports them.
        get INSTANCE_USE_CASES() {
            return getConfigValue('INSTANCE_USE_CASES') ?? [];
        },
        get INSTANCE_PROFILE_APPLIED() {
            return getConfigValue('INSTANCE_PROFILE_APPLIED') ?? '';
        },
        OPENAI_API_KEY: '',
        VOYAGE_API_KEY: '',
        EMBEDDING_BASE_URL: '',
        SONIC_EMBEDDER_URL: '',
    },
    // The embedding check moved out of an inline read of the keys above into
    // this predicate (commit 4d44ba7ea). A partial config mock does NOT inherit
    // it, so it must be stubbed explicitly or every request 500s on "no export
    // is defined" — far from the change that caused it. Returns false to match
    // the empty keys declared above: no embedding provider configured.
    hasEmbeddingProvider: () => false,
    // registry.ts (imported transitively) reads this at module load.
    FEATURE_PER_TASK_QUEUES: false,
}));
// Neutral capabilities, so the projection does not depend on the runner's
// Python/torch install.
vi.mock('$lib/server/services/sonic-embedding.service', () => ({
    isSonicEngineConfigured: () => false,
}));
// Pass-through middleware
vi.mock('$lib/server/middleware/auth', () => ({ requireAdmin: (h: unknown) => h }));
vi.mock('$lib/server/middleware/error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

const auditLog = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog,
    auditActor: () => ({ username: 'admin' }),
}));

import { POST } from './+server';
import { ConfigConflictError } from '$lib/server/config/config-conflict';
import {
    applyUseCasePreset,
    parseAppliedProfile,
    serializeAppliedProfile,
    type UseCaseId,
} from '$lib/config/use-case-presets';

function req(body: unknown, isAdmin = true) {
    if (!POST) throw new Error('POST handler not exported from +server');
    const url = new URL('http://x/api/admin/instance-profile');
    return {
        request: new Request(url.href, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
        }),
        url,
        params: {},
        locals: {
            user: {
                userId: 'u1',
                username: 'admin',
                userGroups: [],
                isAdmin,
                maxAgeRating: null,
            },
            principal: {
                userId: 'u1',
                username: 'admin',
                userGroups: [],
                isAdmin,
                scopes: isAdmin ? ['admin'] : [],
            },
        },
    } as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/admin/instance-profile', () => {
    beforeEach(() => {
        saveConfig.mockReset();
        saveConfig.mockResolvedValue(undefined);
        upsert.mockReset();
        upsert.mockResolvedValue(true);
        getConfigValue.mockReset();
        getConfigValue.mockReturnValue(undefined);
        isEnvOverridden.mockReset();
        isEnvOverridden.mockReturnValue(false);
        invalidate.mockClear();
        // Reset the mock fully so no queued mockResolvedValueOnce values bleed between tests.
        getActiveNonEntLibs.mockReset();
        getActiveNonEntLibs.mockResolvedValue([]);
    });

    it('applies music preset and persists managed keys + selection', async () => {
        expect(POST).toBeDefined();
        const res = await POST!(req({ useCases: ['music'] }));
        expect(res.status).toBe(200);
        expect(saveConfig.mock.calls).toHaveLength(1);
        const saved = saveConfig.mock.calls[0]![0];
        expect(saved.INSTANCE_PRIMARY_MODE).toBe('music');
        expect(saved.FEATURE_MUSIC_FIRST).toBe(true);
        expect(saved.INSTANCE_USE_CASES).toEqual(['music']);
    });

    it('an applied preset is written to the admin audit log; a dry run is not', async () => {
        auditLog.mockClear();
        await POST!(req({ useCases: ['music'], dryRun: true }));
        expect(auditLog).not.toHaveBeenCalled();

        await POST!(req({ useCases: ['music'] }));
        expect(auditLog).toHaveBeenCalledWith(
            'settings.save',
            'config',
            { username: 'admin' },
            expect.objectContaining({
                source: 'instance-profile',
                useCases: ['music'],
                changedKeys: expect.arrayContaining([
                    'INSTANCE_PRIMARY_MODE',
                    'INSTANCE_USE_CASES',
                ]),
            }),
        );
    });

    it('rejects unknown use-case', async () => {
        expect(POST).toBeDefined();
        const res = await POST!(req({ useCases: ['bogus'] }));
        expect(res.status).toBe(422);
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it('rejects an unsafe landing path override', async () => {
        expect(POST).toBeDefined();
        const res = await POST!(req({ useCases: ['enterprise'], landingPath: '//evil.com' }));
        expect(res.status).toBe(422);
    });

    it('activates non-entertainment library types for enterprise', async () => {
        expect(POST).toBeDefined();
        await POST!(req({ useCases: ['enterprise'] }));
        const types = upsert.mock.calls.map((c) => c[1]!.mediaType);
        expect(types).toEqual(
            expect.arrayContaining(['home_video', 'training', 'educational', 'personal']),
        );
    });

    it('dryRun returns diff without calling saveConfig or upsert', async () => {
        expect(POST).toBeDefined();
        const res = await POST!(req({ useCases: ['enterprise'], dryRun: true }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { preview?: boolean; diff?: unknown[] };
        expect(body.preview).toBe(true);
        expect(Array.isArray(body.diff)).toBe(true);
        expect((body.diff as unknown[]).length).toBeGreaterThan(0);
        expect(saveConfig).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('enterprise preset uses first visible non-ent library as landing path', async () => {
        getActiveNonEntLibs.mockResolvedValueOnce([
            { media_type: 'training', sidebar_visible: true },
            { media_type: 'educational', sidebar_visible: true },
        ]);
        expect(POST).toBeDefined();
        const res = await POST!(req({ useCases: ['enterprise'] }));
        expect(res.status).toBe(200);
        expect(saveConfig.mock.calls).toHaveLength(1);
        const saved = saveConfig.mock.calls[0]![0];
        expect(saved.INSTANCE_LANDING_PATH).toBe('/library/training');
    });

    it('enterprise preset falls back to /library/home_video when no non-ent libraries exist', async () => {
        // default mock returns [] — no override needed
        expect(POST).toBeDefined();
        const res = await POST!(req({ useCases: ['enterprise'] }));
        expect(res.status).toBe(200);
        expect(saveConfig.mock.calls).toHaveLength(1);
        const saved = saveConfig.mock.calls[0]![0];
        expect(saved.INSTANCE_LANDING_PATH).toBe('/library/home_video');
    });

    it('enterprise preset respects explicit caller landingPath over DB lookup', async () => {
        getActiveNonEntLibs.mockResolvedValueOnce([
            { media_type: 'training', sidebar_visible: true },
        ]);
        expect(POST).toBeDefined();
        const res = await POST!(
            req({ useCases: ['enterprise'], landingPath: '/library/personal' }),
        );
        expect(res.status).toBe(200);
        expect(saveConfig.mock.calls).toHaveLength(1);
        const saved = saveConfig.mock.calls[0]![0];
        expect(saved.INSTANCE_LANDING_PATH).toBe('/library/personal');
    });

    it('enterprise preset skips non-sidebar-visible libraries when picking landing path', async () => {
        getActiveNonEntLibs.mockResolvedValueOnce([
            { media_type: 'training', sidebar_visible: false },
            { media_type: 'educational', sidebar_visible: true },
        ]);
        expect(POST).toBeDefined();
        const res = await POST!(req({ useCases: ['enterprise'] }));
        expect(res.status).toBe(200);
        expect(saveConfig.mock.calls).toHaveLength(1);
        const saved = saveConfig.mock.calls[0]![0];
        expect(saved.INSTANCE_LANDING_PATH).toBe('/library/educational');
    });

    it('enterprise preset respects sort_order when picking landing path (training=1 wins over educational=0 alphabetically)', async () => {
        // 'educational' comes before 'training' alphabetically but training has lower sort_order=1
        // The endpoint should sort by sort_order and pick the lowest (training=1).
        getActiveNonEntLibs.mockResolvedValueOnce([
            { media_type: 'educational', sidebar_visible: true, sort_order: 2 },
            { media_type: 'training', sidebar_visible: true, sort_order: 1 },
        ]);
        expect(POST).toBeDefined();
        const res = await POST!(req({ useCases: ['enterprise'] }));
        expect(res.status).toBe(200);
        expect(saveConfig.mock.calls).toHaveLength(1);
        const saved = saveConfig.mock.calls[0]![0];
        expect(saved.INSTANCE_LANDING_PATH).toBe('/library/training');
    });

    /** Effective config as the config service would report it. */
    function withConfig(values: Record<string, unknown>, envLocked: string[] = []): void {
        getConfigValue.mockImplementation((key: string) => values[key]);
        isEnvOverridden.mockImplementation((key: string) => envLocked.includes(key));
    }

    it('re-applying the saved profile keeps a setting the admin changed elsewhere', async () => {
        // A music instance where the admin later turned the calendar back on.
        withConfig({ INSTANCE_USE_CASES: ['music'], FEATURE_CALENDAR: true });
        const res = await POST!(req({ useCases: ['music'] }));
        expect(res.status).toBe(200);
        const { INSTANCE_PROFILE_APPLIED: _record, ...written } = saveConfig.mock.calls[0]![0];
        expect(written).toEqual({ INSTANCE_USE_CASES: ['music'] });

        const preview = await POST!(req({ useCases: ['music'], dryRun: true }));
        const body = (await preview.json()) as { diff: { key: string }[] };
        expect(body.diff).toEqual([]);
    });

    it('a selection change writes what it asks for and leaves the rest', async () => {
        // vod and music both turn social on; the admin turned it off.
        withConfig({ INSTANCE_USE_CASES: ['vod'], FEATURE_SOCIAL: false });
        await POST!(req({ useCases: ['music'] }));
        const saved = saveConfig.mock.calls[0]![0];
        expect(saved.INSTANCE_PRIMARY_MODE).toBe('music');
        expect(saved.FEATURE_MUSIC_FIRST).toBe(true);
        expect(saved.FEATURE_CALENDAR).toBe(false);
        expect(saved).not.toHaveProperty('FEATURE_SOCIAL');
        // The landing page follows the profile when the profile's default moves.
        expect(saved.INSTANCE_LANDING_PATH).toBe('/music');
    });

    it('the preview flags a value changed since the last apply that applying replaces', async () => {
        // The admin set their own landing page under vod; switching to music
        // moves the profile's landing page, which replaces it.
        withConfig({ INSTANCE_USE_CASES: ['vod'], INSTANCE_LANDING_PATH: '/playlists' });
        const preview = await POST!(req({ useCases: ['music'], dryRun: true }));
        const body = (await preview.json()) as {
            diff: { key: string; from: unknown; to: unknown; overridesChange?: boolean }[];
        };
        expect(body.diff.find((r) => r.key === 'INSTANCE_LANDING_PATH')).toEqual({
            key: 'INSTANCE_LANDING_PATH',
            from: '/playlists',
            to: '/music',
            overridesChange: true,
        });
        // A key the move asks for, still at the old profile's value: no flag.
        expect(body.diff.find((r) => r.key === 'FEATURE_CALENDAR')).toEqual({
            key: 'FEATURE_CALENDAR',
            from: true,
            to: false,
        });
    });

    it('keeps a custom landing page on re-apply unless the field is sent', async () => {
        withConfig({ INSTANCE_USE_CASES: ['music'], INSTANCE_LANDING_PATH: '/playlists' });
        await POST!(req({ useCases: ['music'] }));
        expect(saveConfig.mock.calls[0]![0]).not.toHaveProperty('INSTANCE_LANDING_PATH');

        // '' asks for the profile's own default.
        await POST!(req({ useCases: ['music'], landingPath: '' }));
        expect(saveConfig.mock.calls[1]![0].INSTANCE_LANDING_PATH).toBe('/music');
    });

    it('env-locked keys are neither written nor reported as applied', async () => {
        // vod -> music wants FEATURE_TRENDING off, but the environment owns it.
        withConfig({ INSTANCE_USE_CASES: ['vod'], FEATURE_TRENDING: true }, ['FEATURE_TRENDING']);
        const preview = await POST!(req({ useCases: ['music'], dryRun: true }));
        const pbody = (await preview.json()) as {
            diff: { key: string; envLocked?: boolean }[];
        };
        expect(pbody.diff.find((r) => r.key === 'FEATURE_TRENDING')).toMatchObject({
            envLocked: true,
        });

        const res = await POST!(req({ useCases: ['music'] }));
        const body = (await res.json()) as {
            applied: Record<string, unknown>;
            envLocked: string[];
        };
        expect(saveConfig.mock.calls[0]![0]).not.toHaveProperty('FEATURE_TRENDING');
        expect(body.applied).not.toHaveProperty('FEATURE_TRENDING');
        expect(body.envLocked).toEqual(['FEATURE_TRENDING']);
    });

    it('an env-set INSTANCE_USE_CASES is not taken as the applied profile', async () => {
        withConfig({ INSTANCE_USE_CASES: ['music'] }, ['INSTANCE_USE_CASES']);
        const res = await POST!(req({ useCases: ['music'] }));
        const saved = saveConfig.mock.calls[0]![0];
        // Full first projection, not an empty three-way delta.
        expect(saved.FEATURE_MUSIC_FIRST).toBe(true);
        expect(saved.FEATURE_CALENDAR).toBe(false);
        expect(saved).not.toHaveProperty('INSTANCE_USE_CASES');
        const body = (await res.json()) as { envLocked: string[] };
        // Same selection as the environment's: nothing to report.
        expect(body.envLocked).toEqual([]);
    });

    it('library types: existing rows are left alone; only newly asked-for types are revealed', async () => {
        withConfig({ INSTANCE_USE_CASES: ['enterprise'] });
        await POST!(req({ useCases: ['enterprise', 'showcase'] }));
        const calls = upsert.mock.calls.map((c) => c[1]);
        expect(calls.find((c) => c.mediaType === 'training')).toMatchObject({ reveal: false });
        expect(calls.find((c) => c.mediaType === 'product')).toMatchObject({ reveal: true });
    });

    it('a refused config save activates no library types', async () => {
        saveConfig.mockRejectedValueOnce(new Error('Invalid value'));
        const res = await POST!(req({ useCases: ['enterprise'] }));
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(upsert).not.toHaveBeenCalled();
    });

    it('reports library types that could not be activated', async () => {
        upsert.mockImplementation(async (_sql, setting) => {
            if (setting.mediaType === 'training') throw new Error('db');
            return true;
        });
        const res = await POST!(req({ useCases: ['enterprise'] }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { libraryTypesNotActivated: string[] };
        expect(body.libraryTypesNotActivated).toEqual(['training']);
    });

    it('refuses a non-admin caller before touching config', async () => {
        const res = await POST!(req({ useCases: ['music'] }, false));
        expect([401, 403]).toContain(res.status);
        expect(saveConfig).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
    });

    describe('recorded applies', () => {
        const recordFor = (useCases: UseCaseId[], at = '2026-10-07T10:00:00.000Z') =>
            serializeAppliedProfile({
                useCases,
                values: applyUseCasePreset(useCases, {
                    hasEmbeddings: false,
                    hasSonicEmbedder: false,
                }).patch,
                at,
            });

        it('records what the apply projected and pins the profile choices', async () => {
            const res = await POST!(req({ useCases: ['music'] }));
            const body = (await res.json()) as { revision: string };
            const [written, options] = saveConfig.mock.calls[0]!;
            const record = parseAppliedProfile(written.INSTANCE_PROFILE_APPLIED);
            expect(record).toMatchObject({ useCases: ['music'], at: body.revision });
            expect(record!.values.FEATURE_CALENDAR).toBe(false);
            // music turns the calendar off (a choice) but never names the showcase.
            expect(options?.pinKeys).toContain('FEATURE_CALENDAR');
            expect(options?.pinKeys).not.toContain('FEATURE_PUBLIC_SHOWCASE');
        });

        it('uses the record as the base: a key the record lacks is written', async () => {
            const raw = JSON.parse(recordFor(['music'])) as { values: Record<string, unknown> };
            delete raw.values.FEATURE_LIVETV;
            withConfig({
                INSTANCE_USE_CASES: ['music'],
                INSTANCE_PROFILE_APPLIED: JSON.stringify(raw),
                FEATURE_LIVETV: true,
            });
            const preview = await POST!(req({ useCases: ['music'], dryRun: true }));
            const body = (await preview.json()) as {
                diff: { key: string; newInProfile?: boolean }[];
            };
            expect(body.diff).toEqual([
                { key: 'FEATURE_LIVETV', from: true, to: false, newInProfile: true },
            ]);
        });

        it('a record that no longer matches the use cases in force is not trusted', async () => {
            withConfig({
                INSTANCE_USE_CASES: ['vod'],
                INSTANCE_PROFILE_APPLIED: recordFor(['music']),
            });
            await POST!(req({ useCases: ['vod'] }));
            // Base recomputed from ['vod']: the same selection writes nothing else.
            const { INSTANCE_PROFILE_APPLIED: _r, ...written } = saveConfig.mock.calls[0]![0];
            expect(written).toEqual({ INSTANCE_USE_CASES: ['vod'] });
        });

        /** saveConfig's compare-and-swap, run against the given settings.json value. */
        function casAgainst(fileValue: unknown): void {
            saveConfig.mockImplementation(async (_updates, options) => {
                const expect_ = (
                    options as { expect?: { key: string; test: (v: unknown) => boolean } }
                )?.expect;
                if (expect_ && !expect_.test(fileValue)) throw new ConfigConflictError(expect_.key);
            });
        }

        it('refuses a form built from an older revision with 409', async () => {
            const newer = recordFor(['music'], '2026-10-07T11:00:00.000Z');
            withConfig({ INSTANCE_USE_CASES: ['music'], INSTANCE_PROFILE_APPLIED: newer });
            casAgainst(newer);
            auditLog.mockClear();
            const stale = await POST!(
                req({ useCases: ['vod'], expectedRevision: '2026-10-07T10:00:00.000Z' }),
            );
            expect(stale.status).toBe(409);
            expect(upsert).not.toHaveBeenCalled();
            expect(auditLog).not.toHaveBeenCalled();

            const fresh = await POST!(
                req({ useCases: ['vod'], expectedRevision: '2026-10-07T11:00:00.000Z' }),
            );
            expect(fresh.status).toBe(200);
        });

        it("checks the revision against settings.json, not this replica's memory", async () => {
            // This replica still holds the old record; the file already has the new one.
            withConfig({
                INSTANCE_USE_CASES: ['music'],
                INSTANCE_PROFILE_APPLIED: recordFor(['music'], '2026-10-07T10:00:00.000Z'),
            });
            casAgainst(recordFor(['music'], '2026-10-07T11:00:00.000Z'));
            const res = await POST!(
                req({ useCases: ['music'], expectedRevision: '2026-10-07T11:00:00.000Z' }),
            );
            expect(res.status).toBe(200);
        });

        it('a dry run is never refused for its revision', async () => {
            withConfig({ INSTANCE_USE_CASES: ['music'] });
            const res = await POST!(
                req({ useCases: ['music'], dryRun: true, expectedRevision: 'whatever' }),
            );
            expect(res.status).toBe(200);
        });

        it('a form from before any record sends null and passes while none exists', async () => {
            withConfig({ INSTANCE_USE_CASES: ['music'] });
            casAgainst(undefined);
            const res = await POST!(req({ useCases: ['music'], expectedRevision: null }));
            expect(res.status).toBe(200);
        });
    });
});
