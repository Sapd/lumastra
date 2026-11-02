// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Constants for the `media_embeddings.source` column.
 *
 * - **LIBRARY**: Embedding generated from library metadata — title, overview,
 *   genres, cast/crew for items the user owns.
 *
 * - **DISCOVERY**: Embedding generated from TMDB / catalog metadata for items
 *   NOT in the user's library, used for recommendation discovery and request
 *   suggestions.
 */
export const EMBEDDING_SOURCE = {
    /** Library metadata embedding */
    LIBRARY: 'library' as const,
    /** Discovery / catalog embedding */
    DISCOVERY: 'discovery' as const,
    /** Music track embedding */
    MUSIC: 'music' as const,
} as const;

/** Union type of valid embedding source values */
export type EmbeddingSource = (typeof EMBEDDING_SOURCE)[keyof typeof EMBEDDING_SOURCE];
