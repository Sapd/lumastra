// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, expect, it } from 'vitest';
import DiscogsCredit from './DiscogsCredit.svelte';
afterEach(cleanup);
it('shows an adjacent item link for data actually displayed', () => {
    render(DiscogsCredit, {
        metadata: {
            artist_enrichment: {
                provenance: {
                    poster: {
                        provider: 'discogs',
                        url: 'https://www.discogs.com/artist/42',
                        value: 'image',
                    },
                },
            },
        },
        namespace: 'artist_enrichment',
        displayed: { poster: 'image' },
    });
    expect(
        screen.getByRole('link', { name: 'Data provided by Discogs' }).getAttribute('href'),
    ).toBe('https://www.discogs.com/artist/42');
});
it('shows no credit for historical metadata or an override', async () => {
    const { rerender } = render(DiscogsCredit, {
        metadata: {},
        namespace: 'album_enrichment',
        displayed: { poster: 'image' },
    });
    expect(screen.queryByRole('link')).toBeNull();
    await rerender({
        metadata: {
            album_enrichment: {
                provenance: {
                    poster: {
                        provider: 'discogs',
                        url: 'https://www.discogs.com/release/42',
                        value: 'old',
                    },
                },
            },
        },
        namespace: 'album_enrichment',
        displayed: { poster: 'uploaded' },
    });
    expect(screen.queryByRole('link')).toBeNull();
});

it('removes visible credit after a curated replacement', async () => {
    const metadata = {
        album_enrichment: {
            provenance: {
                poster: {
                    provider: 'discogs',
                    url: 'https://www.discogs.com/release/42',
                    value: 'image',
                },
            },
        },
    };
    const { rerender } = render(DiscogsCredit, {
        metadata,
        namespace: 'album_enrichment',
        displayed: { poster: 'image' },
    });
    expect(screen.getByRole('link')).toBeTruthy();
    await rerender({ metadata, namespace: 'album_enrichment', displayed: { poster: 'uploaded' } });
    expect(screen.queryByRole('link')).toBeNull();
});
