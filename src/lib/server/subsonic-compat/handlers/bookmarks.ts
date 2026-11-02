// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Bookmark Handlers
// getBookmarks, createBookmark, deleteBookmark.

import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import {
    subsonicError,
    subsonicOk,
    subsonicPing,
} from '$lib/server/subsonic-compat/serializers/response.js';
import { serializeSong } from '$lib/server/subsonic-compat/serializers/song.js';
import type { SubsonicAuthContext, SubsonicHandler } from '$lib/server/subsonic-compat/types.js';
import { getParam } from '$lib/server/subsonic-compat/helpers.js';
import { BOOKMARK_CACHE_PREFIX } from '$lib/server/subsonic-compat/constants.js';
import { getTrackDetail } from '$lib/server/database/queries/music.queries.js';
import { batchGetAvailability } from '$lib/server/database/queries/availability.queries.js';
import { cacheGet, cacheSet } from '$lib/server/cache/valkey.js';
import { checkSubsonicMediaAccess } from '$lib/server/subsonic-compat/media-access.js';

interface StoredBookmarks {
    [mediaId: string]: {
        position: number;
        comment?: string;
        created: string;
        changed: string;
    };
}

// getBookmarks — load bookmarks from Valkey and hydrate with track details.
export const handleGetBookmarks: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const raw = await cacheGet(`${BOOKMARK_CACHE_PREFIX}${auth.userId}`);
    if (!raw) {
        return subsonicOk({ bookmarks: {} }, auth.format);
    }

    let stored: StoredBookmarks;
    try {
        stored = JSON.parse(raw) as StoredBookmarks;
    } catch {
        // best-effort: corrupt cached bookmarks → return empty set.
        return subsonicOk({ bookmarks: {} }, auth.format);
    }

    const entries = Object.entries(stored);
    if (entries.length === 0) {
        return subsonicOk({ bookmarks: {} }, auth.format);
    }

    const bookmark: unknown[] = [];
    const availability = await batchGetAvailability(
        sql,
        entries.map(([id]) => id),
    );
    for (const [mediaId, bm] of entries) {
        if (!availability.get(mediaId)) continue;
        // Drop entries the user can no longer access (e.g. groups changed
        // after the bookmark was created). The bookmark itself remains in
        // Valkey so deleteBookmark still works.
        if (!(await checkSubsonicMediaAccess(sql, mediaId, auth))) continue;
        const track = await getTrackDetail(sql, mediaId).catch(() => null);
        if (!track) continue;
        const entry: Record<string, unknown> = {
            entry: serializeSong(track),
            position: bm.position,
            username: auth.username,
            created: bm.created,
            changed: bm.changed,
        };
        if (bm.comment !== undefined) entry.comment = bm.comment;
        bookmark.push(entry);
    }

    return subsonicOk({ bookmarks: { bookmark } }, auth.format);
};

// createBookmark — upsert a bookmark for the given track id and position.
export const handleCreateBookmark: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }
    if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
        return subsonicError(70, 'Song not found.', auth.format);
    }
    const positionRaw = getParam(event, 'position');
    if (positionRaw === null) {
        return subsonicError(10, 'Required parameter "position" is missing.', auth.format);
    }
    const position = parseInt(positionRaw, 10);
    if (!Number.isFinite(position) || position < 0) {
        return subsonicError(
            10,
            'Parameter "position" must be a non-negative integer.',
            auth.format,
        );
    }
    const comment = getParam(event, 'comment') ?? undefined;

    const cacheKey = `${BOOKMARK_CACHE_PREFIX}${auth.userId}`;
    const raw = await cacheGet(cacheKey);
    let stored: StoredBookmarks = {};
    if (raw) {
        try {
            stored = JSON.parse(raw) as StoredBookmarks;
        } catch {
            /* start fresh */
        }
    }

    const now = new Date().toISOString();
    const existing = stored[id];
    stored[id] = {
        position,
        comment,
        created: existing?.created ?? now,
        changed: now,
    };

    await cacheSet(cacheKey, JSON.stringify(stored), 365 * 24 * 60 * 60);
    return subsonicPing(auth.format);
};

// deleteBookmark — remove a bookmark entry for the given track id.
export const handleDeleteBookmark: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    _sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }

    const cacheKey = `${BOOKMARK_CACHE_PREFIX}${auth.userId}`;
    const raw = await cacheGet(cacheKey);
    if (!raw) return subsonicPing(auth.format);

    let stored: StoredBookmarks;
    // best-effort: corrupt cached bookmarks → treat as nothing to delete (ping OK).
    try {
        stored = JSON.parse(raw) as StoredBookmarks;
    } catch {
        return subsonicPing(auth.format);
    }

    delete stored[id];
    await cacheSet(cacheKey, JSON.stringify(stored), 365 * 24 * 60 * 60);
    return subsonicPing(auth.format);
};
