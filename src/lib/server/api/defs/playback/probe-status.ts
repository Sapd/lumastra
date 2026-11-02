// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playback/probe-status.ts — GET /playback/{itemId}/probe-status
 *
 * Reports whether the server is currently probing keyframes for an item.
 * The video player polls this during initial loading to show an "Analyzing
 * video structure…" overlay instead of a generic spinner while the master
 * m3u8 fetch blocks on on-demand keyframe probing.
 *
 * Response (always 200, bare object):
 *   { probing: false }
 *   { probing: false, error: { code, message, at } }
 *   { probing: true, phase, startedAt, currentSeconds, totalSeconds?, progress? }
 * With `?session=<playSessionId>`, any of these may also carry
 *   encoder: { slowReason?, softwareFallbackFrom? }
 * — the server's encoder cannot keep up, or switched to software. The player
 * polls this before its first heartbeat (which is when the transcode-progress
 * channel starts), so a first segment that takes a minute is explained.
 * Only the session's own transcode answers; anyone else's yields nothing.
 *
 * Auth: {kind:'user'} — any authenticated user; media-access checked inside handler.
 * raw: true — responses are bare JSON (no problem+json for the 200 body),
 *             but pre-stream errors (auth/404) still use problem+json.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { mediaIdResolver } from '$lib/server/services/media-id-resolver.js';
import { getProbeProgressByItem } from '$lib/server/services/keyframe-probe-progress.service.js';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

// The internal route (/api/playback/[itemId]/probe-status) supplies `itemId`;
// the public v1 route lives under the SHARED /api/v1/playback/[id]/… param dir
// and therefore supplies `id`. SvelteKit forbids sibling routes with different
// param names, so the v1 leaf cannot be renamed to `[itemId]` in isolation
// (its siblings — e.g. subtitles/[index] — read `params.id` directly). Accept
// either key so this shared def resolves the media id under both mounts; the
// handler enforces non-empty itself (404 when absent).
const ProbeStatusItemIdParams = z.object({
    itemId: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const SessionParam = z.string().guid();

type EncoderNotice = { slowReason?: 'gpu_busy' | 'cpu_slow'; softwareFallbackFrom?: string };

/** The session's encoder notice, when the caller owns that transcode and there is one. */
async function encoderNotice(event: RequestEvent): Promise<EncoderNotice | undefined> {
    const parsed = SessionParam.safeParse(event.url.searchParams.get('session'));
    const username = event.locals.user?.username;
    if (!parsed.success || !username) return undefined;
    try {
        const notice = await getFFmpegTranscodeService().getEncoderNotice(parsed.data, username);
        if (!notice?.slowReason && !notice?.softwareFallbackFrom) return undefined;
        return notice;
    } catch {
        return undefined;
    }
}

async function resolveInternalId(event: RequestEvent): Promise<string | null> {
    if (event.locals.resolvedIds?.internalId) return event.locals.resolvedIds.internalId;
    const rawId = event.params.itemId ?? event.params.id ?? '';
    if (!rawId) return null;
    try {
        const resolved = await mediaIdResolver.resolveAnyMediaId(rawId);
        return resolved.internalId ?? null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    // Class R: 200 body is bare JSON (not problem+json), but auth errors are still
    // problem+json (mount() handles those before reaching the handler).
    raw: true,

    request: {
        params: ProbeStatusItemIdParams,
    },

    handlers: {
        /**
         * GET /api/playback/{itemId}/probe-status
         *
         * Returns the current keyframe-probe progress for the item, or
         * { probing: false } when no probe is in flight.
         */
        GET: async (event) => {
            const internalId = await resolveInternalId(event);
            if (!internalId) return ApiProblem.notFound('Item not found');

            // Light access check — skip full DB work when user is admin/unconstrained.
            const sql = getDb();
            if (sql) {
                const accessible = await checkMediaAccess(sql, internalId, event.locals.user);
                if (!accessible) return ApiProblem.notFound('Item not found');
            }

            const [progress, encoder] = await Promise.all([
                getProbeProgressByItem(internalId),
                encoderNotice(event),
            ]);
            if (!progress) {
                return json(encoder ? { probing: false, encoder } : { probing: false }, {
                    headers: NO_STORE,
                });
            }

            if (progress.phase === 'error') {
                return json(
                    {
                        probing: false,
                        error: {
                            code: progress.errorCode ?? 'ffmpeg_exit',
                            message:
                                progress.errorMessage ?? 'FFmpeg terminated before producing video',
                            at: progress.startedAt,
                        },
                    },
                    { headers: NO_STORE },
                );
            }

            const body: {
                probing: true;
                phase: 'probing' | 'starting';
                startedAt: number;
                currentSeconds: number;
                totalSeconds?: number;
                progress?: number;
                encoder?: EncoderNotice;
            } = {
                probing: true,
                phase: progress.phase ?? 'probing',
                startedAt: progress.startedAt,
                currentSeconds: progress.currentPts,
                ...(encoder ? { encoder } : {}),
            };

            if (progress.totalDuration > 0) {
                body.totalSeconds = progress.totalDuration;
                body.progress = progress.progress;
            }

            return json(body, { headers: NO_STORE });
        },
    },
});
