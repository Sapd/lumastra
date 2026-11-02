// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readable } from 'svelte/store';
vi.mock('$app/stores', () => ({
    page: readable({ data: { mediaLanguagePriority: ['de', 'fr'] } }),
}));
import { afterEach, describe, expect, it, vi } from 'vitest';
import TrackSelector from './TrackSelector.svelte';
import { playerStore } from './playerStore.svelte';

function setTracks(count: number): void {
    playerStore.currentMediaSource = {
        id: 'subtitle-test',
        audioStreams: [],
        subtitleStreams: Array.from({ length: count }, (_, index) => ({
            index,
            type: 'Subtitle',
            codec: 'subrip',
            language: index === 19 ? 'deu' : 'eng',
            languageCode: index === 19 ? 'deu' : 'eng',
            displayTitle: index === 19 ? 'German SDH' : `English ${index + 1}`,
            isDefault: false,
            isForced: false,
            deliveryMethod: 'External',
        })),
    } as unknown as typeof playerStore.currentMediaSource;
    playerStore.currentSubtitleTrackIndex = count - 1;
}

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    playerStore.currentMediaSource = null;
    playerStore.currentSubtitleTrackIndex = null;
    playerStore.originalLanguage = null;
});

describe('long subtitle lists', () => {
    it('keeps all 20 tracks, filters by language and title, and keeps settings outside the list', async () => {
        setTracks(20);
        const { container, getByRole } = render(TrackSelector);
        const list = container.querySelector('.subtitle-list')!;
        expect(list.querySelectorAll('button')).toHaveLength(21);
        expect(container.querySelector('.track-content')!.contains(list)).toBe(true);
        const search = getByRole('searchbox', { name: 'Search subtitle languages…' });
        await fireEvent.input(search, { target: { value: 'german' } });
        expect(list.querySelectorAll('button')).toHaveLength(2);
        expect(list.textContent).toContain('German SDH');
        await fireEvent.input(search, { target: { value: 'deu' } });
        expect(list.querySelectorAll('button')).toHaveLength(2);
        await fireEvent.input(search, { target: { value: 'missing' } });
        expect(getByRole('status').textContent).toBe('No matching subtitles.');
        expect(list.querySelectorAll('button')).toHaveLength(1); // Off remains available.
        expect(list.contains(getByRole('button', { name: 'Subtitle Appearance' }))).toBe(false);
        await fireEvent.input(search, { target: { value: '' } });
        expect(list.querySelectorAll('button')).toHaveLength(21);
    });

    it('keeps short lists compact without search', () => {
        setTracks(10);
        const { container, queryByRole } = render(TrackSelector);
        expect(queryByRole('searchbox')).toBeNull();
        expect(container.querySelector('.many-subtitles')).toBeNull();
    });

    it('opens at the overview rather than hiding audio to reveal a distant selected subtitle', async () => {
        setTracks(20);
        const { container } = render(TrackSelector);
        await tick();
        expect(container.querySelector('.track-content')!.scrollTop).toBe(0);
    });
});

it('opens appearance as a separate view and restores scroll and keyboard focus on Back', async () => {
    setTracks(20);
    const { container, getByRole } = render(TrackSelector);
    const body = container.querySelector<HTMLElement>('.track-content')!;
    body.scrollTop = 180;
    const appearance = getByRole('button', { name: 'Subtitle Appearance' });
    await fireEvent.click(appearance);
    expect(body.hidden).toBe(true);
    expect(getByRole('button', { name: 'Back' })).toBe(document.activeElement);
    expect(container.querySelector('.style-panel-container')).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: 'Back' }));
    expect(body.hidden).toBe(false);
    expect(body.scrollTop).toBe(180);
    expect(document.activeElement).toBe(appearance);
    expect(container.querySelector('.style-panel-container')).toBeNull();
});

it('returns from appearance on Escape without closing the track menu', async () => {
    setTracks(2);
    const onclose = vi.fn();
    const { getByRole } = render(TrackSelector, { onclose });
    await fireEvent.click(getByRole('button', { name: 'Subtitle Appearance' }));
    await fireEvent.keyDown(getByRole('button', { name: 'Back' }), { key: 'Escape' });
    expect(getByRole('button', { name: 'Subtitle Appearance' })).toBe(document.activeElement);
    expect(onclose).not.toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(onclose).toHaveBeenCalledOnce();
});

it('keeps useful audio distinctions and removes duplicate language codes', async () => {
    setTracks(2);
    playerStore.currentMediaSource!.audioStreams = [
        { index: 0, language: 'deu', languageCode: 'deu', displayTitle: 'deu', channels: 6 },
        {
            index: 1,
            language: 'eng',
            languageCode: 'eng',
            displayTitle: 'Director commentary',
            channels: 2,
        },
        { index: 2, language: 'eng', languageCode: 'eng', displayTitle: 'English', channels: 6 },
    ] as NonNullable<typeof playerStore.currentMediaSource>['audioStreams'];
    const { container, getByRole } = render(TrackSelector);
    expect(container.querySelectorAll('.audio-section small')).toHaveLength(1);
    const commentary = getByRole('button', {
        name: 'Audio track: English — Director commentary 2.0',
    });
    const select = vi.spyOn(playerStore, 'setAudioTrack').mockImplementation(() => {});
    const body = container.querySelector<HTMLElement>('.track-content')!;
    body.scrollTop = 120;
    await fireEvent.click(commentary);
    expect(select).toHaveBeenCalledWith(1);
    expect(body.scrollTop).toBe(120);
});

it('orders subtitle chips by server languages then original while keeping selected indices', async () => {
    setTracks(5);
    const source = playerStore.currentMediaSource!;
    const languages = ['ara', 'jpn', 'eng', 'deu', 'fra'];
    source.subtitleStreams.forEach((track, index) => {
        track.language = languages[index];
        track.languageCode = languages[index];
        track.displayTitle = languages[index];
    });
    playerStore.originalLanguage = 'ja';
    const { container } = render(TrackSelector);
    const names = [...container.querySelectorAll('.subtitle-list .chip-lang')].map((label) =>
        label.textContent?.trim(),
    );
    expect(names.slice(1)).toEqual(['German', 'French', 'Japanese', 'Arabic', 'English']);
    expect(playerStore.currentSubtitleTrackIndex).toBe(4);
    expect(source.subtitleStreams.map((track) => track.index)).toEqual([0, 1, 2, 3, 4]);
});
