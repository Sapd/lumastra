// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET/HEAD /api/v1/music/sonic-mixes/{id}/shuffle?seed=&i=[&bitrateKbps=]
 *
 * Track `i` of a sonic cluster shuffled by `seed`, served as the MP3 itself,
 * with the track's metadata in headers. Built for devices that cannot parse
 * JSON while playing (an ESP32 box driving a Bluetooth speaker): one request
 * per track, no server state, skip = i+1, a new seed = a new order.
 *
 * The audio is ALWAYS re-encoded to MP3, 44.1 kHz, stereo, no ID3 — even for
 * an MP3 source — because the device's Bluetooth output is fixed at 44.1 kHz
 * (see ForcedMp3 in route-handler.ts). Text headers are percent-encoded UTF-8:
 * HTTP header values are not safely UTF-8.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { features } from '$lib/server/config.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import {
    getClusterShuffleTrack,
    CLUSTER_MODEL_ID,
    type ClusterShuffleTrackRow,
} from '$lib/server/database/queries/audio-clusters.queries.js';
import { clampBitrate } from '$lib/server/services/music-transcode/index.js';
import type { MusicStreamHandlers } from '$lib/server/services/music-transcode/route-handler.js';

export const DEFAULT_SHUFFLE_BITRATE_KBPS = 128;

export const ClusterShuffleQuerySchema = z
    .object({
        seed: z.coerce.number().int().min(0).max(4_294_967_295),
        i: z.coerce.number().int().min(0).max(2_147_483_647),
        bitrateKbps: z.coerce.number().int().positive().optional(),
    })
    .strict();

const ClusterIdSchema = z.coerce.number().int().min(0).max(2_147_483_647);

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

/** The metadata headers for a picked track — shared by GET and HEAD. */
export function shuffleTrackHeaders(row: ClusterShuffleTrackRow): Record<string, string> {
    return {
        'X-Track-Id': row.media_id,
        'X-Artist': encodeURIComponent(row.artist_title ?? ''),
        'X-Title': encodeURIComponent(row.title),
        'X-Track-Index': String(row.position),
        'X-Track-Count': String(row.track_count),
    };
}

type Picked =
    | { ok: true; row: ClusterShuffleTrackRow; bitrateKbps: number }
    | { ok: false; response: Response };

async function pickTrack(event: RequestEvent): Promise<Picked> {
    // Same 404 as the cluster list: the feature is simply not there.
    if (!features.musicClusters) {
        return { ok: false, response: ApiProblem.notFound('Sonic clusters are not enabled') };
    }
    const user = event.locals.user;

    const clusterId = ClusterIdSchema.safeParse(event.params.id);
    const query = ClusterShuffleQuerySchema.safeParse(
        Object.fromEntries(event.url.searchParams.entries()),
    );
    if (!clusterId.success || !query.success) {
        return {
            ok: false,
            response: ApiProblem.validationFailed(
                'Expected /sonic-mixes/<id>/shuffle?seed=<0..4294967295>&i=<0..2147483647>[&bitrateKbps=<kbps>]',
            ),
        };
    }

    const sql = await aiDbService.getSql();
    if (!sql)
        return { ok: false, response: ApiProblem.dependencyUnavailable('Database unavailable') };

    const access = searchAccessBoundary(await buildSearchAccessContext(sql, user));
    const row = await getClusterShuffleTrack(
        sql,
        CLUSTER_MODEL_ID,
        clusterId.data,
        query.data.seed,
        query.data.i,
        access,
    );
    if (!row) return { ok: false, response: ApiProblem.notFound('Cluster not found or empty') };

    return {
        ok: true,
        row,
        bitrateKbps: clampBitrate('mp3', query.data.bitrateKbps ?? DEFAULT_SHUFFLE_BITRATE_KBPS),
    };
}

export function createClusterShuffleHandlers(stream: Pick<MusicStreamHandlers, 'serveTrack'>): {
    GET: RequestHandler;
    HEAD: RequestHandler;
} {
    const GET: RequestHandler = requireAuth(
        withErrorHandler(async (event) => {
            const picked = await pickTrack(event);
            if (!picked.ok) return picked.response;
            return stream.serveTrack(event, picked.row.media_id, {
                bitrateKbps: picked.bitrateKbps,
                headers: shuffleTrackHeaders(picked.row),
            });
        }),
    );

    // Peek at a track without starting an encode (SvelteKit would otherwise
    // run GET for a HEAD and throw the body away — a full ffmpeg spawn).
    const HEAD: RequestHandler = requireAuth(
        withErrorHandler(async (event) => {
            const picked = await pickTrack(event);
            if (!picked.ok) return new Response(null, { status: picked.response.status });
            return new Response(null, {
                status: 200,
                headers: {
                    'Content-Type': 'audio/mpeg',
                    // GET goes through serveTrack, which answers a Range
                    // from the finished encode.
                    'Accept-Ranges': 'bytes',
                    'X-Audio-Codec': 'mp3',
                    'X-Audio-Bitrate-Kbps': String(picked.bitrateKbps),
                    ...shuffleTrackHeaders(picked.row),
                    ...CORS_HEADERS,
                },
            });
        }),
    );

    return { GET, HEAD };
}
