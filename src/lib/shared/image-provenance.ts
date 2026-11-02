// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { IMAGE_PROVIDERS, type ImageProvider } from '$lib/schemas/image-candidates.js';

export const DEFAULT_IMAGE_CANDIDATE_ORDER: ImageProvider[] = [
    'tmdb',
    'tvdb',
    'fanart',
    'musicbrainz-caa',
    'discogs',
    'deezer',
    'theaudiodb',
    'lastfm',
    'jellyfin',
    'audiobookshelf',
    'upload',
    'unknown',
];
export const IMAGE_PROVIDER_HOSTS: Readonly<Record<string, ImageProvider>> = {
    'image.tmdb.org': 'tmdb',
    'thetvdb.com': 'tvdb',
    'artworks.thetvdb.com': 'tvdb',
    'fanart.tv': 'fanart',
    'assets.fanart.tv': 'fanart',
    'coverartarchive.org': 'musicbrainz-caa',
    'archive.org': 'musicbrainz-caa',
    'i.discogs.com': 'discogs',
    'api.discogs.com': 'discogs',
    'e-cdns-images.dzcdn.net': 'deezer',
    'cdn-images.dzcdn.net': 'deezer',
    'theaudiodb.com': 'theaudiodb',
    'www.theaudiodb.com': 'theaudiodb',
    'lastfm.freetls.fastly.net': 'lastfm',
    'userserve-ak.last.fm': 'lastfm',
};

/** Conservative historical derivation. A cache location alone never identifies a provider. */
export function deriveImageProvider(
    reference?: string | null,
    filePath?: string | null,
): ImageProvider {
    if (reference?.startsWith('admin:')) return 'upload';
    if (reference?.startsWith('generated:ffmpeg')) return 'frame-extract';
    if (reference?.startsWith('generated:')) return 'generated';
    if (reference?.startsWith('embedded:')) return 'embedded';
    if (reference?.startsWith('local-folder:')) return 'local-folder';
    if (reference?.startsWith('provider:')) {
        const provider = reference.split(':')[1];
        if (IMAGE_PROVIDERS.includes(provider as ImageProvider)) return provider as ImageProvider;
    }
    if (reference?.startsWith('jellyfin:')) return 'jellyfin';
    if (reference?.startsWith('audiobookshelf:')) return 'audiobookshelf';
    if (reference) {
        try {
            const url = new URL(reference);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'unknown';
            const host = url.hostname.toLowerCase();
            if (IMAGE_PROVIDER_HOSTS[host]) return IMAGE_PROVIDER_HOSTS[host];
            if (host.endsWith('.dzcdn.net') || host === 'dzcdn.net') return 'deezer';
        } catch {
            /* A tag or an own route, handled below. */
        }
        if (/^\/api\/(?:v1\/)?image\/custom\//.test(reference)) return 'unknown';
        if (/^\/api\/.*(?:upload|uploaded)/.test(reference)) return 'upload';
        if (/^\/api\/.*(?:extract|frame|trickplay)/.test(reference)) return 'frame-extract';
        if (/^\/api\/.*(?:folder|embedded)/.test(reference))
            return reference.includes('embedded') ? 'embedded' : 'local-folder';
    }
    if (!reference && filePath && !/\/(\.metadata|metadata|image-sync)\//.test(filePath))
        return 'local-folder';
    return 'unknown';
}

export interface SelectableImage {
    id: string;
    provider: ImageProvider;
    chosen_by: 'auto' | 'admin' | 'user';
    locked: boolean;
    sort_order: number;
    created_at: Date | string;
}
export function imageCandidateRank(
    candidate: SelectableImage,
    order: readonly string[],
    preferFrames = false,
): number {
    if (candidate.locked && candidate.chosen_by !== 'auto') return -100;
    if (candidate.provider === 'local-folder' || candidate.provider === 'embedded') return -50;
    if (candidate.provider === 'frame-extract' || candidate.provider === 'generated')
        return preferFrames ? -25 : 10000;
    const index = order.indexOf(candidate.provider);
    return index < 0 ? 9999 : index;
}
export function selectImageCandidates<T extends SelectableImage>(
    candidates: readonly T[],
    role: string,
    order: readonly string[] = DEFAULT_IMAGE_CANDIDATE_ORDER,
    preferFrames = false,
): T[] {
    const sorted = [...candidates].sort(
        (a, b) =>
            imageCandidateRank(a, order, preferFrames) -
                imageCandidateRank(b, order, preferFrames) ||
            a.sort_order - b.sort_order ||
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
            a.id.localeCompare(b.id),
    );
    if (role !== 'backdrop') return sorted.slice(0, 1);
    const locked = sorted.filter((c) => c.locked && c.chosen_by !== 'auto');
    return locked.length ? locked : sorted;
}
