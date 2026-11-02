// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared music item handlers + hiddenTrackIds, used by BOTH the /music home
 * feed and MusicSearchResults. Lifted verbatim from src/routes/music/+page.svelte
 * so click/play/more/remove behave identically on both hosts. Each call reads
 * the live feature flags from `page.data` (reactive $app/state).
 */

import { goto } from '$app/navigation';
import { page } from '$app/state';
import { resolve } from '$lib/paths';
import { SvelteSet } from 'svelte/reactivity';
import { musicPlayerStore } from '$lib/stores/music-player.store';
import {
    openAlbumModal,
    openAlbumForTrack,
    openArtistModal,
    openSimilarTracksModal,
} from '$lib/utils/modal-utils';
import { getAllPlaylistItems } from '$lib/api/playlists';
import { musicTrackFromCard } from '$lib/utils/music-track';
import { getAlbum } from '$lib/api/music';
import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
import type { MusicTrack } from '$lib/schemas/music';

const PLAYLISTS_SECTION_ID = 'music-your-playlists';

export interface MusicItemEvent {
    section: PageSection;
    item: UniversalMediaItem;
}

export interface MusicItemHandlers {
    hiddenTrackIds: SvelteSet<string>;
    posterImages(url: string | undefined): MusicTrack['images'] | undefined;
    getTrackInternalId(item: UniversalMediaItem): string | undefined;
    handleItemClick(event: MusicItemEvent): void;
    handleItemPlay(event: MusicItemEvent): Promise<void>;
    handleItemMore(event: MusicItemEvent): void;
    handleItemRemove(event: MusicItemEvent): void;
}

function sonicEnabled(): boolean {
    return (
        (page.data as { features?: { sonicEmbeddings?: boolean } })?.features?.sonicEmbeddings ===
        true
    );
}

export function createMusicItemHandlers(): MusicItemHandlers {
    const hiddenTrackIds: SvelteSet<string> = new SvelteSet();

    function posterImages(url: string | undefined): MusicTrack['images'] | undefined {
        if (!url) return undefined;
        return {
            primary: { href: url, revision: '1', source: 'self' },
        };
    }

    function getTrackInternalId(item: UniversalMediaItem): string | undefined {
        if (item.mediaType !== 'track') return undefined;
        return item.id;
    }

    function handleItemClick(event: MusicItemEvent): void {
        const { section, item } = event;
        const internalId = item.id;
        if (!internalId) return;

        if (
            item.mediaType === 'playlist' ||
            item.mediaType === 'album' ||
            item.mediaType === 'artist'
        ) {
            if (section.id === PLAYLISTS_SECTION_ID) {
                // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
                goto(resolve(`/playlists/${internalId}?type=music&from=music`), {
                    state: { musicPlaylistOrigin: true },
                });
            } else if (
                item.mediaType === 'artist' ||
                section.id.startsWith('music-top-artists') ||
                section.id === 'music-top-artists' ||
                section.id === 'music-popular-artists'
            ) {
                openArtistModal(internalId, { sonicEnabled: sonicEnabled() });
            } else {
                openAlbumModal(internalId, { sonicEnabled: sonicEnabled() });
            }
        } else if (item.mediaType === 'track') {
            const clickAlbumId =
                typeof item.clickData?.albumId === 'string' ? item.clickData.albumId : undefined;
            void openAlbumForTrack(internalId, {
                albumId: clickAlbumId,
                sonicEnabled: sonicEnabled(),
                fallback: () => {
                    const track = musicTrackFromCard({
                        id: internalId,
                        title: item.title,
                        artists: item.artists?.map((a) => ({ ...a, id: a.id ?? null })) ?? [
                            { id: null, title: item.overview ?? item.subtitle ?? 'Unknown Artist' },
                        ],
                        remixerArtists: item.remixerArtists?.map((a) => ({
                            ...a,
                            id: a.id ?? null,
                        })),
                        images: posterImages(item.image ?? undefined),
                        type: 'track',
                    });
                    void musicPlayerStore.startPlayback(track);
                },
            });
        }
    }

    async function handleItemPlay(event: MusicItemEvent): Promise<void> {
        const { section, item } = event;
        const playItemUuid = item.id;
        if (!playItemUuid) return;

        if (
            item.mediaType === 'playlist' ||
            item.mediaType === 'album' ||
            item.mediaType === 'artist'
        ) {
            if (section.id === PLAYLISTS_SECTION_ID) {
                try {
                    const { data: pData, error: pErr } = await getAllPlaylistItems(
                        Number(playItemUuid),
                        'music',
                    );
                    if (pErr || !pData) {
                        // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
                        goto(resolve('/playlists/' + playItemUuid + '?type=music&from=music'), {
                            state: { musicPlaylistOrigin: true },
                        });
                        return;
                    }
                    const audioItems = pData.items.filter(
                        (i) => i.mediaType === 'track' && i.mediaId,
                    );
                    if (audioItems.length === 0) {
                        // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
                        goto(resolve('/playlists/' + playItemUuid + '?type=music&from=music'), {
                            state: { musicPlaylistOrigin: true },
                        });
                        return;
                    }
                    const toTrack = (i: (typeof audioItems)[0]): MusicTrack =>
                        musicTrackFromCard({
                            id: i.mediaId,
                            title: i.title,
                            artists: [
                                {
                                    id: null,
                                    title: (i as { artist?: string }).artist ?? 'Unknown Artist',
                                },
                            ],
                            images: posterImages((i as { posterPath?: string }).posterPath),
                            type: 'track',
                        });
                    await musicPlayerStore.enqueueFromBrew(audioItems.map(toTrack));
                    musicPlayerStore.setPlaybackContext({
                        type: 'mix',
                        name: item.title,
                        trackCount: audioItems.length,
                        href: resolve(`/playlists/${playItemUuid}?type=music&from=music`),
                    });
                } catch (e) {
                    console.warn('[MusicItemHandlers] Failed to start playlist track playback', e);
                    // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
                    goto(resolve('/playlists/' + playItemUuid + '?type=music&from=music'), {
                        state: { musicPlaylistOrigin: true },
                    });
                }
                return;
            }
            if (
                item.mediaType === 'artist' ||
                section.id === 'music-top-artists' ||
                section.id === 'music-popular-artists' ||
                section.id.startsWith('music-top-artists')
            ) {
                musicPlayerStore.seedAutoplay({
                    type: 'artist',
                    artistId: playItemUuid,
                    artistName: item.title,
                });
                return;
            }

            try {
                const { data: albumApiData, error: albumErr } = await getAlbum(playItemUuid);
                if (albumErr || !albumApiData) return;
                const tracks = albumApiData.tracks;
                if (!tracks.length) return;
                const track = tracks[Math.floor(Math.random() * tracks.length)];
                await musicPlayerStore.startPlayback(track);
            } catch (e) {
                console.warn('[MusicItemHandlers] Failed to start album track playback', e);
            }
        } else if (item.mediaType === 'track') {
            const track = musicTrackFromCard({
                id: playItemUuid,
                title: item.title,
                artists: item.artists?.map((a) => ({ ...a, id: a.id ?? null })) ?? [
                    { id: null, title: item.overview ?? item.subtitle ?? 'Unknown Artist' },
                ],
                remixerArtists: item.remixerArtists?.map((a) => ({ ...a, id: a.id ?? null })),
                images: posterImages(item.image ?? undefined),
                type: 'track',
            });
            await musicPlayerStore.startPlayback(track);
        }
    }

    function handleItemMore(event: MusicItemEvent): void {
        const { item } = event;
        if (item.mediaType !== 'track') return;
        const internalId = item.id;
        if (!internalId) return;
        openSimilarTracksModal(internalId, sonicEnabled());
    }

    function handleItemRemove(event: MusicItemEvent): void {
        const internalId = getTrackInternalId(event.item);
        if (!internalId) return;
        hiddenTrackIds.add(event.item.itemKey ?? event.item.id);
    }

    return {
        hiddenTrackIds,
        posterImages,
        getTrackInternalId,
        handleItemClick,
        handleItemPlay,
        handleItemMore,
        handleItemRemove,
    };
}
