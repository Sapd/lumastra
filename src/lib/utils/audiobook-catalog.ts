// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
import { openMediaModal } from '$lib/utils/modal-utils';

/** Project a catalog preview into the shared card renderer's view model. */
export function audiobookCardItem(book: AudiobookPreview): UniversalMediaItem {
    return {
        id: book.id,
        title: book.title,
        subtitle: book.audiobook.authors.map((person) => person.name).join(', '),
        mediaType: 'audiobook',
        aspectRatio: 'square',
        externalIds: { ...book.ids, internal: book.catalogId ?? book.id },
        image: book.images.primary?.variants?.card ?? book.images.primary?.href ?? '',
        year: book.year == null ? undefined : String(book.year),
        progress: book.progress?.fraction == null ? undefined : book.progress.fraction * 100,
        isPlayed: book.progress?.finished,
        isAvailable: true,
        canRequest: false,
        hasFiles: true,
    };
}

export function openAudiobook(book: AudiobookPreview): void {
    openMediaModal(
        {
            title: book.title,
            mediaType: 'audiobook',
            externalIds: { ...book.ids, internal: book.catalogId ?? book.id },
            year: book.year == null ? undefined : String(book.year),
            isAvailable: true,
            canRequest: false,
        },
        book.images.primary?.href ?? '',
    );
}
