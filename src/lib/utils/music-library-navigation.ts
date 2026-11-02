// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { browser } from '$app/environment';
import { page } from '$app/stores';
import { derived, type Readable } from 'svelte/store';
import {
    DEFAULT_LIBRARY_SEGMENT,
    librarySegmentStorageKey,
    segmentFromRoute,
    type LibrarySegment,
} from './music-bottom-nav';

export interface MusicNavigationPage {
    route: { id: string | null };
    url: { searchParams: URLSearchParams };
    data?: {
        user?: { username?: string } | null;
        playlist?: { playlistType?: unknown } | null;
    };
}

type LibraryStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** One memory for both navigation bars, retained even while neither is mounted. */
export function createMusicLibraryNavigation(
    source: Readable<MusicNavigationPage>,
    getStorage: () => LibraryStorage | null,
): Readable<LibrarySegment> {
    const remembered = new Map<string, LibrarySegment>();
    const observedPersisted = new Map<string, string | null>();
    return derived(source, (current) => {
        const username = current.data?.user?.username;
        const routeSegment = segmentFromRoute(
            current.route.id,
            current.url.searchParams,
            current.data?.playlist?.playlistType,
        );
        if (!username) return routeSegment ?? DEFAULT_LIBRARY_SEGMENT;

        let externalSegment: LibrarySegment | undefined;
        let persisted: string | null | undefined;
        try {
            const storage = getStorage();
            if (storage) {
                persisted = storage.getItem(librarySegmentStorageKey(username));
                const changed =
                    !observedPersisted.has(username) ||
                    observedPersisted.get(username) !== persisted;
                observedPersisted.set(username, persisted);
                if (
                    changed &&
                    (persisted === 'albums' || persisted === 'artists' || persisted === 'playlists')
                ) {
                    externalSegment = persisted;
                }
            }
        } catch {
            // Storage access itself can throw; the in-session memory still works.
        }
        const segment =
            routeSegment ?? externalSegment ?? remembered.get(username) ?? DEFAULT_LIBRARY_SEGMENT;
        remembered.set(username, segment);
        if (routeSegment && routeSegment !== persisted) {
            try {
                const storage = getStorage();
                storage?.setItem(librarySegmentStorageKey(username), routeSegment);
                if (storage) observedPersisted.set(username, routeSegment);
            } catch {
                // Unchanged stale disk must not overwrite this newer session memory.
            }
        }
        return segment;
    });
}

// Never retain account state in a server module shared by multiple requests.
export const musicLibrarySegment: Readable<LibrarySegment> = browser
    ? createMusicLibraryNavigation(page, () => localStorage)
    : derived(
          page,
          (current) =>
              segmentFromRoute(
                  current.route.id,
                  current.url.searchParams,
                  current.data?.playlist?.playlistType,
              ) ?? DEFAULT_LIBRARY_SEGMENT,
      );
