// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PlaybackPreferencesResponseSchema } from '$lib/schemas/api-user-responses';
import { resolveTracks } from '$lib/shared/track-selection';

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), savedCue: vi.fn() }));
vi.mock('$lib/api/user', () => ({
    getPlaybackPreferences: api.get,
    updatePlaybackPreferences: api.update,
}));
vi.mock('./SavedCue.svelte', () => ({ default: api.savedCue }));

const serverPreferences = PlaybackPreferencesResponseSchema.parse({
    audioLanguage: 'fr',
    subtitleLanguage: 'fr',
    subtitlesEnabled: true,
    forcedSubtitlesEnabled: true,
    subtitleStyle: null,
    qualityMode: 'original',
    maxBitrateBps: null,
    preferredResolution: null,
    autoplayNextEpisode: true,
    skipIntroAutomatically: false,
    skipCreditsAutomatically: false,
    nextEpisodeCountdownSecondsDefault: 10,
    updatedAt: '2026-10-26T00:00:00.000Z',
});

const savedStyle = {
    preset: 'shadow' as const,
    fontSize: 1.7,
    fontFamily: 'serif' as const,
    textColor: '#FFFFCC',
    backgroundColor: 'transparent',
    outlineColor: '#223344',
    outlineWidth: 2,
    shadowBlur: 8,
    positionY: 64,
};
const styledServerPreferences = PlaybackPreferencesResponseSchema.parse({
    ...serverPreferences,
    subtitleStyle: savedStyle,
});

let cleanupComponent: () => void | Promise<void> = () => {};
let clearAccount = (): void => {};
let removeListeners = (): void => {};

beforeEach(() => {
    vi.resetModules();
    api.get.mockReset();
    api.update.mockReset().mockResolvedValue({ data: serverPreferences, error: null, status: 200 });
    api.savedCue.mockClear();
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
            get length() {
                return values.size;
            },
            key: (index: number) => [...values.keys()][index] ?? null,
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, String(value)),
            removeItem: (key: string) => values.delete(key),
            clear: () => values.clear(),
        },
    });
    const windowListeners = vi.spyOn(window, 'addEventListener');
    const documentListeners = vi.spyOn(document, 'addEventListener');
    removeListeners = () => {
        for (const [type, listener, options] of windowListeners.mock.calls)
            window.removeEventListener(type, listener, options);
        for (const [type, listener, options] of documentListeners.mock.calls)
            document.removeEventListener(type, listener, options);
        windowListeners.mockRestore();
        documentListeners.mockRestore();
    };
});

afterEach(async () => {
    await cleanupComponent();
    clearAccount();
    removeListeners();
});

async function freshSettings(section: 'playback' | 'subtitles') {
    const { clearUserClientState } = await import('$lib/auth/clear-user-client-state');
    clearAccount = clearUserClientState;
    // Exercise a fresh settings visit after a real account wipe, without mounting a player.
    window.localStorage.setItem('playerPreferences', JSON.stringify({ audioLanguage: 'de' }));
    clearAccount();
    const component =
        section === 'playback'
            ? (await import('./PlaybackSection.svelte')).default
            : (await import('./SubtitlesSection.svelte')).default;
    // Keep the renderer and dynamically imported component on the same fresh Svelte runtime.
    const testing = await import('@testing-library/svelte/pure');
    const view = testing.render(component);
    cleanupComponent = testing.cleanup;
    return { ...testing, ...view };
}

test.each([
    ['playback', 'audioLanguage', /Default audio language/i],
    ['subtitles', 'subtitleLanguage', /Default subtitle language/i],
] as const)(
    '%s settings initialize after logout before accepting and persisting changes',
    async (section, field, label) => {
        let release!: (value: unknown) => void;
        api.get.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const view = await freshSettings(section);
        await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce());
        const controls = view.container.querySelector('fieldset')!;
        expect(controls.disabled).toBe(true);
        expect(api.update).not.toHaveBeenCalled();

        release({ data: serverPreferences, error: null, status: 200 });
        await vi.waitFor(() => expect(controls.disabled).toBe(false));
        const picker = view.getByRole('combobox', { name: label }) as HTMLSelectElement;
        expect(picker.value).toBe('fre');
        await view.fireEvent.change(picker, { target: { value: 'ita' } });
        const { playbackPreferences } =
            await import('$lib/components/player/preferences-sync.svelte');
        await playbackPreferences.forceSyncToServer();
        expect(api.update).toHaveBeenCalledOnce();
        const [payload, options] = api.update.mock.calls[0]!;
        const { writeOrder, ...preferences } = payload;
        const expected =
            section === 'subtitles'
                ? { subtitleLanguage: 'ita', subtitleTrackHint: null }
                : { [field]: 'ita' };
        expect(preferences).toEqual(expected);
        expect(writeOrder).toMatchObject({
            deviceId: expect.any(String),
            epochGeneration: expect.any(Number),
            epochId: expect.any(String),
            fields: Object.fromEntries(
                Object.keys(expected).map((key) => [
                    key,
                    { clock: expect.any(Number), operationId: expect.any(String) },
                ]),
            ),
        });
        expect(Object.keys(writeOrder.fields)).toEqual(Object.keys(expected));
        expect(options).toEqual({ keepalive: true });
    },
);

test.each([false, true])(
    'changing Default subtitle language clears a prior %s forced edition hint before resolution',
    async (isForced) => {
        const priorHint = { language: 'de', isForced, codec: 'subrip' };
        api.get.mockResolvedValueOnce({
            data: PlaybackPreferencesResponseSchema.parse({
                ...serverPreferences,
                subtitleLanguage: 'de',
                subtitleTrackHint: priorHint,
            }),
            error: null,
            status: 200,
        });
        const view = await freshSettings('subtitles');
        const controls = view.container.querySelector('fieldset')!;
        await vi.waitFor(() => expect(controls.disabled).toBe(false));
        const { playbackPreferences } =
            await import('$lib/components/player/preferences-sync.svelte');
        const audio = [{ index: 0, language: 'de', isDefault: true }];
        const subtitles = [
            { index: 1, language: 'de', isForced, codec: 'subrip' },
            { index: 2, language: 'it', isForced: false, codec: 'subrip' },
        ];
        expect(resolveTracks(audio, subtitles, playbackPreferences, null, 0).subtitle.index).toBe(
            1,
        );

        const picker = view.getByRole('combobox', { name: /Default subtitle language/i });
        await view.fireEvent.change(picker, { target: { value: 'ita' } });
        expect(playbackPreferences.subtitleLanguage).toBe('ita');
        expect(playbackPreferences.subtitleTrackHint).toBeNull();
        expect(resolveTracks(audio, subtitles, playbackPreferences, null, 0).subtitle).toEqual({
            index: 2,
            reason: 'saved-language',
        });
        await playbackPreferences.forceSyncToServer();
        expect(api.update.mock.calls[0]?.[0]).toMatchObject({
            subtitleLanguage: 'ita',
            subtitleTrackHint: null,
        });

        await view.fireEvent.change(picker, { target: { value: '' } });
        expect(playbackPreferences.subtitleLanguage).toBeNull();
        expect(playbackPreferences.subtitleTrackHint).toBeNull();
        await playbackPreferences.forceSyncToServer();
        expect(api.update.mock.calls[1]?.[0]).toMatchObject({
            subtitleLanguage: null,
            subtitleTrackHint: null,
        });
    },
);

test('failed account initialization keeps settings disabled and permits an explicit retry', async () => {
    api.get.mockResolvedValueOnce({ data: null, error: 'Unavailable', status: 503 });
    const view = await freshSettings('subtitles');
    const controls = view.container.querySelector('fieldset')!;
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce());
    expect(controls.disabled).toBe(true);
    api.get.mockResolvedValueOnce({ data: serverPreferences, error: null, status: 200 });
    await view.fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(controls.disabled).toBe(false));
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.update).not.toHaveBeenCalled();
});

test('delayed subtitle hydration and an external update change the controls without losing other fields', async () => {
    let release!: (value: unknown) => void;
    api.get.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    const view = await freshSettings('subtitles');
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce());
    const controls = view.container.querySelector('fieldset')!;
    expect(controls.disabled).toBe(true);

    release({ data: styledServerPreferences, error: null, status: 200 });
    await vi.waitFor(() => expect(controls.disabled).toBe(false));
    const size = view.getByLabelText(/Size/) as HTMLInputElement;
    const height = view.getByLabelText(/Height/) as HTMLInputElement;
    await vi.waitFor(() => expect(size.value).toBe('1.7'));
    expect(height.value).toBe('36');
    expect(view.getByRole('button', { name: 'Serif' }).getAttribute('aria-pressed')).toBe('true');
    expect(api.update).not.toHaveBeenCalled();

    const { playbackPreferences } = await import('$lib/components/player/preferences-sync.svelte');
    const externalStyle = { ...savedStyle, fontSize: 1.9, positionY: 70, textColor: '#AABBCC' };
    playbackPreferences.subtitleStyle = externalStyle;
    await vi.waitFor(() => expect(size.value).toBe('1.9'));
    expect(height.value).toBe('30');
    expect(api.update).not.toHaveBeenCalled();

    await view.fireEvent.click(view.getByRole('button', { name: 'Monospace' }));
    await playbackPreferences.forceSyncToServer();
    expect(api.update).toHaveBeenCalledOnce();
    expect(api.update.mock.calls[0]?.[0].subtitleStyle).toEqual({
        ...externalStyle,
        fontFamily: 'mono',
    });
});

test('settings preset and reset persist real paint fields and complete defaults', async () => {
    api.get.mockResolvedValueOnce({ data: styledServerPreferences, error: null, status: 200 });
    const view = await freshSettings('subtitles');
    const { playbackPreferences, SUBTITLE_STYLE_PRESETS, DEFAULT_SUBTITLE_STYLE } =
        await import('$lib/components/player/preferences-sync.svelte');
    const controls = view.container.querySelector('fieldset')!;
    await vi.waitFor(() => expect(controls.disabled).toBe(false));
    await view.fireEvent.click(view.getByRole('button', { name: 'Aa Outlined' }));
    const outlined = { ...savedStyle, ...SUBTITLE_STYLE_PRESETS.outlined, preset: 'outlined' };
    expect(outlined).toMatchObject({
        backgroundColor: 'transparent',
        outlineWidth: 3,
        shadowBlur: 2,
    });
    expect(playbackPreferences.subtitleStyle).toEqual(outlined);
    expect(
        view.container
            .querySelector('#subtitles-appearance [aria-hidden="true"] span')
            ?.getAttribute('style'),
    ).toContain('background: none');
    await playbackPreferences.forceSyncToServer();
    expect(api.update.mock.calls[0]?.[0].subtitleStyle).toEqual(outlined);

    await view.fireEvent.click(view.getByRole('button', { name: 'Reset to Default' }));
    expect(playbackPreferences.subtitleStyle).toEqual(DEFAULT_SUBTITLE_STYLE);
    await playbackPreferences.forceSyncToServer();
    expect(api.update.mock.calls[1]?.[0].subtitleStyle).toEqual(DEFAULT_SUBTITLE_STYLE);
});

test('open player popover follows external styles and saves real preset and reset values', async () => {
    api.get.mockResolvedValueOnce({ data: styledServerPreferences, error: null, status: 200 });
    const view = await freshSettings('subtitles');
    const { playbackPreferences, SUBTITLE_STYLE_PRESETS, DEFAULT_SUBTITLE_STYLE } =
        await import('$lib/components/player/preferences-sync.svelte');
    await vi.waitFor(() => expect(view.container.querySelector('fieldset')?.disabled).toBe(false));
    const Selector = (await import('$lib/components/player/SubtitleStyleSelector.svelte')).default;
    const onstylechange = vi.fn();
    const selector = view.render(Selector, { onstylechange });
    const size = selector.container.querySelector('input[aria-label="Size"]') as HTMLInputElement;
    const height = selector.container.querySelector(
        'input[aria-label="Height"]',
    ) as HTMLInputElement;
    await vi.waitFor(() => expect(size.value).toBe('1.7'));

    const externalStyle = { ...savedStyle, fontSize: 1.9, positionY: 70, textColor: '#AABBCC' };
    playbackPreferences.subtitleStyle = externalStyle;
    await vi.waitFor(() => expect(size.value).toBe('1.9'));
    expect(height.value).toBe('30');
    expect(api.update).not.toHaveBeenCalled();

    await view.fireEvent.click(selector.container.querySelector('button[title="Outlined"]')!);
    const outlined = { ...externalStyle, ...SUBTITLE_STYLE_PRESETS.outlined, preset: 'outlined' };
    expect(outlined).toMatchObject({
        backgroundColor: 'transparent',
        outlineWidth: 3,
        shadowBlur: 2,
    });
    expect(playbackPreferences.subtitleStyle).toEqual(outlined);
    expect(onstylechange).toHaveBeenLastCalledWith(outlined);
    expect(onstylechange.mock.lastCall?.[0]).not.toBe(playbackPreferences.subtitleStyle);
    expect(selector.container.querySelector('.preview-text')?.getAttribute('style')).toContain(
        'background: none',
    );
    await playbackPreferences.forceSyncToServer();
    expect(api.update.mock.calls[0]?.[0].subtitleStyle).toEqual(outlined);

    await view.fireEvent.click(selector.container.querySelector('.reset-btn')!);
    expect(playbackPreferences.subtitleStyle).toEqual(DEFAULT_SUBTITLE_STYLE);
    expect(onstylechange).toHaveBeenLastCalledWith(DEFAULT_SUBTITLE_STYLE);
    await playbackPreferences.forceSyncToServer();
    expect(api.update.mock.calls[1]?.[0].subtitleStyle).toEqual(DEFAULT_SUBTITLE_STYLE);
});

test('unavailable browser storage exposes a recovery error and can be retried after space is restored', async () => {
    const { PREFERENCE_EPOCH_KEY } = await import('$lib/shared/playback-preference-journal');
    const storage = window.localStorage;
    const setItem = storage.setItem.bind(storage);
    let available = false;
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
        if (key === PREFERENCE_EPOCH_KEY && !available)
            throw new DOMException('Storage is full', 'QuotaExceededError');
        setItem(key, value);
    });
    api.get.mockResolvedValue({ data: serverPreferences, error: null, status: 200 });
    const view = await freshSettings('subtitles');
    expect(await view.findByRole('alert')).toBeTruthy();
    const controls = view.container.querySelector('fieldset')!;
    expect(controls.disabled).toBe(true);
    expect(api.update).not.toHaveBeenCalled();

    available = true;
    await view.fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(controls.disabled).toBe(false));
    expect(view.queryByRole('alert')).toBeNull();
});

test('quota reached after loading does not show Saved and retry persists the retained edit', async () => {
    api.get.mockResolvedValue({ data: serverPreferences, error: null, status: 200 });
    const view = await freshSettings('subtitles');
    const controls = view.container.querySelector('fieldset')!;
    await vi.waitFor(() => expect(controls.disabled).toBe(false));
    const { PREFERENCE_JOURNAL_PREFIX } = await import('$lib/shared/playback-preference-journal');
    const storage = window.localStorage;
    const setItem = storage.setItem.bind(storage);
    let full = true;
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
        if (full && key.startsWith(PREFERENCE_JOURNAL_PREFIX))
            throw new DOMException('Storage is full', 'QuotaExceededError');
        setItem(key, value);
    });
    const picker = view.getByRole('combobox', { name: /Default subtitle language/i });
    await view.fireEvent.change(picker, { target: { value: 'ita' } });
    const { playbackPreferences } = await import('$lib/components/player/preferences-sync.svelte');
    expect(await playbackPreferences.forceSyncToServer()).toBe(false);
    expect(controls.disabled).toBe(true);
    expect(view.getByRole('alert')).toBeTruthy();
    expect(api.update).not.toHaveBeenCalled();
    expect(api.savedCue).toHaveBeenCalled();
    expect(api.savedCue.mock.calls[0]?.[1]?.savedAt).toBe(0);

    full = false;
    await view.fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(controls.disabled).toBe(false));
    expect(await playbackPreferences.forceSyncToServer()).toBe(true);
    expect(api.update).toHaveBeenCalledOnce();
    const { writeOrder, ...preferences } = api.update.mock.calls[0]![0];
    expect(preferences).toEqual({ subtitleLanguage: 'ita', subtitleTrackHint: null });
    expect(Object.keys(writeOrder.fields)).toEqual(['subtitleLanguage', 'subtitleTrackHint']);
    expect(view.queryByRole('alert')).toBeNull();
});

test('successful PATCH reclaims redundant cache before retrying its quota-blocked acknowledgement', async () => {
    api.get.mockResolvedValue({ data: serverPreferences, error: null, status: 200 });
    const view = await freshSettings('subtitles');
    const controls = view.container.querySelector('fieldset')!;
    await vi.waitFor(() => expect(controls.disabled).toBe(false));
    const { PREFERENCE_ACK_PREFIX, PREFERENCE_JOURNAL_PREFIX } =
        await import('$lib/shared/playback-preference-journal');
    const storage = window.localStorage;
    const setItem = storage.setItem.bind(storage);
    const usage = () =>
        Array.from({ length: storage.length }, (_, index) => storage.key(index)!).reduce(
            (total, key) => total + key.length + storage.getItem(key)!.length,
            0,
        );
    let capacity = Infinity;
    let rejectedAcknowledgements = 0;
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
        const previous = storage.getItem(key);
        const replaced = previous === null ? 0 : key.length + previous.length;
        if (usage() - replaced + key.length + value.length > capacity) {
            if (key.startsWith(PREFERENCE_ACK_PREFIX)) rejectedAcknowledgements++;
            throw new DOMException('Storage is full', 'QuotaExceededError');
        }
        setItem(key, value);
    });
    api.update.mockImplementationOnce(async () => {
        setItem('dashboard-cache', 'x'.repeat(2000));
        capacity = usage();
        return { data: serverPreferences, error: null, status: 200 };
    });
    const picker = view.getByRole('combobox', { name: /Default subtitle language/i });
    await view.fireEvent.change(picker, { target: { value: 'ita' } });
    const { playbackPreferences } = await import('$lib/components/player/preferences-sync.svelte');
    expect(await playbackPreferences.forceSyncToServer()).toBe(true);
    expect(rejectedAcknowledgements).toBeGreaterThan(0);
    expect(api.update).toHaveBeenCalledOnce();
    expect(storage.getItem('dashboard-cache')).toBeNull();
    expect(
        Array.from({ length: storage.length }, (_, index) => storage.key(index)!).filter((key) =>
            key.startsWith(PREFERENCE_JOURNAL_PREFIX),
        ),
    ).toEqual([]);
    expect(playbackPreferences.subtitleLanguage).toBe('ita');
    expect(playbackPreferences.ready).toBe(true);
    expect(playbackPreferences.storageUnavailable).toBe(false);
    expect(controls.disabled).toBe(false);
});

test('persistent acknowledgement failure disables settings and explicit retry retains the saved choice', async () => {
    api.get.mockResolvedValue({ data: serverPreferences, error: null, status: 200 });
    const view = await freshSettings('subtitles');
    const controls = view.container.querySelector('fieldset')!;
    await vi.waitFor(() => expect(controls.disabled).toBe(false));
    const { PREFERENCE_ACK_PREFIX } = await import('$lib/shared/playback-preference-journal');
    const storage = window.localStorage;
    const setItem = storage.setItem.bind(storage);
    let unavailable = true;
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
        if (unavailable && key.startsWith(PREFERENCE_ACK_PREFIX))
            throw new DOMException('Storage is full', 'QuotaExceededError');
        setItem(key, value);
    });
    const picker = view.getByRole('combobox', { name: /Default subtitle language/i });
    await view.fireEvent.change(picker, { target: { value: 'ita' } });
    const { playbackPreferences } = await import('$lib/components/player/preferences-sync.svelte');
    expect(await playbackPreferences.forceSyncToServer()).toBe(false);
    expect(api.update).toHaveBeenCalledOnce();
    expect(playbackPreferences.ready).toBe(false);
    expect(playbackPreferences.storageUnavailable).toBe(true);
    await vi.waitFor(() => expect(controls.disabled).toBe(true));
    expect(view.getByRole('alert')).toBeTruthy();

    unavailable = false;
    await view.fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(controls.disabled).toBe(false));
    expect(await playbackPreferences.forceSyncToServer()).toBe(true);
    expect(playbackPreferences.subtitleLanguage).toBe('ita');
    expect(playbackPreferences.storageUnavailable).toBe(false);
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(api.update.mock.calls[1]![0]).toMatchObject({ subtitleLanguage: 'ita' });
    expect(view.queryByRole('alert')).toBeNull();
});
