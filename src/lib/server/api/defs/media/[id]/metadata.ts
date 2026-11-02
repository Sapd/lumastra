// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/metadata.ts
 *
 * GET    /api/media/[id]/metadata  — read lock status
 * PATCH  /api/media/[id]/metadata  — update editable metadata + auto-lock
 * DELETE /api/media/[id]/metadata  — unlock (allow syncs to update again)
 *
 * [id] accepts UUID, composite tmdb:550:movie, or Jellyfin UUID.
 *
 * Contract:
 *   GET    → { locked, lockedBy, lockedAt }
 *   PATCH  → { locked: true }
 *   DELETE → { locked: false }
 *
 * Auth: admin.  Surface: internal.
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    listMusicEdits,
    undoMusicEdit,
    MusicEditConflict,
    captureMusicEdit,
    recordMusicEdit,
} from '$lib/server/services/music/edit-recovery.js';
import {
    ArtistCreditReviewError,
    getArtistCreditReview,
    confirmArtistCredits,
} from '$lib/server/services/music/artist-credit-review.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    MediaMetadataPatchSchema,
    MetadataPatchSchema,
} from '$lib/schemas/api-admin-unmatched-responses.js';
import {
    updateAndLockMediaItem,
    confirmFilenameTitle,
    unlockMediaItem,
    getMediaItemLockStatus,
} from '$lib/server/database/queries/media-items.queries.js';
import { resolveCatalogInternalId } from '../../catalog/resolve-id.js';

function creditProblem(error: ArtistCreditReviewError): Response {
    if (error.kind === 'missing') return ApiProblem.notFound(error.message);
    if (error.kind === 'conflict') return ApiProblem.conflict(error.message);
    return ApiProblem.validationFailed(error.message);
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        // PATCH body only — GET and DELETE have no body.
        body: MediaMetadataPatchSchema,
        query: z.object({
            includeArtistCredits: z.literal('1').optional(),
            includeMusicEdits: z.literal('1').optional(),
        }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');
            if (ctx.input?.query.includeMusicEdits === '1') {
                if (internalId !== event.params.id)
                    return ApiProblem.conflict('Reload the canonical music entry.');
                return json({ edits: await listMusicEdits(sql, internalId) });
            }
            if (ctx.input?.query.includeArtistCredits === '1') {
                if (internalId !== event.params.id)
                    return ApiProblem.conflict(
                        'Reload the canonical track before reviewing artist credits.',
                    );
                try {
                    const review = await getArtistCreditReview(sql, internalId);
                    return json({ ...review.protection, artistCreditReview: review });
                } catch (error) {
                    if (error instanceof ArtistCreditReviewError) return creditProblem(error);
                    throw error;
                }
            }
            const status = await getMediaItemLockStatus(sql, internalId);
            if (!status) return ApiProblem.notFound('Media item not found');
            return json(status);
        },

        PATCH: async (event, ctx) => {
            const username = event.locals.principal?.username ?? event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();
            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const body = ctx.input?.body;
            if (body && 'undoMusicEdit' in body && body.undoMusicEdit) {
                if (internalId !== event.params.id)
                    return ApiProblem.conflict('Reload the canonical music entry.');
                try {
                    await undoMusicEdit(sql, internalId, body.undoMusicEdit, username);
                } catch (error) {
                    if (error instanceof MusicEditConflict)
                        return ApiProblem.conflict(error.message);
                    throw error;
                }
                return json({ restored: true });
            }
            if (body && 'confirmArtistCredits' in body && body.confirmArtistCredits) {
                if (internalId !== event.params.id)
                    return ApiProblem.conflict(
                        'Reload the canonical track before reviewing artist credits.',
                    );
                try {
                    await confirmArtistCredits(
                        sql,
                        internalId,
                        username,
                        body.confirmArtistCredits,
                    );
                } catch (error) {
                    if (error instanceof ArtistCreditReviewError) return creditProblem(error);
                    throw error;
                }
                return json({ locked: true });
            }
            if (body && 'confirmFilenameTitle' in body && body.confirmFilenameTitle) {
                // The UI reviews a UUID row, never a canonical redirect or an external ID.
                if (internalId !== event.params.id)
                    return ApiProblem.conflict(
                        'Media item changed. Reload and review the title again.',
                    );
                const confirmation = body.confirmFilenameTitle;
                const result = await withTx(sql, async (tx) => {
                    await tx`SELECT pg_advisory_xact_lock(hashtext(${internalId}))`;
                    const before = await captureMusicEdit(tx, [internalId]);
                    const outcome = await confirmFilenameTitle(
                        tx,
                        internalId,
                        username,
                        confirmation,
                    );
                    if (outcome === 'confirmed')
                        await recordMusicEdit(tx, internalId, 'title', username, before);
                    return outcome;
                });
                if (result === 'not_found') return ApiProblem.notFound('Media item not found');
                if (result === 'ineligible')
                    return ApiProblem.validationFailed(
                        'Only active music tracks with a filename title can be confirmed.',
                    );
                if (result === 'conflict')
                    return ApiProblem.conflict(
                        'Title or protection changed. Reload and review the title again.',
                    );
                return json({ locked: true });
            }
            const fields = MetadataPatchSchema.parse(body);
            const updated = await updateAndLockMediaItem(sql, internalId, username, {
                title: fields.title,
                releaseYear: fields.releaseYear,
                overview: fields.overview,
                customPosterUrl: fields.customPosterUrl,
                customBackdropUrl: fields.customBackdropUrl,
                customLogoUrl: fields.customLogoUrl,
                customThumbUrl: fields.customThumbUrl,
                customMetadata: fields.customMetadata,
            });

            if (!updated) return ApiProblem.notFound('Media item not found');
            return json({ locked: true });
        },

        DELETE: async (event) => {
            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');
            const unlocked = await unlockMediaItem(sql, internalId);
            if (!unlocked) return ApiProblem.notFound('Media item not found');
            return json({ locked: false });
        },
    },
});
