// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/subtitles — GET (search across providers) / POST (install one).
 *
 * The surface the `defineSubtitleProvider` contract was missing. The contract,
 * its ranking service and its tests all shipped; nothing ever called them, so
 * an operator could install a subtitle provider, watch it register cleanly, and
 * never be able to make it do anything.
 *
 * Admin-scoped rather than per-viewer: installing a subtitle writes a sidecar
 * next to the video, which is a library mutation, and the ranking already
 * happens host-side. A viewer-facing picker can layer on this later without
 * changing the contract.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import {
    searchSubtitleCandidates,
    installSubtitleCandidate,
} from '$lib/server/services/subtitle-acquisition.service.js';
import { getMediaDetailsById } from '$lib/server/database/queries/media-lookup.queries.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain.js';
import type { SdkMediaType } from '@sapd/lumastra-plugin-sdk';

const LANG = z.string().min(2).max(8);

const InstallBodySchema = z.object({
    mediaItemId: z.string().uuid(),
    fileId: z.string().uuid(),
    providerId: z.string(),
    candidateId: z.string(),
    language: LANG,
    isForced: z.boolean().optional(),
    isSDH: z.boolean().optional(),
});

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        /**
         * Search every loaded provider for one item. Returns host-RANKED
         * candidates — the viewer's language order first, hash match second —
         * so a caller renders the list as given rather than re-sorting it.
         */
        GET: async (event: RequestEvent) => {
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');

            const mediaItemId = event.url.searchParams.get('mediaItemId') ?? '';
            if (!z.string().uuid().safeParse(mediaItemId).success) {
                return ApiResponses.badRequest('a mediaItemId is required');
            }
            const languages = (event.url.searchParams.get('languages') ?? 'en')
                .split(',')
                .map((l) => l.trim())
                .filter((l) => LANG.safeParse(l).success)
                .slice(0, 10);
            if (languages.length === 0) {
                return ApiResponses.badRequest('at least one language is required');
            }

            // No providers is not an error — it is the default state, and the
            // UI needs to distinguish "nobody to ask" from "asked, found none".
            if (taskRegistry.getAllSubtitleProviders().length === 0) {
                return json({ candidates: [], providers: 0 });
            }

            // Details, not the summary row: an episode search without its
            // season and episode numbers matches on title alone, which is how
            // you end up with the wrong episode's subtitles.
            const item = await getMediaDetailsById(sql, mediaItemId);
            if (!item) return ApiResponses.notFound('media item not found');

            // The DB stores `tv`; every public surface — including the plugin
            // contract — says `series`. Never hand-convert; see
            // docs/dev/media-type-vocabulary.md.
            const publicType = toPublicMediaType(item.media_type);
            if (
                !publicType ||
                (publicType !== 'movie' && publicType !== 'series' && publicType !== 'episode')
            ) {
                return ApiResponses.badRequest('unsupported media type for subtitle search');
            }
            const mediaType = publicType as SdkMediaType;

            const candidates = await searchSubtitleCandidates({
                mediaItemId,
                mediaType,
                title: item.title ?? '',
                ...(item.year ? { year: item.year } : {}),
                ...(item.season_number != null ? { season: item.season_number } : {}),
                ...(item.episode_number != null ? { episode: item.episode_number } : {}),
                languages,
            });

            return json({
                candidates,
                providers: taskRegistry.getAllSubtitleProviders().length,
            });
        },

        /** Download one candidate and install it as a sidecar. */
        POST: async (event: RequestEvent) => {
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');

            const raw: unknown = await event.request.json().catch(() => ({}));
            const parsed = InstallBodySchema.safeParse(raw);
            if (!parsed.success) return ApiResponses.badRequest('invalid subtitle install request');

            try {
                const result = await installSubtitleCandidate(sql, parsed.data);
                auditLog('subtitle.install', parsed.data.mediaItemId, auditActor(event), {
                    provider: parsed.data.providerId,
                    language: result.language,
                });
                return json(result, 201);
            } catch (err) {
                // The service throws with an operator-readable reason on every
                // failure path, deliberately — this is a button someone pressed,
                // and swallowing the cause leaves them with one that silently
                // does nothing.
                return ApiResponses.badRequest(
                    err instanceof Error ? err.message : 'subtitle install failed',
                );
            }
        },
    },
});
