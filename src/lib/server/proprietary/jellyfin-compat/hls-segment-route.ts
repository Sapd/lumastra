// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * One HLS segment / sub-playlist request on the /j surface, shared by
 * `/Videos/{itemId}/hls/{...path}` and `/Audio/{itemId}/hls1/{playlistId}/{...segment}`.
 * The caller has already run `withJellyfinAuth`.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { handleHlsSegment } from '$lib/server/handlers/hls/lumastra-segment-handler.js';
import { getDb } from '$lib/server/database';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { mediaItemExistsById } from '$lib/server/database/queries/media-items.queries.js';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { disarmSilentStart } from './silent-start';
import { getParam } from './utils';

export async function serveJellyfinHlsSegment(
    event: RequestEvent,
    itemId: string | undefined,
    segmentPath: string | undefined,
): Promise<Response> {
    const { url, request } = event;

    if (!itemId || !segmentPath?.trim()) {
        return new Response('Missing parameters', { status: 400 });
    }

    // Re-check library/age access on EVERY segment request — matching every
    // other /j surface (master.m3u8, Trickplay, Subtitles) and /api/v1's
    // withMediaAccess. handleHlsSegment only verifies play-session OWNERSHIP
    // (who) and, since fix plan 6 (C1), job->item BINDING (does the job
    // belong to this item at all) — neither is current authorization (still
    // allowed?), and both exempt preview- sessions from ownership — so
    // without this a user whose access is revoked mid-stream (removed from
    // library group, age rating lowered) could keep pulling segments
    // indefinitely.
    const sql = getDb();
    if (!sql) {
        return new Response('Database unavailable', { status: 503 });
    }
    // Defence in depth only: `checkMediaAccess` is NOT an existence check
    // (`NOT EXISTS(row) OR accessible`, see media-access.ts), so a
    // syntactically valid but nonexistent UUID passes it — even for a
    // library-restricted user. The job->item binding check inside
    // handleHlsSegment is what actually closes that gap (no real job's
    // `config.itemId` can ever equal an id with no `media_items` row), so
    // this existence check is redundant once that lands; kept because it's
    // cheap and gives a clearer signal than a downstream binding-mismatch
    // 404 would. Guarded by isUuid first — a non-UUID id would otherwise
    // 22P02 the query, and non-UUID /j ids are handled by checkMediaAccess.
    // No status/media-type filter (mediaItemExistsById has neither):
    // master.m3u8 doesn't require an active item either, and /j/Videos
    // serves movies, episodes, extras AND music.
    if (isUuid(itemId) && !(await mediaItemExistsById(sql, itemId))) {
        return ApiResponses.notFound('Media');
    }
    if (!(await checkMediaAccess(sql, itemId, event.locals.user, { fileBacked: true }))) {
        return ApiResponses.notFound('Media');
    }

    // Idempotent and cheap when nothing is armed (a few Valkey round trips);
    // called on every playlist/segment request because the path does not
    // expose the segment index cheaply.
    void disarmSilentStart({
        playSessionId: getParam(url, 'PlaySessionId'),
        username: event.locals.user?.username ?? null,
        itemId,
        userId: event.locals.user?.userId ?? null,
        deviceId: event.locals.jfDevice?.deviceId ?? null,
    });

    return handleHlsSegment({
        itemId,
        segmentPath,
        url,
        request,
        basePath: '/j',
        username: event.locals.user?.username,
        mount: 'j',
        // /j routes never run withIdResolution — itemId is assumed to already
        // BE the internal media_items.id (same assumption checkMediaAccess
        // just above relies on), so it doubles as the internalId the synthetic
        // I-frame handlers need to scope a trickplay fileId to this item, and
        // as one of the two spellings the job->item binding check (fix plan 6,
        // C1) admits. That assumption can be wrong — a dashless/garbage/
        // nonexistent itemId is NOT verified to be a real internal id by
        // anything above (checkMediaAccess passes a nonexistent id too) —
        // which is exactly why the binding check normalizes and fails closed
        // rather than trusting this value outright.
        internalId: itemId,
    });
}
