// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/playback-decision — "why did this transcode instead of direct playing?"
 *
 * GET /api/admin/fix/playback-decision?mediaId=… → PlaybackDecision.
 * Auth: admin. Errors: problem+json.
 *
 * ## Nothing here is recomputed
 *
 * The planner already records its own verdict and its reasons on the session
 * row: `play_method`, `plan_reasons`, the delivered codecs, the targeted
 * transcode codec, the subtitle method and the delivery path. The answer to the
 * most common performance complaint on the product was already stored per
 * playback; no surface put it next to the question.
 *
 * This endpoint therefore REPORTS the recorded decision rather than re-deriving
 * one. Re-running the planner here would risk a second opinion that disagreed
 * with what actually happened, which is worse than no page: the operator would
 * be debugging a decision the server never made.
 *
 * ## A list, not a verdict
 *
 * Every other diagnostic on this surface reports one verdict. This one cannot:
 * the same file direct-plays to one client and full-transcodes to another, and
 * which client it was is the entire content of the answer. Collapsing that into
 * a single verdict would hide the only variable that matters.
 *
 * The source streams travel alongside so the delivered codec can be read against
 * what the file actually contains, rather than in isolation.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import type { PlaybackDecision } from '$lib/components/admin/fix/playback-decision.schema.js';

// `.uuid()` because this reaches a `::uuid` cast and the page feeds it from a
// free-text field — a pasted title would otherwise be a 500, not a 400.
const QuerySchema = z.object({ mediaId: z.string().uuid() });

/** Evidence, not an audit trail — the recent past is what explains "today it was slow". */
const MAX_SESSIONS = 20;

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getAdminDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not configured');
            }

            const { mediaId } = ctx.input!.query;

            const [item] = await sql<{ id: string; title: string }[]>`
                SELECT id, title FROM media_items WHERE id = ${mediaId}::uuid LIMIT 1
            `;
            if (!item) {
                return ApiProblem.notFound('Media item not found');
            }

            const [streams, sessions] = await Promise.all([
                sql<
                    {
                        stream_type: string;
                        codec: string | null;
                        profile: string | null;
                        channels: number | null;
                        language: string | null;
                    }[]
                >`
                    SELECT ms.stream_type, ms.codec, ms.profile, ms.channels, ms.language
                      FROM media_streams ms
                      JOIN media_file_items mfi ON mfi.file_id = ms.file_id
                     WHERE mfi.media_item_id = ${mediaId}::uuid
                     ORDER BY ms.stream_type, ms.stream_index
                     LIMIT 40
                `,
                sql<
                    {
                        id: string;
                        started_at: Date;
                        username: string | null;
                        client_name: string | null;
                        client_version: string | null;
                        play_method: string;
                        plan_reasons: string[] | null;
                        video_codec: string | null;
                        audio_codec: string | null;
                        container: string | null;
                        resolution: string | null;
                        bitrate_kbps: number | null;
                        transcode_codec: string | null;
                        subtitle_method: string | null;
                        delivery_path: string | null;
                    }[]
                >`
                    SELECT ps.id, ps.started_at, u.username,
                           ps.client_name, ps.client_version,
                           ps.play_method, ps.plan_reasons,
                           ps.video_codec, ps.audio_codec, ps.container,
                           ps.resolution, ps.bitrate_kbps,
                           ps.transcode_codec, ps.subtitle_method, ps.delivery_path
                      FROM play_sessions ps
                      LEFT JOIN users u ON u.id = ps.user_id
                     WHERE ps.media_id = ${mediaId}::uuid
                     ORDER BY ps.started_at DESC
                     LIMIT ${MAX_SESSIONS}
                `,
            ]);

            const payload: PlaybackDecision = {
                generatedAt: new Date().toISOString(),
                mediaId: item.id,
                mediaTitle: item.title,
                sourceStreams: streams.map((s) => ({
                    kind: s.stream_type,
                    codec: s.codec,
                    profile: s.profile,
                    channels: s.channels,
                    language: s.language,
                })),
                sessions: sessions.map((s) => ({
                    sessionId: s.id,
                    startedAt: new Date(s.started_at).toISOString(),
                    username: s.username,
                    clientName: s.client_name,
                    clientVersion: s.client_version,
                    playMethod: s.play_method,
                    planReasons: s.plan_reasons ?? [],
                    // Not the same thing to a reader: null means the planner never
                    // recorded this session (a client that skipped it, an expired
                    // plan), so the method is the client's own claim; [] is a plan
                    // that needed no reasons.
                    planRecorded: s.plan_reasons !== null,
                    videoCodec: s.video_codec,
                    audioCodec: s.audio_codec,
                    container: s.container,
                    resolution: s.resolution,
                    bitrateKbps: s.bitrate_kbps,
                    transcodeCodec: s.transcode_codec,
                    subtitleMethod: s.subtitle_method,
                    deliveryPath: s.delivery_path,
                })),
            };

            return json(payload);
        },
    },
});
