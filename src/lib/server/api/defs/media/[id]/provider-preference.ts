// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/provider-preference.ts
 *
 * GET    /api/media/[id]/provider-preference  — read current preference (any user)
 * POST   /api/media/[id]/provider-preference  — set provider override (admin only)
 * DELETE /api/media/[id]/provider-preference  — reset to default chain (admin only)
 *
 * Contract (bare objects — no success/timestamp wrappers):
 *   GET    → { mediaId, title, mediaType, preferredProvider, effectiveProvider,
 *              availableProviders, isOverridden }
 *   POST   → { mediaId, effectiveProvider }
 *   DELETE → { mediaId, effectiveProvider, wasOverridden }
 *
 * Auth: GET=user, POST/DELETE=admin.  Surface: internal.
 * 503 dependency_unavailable when DB is down.
 *
 * No def-level `request.body`: mount() applies a declared body schema to
 * every method that can carry one, including DELETE (see mount.ts
 * `methodCanHaveBody`). `PostBodySchema` has a required `provider` field, so
 * declaring it there would reject every DELETE (empty body) before this
 * handler ever runs. POST validates the body itself instead, mirroring
 * `defs/playlists/[id]/index.ts`.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { resolveCatalogInternalId } from '../../catalog/resolve-id.js';
import {
    getMediaProviderPreference,
    getAvailableProviders,
    checkMediaExists,
    checkMediaWithProvider,
    checkProviderEnabled,
    checkProviderHasMetadata,
    setPreferredProvider,
    resetPreferredProvider,
    getEffectiveProvider,
} from '$lib/server/database/queries/provider-preference.queries.js';

const logger = Logger.for('ProviderPreference');

// POST body — the provider to set as preferred.
const PostBodySchema = z.object({
    provider: z.string().min(1),
});

export const def = defineEndpoint({
    // Per-method auth: GET is open to any user; POST/DELETE require admin.
    auth: {
        GET: { kind: 'user' },
        POST: { kind: 'admin' },
        DELETE: { kind: 'admin' },
    },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media not found');

            const row = await getMediaProviderPreference(sql, internalId);
            if (!row) return ApiProblem.notFound('Media not found');

            const availableProviders = await getAvailableProviders(sql, internalId);

            return json({
                mediaId: row.media_id,
                title: row.title,
                // eslint-disable-next-line callback-safety/no-discriminator-leak-in-response
                mediaType: row.media_type,
                preferredProvider: row.preferred_provider,
                effectiveProvider: row.effective_provider,
                availableProviders: availableProviders.map((p) => ({
                    provider: p.provider,
                    fetchedAt: p.fetched_at.toISOString(),
                })),
                isOverridden: row.preferred_provider !== null,
            });
        },

        POST: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media not found');

            let rawBody: unknown;
            try {
                rawBody = await readBoundedJson(event.request);
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsedBody = PostBodySchema.safeParse(rawBody);
            if (!parsedBody.success) {
                return ApiProblem.validationFailed(
                    parsedBody.error.issues.map((issue) => ({
                        field: issue.path.join('.'),
                        message: issue.message,
                    })),
                );
            }
            const { provider } = parsedBody.data;

            const mediaExists = await checkMediaExists(sql, internalId);
            if (!mediaExists) return ApiProblem.notFound('Media not found');

            const providerValid = await checkProviderEnabled(sql, provider);
            if (!providerValid) {
                return ApiProblem.validationFailed(
                    `Provider "${provider}" is not enabled or does not exist`,
                );
            }

            const metadataExists = await checkProviderHasMetadata(sql, internalId, provider);
            if (!metadataExists) {
                return ApiProblem.validationFailed(
                    `Provider "${provider}" has no metadata stored for this media item`,
                );
            }

            await setPreferredProvider(sql, internalId, provider);

            logger.info('Set provider preference', {
                mediaId: internalId,
                mediaTitle: mediaExists.title,
                provider,
                admin: event.locals.user?.username,
            });

            return json({
                mediaId: internalId,
                effectiveProvider: provider,
            });
        },

        DELETE: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media not found');

            const mediaExists = await checkMediaWithProvider(sql, internalId);
            if (!mediaExists) return ApiProblem.notFound('Media not found');

            const hadOverride = mediaExists.preferred_provider !== null;

            await resetPreferredProvider(sql, internalId);

            logger.info('Reset provider preference', {
                mediaId: internalId,
                previousProvider: mediaExists.preferred_provider,
                admin: event.locals.user?.username,
            });

            const newEffective = await getEffectiveProvider(sql, internalId);

            return json({
                mediaId: internalId,
                effectiveProvider: newEffective?.effective_provider ?? null,
                wasOverridden: hadOverride,
            });
        },
    },
});
