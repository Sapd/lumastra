// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { apiGet, apiPatch } from './client.js';
import {
    ArtistCreditReviewResponseSchema,
    MusicEditHistoryResponseSchema,
    ArtistTracksResponseSchema,
    type ConfirmArtistCredits,
} from '$lib/schemas/music-credit-review.js';
export function readArtistCredits(id: string) {
    return apiGet(`/api/media/${id}/metadata`, ArtistCreditReviewResponseSchema, {
        params: { includeArtistCredits: '1' },
    });
}
export function applyArtistCredits(id: string, confirmation: ConfirmArtistCredits) {
    return apiPatch(`/api/media/${id}/metadata`, z.object({ locked: z.literal(true) }), {
        confirmArtistCredits: confirmation,
    });
}

export function readArtistTracks(
    id: string,
    params: { q: string; issue: string; sort: string; page: string },
) {
    return apiGet(`/api/admin/media/${id}/tracks`, ArtistTracksResponseSchema, { params });
}

export function readMusicEdits(id: string) {
    return apiGet(`/api/media/${id}/metadata`, MusicEditHistoryResponseSchema, {
        params: { includeMusicEdits: '1' },
    });
}
export function restoreMusicEdit(id: string, receipt: string) {
    return apiPatch(`/api/media/${id}/metadata`, z.object({ restored: z.literal(true) }), {
        undoMusicEdit: receipt,
    });
}
