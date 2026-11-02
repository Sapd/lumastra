// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, expect, it } from 'vitest';
import ImageDropZone from './ImageDropZone.svelte';
import { MediaImagesResponseSchema } from '$lib/schemas/media-image-upload';

afterEach(cleanup);

it('credits Discogs beside the admin image and hides the credit when the image fails', async () => {
    render(ImageDropZone, {
        mediaId: 'artist', artworkType: 'poster', currentUrl: '/image',
        discogsUrl: 'https://www.discogs.com/artist/42', onsaved: () => {},
    });
    const link = screen.getByRole('link', { name: 'Data provided by Discogs' });
    expect(link.getAttribute('href')).toBe('https://www.discogs.com/artist/42');
    expect(link.getAttribute('rel')).not.toContain('nofollow');
    await fireEvent.error(screen.getByAltText('poster'));
    expect(screen.queryByRole('link', { name: 'Data provided by Discogs' })).toBeNull();
});

it('does not invent a provider credit for uploaded artwork', () => {
    render(ImageDropZone, {
        mediaId: 'album', artworkType: 'poster', currentUrl: '/uploaded', onsaved: () => {},
    });
    expect(screen.queryByRole('link', { name: 'Data provided by Discogs' })).toBeNull();
});

it('preserves the artwork owner link through the DTO for an inherited album cover', () => {
    const [artwork] = MediaImagesResponseSchema.parse([{
        id: 'image', artworkType: 'poster', url: '/album-cover', source: 'album',
        sourceId: 'album', sourceName: 'Album', discogsUrl: 'https://www.discogs.com/release/42',
    }]);
    render(ImageDropZone, {
        mediaId: 'track', artworkType: artwork.artworkType, currentUrl: artwork.url,
        isInherited: true, sourceName: artwork.sourceName, sourceLevel: 'album',
        discogsUrl: artwork.discogsUrl, onsaved: () => {},
    });
    expect(screen.getByRole('link', { name: 'Data provided by Discogs' }).getAttribute('href'))
        .toBe('https://www.discogs.com/release/42');
});
