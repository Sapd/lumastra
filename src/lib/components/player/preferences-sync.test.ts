// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for preferences-sync dirty-key tracking.
 *
 * Each test uses vi.resetModules() to get a fresh copy of the module so
 * module-level `dirtyKeys`, `revisionCounter`, and `playbackPreferences`
 * singletons are isolated.
 */

import {
    PlaybackPreferenceJournal,
    PREFERENCE_EPOCH_KEY,
    PREFERENCE_PERMIT_KEY,
    PREFERENCE_BROWSER_ID_KEY,
    advancePreferenceEpoch,
} from '$lib/shared/playback-preference-journal';
import { PlaybackPreferencesResponseSchema } from '$lib/schemas/api-user-responses';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ApiRequestOptions } from '$lib/api/types';
import { playbackPreferencesSchema, type PlaybackPreferencesInput } from '$lib/schemas/user';

// Mock the API module so we can assert on the payload without hitting network.
const updateMock = vi.fn<
    (
        payload: Record<string, unknown>,
        options?: ApiRequestOptions,
    ) => Promise<{
        data: unknown;
        error: string | { message: string } | null;
    }>
>();
const getMock = vi.fn<() => Promise<{ data: unknown; error: { message: string } | null }>>();

vi.mock('$lib/api/user', () => ({
    getPlaybackPreferences: () => getMock(),
    updatePlaybackPreferences: (payload: Record<string, unknown>, options?: ApiRequestOptions) =>
        updateMock(payload, options),
}));

// happy-dom's localStorage implementation is file-backed and missing in some
// harness configurations; install a plain in-memory shim per test.
function installLocalStorageShim(): void {
    const store = new Map<string, string>();
    const mock = {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
            store.set(key, String(value));
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() {
            return store.size;
        },
    };
    vi.stubGlobal('localStorage', mock);
    Object.defineProperty(window, 'localStorage', {
        value: mock,
        writable: true,
        configurable: true,
    });
}

let cleanupListeners = (): void => {};
beforeEach(() => {
    const windowListeners = vi.spyOn(window, 'addEventListener');
    const documentListeners = vi.spyOn(document, 'addEventListener');
    cleanupListeners = () => {
        for (const [type, listener, options] of windowListeners.mock.calls)
            window.removeEventListener(type, listener, options);
        for (const [type, listener, options] of documentListeners.mock.calls)
            document.removeEventListener(type, listener, options);
        windowListeners.mockRestore();
        documentListeners.mockRestore();
    };
    installLocalStorageShim();
    updateMock.mockReset();
    updateMock.mockResolvedValue({ data: {}, error: null });
    getMock.mockReset();
    getMock.mockResolvedValue({ data: null, error: null });
    vi.resetModules();
    vi.useFakeTimers();
});

afterEach(() => {
    cleanupListeners();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

async function freshModule() {
    return import('./preferences-sync.svelte');
}

function replayEdits() {
    return new PlaybackPreferenceJournal(window.localStorage, () => true).entries();
}

describe('preferences-sync dirty-key tracking', () => {
    test('serializes overlapping saves so an older subtitle choice cannot persist last', async () => {
        const mod = await freshModule();
        let finishFirst!: (value: { data: unknown; error: null }) => void;
        updateMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishFirst = resolve;
                }),
        );
        mod.updatePreference('subtitleLanguage', 'en');
        const first = mod.forceSyncToServer();
        await vi.waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
        mod.updatePreference('subtitleLanguage', 'de');
        const second = mod.forceSyncToServer();
        await Promise.resolve();
        expect(updateMock).toHaveBeenCalledTimes(1);
        finishFirst({ data: {}, error: null });
        await Promise.all([first, second]);
        expect(updateMock.mock.calls.map(([payload]) => payload.subtitleLanguage)).toEqual([
            'en',
            'de',
        ]);
        expect(mod.selectionPreferenceSnapshot().subtitleDirty).toBe(false);
    });

    test('cross-tab selection updates invalidate pending probes without dirtying merged preferences', async () => {
        const mod = await freshModule();
        const pending = mod.selectionPreferenceSnapshot();
        window.dispatchEvent(
            new StorageEvent('storage', {
                key: 'playerPreferences',
                newValue: JSON.stringify({ ...mod.getPreferences(), subtitleLanguage: 'de' }),
                storageArea: window.localStorage,
            }),
        );
        expect(mod.getPreferences().subtitleLanguage).toBe('de');
        expect(mod.staleSelectionPreferences(pending)).toEqual({ audio: false, subtitle: true });
        expect(mod.selectionPreferenceSnapshot().subtitleDirty).toBe(false);
    });

    test.each(['subtitlesEnabled', 'forcedSubtitlesEnabled', 'showEpisodeLanguages'] as const)(
        'migrates a lone local %s Off preference when the server has no row',
        async (key) => {
            window.localStorage.setItem('playerPreferences', JSON.stringify({ [key]: false }));
            const mod = await freshModule();
            await mod.initializePreferences();
            expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ [key]: false }), {
                keepalive: true,
            });
            expect(mod.getPreferences()[key]).toBe(false);
        },
    );

    test.each(['false', null, 0])(
        'normalizes malformed episode-language caches (%s)',
        async (value) => {
            window.localStorage.setItem(
                'playerPreferences',
                JSON.stringify({ showEpisodeLanguages: value }),
            );
            const mod = await freshModule();
            expect(mod.playbackPreferences.showEpisodeLanguages).toBe(true);
        },
    );

    test('episode languages default on, load from the server, and save explicit false', async () => {
        const mod = await freshModule();
        expect(mod.playbackPreferences.showEpisodeLanguages).toBe(true);
        getMock.mockResolvedValue({
            data: { showEpisodeLanguages: false, updatedAt: '2026-10-26T12:00:00Z' },
            error: null,
        });
        await mod.initializePreferences();
        expect(mod.getPreferences().showEpisodeLanguages).toBe(false);
        mod.updatePreference('showEpisodeLanguages', true);
        await mod.forceSyncToServer();
        expect(updateMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ showEpisodeLanguages: true }),
            expect.anything(),
        );
        mod.updatePreference('showEpisodeLanguages', false);
        await mod.forceSyncToServer();
        expect(updateMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ showEpisodeLanguages: false }),
            expect.anything(),
        );
    });

    test('still-watching prompt defaults to off', async () => {
        const mod = await freshModule();
        expect(mod.playbackPreferences.stillWatchingEnabled).toBe(false);
    });

    test('enabling the still-watching prompt reaches the server', async () => {
        const mod = await freshModule();
        mod.updatePreference('stillWatchingEnabled', true);
        await vi.runOnlyPendingTimersAsync();
        expect(updateMock).toHaveBeenCalledTimes(1);
        expect(updateMock.mock.calls[0][0].stillWatchingEnabled).toBe(true);
        expect(mod.playbackPreferences.stillWatchingEnabled).toBe(true);
    });

    test('explicit null passes through to the server (does not become undefined)', async () => {
        const mod = await freshModule();
        mod.updatePreference('subtitleLanguage', null);
        await vi.runOnlyPendingTimersAsync();
        expect(updateMock).toHaveBeenCalledTimes(1);
        const payload = updateMock.mock.calls[0][0];
        expect(Object.hasOwn(payload, 'subtitleLanguage')).toBe(true);
        expect(payload.subtitleLanguage).toBeNull();
    });

    test('back-to-back updatePreference calls all reach the server in one flush', async () => {
        const mod = await freshModule();
        mod.updatePreference('subtitleLanguage', 'en');
        mod.updatePreference('subtitlesEnabled', true);
        mod.updatePreference('forcedSubtitlesEnabled', false);
        await vi.runOnlyPendingTimersAsync();
        expect(updateMock).toHaveBeenCalledTimes(1);
        const payload = updateMock.mock.calls[0][0];
        expect(payload.subtitleLanguage).toBe('en');
        expect(payload.subtitlesEnabled).toBe(true);
        expect(payload.forcedSubtitlesEnabled).toBe(false);
    });

    test('updatePreferences multi-key flushes a single request with all keys', async () => {
        const mod = await freshModule();
        mod.updatePreferences({
            subtitleLanguage: 'de',
            subtitlesEnabled: true,
            subtitleTrackHint: {
                language: 'de',
                isForced: true,
                codec: 'pgs',
            },
        });
        await vi.runOnlyPendingTimersAsync();
        expect(updateMock).toHaveBeenCalledTimes(1);
        const payload = updateMock.mock.calls[0][0];
        expect(payload.subtitleLanguage).toBe('de');
        expect(payload.subtitlesEnabled).toBe(true);
        expect(payload.subtitleTrackHint).toEqual({
            language: 'de',
            isForced: true,
            codec: 'pgs',
        });
    });

    test('same-key edit during in-flight flush keeps the newer value dirty', async () => {
        const mod = await freshModule();

        // Hold the server response open so we can race a new edit against it.
        let resolveFirst: (value: {
            data: unknown;
            error: { message: string } | null;
        }) => void = () => {};
        updateMock.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolveFirst = r;
                }),
        );

        mod.updatePreference('subtitleLanguage', 'en');
        await vi.runOnlyPendingTimersAsync(); // debounce fires; in-flight begins
        expect(updateMock).toHaveBeenCalledTimes(1);

        // While first flush is in-flight, user edits the same key.
        mod.updatePreference('subtitleLanguage', 'de');

        // Server confirms the OLD 'en' value. Revision has moved on, so the
        // key must STAY dirty.
        resolveFirst({ data: {}, error: null });
        await Promise.resolve();
        await Promise.resolve();

        // Next debounce fires and should resend 'de'.
        updateMock.mockResolvedValueOnce({ data: {}, error: null });
        await vi.runOnlyPendingTimersAsync();
        expect(updateMock).toHaveBeenCalledTimes(2);
        const secondPayload = updateMock.mock.calls[1][0];
        expect(secondPayload.subtitleLanguage).toBe('de');
    });

    test('failed flush leaves dirty state — next flush retries', async () => {
        const mod = await freshModule();

        updateMock.mockResolvedValueOnce({
            data: null,
            error: { message: 'boom' },
        });

        mod.updatePreference('subtitleLanguage', 'en');
        await vi.runOnlyPendingTimersAsync();
        expect(updateMock).toHaveBeenCalledTimes(1);

        // Trigger a second flush via force sync; should resend because the
        // first failed.
        updateMock.mockResolvedValueOnce({ data: {}, error: null });
        await mod.forceSyncToServer();
        expect(updateMock).toHaveBeenCalledTimes(2);
        expect(updateMock.mock.calls[1][0].subtitleLanguage).toBe('en');
    });

    test('LOCAL_ONLY_FIELDS (volume, isMuted) never hit the server', async () => {
        const mod = await freshModule();
        mod.updatePreference('volume', 0.42);
        mod.updatePreference('isMuted', true);
        await vi.runOnlyPendingTimersAsync();
        // No dirty keys were ever marked → no flush was scheduled.
        expect(updateMock).not.toHaveBeenCalled();
    });

    test('an all-undefined flush sends nothing at all', async () => {
        // THE case the undefined-skip creates: with no other key to keep the payload
        // non-empty, the request would previously go out and arrive as `{}` — which the
        // server rejects with 422 "At least one preference field must be provided".
        // This is also the only path that reaches #flushDirty's empty-payload branch
        // with an ordinary server key rather than a LOCAL_ONLY_FIELD.
        const mod = await freshModule();
        mod.updatePreferences({ qualityMode: undefined as unknown as 'original' });
        await vi.runOnlyPendingTimersAsync();

        expect(updateMock).not.toHaveBeenCalled();
    });

    test('an undefined-valued key is never sent as a phantom field', async () => {
        // JSON.stringify DELETES undefined-valued keys. Such a key still counts
        // toward the "is the payload empty?" guard client-side, so the request goes
        // out — and arrives as `{}`, which the server rejects with 422 "At least one
        // preference field must be provided" and no field name to explain it.
        const mod = await freshModule();
        mod.updatePreferences({
            qualityMode: undefined as unknown as 'original',
            subtitleLanguage: 'fr',
        });
        await vi.runOnlyPendingTimersAsync();

        expect(updateMock).toHaveBeenCalledTimes(1);
        const payload = updateMock.mock.calls[0][0];
        expect(Object.hasOwn(payload, 'qualityMode')).toBe(false);
        expect(payload.subtitleLanguage).toBe('fr');
    });

    test('mixed update: local-only key does not send, server key does', async () => {
        const mod = await freshModule();
        mod.updatePreferences({ volume: 0.7, subtitleLanguage: 'fr' });
        await vi.runOnlyPendingTimersAsync();
        expect(updateMock).toHaveBeenCalledTimes(1);
        const payload = updateMock.mock.calls[0][0];
        expect(Object.hasOwn(payload, 'volume')).toBe(false);
        expect(Object.hasOwn(payload, 'isMuted')).toBe(false);
        expect(payload.subtitleLanguage).toBe('fr');
    });

    test('dirty map is persisted to localStorage and replayed on initialize()', async () => {
        // Simulate a prior session that wrote a dirty entry but didn't flush.
        window.localStorage.setItem('lumastra:pref-dirty', JSON.stringify({ subtitleLanguage: 1 }));
        window.localStorage.setItem(
            'playerPreferences',
            JSON.stringify({
                subtitleLanguage: 'ja',
                subtitleStyle: {
                    preset: 'default',
                    fontSize: 1,
                    fontFamily: 'system',
                    textColor: '#fff',
                    backgroundColor: 'rgba(0,0,0,0.75)',
                    outlineColor: '#000',
                    outlineWidth: 0,
                    shadowBlur: 4,
                    positionY: 85,
                },
            }),
        );

        // Server replies empty (never had this user's prefs).
        getMock.mockResolvedValueOnce({ data: null, error: null });

        const mod = await freshModule();
        // Use real timers for the async initialize(); the replay triggers a
        // direct #flushDirty() without the debounce path.
        vi.useRealTimers();
        await mod.initializePreferences();

        expect(updateMock).toHaveBeenCalled();
        const payload = updateMock.mock.calls[0][0];
        expect(payload.subtitleLanguage).toBe('ja');
    });

    test('multi-key null payload (turnOffSubtitles) sends all nulls in one request', async () => {
        const mod = await freshModule();
        // Simulates TrackSelector.turnOffSubtitles — 3 keys, one of them a
        // nested null, must all survive as explicit JSON nulls in the payload.
        mod.updatePreferences({
            subtitleLanguage: null,
            subtitlesEnabled: false,
            subtitleTrackHint: null,
        });
        await vi.runOnlyPendingTimersAsync();
        expect(updateMock).toHaveBeenCalledTimes(1);
        const payload = updateMock.mock.calls[0][0];
        expect(Object.hasOwn(payload, 'subtitleLanguage')).toBe(true);
        expect(payload.subtitleLanguage).toBeNull();
        expect(payload.subtitlesEnabled).toBe(false);
        expect(Object.hasOwn(payload, 'subtitleTrackHint')).toBe(true);
        expect(payload.subtitleTrackHint).toBeNull();
    });

    test('cross-tab storage event merges clean keys, preserves local dirty keys', async () => {
        const mod = await freshModule();

        // Local edit on subtitleLanguage (marks it dirty).
        mod.updatePreference('subtitleLanguage', 'en');

        // Simulate another tab writing a newer snapshot via the storage event.
        const crossTabSnapshot = {
            audioLanguage: 'fr', // clean → should apply
            subtitleLanguage: 'de', // dirty locally → must NOT apply
            subtitlesEnabled: true,
            forcedSubtitlesEnabled: false,
            qualityMode: 'original',
            maxBitrateBps: null,
            preferredResolution: null,
            autoplayNextEpisode: true,
            skipIntroAutomatically: false,
            skipCreditsAutomatically: false,
            subtitleStyle: {
                preset: 'default',
                fontSize: 1,
                fontFamily: 'system',
                textColor: '#fff',
                backgroundColor: 'rgba(0,0,0,0.75)',
                outlineColor: '#000',
                outlineWidth: 0,
                shadowBlur: 4,
                positionY: 85,
            },
            subtitleTrackHint: null,
            showAnnotationMarkers: true,
            autoShowAnnotations: true,
            volume: 0.33, // local-only → must NOT apply
            isMuted: true, // local-only → must NOT apply
        };

        window.dispatchEvent(
            new StorageEvent('storage', {
                key: 'playerPreferences',
                newValue: JSON.stringify(crossTabSnapshot),
                storageArea: window.localStorage,
            }),
        );

        const prefs = mod.getPreferences();
        expect(prefs.audioLanguage).toBe('fr'); // clean → applied
        expect(prefs.subtitleLanguage).toBe('en'); // dirty → kept local
        expect(prefs.volume).toBe(1); // local-only → default kept
        expect(prefs.isMuted).toBe(false); // local-only → default kept
    });

    test('#mergeFromServer skips dirty keys and LOCAL_ONLY_FIELDS', async () => {
        const mod = await freshModule();

        // User locally changes subtitleLanguage.
        mod.updatePreference('subtitleLanguage', 'en');

        // Server returns different values for subtitleLanguage (should be
        // ignored because it's dirty) AND a different volume (should be
        // ignored because it's a LOCAL_ONLY field).
        const serverPrefs = {
            audioLanguage: 'fr',
            subtitleLanguage: 'de',
            volume: 0.1,
            updatedAt: '2026-01-01T00:00:00Z',
            subtitleStyle: {
                preset: 'default',
                fontSize: 1,
                fontFamily: 'system',
                textColor: '#fff',
                backgroundColor: 'rgba(0,0,0,0.75)',
                outlineColor: '#000',
                outlineWidth: 0,
                shadowBlur: 4,
                positionY: 85,
            },
        };
        getMock.mockResolvedValueOnce({ data: serverPrefs, error: null });

        vi.useRealTimers();
        await mod.initializePreferences();

        const prefs = mod.getPreferences();
        // audioLanguage (clean) → applied from server
        expect(prefs.audioLanguage).toBe('fr');
        // subtitleLanguage (dirty) → kept local
        expect(prefs.subtitleLanguage).toBe('en');
        // volume (local-only) → kept local default (1), not 0.1 from server
        expect(prefs.volume).toBe(1);
    });

    test('subtitleStyle missing a new field (simulated app update) preserves user customizations', async () => {
        // Simulate a saved style from an older version of the app that predates
        // a newly-added field. User had customized fontSize, textColor, etc.
        // Those customizations MUST survive the update — only the missing
        // field should come from defaults.
        window.localStorage.setItem(
            'playerPreferences',
            JSON.stringify({
                subtitleStyle: {
                    preset: 'outlined',
                    fontSize: 1.8,
                    fontFamily: 'serif',
                    textColor: '#FFFF00',
                    backgroundColor: 'transparent',
                    outlineColor: '#FF0000',
                    outlineWidth: 3,
                    shadowBlur: 2,
                    // positionY intentionally missing (added in a later version)
                },
            }),
        );

        const mod = await freshModule();
        const prefs = mod.getPreferences();

        expect(prefs.subtitleStyle.fontSize).toBe(1.8);
        expect(prefs.subtitleStyle.fontFamily).toBe('serif');
        expect(prefs.subtitleStyle.textColor).toBe('#FFFF00');
        expect(prefs.subtitleStyle.outlineColor).toBe('#FF0000');
        expect(prefs.subtitleStyle.outlineWidth).toBe(3);
        expect(prefs.subtitleStyle.shadowBlur).toBe(2);
        expect(prefs.subtitleStyle.preset).toBe('outlined');

        // Missing field filled from defaults, not the entire style wiped
        expect(prefs.subtitleStyle.positionY).toBe(85);
    });

    test('out-of-range numeric fields are clamped or defaulted, not propagated', async () => {
        window.localStorage.setItem(
            'playerPreferences',
            JSON.stringify({
                subtitleStyle: {
                    preset: 'default',
                    fontSize: 1.2,
                    fontFamily: 'system',
                    textColor: '#fff',
                    backgroundColor: 'transparent',
                    outlineColor: '#000',
                    outlineWidth: -3, // negative, must clamp to 0
                    shadowBlur: -5, // negative, must clamp to 0
                    positionY: -50, // below range, must clamp to 0 or default
                },
            }),
        );

        const mod = await freshModule();
        const prefs = mod.getPreferences();

        expect(prefs.subtitleStyle.outlineWidth).toBeGreaterThanOrEqual(0);
        expect(prefs.subtitleStyle.shadowBlur).toBeGreaterThanOrEqual(0);
        expect(prefs.subtitleStyle.positionY).toBeGreaterThanOrEqual(0);
        expect(prefs.subtitleStyle.positionY).toBeLessThanOrEqual(100);
    });

    test('positionY above 100 is clamped to 100', async () => {
        window.localStorage.setItem(
            'playerPreferences',
            JSON.stringify({
                subtitleStyle: {
                    ...{
                        preset: 'default',
                        fontSize: 1,
                        fontFamily: 'system',
                        textColor: '#fff',
                        backgroundColor: 'transparent',
                        outlineColor: '#000',
                        outlineWidth: 0,
                        shadowBlur: 0,
                    },
                    positionY: 999,
                },
            }),
        );

        const mod = await freshModule();
        const prefs = mod.getPreferences();

        expect(prefs.subtitleStyle.positionY).toBeLessThanOrEqual(100);
    });

    test('invalid fontFamily string falls back to system', async () => {
        window.localStorage.setItem(
            'playerPreferences',
            JSON.stringify({
                subtitleStyle: {
                    preset: 'default',
                    fontSize: 1,
                    fontFamily: 'comic-sans-ms',
                    textColor: '#fff',
                    backgroundColor: 'transparent',
                    outlineColor: '#000',
                    outlineWidth: 0,
                    shadowBlur: 0,
                    positionY: 85,
                },
            }),
        );

        const mod = await freshModule();
        const prefs = mod.getPreferences();

        expect(prefs.subtitleStyle.fontFamily).toBe('system');
    });

    test('invalid preset string falls back to default', async () => {
        window.localStorage.setItem(
            'playerPreferences',
            JSON.stringify({
                subtitleStyle: {
                    preset: 'unknown-preset',
                    fontSize: 1,
                    fontFamily: 'system',
                    textColor: '#fff',
                    backgroundColor: 'transparent',
                    outlineColor: '#000',
                    outlineWidth: 0,
                    shadowBlur: 0,
                    positionY: 85,
                },
            }),
        );

        const mod = await freshModule();
        const prefs = mod.getPreferences();

        expect(prefs.subtitleStyle.preset).toBe('default');
    });

    test('fontSize of zero or negative falls back to default', async () => {
        window.localStorage.setItem(
            'playerPreferences',
            JSON.stringify({
                subtitleStyle: {
                    preset: 'default',
                    fontSize: 0,
                    fontFamily: 'system',
                    textColor: '#fff',
                    backgroundColor: 'transparent',
                    outlineColor: '#000',
                    outlineWidth: 0,
                    shadowBlur: 0,
                    positionY: 85,
                },
            }),
        );

        const mod = await freshModule();
        const prefs = mod.getPreferences();

        expect(prefs.subtitleStyle.fontSize).toBeGreaterThan(0);
    });

    test('truly corrupted subtitleStyle (char-indexed object) falls back to defaults', async () => {
        // Guards the original intent: a string accidentally serialized into
        // a char-keyed object must not propagate as style data.
        window.localStorage.setItem(
            'playerPreferences',
            JSON.stringify({
                subtitleStyle: { 0: 'F', 1: 'F', 2: 'F', 3: 'F' },
            }),
        );

        const mod = await freshModule();
        const prefs = mod.getPreferences();

        expect(prefs.subtitleStyle.fontSize).toBe(1.0);
        expect(prefs.subtitleStyle.positionY).toBe(85);
        expect(prefs.subtitleStyle.fontFamily).toBe('system');
    });
});

describe('subtitleStyle client/server contract', () => {
    // The server schema once declared `fontSize: z.number().min(8).max(200)` —
    // points/pixels — while the client emits a scale factor (1.0 = 100%, UI
    // slider 0.5–2.5). No value the client could produce validated, so every
    // subtitleStyle write 422'd; the failed flush left the key dirty and it
    // replayed on every page load, forever. These tests pin the unit agreement.

    test('the client default validates against the server schema', async () => {
        const { subtitleStyleSchema } = await import('$lib/schemas/user');
        const { DEFAULT_SUBTITLE_STYLE } = await import('./preferences-sync.svelte');

        expect(subtitleStyleSchema.safeParse(DEFAULT_SUBTITLE_STYLE).success).toBe(true);
    });

    test('every style the client sanitizer can emit validates server-side', async () => {
        const { subtitleStyleSchema } = await import('$lib/schemas/user');
        const mod = await freshModule();

        // Values chosen to hit the sanitizer's clamp edges from both directions,
        // plus the UI slider ends. Whatever comes out must satisfy the schema.
        for (const stored of [
            { fontSize: -100 },
            { fontSize: 0.5 },
            { fontSize: 2.5 },
            { fontSize: 999 },
            { fontSize: 16 }, // a legacy px-style value
            { fontSize: 1, outlineWidth: 999, shadowBlur: 999, positionY: 999 },
        ]) {
            window.localStorage.setItem(
                'playerPreferences',
                JSON.stringify({ subtitleStyle: stored }),
            );
            vi.resetModules();
            const fresh = await freshModule();
            const style = fresh.getPreferences().subtitleStyle;

            const result = subtitleStyleSchema.safeParse(style);
            expect(
                result.success,
                `stored ${JSON.stringify(stored)} sanitized to ${JSON.stringify(style)}`,
            ).toBe(true);
        }
        expect(mod).toBeDefined();
    });
});

test('pagehide serializes the latest same-key edit behind an in-flight keepalive PATCH on the actual wire', async () => {
    const actualApi = await vi.importActual<typeof import('$lib/api/user')>('$lib/api/user');
    updateMock.mockImplementation((payload, options) =>
        actualApi.updatePlaybackPreferences(payload as Partial<PlaybackPreferencesInput>, options),
    );
    const response = () =>
        Response.json(
            PlaybackPreferencesResponseSchema.parse({
                audioLanguage: null,
                subtitleLanguage: null,
                subtitlesEnabled: true,
                forcedSubtitlesEnabled: true,
                subtitleStyle: null,
                qualityMode: 'original',
                maxBitrateBps: null,
                preferredResolution: null,
                autoplayNextEpisode: true,
                skipIntroAutomatically: false,
                skipCreditsAutomatically: false,
                nextEpisodeCountdownSecondsDefault: 15,
            }),
        );
    let finishFirst: (value: Response) => void = () => {};
    const committed: string[] = [];
    const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce(
            (_url, init) =>
                new Promise<Response>((resolve) => {
                    finishFirst = (value) => {
                        committed.push(JSON.parse(String(init?.body)).audioLanguage);
                        resolve(value);
                    };
                }),
        )
        .mockImplementation(async (_url, init) => {
            committed.push(JSON.parse(String(init?.body)).audioLanguage);
            return response();
        });
    try {
        const mod = await freshModule();
        mod.updatePreference('audioLanguage', 'en');
        const first = mod.playbackPreferences._flushDirty();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        expect(fetchMock.mock.calls[0]).toEqual([
            '/api/me/playback-preferences',
            expect.objectContaining({
                method: 'PATCH',
                keepalive: true,
                body: expect.any(String),
            }),
        ]);
        const firstPayload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
        expect(firstPayload).toMatchObject({
            audioLanguage: 'en',
            writeOrder: {
                deviceId: expect.stringMatching(/^dashboard-/),
                epochGeneration: expect.any(Number),
                fields: {
                    audioLanguage: { clock: expect.any(Number), operationId: expect.any(String) },
                },
            },
        });
        mod.updatePreference('audioLanguage', 'de');
        window.dispatchEvent(new Event('pagehide'));
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(replayEdits()).toContainEqual(
            expect.objectContaining({ field: 'audioLanguage', value: 'de' }),
        );
        finishFirst(response());
        await first;
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(fetchMock.mock.calls[1]).toEqual([
            '/api/me/playback-preferences',
            expect.objectContaining({
                method: 'PATCH',
                keepalive: true,
                body: expect.any(String),
            }),
        ]);
        const secondPayload = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
        expect(secondPayload.audioLanguage).toBe('de');
        expect(secondPayload.writeOrder.fields.audioLanguage.clock).toBeGreaterThan(
            firstPayload.writeOrder.fields.audioLanguage.clock,
        );
        await mod.playbackPreferences._flushDirty();
        expect(committed).toEqual(['en', 'de']);
        expect(window.localStorage.getItem('lumastra:pref-dirty')).toBeNull();
    } finally {
        fetchMock.mockRestore();
    }
});

test('failed GET never migrates stale cached settings, preserves dirty edits and retries the read', async () => {
    window.localStorage.setItem(
        'playerPreferences',
        JSON.stringify({
            audioLanguage: 'de',
            subtitleLanguage: 'de',
            forcedSubtitlesEnabled: true,
        }),
    );
    window.localStorage.setItem(
        'lumastra:pref-dirty',
        JSON.stringify({ forcedSubtitlesEnabled: 1 }),
    );
    getMock.mockResolvedValueOnce({ data: null, error: { message: 'Unavailable' } });
    const { playbackPreferences } = await import('./preferences-sync.svelte');
    await playbackPreferences.initialize();
    expect(updateMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
            forcedSubtitlesEnabled: true,
            writeOrder: expect.objectContaining({
                fields: { forcedSubtitlesEnabled: expect.any(Object) },
            }),
        }),
        { keepalive: true },
    );
    getMock.mockResolvedValueOnce({
        data: { audioLanguage: 'en', subtitleLanguage: 'fr', updatedAt: '2026-10-25T12:00:00Z' },
        error: null,
    });
    await playbackPreferences.initialize();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(playbackPreferences.audioLanguage).toBe('en');
    expect(playbackPreferences.subtitleLanguage).toBe('fr');
    expect(updateMock).toHaveBeenCalledTimes(1);
});

test('account cleanup fences deferred saves, queued edits and reads before the next account initializes', async () => {
    const mod = await freshModule();
    const { clearUserClientState } = await import('$lib/auth/clear-user-client-state');
    let finishSave!: (value: { data: unknown; error: null }) => void;
    let finishOldRead!: (value: { data: unknown; error: null }) => void;
    let finishNextRead!: (value: { data: unknown; error: null }) => void;
    getMock.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishOldRead = resolve;
            }),
    );
    const oldRead = mod.playbackPreferences.initialize();
    updateMock.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishSave = resolve;
            }),
    );
    mod.updatePreference('audioLanguage', 'en');
    const oldSave = mod.playbackPreferences._flushDirty();
    await vi.waitFor(() => expect(updateMock).toHaveBeenCalledOnce());
    mod.updatePreference('audioLanguage', 'de');
    const queued = mod.playbackPreferences._flushDirty();
    clearUserClientState();
    finishSave({ data: {}, error: null });
    await oldSave;
    await queued;
    window.dispatchEvent(new Event('pagehide'));
    await vi.runOnlyPendingTimersAsync();
    expect(updateMock).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem('playerPreferences')).toBeNull();
    expect(window.localStorage.getItem('lumastra:pref-dirty')).toBeNull();
    getMock.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishNextRead = resolve;
            }),
    );
    const next = mod.playbackPreferences.initialize();
    finishOldRead({
        data: { audioLanguage: 'de', subtitleLanguage: 'de', updatedAt: '2026-10-26T10:00:00Z' },
        error: null,
    });
    await oldRead;
    const sameNext = mod.playbackPreferences.initialize();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem('playerPreferences')).toBeNull();
    finishNextRead({
        data: { audioLanguage: 'fr', subtitleLanguage: 'it', updatedAt: '2026-10-26T12:00:00Z' },
        error: null,
    });
    await next;
    await sameNext;
    expect(mod.getPreferences()).toMatchObject({ audioLanguage: 'fr', subtitleLanguage: 'it' });
    expect(mod.selectionPreferenceSnapshot()).toMatchObject({
        audioDirty: false,
        subtitleDirty: false,
    });
    expect(updateMock).toHaveBeenCalledOnce();
});

test('incoming storage changes apply without echoing per-tab volume or mute back into storage', async () => {
    const mod = await freshModule();
    mod.updatePreferences({ volume: 0.42, isMuted: true });
    await mod.playbackPreferences.forceSyncToServer();
    const setItem = vi.spyOn(window.localStorage, 'setItem');
    const before = mod.selectionPreferenceSnapshot();
    try {
        window.dispatchEvent(
            new StorageEvent('storage', {
                key: 'playerPreferences',
                storageArea: window.localStorage,
                newValue: JSON.stringify({
                    audioLanguage: 'fr',
                    subtitleLanguage: 'de',
                    volume: 1,
                    isMuted: false,
                }),
            }),
        );
        expect(mod.getPreferences()).toMatchObject({
            audioLanguage: 'fr',
            subtitleLanguage: 'de',
            volume: 0.42,
            isMuted: true,
        });
        expect(mod.selectionPreferenceSnapshot().audio).toBeGreaterThan(before.audio);
        expect(mod.selectionPreferenceSnapshot().subtitle).toBeGreaterThan(before.subtitle);
        expect(setItem).not.toHaveBeenCalled();
    } finally {
        setItem.mockRestore();
    }
});

test('independent tabs preserve another discarded tab journal and replay its stored value after an unrelated acknowledgement', async () => {
    const server = {
        audioLanguage: 'en',
        subtitleLanguage: 'en',
        updatedAt: '2026-10-26T12:00:00Z',
    };
    getMock.mockImplementation(async () => ({ data: { ...server }, error: null }));
    const a = await freshModule();
    await a.playbackPreferences.initialize();
    vi.resetModules();
    const b = await freshModule();
    await b.playbackPreferences.initialize();
    let discard!: (value: { data: unknown; error: { message: string } }) => void;
    updateMock.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                discard = resolve;
            }),
    );
    a.updatePreference('subtitleLanguage', 'de');
    void a.playbackPreferences._flushDirty();
    await vi.waitFor(() => expect(updateMock).toHaveBeenCalledOnce());
    // Discarding the realm releases its browser lock; its unacknowledged journal survives.
    discard({ data: null, error: { message: 'Discarded' } });
    updateMock.mockImplementation(async (payload) => {
        Object.assign(server, payload);
        return { data: {}, error: null };
    });
    b.updatePreference('audioLanguage', 'fr');
    await b.playbackPreferences.forceSyncToServer();
    expect(server).toMatchObject({ audioLanguage: 'fr', subtitleLanguage: 'en' });
    // B's full cache carries en, but A's own durable edit still carries de.
    expect(JSON.parse(window.localStorage.getItem('playerPreferences')!).subtitleLanguage).toBe(
        'en',
    );
    expect(replayEdits()).toContainEqual(
        expect.objectContaining({ field: 'subtitleLanguage', value: 'de' }),
    );
    vi.resetModules();
    const fresh = await freshModule();
    await fresh.playbackPreferences.initialize();
    expect(fresh.getPreferences()).toMatchObject({ audioLanguage: 'fr', subtitleLanguage: 'de' });
    expect(updateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ subtitleLanguage: 'de' }),
        { keepalive: true },
    );
    expect(server.subtitleLanguage).toBe('de');
    expect(replayEdits()).toEqual([]);
});

test('a newer edit in the original tab survives acknowledgement of an adopted replay snapshot', async () => {
    getMock.mockResolvedValue({
        data: { audioLanguage: 'en', subtitleLanguage: 'en', updatedAt: '2026-10-26T12:00:00Z' },
        error: null,
    });
    const a = await freshModule();
    a.updatePreference('subtitleLanguage', 'de');
    vi.resetModules();
    const replay = await freshModule();
    let finishReplay!: (value: { data: unknown; error: null }) => void;
    updateMock.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishReplay = resolve;
            }),
    );
    const pending = replay.playbackPreferences.initialize();
    await vi.waitFor(() => expect(updateMock).toHaveBeenCalledOnce());
    a.updatePreference('subtitleLanguage', 'ja');
    finishReplay({ data: {}, error: null });
    await pending;
    expect(replayEdits().map((edit) => edit.value)).toEqual(['ja']);
    vi.resetModules();
    const next = await freshModule();
    await next.playbackPreferences.initialize();
    expect(updateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ subtitleLanguage: 'ja' }),
        { keepalive: true },
    );
    expect(replayEdits()).toEqual([]);
});

test('sibling logout signals without a cache fence old saves, queued edits and reads until explicit next-account initialization', async () => {
    const a = await freshModule();
    vi.resetModules();
    const b = await freshModule();
    let finishRead!: (value: { data: unknown; error: null }) => void;
    getMock.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishRead = resolve;
            }),
    );
    const oldRead = b.playbackPreferences.initialize();
    let finishSave!: (value: { data: unknown; error: null }) => void;
    updateMock.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishSave = resolve;
            }),
    );
    a.updatePreference('audioLanguage', 'de');
    const oldSave = a.playbackPreferences._flushDirty();
    await vi.waitFor(() => expect(updateMock).toHaveBeenCalledOnce());
    a.updatePreference('audioLanguage', 'fr');
    const queued = a.playbackPreferences._flushDirty();
    window.localStorage.removeItem('playerPreferences');
    const { clearUserClientState } = await import('$lib/auth/clear-user-client-state');
    // A sibling window receives storage notification, not the origin's local event.
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockImplementationOnce(() => true);
    clearUserClientState();
    dispatch.mockRestore();
    window.dispatchEvent(
        new StorageEvent('storage', {
            key: PREFERENCE_EPOCH_KEY,
            storageArea: window.localStorage,
            newValue: window.localStorage.getItem(PREFERENCE_EPOCH_KEY),
        }),
    );
    expect(a.selectionPreferenceSnapshot().audioDirty).toBe(false);
    expect(replayEdits()).toEqual([]);
    a.updatePreference('audioLanguage', 'es');
    expect(a.getPreferences().audioLanguage).toBeNull();
    getMock.mockResolvedValue({
        data: { audioLanguage: 'it', subtitleLanguage: 'en', updatedAt: '2026-10-26T13:00:00Z' },
        error: null,
    });
    await a.playbackPreferences.initialize();
    finishRead({
        data: { audioLanguage: 'de', subtitleLanguage: 'de', updatedAt: '2026-10-26T12:00:00Z' },
        error: null,
    });
    finishSave({ data: {}, error: null });
    await oldRead;
    await oldSave;
    await queued;
    window.dispatchEvent(new Event('pagehide'));
    await vi.runOnlyPendingTimersAsync();
    expect(updateMock).toHaveBeenCalledOnce();
    expect(a.getPreferences().audioLanguage).toBe('it');
    expect(JSON.parse(window.localStorage.getItem('playerPreferences')!).audioLanguage).toBe('it');
    expect(replayEdits()).toEqual([]);
    vi.resetModules();
    const next = await freshModule();
    await next.playbackPreferences.initialize();
    expect(next.getPreferences().audioLanguage).toBe('it');
    expect(updateMock).toHaveBeenCalledOnce();
});

test('a failed signed-out initialization cannot reactivate a cleaned-up sibling tab', async () => {
    const mod = await freshModule();
    const { clearUserClientState } = await import('$lib/auth/clear-user-client-state');
    clearUserClientState();
    getMock.mockResolvedValueOnce({ data: null, error: { message: 'Unauthorized' } });
    await mod.playbackPreferences.initialize();
    expect(mod.playbackPreferences.loading).toBe(false);
    expect(mod.playbackPreferences.ready).toBe(false);
    mod.updatePreference('audioLanguage', 'de');
    window.dispatchEvent(new Event('pagehide'));
    await vi.runOnlyPendingTimersAsync();
    expect(updateMock).not.toHaveBeenCalled();
    expect(replayEdits()).toEqual([]);
    expect(window.localStorage.getItem('playerPreferences')).toBeNull();
    getMock.mockResolvedValueOnce({
        data: { audioLanguage: 'it', updatedAt: '2026-10-26T13:00:00Z' },
        error: null,
    });
    await mod.playbackPreferences.initialize();
    expect(mod.getPreferences().audioLanguage).toBe('it');
    expect(mod.playbackPreferences.ready).toBe(true);
});

test('delayed old cache deletion cannot retire initialization in the already-current cleanup epoch', async () => {
    const mod = await freshModule();
    mod.updatePreference('audioLanguage', 'de');
    const oldCache = window.localStorage.getItem('playerPreferences');
    const { clearUserClientState } = await import('$lib/auth/clear-user-client-state');
    clearUserClientState();
    let finish!: (value: { data: unknown; error: null }) => void;
    getMock.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const pending = mod.playbackPreferences.initialize();
    await vi.waitFor(() => expect(getMock).toHaveBeenCalledOnce());
    window.dispatchEvent(
        new StorageEvent('storage', {
            key: PREFERENCE_EPOCH_KEY,
            storageArea: window.localStorage,
            newValue: window.localStorage.getItem(PREFERENCE_EPOCH_KEY),
        }),
    );
    window.dispatchEvent(
        new StorageEvent('storage', {
            key: 'playerPreferences',
            storageArea: window.localStorage,
            oldValue: oldCache,
            newValue: null,
        }),
    );
    finish({ data: { audioLanguage: 'it', updatedAt: '2026-10-26T14:00:00Z' }, error: null });
    await pending;
    expect(mod.getPreferences().audioLanguage).toBe('it');
    expect(getMock).toHaveBeenCalledOnce();
    expect(JSON.parse(window.localStorage.getItem('playerPreferences')!).audioLanguage).toBe('it');
    expect(updateMock).not.toHaveBeenCalled();
});

test('a durable epoch rotation blocks queued, pagehide and explicit network dispatch before any storage event arrives', async () => {
    const mod = await freshModule();
    mod.updatePreference('audioLanguage', 'de');
    const queued = mod.playbackPreferences._flushDirty();
    advancePreferenceEpoch(window.localStorage);
    window.dispatchEvent(new Event('pagehide'));
    expect(await queued).toBe(false);
    expect(await mod.playbackPreferences._flushDirty()).toBe(false);
    await vi.runOnlyPendingTimersAsync();
    expect(updateMock).not.toHaveBeenCalled();
});

function wirePreferenceResponse(audioLanguage: string, subtitleLanguage: string): Response {
    return Response.json(
        PlaybackPreferencesResponseSchema.parse({
            audioLanguage,
            subtitleLanguage,
            subtitlesEnabled: true,
            forcedSubtitlesEnabled: true,
            subtitleStyle: null,
            qualityMode: 'original',
            maxBitrateBps: null,
            preferredResolution: null,
            autoplayNextEpisode: true,
            skipIntroAutomatically: false,
            skipCreditsAutomatically: false,
            nextEpisodeCountdownSecondsDefault: 15,
        }),
    );
}

test('three realms serialize an adopted HTTP replay before the newer original-tab edit and keep the final server choice', async () => {
    const server = {
        audioLanguage: 'en',
        subtitleLanguage: 'en',
        updatedAt: '2026-10-26T12:00:00Z',
    };
    getMock.mockImplementation(async () => ({ data: { ...server }, error: null }));
    const actualApi = await vi.importActual<typeof import('$lib/api/user')>('$lib/api/user');
    updateMock.mockImplementation((payload, options) =>
        actualApi.updatePlaybackPreferences(payload as Partial<PlaybackPreferencesInput>, options),
    );
    let finishOld!: () => void;
    const committed: string[] = [];
    const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce(
            (_url, init) =>
                new Promise<Response>((resolve) => {
                    finishOld = () => {
                        Object.assign(server, JSON.parse(String(init?.body)));
                        committed.push(server.subtitleLanguage);
                        resolve(
                            wirePreferenceResponse(server.audioLanguage, server.subtitleLanguage),
                        );
                    };
                }),
        )
        .mockImplementation(async (_url, init) => {
            Object.assign(server, JSON.parse(String(init?.body)));
            committed.push(server.subtitleLanguage);
            return wirePreferenceResponse(server.audioLanguage, server.subtitleLanguage);
        });
    try {
        const a = await freshModule();
        await a.playbackPreferences.initialize();
        a.updatePreference('subtitleLanguage', 'de');
        vi.resetModules();
        const b = await freshModule();
        const replay = b.playbackPreferences.initialize();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        a.updatePreference('subtitleLanguage', 'ja');
        const latest = a.playbackPreferences.forceSyncToServer();
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledOnce();
        finishOld();
        await replay;
        await latest;
        expect(committed).toEqual(['de', 'ja']);
        expect(server.subtitleLanguage).toBe('ja');
        vi.resetModules();
        const c = await freshModule();
        await c.playbackPreferences.initialize();
        expect(c.getPreferences().subtitleLanguage).toBe('ja');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(replayEdits()).toEqual([]);
    } finally {
        fetchMock.mockRestore();
    }
});

test('three realms do not replay an older same-field journal after a newer HTTP acknowledgement', async () => {
    const server = {
        audioLanguage: 'en',
        subtitleLanguage: 'en',
        updatedAt: '2026-10-26T12:00:00Z',
    };
    getMock.mockImplementation(async () => ({ data: { ...server }, error: null }));
    const actualApi = await vi.importActual<typeof import('$lib/api/user')>('$lib/api/user');
    updateMock.mockImplementation((payload, options) =>
        actualApi.updatePlaybackPreferences(payload as Partial<PlaybackPreferencesInput>, options),
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        Object.assign(server, JSON.parse(String(init?.body)));
        return wirePreferenceResponse(server.audioLanguage, server.subtitleLanguage);
    });
    try {
        const a = await freshModule();
        await a.playbackPreferences.initialize();
        vi.resetModules();
        const b = await freshModule();
        await b.playbackPreferences.initialize();
        a.updatePreference('subtitleLanguage', 'de');
        b.updatePreference('subtitleLanguage', 'fr');
        await b.playbackPreferences.forceSyncToServer();
        expect(server.subtitleLanguage).toBe('fr');
        // A's stale in-memory view must also reconcile before it can dispatch.
        await a.playbackPreferences.forceSyncToServer();
        expect(a.getPreferences().subtitleLanguage).toBe('fr');
        vi.resetModules();
        const c = await freshModule();
        await c.playbackPreferences.initialize();
        expect(c.getPreferences().subtitleLanguage).toBe('fr');
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(replayEdits()).toEqual([]);
    } finally {
        fetchMock.mockRestore();
    }
});

test('unrecoverable initial epoch allocation exposes storage failure and retry activates after quota clears', async () => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    let full = true;
    window.localStorage.setItem = (key: string, value: string) => {
        if (full && key === PREFERENCE_EPOCH_KEY) throw new Error('QuotaExceeded');
        original(key, value);
    };
    const mod = await freshModule();
    await mod.initializePreferences();
    expect(mod.playbackPreferences.ready).toBe(false);
    expect(mod.playbackPreferences.storageUnavailable).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
    mod.updatePreference('audioLanguage', 'de');
    await mod.forceSyncToServer();
    expect(updateMock).not.toHaveBeenCalled();
    full = false;
    await mod.initializePreferences();
    expect(mod.playbackPreferences.ready).toBe(true);
    expect(mod.playbackPreferences.storageUnavailable).toBe(false);
    mod.updatePreference('audioLanguage', 'fr');
    await mod.forceSyncToServer();
    expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
            audioLanguage: 'fr',
            writeOrder: expect.objectContaining({ epochGeneration: 1 }),
        }),
        { keepalive: true },
    );
});

test('insecure-context UUID fallbacks produce schema-valid ordered payloads', async () => {
    vi.stubGlobal('crypto', {}); // Plain HTTP: no randomUUID or other crypto API.
    const mod = await freshModule();
    mod.updatePreference('audioLanguage', 'de');
    await mod.forceSyncToServer();
    expect(updateMock).toHaveBeenCalledOnce();
    const payload = updateMock.mock.calls[0][0];
    expect(playbackPreferencesSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
        writeOrder: {
            deviceId: expect.stringMatching(/^dashboard-[a-f0-9-]+$/),
            epochId: expect.stringMatching(/^[a-f0-9-]+$/),
            fields: { audioLanguage: { operationId: expect.stringMatching(/^[a-f0-9-]+$/) } },
        },
    });
});

test('a removed cleanup permit fences a dirty sibling before storage events when every write is denied', async () => {
    const sibling = await freshModule();
    await sibling.initializePreferences();
    const oldMarker = window.localStorage.getItem(PREFERENCE_EPOCH_KEY)!;
    const { clearUserClientState } = await import('$lib/auth/clear-user-client-state');
    sibling.updatePreference('audioLanguage', 'de');
    const queued = sibling.playbackPreferences._flushDirty();
    window.localStorage.removeItem('playerPreferences');
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    let deny = true;
    window.localStorage.setItem = (key: string, value: string) => {
        if (deny) throw new Error('All writes denied');
        setItem(key, value);
    };
    const dispatch = window.dispatchEvent.bind(window);
    const localEvent = vi
        .spyOn(window, 'dispatchEvent')
        .mockImplementation((event) =>
            event.type === 'lumastra:user-client-state-cleared' ? true : dispatch(event),
        );
    clearUserClientState();
    localEvent.mockRestore(); // No cleanup/storage notification has reached the sibling.
    expect(window.localStorage.getItem(PREFERENCE_EPOCH_KEY)).toBe(oldMarker);
    expect(window.localStorage.getItem(PREFERENCE_PERMIT_KEY)).toBeNull();
    window.dispatchEvent(new Event('pagehide'));
    expect(await queued).toBe(false);
    expect(await sibling.playbackPreferences._flushDirty()).toBe(false);
    await vi.runOnlyPendingTimersAsync();
    expect(updateMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('playerPreferences')).toBeNull();
    deny = false;
    vi.resetModules();
    const nextAccount = await freshModule();
    getMock.mockResolvedValue({
        data: { audioLanguage: 'it', updatedAt: '2026-10-26T15:00:00Z' },
        error: null,
    });
    await nextAccount.initializePreferences();
    expect(nextAccount.playbackPreferences.ready).toBe(true);
    const marker = JSON.parse(window.localStorage.getItem(PREFERENCE_EPOCH_KEY)!);
    expect(marker.id).not.toBe(JSON.parse(oldMarker).id);
    expect(Number(marker.generation)).toBeGreaterThan(Number(JSON.parse(oldMarker).generation));
    nextAccount.updatePreference('audioLanguage', 'fr');
    await nextAccount.forceSyncToServer();
    expect(updateMock).toHaveBeenCalledOnce();
    expect(updateMock.mock.calls[0][0]).toMatchObject({ audioLanguage: 'fr' });
    // Even after the durable permit is granted to the new account, old memory
    // cannot reopen its retired context or repopulate its cache.
    sibling.updatePreference('audioLanguage', 'de');
    window.dispatchEvent(new Event('pagehide'));
    await vi.runOnlyPendingTimersAsync();
    expect(updateMock).toHaveBeenCalledOnce();
    expect(sibling.playbackPreferences.ready).toBe(false);
    expect(sibling.getPreferences().audioLanguage).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('playerPreferences')!).audioLanguage).toBe('fr');
});

test('a later browser identity storage failure clears readiness and explicit initialization can retry', async () => {
    const mod = await freshModule();
    await mod.initializePreferences();
    expect(mod.playbackPreferences.ready).toBe(true);
    window.localStorage.removeItem(PREFERENCE_BROWSER_ID_KEY);
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    let deny = true;
    window.localStorage.setItem = (key: string, value: string) => {
        if (deny && key === PREFERENCE_BROWSER_ID_KEY) throw new Error('Quota');
        setItem(key, value);
    };
    mod.updatePreference('audioLanguage', 'de');
    expect(await mod.forceSyncToServer()).toBe(false);
    expect(mod.playbackPreferences.ready).toBe(false);
    expect(mod.playbackPreferences.storageUnavailable).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
    deny = false;
    await mod.initializePreferences();
    expect(mod.playbackPreferences.ready).toBe(true);
    expect(mod.playbackPreferences.storageUnavailable).toBe(false);
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenCalledOnce();
    expect(updateMock.mock.calls[0][0]).toMatchObject({ audioLanguage: 'de' });
});

test('a post-ready journal allocation failure stays visible until retry durably preserves the edit before GET', async () => {
    getMock.mockResolvedValue({
        data: { audioLanguage: 'fr', updatedAt: '2026-10-26T15:00:00Z' },
        error: null,
    });
    const mod = await freshModule();
    await mod.initializePreferences();
    expect(mod.playbackPreferences.ready).toBe(true);
    const put = window.localStorage.setItem.bind(window.localStorage);
    let deny = true;
    window.localStorage.setItem = (key: string, value: string) => {
        if (deny && key.startsWith('lumastra:pref-journal:')) throw new Error('Quota');
        put(key, value);
    };
    mod.updatePreference('audioLanguage', 'de');
    expect(mod.playbackPreferences.storageUnavailable).toBe(true);
    expect(mod.playbackPreferences.ready).toBe(false);
    expect(await mod.forceSyncToServer()).toBe(false);
    await mod.initializePreferences();
    expect(mod.playbackPreferences.ready).toBe(false);
    expect(getMock).toHaveBeenCalledOnce();
    expect(updateMock).not.toHaveBeenCalled();
    deny = false;
    let finishRead!: (value: { data: unknown; error: null }) => void;
    getMock.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishRead = resolve;
            }),
    );
    const retry = mod.initializePreferences();
    await vi.waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(replayEdits()).toContainEqual(
        expect.objectContaining({ field: 'audioLanguage', value: 'de' }),
    );
    expect(mod.playbackPreferences.ready).toBe(false);
    finishRead({ data: { audioLanguage: 'fr', updatedAt: '2026-10-26T15:00:00Z' }, error: null });
    await retry;
    expect(mod.playbackPreferences.ready).toBe(true);
    expect(mod.playbackPreferences.storageUnavailable).toBe(false);
    expect(mod.getPreferences().audioLanguage).toBe('de');
    expect(updateMock).toHaveBeenCalledOnce();
    expect(updateMock.mock.calls[0][0]).toMatchObject({ audioLanguage: 'de' });
});

test('concurrent explicit missing-permit recovery publishes one context and queued old saves never recover it', async () => {
    const a = await freshModule();
    await a.initializePreferences();
    a.updatePreference('audioLanguage', 'de');
    const oldSave = a.playbackPreferences._flushDirty();
    const previous = window.localStorage.getItem(PREFERENCE_EPOCH_KEY)!;
    window.localStorage.removeItem(PREFERENCE_PERMIT_KEY);
    vi.resetModules();
    const b = await freshModule();
    expect(window.localStorage.getItem(PREFERENCE_EPOCH_KEY)).toBe(previous); // Constructor cannot recover.
    expect(await oldSave).toBe(false);
    expect(window.localStorage.getItem(PREFERENCE_EPOCH_KEY)).toBe(previous); // Flush cannot recover.
    expect(window.localStorage.getItem(PREFERENCE_PERMIT_KEY)).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
    const put = window.localStorage.setItem.bind(window.localStorage);
    const epochs: string[] = [];
    let other!: Promise<void>;
    let triggered = false;
    window.localStorage.setItem = (key: string, value: string) => {
        put(key, value);
        if (key === PREFERENCE_EPOCH_KEY) {
            epochs.push(value);
            if (!triggered) {
                triggered = true;
                other = b.initializePreferences();
            }
        }
    };
    await a.initializePreferences();
    await other;
    expect(epochs).toHaveLength(1);
    expect(a.playbackPreferences.ready).toBe(true);
    expect(b.playbackPreferences.ready).toBe(true);
    a.updatePreference('audioLanguage', 'it');
    await a.forceSyncToServer();
    b.updatePreference('audioLanguage', 'fr');
    await b.forceSyncToServer();
    const contexts = updateMock.mock.calls.map(
        ([payload]) => playbackPreferencesSchema.parse(payload).writeOrder!,
    );
    expect(contexts).toHaveLength(2);
    expect(contexts[0].epochId).toBe(contexts[1].epochId);
    expect(contexts[0].epochGeneration).toBe(contexts[1].epochGeneration);
    expect(contexts[0].deviceId).toBe(contexts[1].deviceId);
});

test('interleaved media ID allocation cannot fork the preference ledger for late keepalive requests', async () => {
    getMock.mockResolvedValue({
        data: { audioLanguage: 'fr', updatedAt: '2026-10-26T15:00:00Z' },
        error: null,
    });
    const a = await freshModule();
    vi.resetModules();
    const b = await freshModule();
    const { getDeviceId } = await import('./device-id');
    let secondInitialization!: Promise<void>;
    let interleaved = false;
    let sequence = 0;
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
        const value =
            `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`;
        if (!interleaved) {
            interleaved = true;
            getDeviceId(); // Unlocked media allocator publishes a different UUID mid-allocation.
            secondInitialization = b.initializePreferences();
        }
        return value;
    });
    try {
        await a.initializePreferences();
        await secondInitialization;
        const canonical = window.localStorage.getItem(PREFERENCE_BROWSER_ID_KEY);
        expect(canonical).toBeTruthy();
        expect(window.localStorage.getItem('dashboard_device_id')).not.toBe(canonical);
        // Model document teardown releasing its write lock while its HTTP
        // request survives. Bootstrap locks keep their real FIFO semantics.
        const request = navigator.locks.request.bind(navigator.locks);
        const lock = vi
            .spyOn(navigator.locks, 'request')
            .mockImplementation(((
                name: string,
                options: { signal?: AbortSignal },
                callback: (lock: unknown) => unknown,
            ) =>
                name === 'lumastra:preferences:bootstrap'
                    ? request(name, options, callback)
                    : Promise.resolve(callback(null))) as typeof navigator.locks.request);
        try {
            const orders = new Map<string, number>();
            let persisted = 'fr';
            let finishOld!: () => void;
            let dispatched = 0;
            const commit = (payload: Record<string, unknown>): void => {
                const order = playbackPreferencesSchema.parse(payload).writeOrder!;
                const clock = order.fields.audioLanguage.clock;
                if (clock > (orders.get(order.deviceId) ?? -1)) {
                    orders.set(order.deviceId, clock);
                    persisted = String(payload.audioLanguage);
                }
            };
            updateMock.mockImplementation((payload) => {
                if (++dispatched === 1)
                    return new Promise((resolve) => {
                        finishOld = () => {
                            commit(payload);
                            resolve({ data: {}, error: null });
                        };
                    });
                commit(payload);
                return Promise.resolve({ data: {}, error: null });
            });
            a.updatePreference('audioLanguage', 'de');
            const old = a.forceSyncToServer();
            await vi.waitFor(() => expect(updateMock).toHaveBeenCalledOnce());
            b.updatePreference('audioLanguage', 'ja');
            await b.forceSyncToServer();
            expect(persisted).toBe('ja');
            finishOld();
            await old;
            expect(persisted).toBe('ja');
            expect(orders.size).toBe(1);
            expect(
                updateMock.mock.calls.map(
                    ([payload]) => playbackPreferencesSchema.parse(payload).writeOrder!.deviceId,
                ),
            ).toEqual([canonical, canonical]);
        } finally {
            lock.mockRestore();
        }
    } finally {
        uuid.mockRestore();
    }
});

test('quota during a successful legacy-cache migration cannot suppress the next verified initialization', async () => {
    window.localStorage.setItem('playerPreferences', JSON.stringify({ audioLanguage: 'de' }));
    let finish!: (value: { data: unknown; error: null }) => void;
    getMock.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const mod = await freshModule();
    const initialization = mod.initializePreferences();
    await vi.waitFor(() => expect(getMock).toHaveBeenCalledOnce());
    const put = window.localStorage.setItem.bind(window.localStorage);
    let deny = true;
    window.localStorage.setItem = (key: string, value: string) => {
        if (deny && key.startsWith('lumastra:pref-journal:')) throw new Error('Quota');
        put(key, value);
    };
    finish({ data: null, error: null });
    await initialization;
    expect(mod.playbackPreferences.ready).toBe(false);
    expect(mod.playbackPreferences.storageUnavailable).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
    deny = false;
    getMock.mockResolvedValue({
        data: { audioLanguage: 'fr', updatedAt: '2026-10-26T15:00:00Z' },
        error: null,
    });
    await mod.initializePreferences();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(mod.playbackPreferences.ready).toBe(true);
    expect(mod.getPreferences().audioLanguage).toBe('de');
    expect(updateMock).toHaveBeenCalledOnce();
});

test('failed legacy dirty-map journaling blocks GET from overwriting its only durable values', async () => {
    window.localStorage.setItem('playerPreferences', JSON.stringify({ audioLanguage: 'de' }));
    window.localStorage.setItem('lumastra:pref-dirty', '{"audioLanguage":1}');
    const put = window.localStorage.setItem.bind(window.localStorage);
    let deny = true;
    window.localStorage.setItem = (key: string, value: string) => {
        if (deny && key.startsWith('lumastra:pref-journal:')) throw new Error('Quota');
        put(key, value);
    };
    getMock.mockResolvedValue({
        data: { audioLanguage: 'fr', updatedAt: '2026-10-26T15:00:00Z' },
        error: null,
    });
    const mod = await freshModule();
    await mod.initializePreferences();
    expect(mod.playbackPreferences.storageUnavailable).toBe(true);
    expect(mod.playbackPreferences.ready).toBe(false);
    expect(getMock).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem('playerPreferences')!).audioLanguage).toBe('de');
    expect(window.localStorage.getItem('lumastra:pref-dirty')).not.toBeNull();
    deny = false;
    await mod.initializePreferences();
    expect(mod.playbackPreferences.ready).toBe(true);
    expect(mod.getPreferences().audioLanguage).toBe('de');
    expect(updateMock).toHaveBeenCalledOnce();
    expect(updateMock.mock.calls[0][0]).toMatchObject({ audioLanguage: 'de' });
});

test('quota cache compaction preserves clean sibling choices and selection revisions without echoing defaults', async () => {
    getMock.mockResolvedValue({
        data: {
            ...(await wirePreferenceResponse('fr', 'de').json()),
            qualityMode: 'auto',
            updatedAt: '2026-10-26T00:00:00Z',
        },
        error: null,
    });
    const sibling = await freshModule();
    await sibling.initializePreferences();
    expect(sibling.playbackPreferences.ready).toBe(true);
    const before = sibling.getPreferences();
    expect(before).toMatchObject({
        audioLanguage: 'fr',
        subtitleLanguage: 'de',
        qualityMode: 'auto',
    });
    const revisions = sibling.selectionPreferenceSnapshot();
    const recovering = new PlaybackPreferenceJournal(window.localStorage, () => true);
    const oldValue = window.localStorage.getItem('playerPreferences');
    recovering.recoverStorage();
    const newValue = window.localStorage.getItem('playerPreferences');
    expect(JSON.parse(newValue!)).not.toHaveProperty('audioLanguage');
    const writes = vi.spyOn(window.localStorage, 'setItem');
    try {
        window.dispatchEvent(
            new StorageEvent('storage', {
                key: 'playerPreferences',
                storageArea: window.localStorage,
                oldValue,
                newValue,
            }),
        );
        expect(sibling.getPreferences()).toEqual(before);
        expect(sibling.selectionPreferenceSnapshot()).toEqual(revisions);
        expect(sibling.playbackPreferences.ready).toBe(true);
        expect(writes).not.toHaveBeenCalled();
        expect(updateMock).not.toHaveBeenCalled();
    } finally {
        writes.mockRestore();
    }
});
