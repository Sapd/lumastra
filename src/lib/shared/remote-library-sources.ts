// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client-safe descriptors for remote library sources.
 *
 * The add-library form has to render the source selector — with a human label
 * and the media type each source ingests as — BEFORE it can fetch anything, so
 * this data cannot live only in the server-side `RemoteLibrarySource`
 * implementations. Rather than duplicating the labels, the server builds its
 * sources FROM these descriptors (`$lib/server/services/remote-library-sources`),
 * so there is exactly one place a source is named.
 *
 * Contains no credentials, no URLs and no provider HTTP knowledge — only what
 * the selector needs to draw itself. Everything that requires talking to the
 * remote server stays behind `/api/admin/library/remote-libraries`.
 */

import type { REMOTE_LIBRARY_PROVIDER_NAMES } from '$lib/schemas/common.js';

export type RemoteLibraryProviderName = (typeof REMOTE_LIBRARY_PROVIDER_NAMES)[number];

export interface RemoteLibrarySourceDescriptor {
    provider: RemoteLibraryProviderName;
    /** Operator-facing name. Matches the vendor's own spelling. */
    label: string;
    /** `library_paths.media_type` every library from this source ingests as. */
    mediaType: 'audiobook';
    /** Settings page where this source's connection is configured. */
    settingsHref: string;
    /** Settings keys required before the source can enumerate libraries. */
    requiredKeys: readonly string[];
    /** URI scheme for the synthetic `library_paths.path` sentinel. */
    scheme: string;
}

export const REMOTE_LIBRARY_SOURCE_DESCRIPTORS: readonly RemoteLibrarySourceDescriptor[] = [
    {
        provider: 'audiobookshelf',
        label: 'AudiobookShelf',
        mediaType: 'audiobook',
        settingsHref: '/admin/settings/audiobookshelf',
        requiredKeys: ['AUDIOURL', 'AUDIOAPIKEY'],
        scheme: 'abs',
    },
];

export function getRemoteLibrarySourceDescriptor(
    provider: string,
): RemoteLibrarySourceDescriptor | undefined {
    return REMOTE_LIBRARY_SOURCE_DESCRIPTORS.find((d) => d.provider === provider);
}

/**
 * Type-level guard: every remote provider must have a descriptor.
 *
 * Adding a provider to `REMOTE_LIBRARY_PROVIDER_NAMES` without describing it here
 * would leave it absent from the source selector — reachable only by hand-crafted
 * API call, which is the exact problem this whole surface exists to remove.
 */
export type AssertEveryRemoteProviderDescribed =
    Exclude<
        RemoteLibraryProviderName,
        (typeof REMOTE_LIBRARY_SOURCE_DESCRIPTORS)[number]['provider']
    > extends never
        ? true
        : never;

/**
 * Audiobooks are ingested only through a remote source (AudiobookShelf). The
 * file scanner hands audio files to the music importer and skips them in every
 * other library type (see `video-processor.ts`, "Audio files — only process in
 * music libraries"), so a filesystem library typed `audiobook` scans and
 * imports nothing, without an error. Every create surface (setup wizard, admin
 * wizard, add-folder modal, library detail page) and every create/patch API
 * refuses that combination through this one predicate.
 */
export function isLocalAudiobookLibrary(mediaType: string, provider: string): boolean {
    return mediaType === 'audiobook' && getRemoteLibrarySourceDescriptor(provider) === undefined;
}

/** API error for {@link isLocalAudiobookLibrary}. English, like the other API errors. */
export const LOCAL_AUDIOBOOK_LIBRARY_ERROR =
    'Audiobooks cannot be added from a local folder: the scanner imports audio files only in music libraries. Connect AudiobookShelf under /admin/settings/audiobookshelf and add one of its libraries instead.';
