// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addPlaylistItemSchema } from '$lib/schemas/playlists.js';
describe('playlist public input rejects legacy identity and metadata', () => {
    it.each([
        { externalIds: { tmdb: '1', jellyfin: 'denied' }, mediaType: 'movie', title: 'Film' },
        { externalIds: { jellyfin: 'episode' }, mediaType: 'episode', title: 'Episode' },
        { externalIds: { tmdb: '1' }, seriesExternalIds: { tmdb: '2' }, title: 'Episode' },
        { mediaIds: ['550e8400-e29b-41d4-a716-446655440000'], title: 'Injected metadata' },
    ])('rejects %j', (input) => expect(addPlaylistItemSchema.safeParse(input).success).toBe(false));
});
