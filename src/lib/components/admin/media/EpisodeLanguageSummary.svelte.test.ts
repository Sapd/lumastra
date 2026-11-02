// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type {
    EpisodeLanguageSummary,
    FileLanguageSummary,
    LanguageTrack,
} from '$lib/schemas/admin-language-summary.js';
vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn() }));
vi.mock('$lib/api/admin', () => ({ updateMediaMetadata: vi.fn() }));
import OverviewTab from './OverviewTab.svelte';
import EpisodeLanguageSummaryView from './EpisodeLanguageSummary.svelte';
import FileLanguageSummaryView from './FileLanguageSummary.svelte';
const first = '11111111-1111-4111-8111-111111111111',
    second = '22222222-2222-4222-8222-222222222222';
const track = (
    language: string,
    isDefault = false,
    isForced = false,
    source: 'embedded' | 'sidecar' = 'embedded',
): LanguageTrack => ({
    language,
    isDefault: source === 'sidecar' ? null : isDefault,
    isForced,
    source,
});
const selected: FileLanguageSummary = {
    fileId: first,
    probed: true,
    isMissing: false,
    audio: [track('jpn', true), track('ger'), track('ita'), track('spa'), track('deu')],
    subtitles: [
        track('eng', true),
        track('und', false, true),
        track('fra', false, true, 'sidecar'),
    ],
};
const summary: EpisodeLanguageSummary = {
    selectedFileId: first,
    selection: 'default',
    files: [
        { ...selected, isDefault: true, label: 'Japanese cut' },
        {
            fileId: second,
            probed: true,
            isMissing: false,
            isDefault: false,
            label: 'English cut',
            audio: [track('eng', true)],
            subtitles: [],
        },
    ],
};
afterEach(cleanup);
it('shows two compact default-file lines with deduplicated languages and accessible full language popover', async () => {
    render(EpisodeLanguageSummaryView, { summary });
    const playback = screen.getByRole('region', { name: 'Playback file languages' });
    const disclosure = within(playback).getByLabelText('Language details');
    expect(disclosure.textContent).toContain('Audio (Default file): German, Spanish, Italian');
    expect(disclosure.textContent).toContain('Subtitles: English, French, Unknown language');
    expect(disclosure.querySelectorAll(':scope > span')).toHaveLength(2);
    expect(disclosure.textContent).not.toContain('English · default');
    const overflow = within(playback).getByRole('button', { name: 'Audio: +1 more' });
    await fireEvent.focus(overflow);
    expect((await screen.findByRole('region', { name: 'Audio' })).textContent).toContain(
        'German · Spanish · Italian · Japanese',
    );
    await fireEvent.click(overflow);
    await fireEvent.mouseLeave(overflow.parentElement!);
    expect((await screen.findByRole('region', { name: 'Audio' })).textContent).toContain(
        'Japanese',
    );
    await fireEvent.blur(overflow, { relatedTarget: document.body });
    expect(screen.queryByRole('region', { name: 'Audio' })).toBeNull();
    expect(overflow.getAttribute('aria-expanded')).toBe('false');
    expect((disclosure.closest('details') as HTMLDetailsElement).open).toBe(false);
});
it('expands full flags and alternate versions separately without unioning alternate audio into the default', async () => {
    render(EpisodeLanguageSummaryView, { summary });
    const playback = screen.getByRole('region', { name: 'Playback file languages' });
    const disclosure = within(playback).getByLabelText('Language details');
    expect(disclosure.textContent).not.toContain('Audio (Default file): English');
    await fireEvent.click(disclosure);
    expect(within(playback).getByText('Japanese · default')).toBeTruthy();
    expect(within(playback).getByText('Unknown language · forced')).toBeTruthy();
    expect(within(playback).getByText('French · forced · external')).toBeTruthy();
    expect(within(playback).getByText('Other file versions (1)')).toBeTruthy();
    expect(within(playback).getByText('English cut')).toBeTruthy();
    const alternate = within(playback).getByLabelText('Language details: English cut');
    expect(alternate.textContent).toContain('Audio: English');
    expect(alternate.textContent).toContain('Subtitles: None found');
    expect(alternate.textContent).not.toContain('French');
});
it('distinguishes unprobed unknown, probed none, present unknown-language tracks and no linked file', () => {
    const view = render(FileLanguageSummaryView, {
        summary: { fileId: first, probed: false, isMissing: false, audio: [], subtitles: [] },
    });
    expect(screen.getByLabelText('Language details').textContent).toContain('Unknown (not probed)');
    view.unmount();
    const probed = render(FileLanguageSummaryView, {
        summary: {
            fileId: first,
            probed: true,
            isMissing: false,
            audio: [track('und')],
            subtitles: [],
        },
    });
    const details = screen.getByLabelText('Language details');
    expect(details.textContent).toContain('Audio: Unknown language');
    expect(details.textContent).toContain('Subtitles: None found');
    probed.unmount();
    render(EpisodeLanguageSummaryView, {
        summary: { selectedFileId: null, selection: 'none', files: [] },
    });
    expect(screen.getByLabelText('Language details').textContent).toContain('No linked file');
});

it('episode Overview adopts the same restrained playback summary without loading technical tabs', () => {
    render(OverviewTab, {
        mediaId: first,
        title: 'Fictional anime',
        locked: false,
        mediaType: 'episode',
        languageSummary: summary,
    });
    const playback = screen.getByRole('region', { name: 'Playback file languages' });
    const compact = within(playback).getByLabelText('Language details');
    expect(compact.textContent).toContain('German, Spanish, Italian');
    expect(compact.textContent).toContain('Subtitles: English, French, Unknown language');
    expect((compact.closest('details') as HTMLDetailsElement).open).toBe(false);
});

it('missing sentinel inventories remain unknown while cached language evidence stays visible', () => {
    render(FileLanguageSummaryView, {
        summary: { ...selected, isMissing: true, probed: false, subtitles: [] },
    });
    const details = screen.getByLabelText('Language details');
    expect(details.textContent).toContain('German, Spanish, Italian');
    expect(details.textContent).toContain('Unknown (not probed)');
    expect(details.textContent).not.toContain('None found');
});
