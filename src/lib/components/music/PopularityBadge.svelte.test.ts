// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import PopularityBadge from './PopularityBadge.svelte';
afterEach(cleanup);
const popularity = {
    listeners: 12,
    playcount: 30,
    rankInArtist: 2,
    score: 50,
    scoreContext: 'track_in_artist' as const,
    attribution: {
        source: 'lastfm' as const,
        text: 'Data from Last.fm',
        url: 'https://www.last.fm/music/Artist/_/Song',
    },
};
it.each(['artist', 'track'] as const)(
    'shows Last.fm branding inside the %s popup only',
    async (variant) => {
        render(PopularityBadge, { popularity, variant });
        const link = screen.getByRole('link');
        expect(link.getAttribute('href')).toBe(popularity.attribution.url);
        expect(screen.queryByAltText('Powered by AudioScrobbler')).toBeNull();
        await fireEvent.focusIn(link);
        const tooltip = screen.getByRole('tooltip');
        expect(tooltip.contains(screen.getByAltText('Powered by AudioScrobbler'))).toBe(true);
        expect(screen.getByAltText('Powered by AudioScrobbler').getAttribute('src')).toBe(
            '/attribution/powered-by-audioscrobbler.png',
        );
        expect(tooltip.textContent).toContain(popularity.attribution.text);
        expect(link.querySelector('img')).toBeNull();
        expect(screen.getByAltText('Powered by AudioScrobbler').classList.contains('hidden')).toBe(
            false,
        );
        await fireEvent.focusOut(link);
        expect(screen.queryByRole('tooltip')).toBeNull();
        expect(screen.queryByAltText('Powered by AudioScrobbler')).toBeNull();
    },
);
it.each(['artist', 'track'] as const)('keeps local %s attribution unlinked', async (variant) => {
    const { container } = render(PopularityBadge, {
        popularity: { ...popularity, attribution: { source: 'local', text: 'Local', url: '' } },
        variant,
    });
    expect(screen.queryByRole('link')).toBeNull();
    const trigger = container.firstElementChild;
    if (!trigger) throw new Error('trigger not found');
    await fireEvent.focusIn(trigger);
    expect(screen.getByRole('tooltip').textContent?.trim()).toBe('Local');
    expect(screen.queryByAltText('Powered by AudioScrobbler')).toBeNull();
});

it.each(['artist', 'track'] as const)(
    'isolates %s catalogue activation from playback rows without cancelling navigation',
    async (variant) => {
        const { container } = render(PopularityBadge, { popularity, variant });
        const playback = vi.fn();
        container.addEventListener('click', playback);
        container.addEventListener('keydown', playback);
        const link = screen.getByRole('link');
        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        link.dispatchEvent(click);
        await fireEvent.keyDown(link, { key: 'Enter' });
        expect(playback).not.toHaveBeenCalled();
        expect(click.defaultPrevented).toBe(false);
        await fireEvent.keyDown(link, { key: ' ' });
        expect(playback).not.toHaveBeenCalled();
        await fireEvent.keyDown(link, { key: 'Escape' });
        expect(playback).toHaveBeenCalledOnce();
        expect(playback.mock.calls[0][0].key).toBe('Escape');
        expect(link.getAttribute('href')).toBe(popularity.attribution.url);
    },
);

for (const source of ['listenbrainz', 'future-provider']) {
    it.each(['artist', 'track'] as const)(
        `preserves ${source} attribution without Last.fm branding for %s`,
        async (variant) => {
            const attribution = {
                source,
                text: `Data from ${source}`,
                url:
                    source === 'listenbrainz'
                        ? 'https://listenbrainz.org/'
                        : 'https://example.com/',
            };
            render(PopularityBadge, { popularity: { ...popularity, attribution }, variant });
            const link = screen.getByRole('link');
            expect(link.getAttribute('href')).toBe(attribution.url);
            await fireEvent.focusIn(link);
            expect(screen.getByRole('tooltip').textContent?.trim()).toBe(attribution.text);
            expect(screen.queryByAltText('Powered by AudioScrobbler')).toBeNull();
        },
    );
}

it('removes Last.fm branding when the provider changes while the popup is open', async () => {
    const { rerender } = render(PopularityBadge, { popularity, variant: 'artist' });
    await fireEvent.focusIn(screen.getByRole('link'));
    expect(screen.getByAltText('Powered by AudioScrobbler')).toBeTruthy();
    const attribution = {
        source: 'listenbrainz',
        text: 'Data from ListenBrainz',
        url: 'https://listenbrainz.org/',
    };
    await rerender({ popularity: { ...popularity, attribution }, variant: 'artist' });
    expect(screen.queryByAltText('Powered by AudioScrobbler')).toBeNull();
    expect(screen.getByRole('tooltip').textContent?.trim()).toBe(attribution.text);
    expect(screen.getByRole('link').getAttribute('href')).toBe(attribution.url);
});
