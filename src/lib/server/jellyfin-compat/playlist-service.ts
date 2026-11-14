// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin PlaylistsController semantics on top of Lumastra playlists.
 *
 * Jellyfin addresses everything by GUID: playlists, media items, users, and
 * playlist entries (`PlaylistItemId`). This module translates those ids, gates
 * every call on Lumastra's playlist roles (`getUserRole`) and per-item media
 * access, and performs the writes through `playlistItemManager` and the
 * playlist query module — the /j routes only parse the request and map the
 * outcome to a status code.
 *
 * Role mapping (Lumastra has owner / editor / readonly; no "contributor"):
 *   - Jellyfin owner               → owner
 *   - share with CanEdit = true    → editor member
 *   - share with CanEdit = false   → readonly member
 *   - OpenAccess                   → visibility 'public' (readonly for everyone)
 * A share is a Lumastra membership invite: it is created `pending` and grants
 * access once the invitee accepts it in Lumastra, exactly like an invite sent
 * from the web UI.
 */

import {
    BODY_TOO_LARGE,
    DEFAULT_MAX_BODY_BYTES,
    readBoundedBodyText,
} from '$lib/server/utils/bounded-body-reader';
import type postgres from 'postgres';
import { config, canCreatePublicPlaylist } from '$lib/server/config';
import { withTx } from '$lib/server/database/with-tx';
import { cacheInvalidation } from '$lib/server/cache';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getUserRole, type PlaylistRole } from '$lib/server/utils/playlist-utils';
import { normalizeUuid, isUuid } from '$lib/server/utils/media-key-parser';
import { playlistItemManager } from '$lib/server/services/playlist-item-manager.service';
import {
    getMediaSummariesForIds,
    getPlaylistEntries,
    getPlaylistMembers,
    getPlaylistType,
    createPlaylist,
    updatePlaylist,
    getPlaylistItems,
    bulkDeletePlaylistItems,
    recalculatePositions,
    updateItemPosition,
    touchPlaylist,
    inviteMember,
    updateMemberRole,
    deleteMember,
    deleteMemberWatchedStatus,
    type PlaylistTypeValue,
    type PlaylistMemberRow,
} from '$lib/server/database/queries/playlists.queries';
import { getSeasonEpisodeIds } from '$lib/server/database/queries/playlist-items.queries';
import { getUserById } from '$lib/server/database/queries/users.queries';
import { toUserId, type UserId } from '$lib/shared/user-id';
import type { UserContext } from '$lib/server/types';
import { Logger } from '$lib/server/utils/logger';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { sanitizeDisplayName } from '$lib/server/utils/display-name';
import {
    parseJellyfinPlaylistId,
    jellyfinToPlaylistEntryId,
    playlistIdToUuid,
} from './playlist-id';
import { toJellyfinId } from './serializers/user';
import type { JellyfinPlaylistUserPermissions } from './types';
import { buildJellyfinAccessContext } from './access-context';

const logger = Logger.for('JellyfinCompat:Playlists');

/** Upper bound on ids per request — the bulk v1 route allows the same order of magnitude. */
export const MAX_IDS_PER_REQUEST = 500;

export interface JfPlaylistAccess {
    playlistId: number;
    role: Exclude<PlaylistRole, null>;
    isSystem: boolean;
    ownerUserId: UserId;
    visibility: 'private' | 'public';
    playlistType: PlaylistTypeValue | null;
}

/** 403 when the playlists feature is switched off server-wide. */
export function playlistsDisabledResponse(): Response | null {
    return config.FEATURE_PLAYLISTS ? null : ApiResponses.forbidden('Playlists are disabled');
}

/**
 * Resolve a playlist id from the path and the caller's role on it.
 * Unparseable id → 400; no such playlist or no access → 404 (existence is not
 * revealed, matching the sibling GET /Playlists/{id}/Items).
 */
export async function resolvePlaylistAccess(
    sql: postgres.Sql,
    rawId: string | undefined,
    user: UserContext,
): Promise<{ access: JfPlaylistAccess } | { error: Response }> {
    const disabled = playlistsDisabledResponse();
    if (disabled) return { error: disabled };

    const playlistId = parseJellyfinPlaylistId(rawId);
    if (playlistId === null) {
        return { error: ApiResponses.badRequest('Invalid playlist ID') };
    }
    const { role, isSystem, userId, visibility } = await getUserRole(
        sql,
        playlistId,
        null,
        user.userId,
    );
    if (!role || !userId) {
        return { error: ApiResponses.notFound('Playlist not found') };
    }
    const playlistType = await getPlaylistType(sql, playlistId);
    return {
        access: {
            playlistId,
            role,
            isSystem,
            ownerUserId: userId,
            visibility: visibility ?? 'private',
            playlistType,
        },
    };
}

/** Longest playlist name accepted — the REST API's `name` max. */
const MAX_PLAYLIST_NAME_LENGTH = 255;

/** Sanitised playlist name, or null when nothing printable is left. */
export function cleanPlaylistName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const name = sanitizeDisplayName(raw, MAX_PLAYLIST_NAME_LENGTH);
    return name.length > 0 ? name : null;
}

/**
 * Read an optional JSON object body. An empty body is `{}` (Jellyfin accepts
 * CreatePlaylist with query parameters only); null means malformed JSON or a
 * non-object or a body over the cap.
 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
    const text = await readBoundedBodyText(request, DEFAULT_MAX_BODY_BYTES);
    if (text === BODY_TOO_LARGE) return null;
    if (text.trim() === '') return {};
    try {
        const parsed: unknown = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/** Read a field by its PascalCase name, falling back to camelCase. */
export function bodyField(body: Record<string, unknown>, name: string): unknown {
    return body[name] ?? body[name.charAt(0).toLowerCase() + name.slice(1)];
}

export interface CreatePlaylistInput {
    name: string;
    mediaIds: string[];
    playlistType: PlaylistTypeValue;
    isPublic: boolean;
    shares: Array<{ userId: string; canEdit: boolean }>;
}

/**
 * Create a playlist owned by `user`, add the items and shares, and return the
 * Jellyfin id. The caller has already validated the input and the public-
 * playlist permission.
 */
export async function createJellyfinPlaylist(
    sql: postgres.Sql,
    user: UserContext,
    input: CreatePlaylistInput,
): Promise<string> {
    const row = await createPlaylist(
        sql,
        user.userId,
        input.name,
        null,
        input.isPublic ? 'public' : 'private',
        input.playlistType,
    );
    const access: JfPlaylistAccess = {
        playlistId: row.id,
        role: 'owner',
        isSystem: false,
        ownerUserId: user.userId,
        visibility: row.visibility,
        playlistType: row.playlist_type ?? input.playlistType,
    };
    if (input.mediaIds.length > 0) {
        await addJellyfinItems(sql, access, user, input.mediaIds);
    }
    if (input.shares.length > 0) {
        await setShares(sql, access, input.shares);
    }
    logger.info('Playlist created via /j', {
        playlistId: row.id,
        username: user.username,
        items: input.mediaIds.length,
        shares: input.shares.length,
    });
    return playlistIdToUuid(row.id);
}

/** Rename and/or change visibility. The caller has checked role and system rules. */
export async function updatePlaylistMeta(
    sql: postgres.Sql,
    access: JfPlaylistAccess,
    updates: { name?: string; isPublic?: boolean },
): Promise<void> {
    if (updates.name === undefined && updates.isPublic === undefined) return;
    await updatePlaylist(sql, access.playlistId, {
        name: updates.name,
        visibility:
            updates.isPublic === undefined ? undefined : updates.isPublic ? 'public' : 'private',
    });
}

/**
 * Media ids of the entries the caller can see, in playlist order (the same
 * rows GET /Playlists/{id}/Items returns).
 */
export async function getVisibleMediaIds(
    sql: postgres.Sql,
    access: JfPlaylistAccess,
    user: UserContext,
): Promise<string[]> {
    const ctx = await buildJellyfinAccessContext(sql, user);
    const rows = await getPlaylistItems(
        sql,
        access.playlistId,
        user.userId,
        undefined,
        ctx.boundary,
        { mode: 'offset', availableOnly: true },
    );
    return rows.map((r) => r.media_id).filter((id): id is string => Boolean(id));
}

/** Owner or editor — Jellyfin's "owner or a share with CanEdit". */
export function canEditPlaylist(access: JfPlaylistAccess): boolean {
    return access.role === 'owner' || access.role === 'editor';
}

/**
 * Split comma-delimited / repeated GUID params (`ids=a,b&ids=c`) and normalise
 * each to a dashed lower-case UUID. Returns null when any entry is not a UUID.
 */
export function parseJellyfinIdList(values: readonly string[]): string[] | null {
    const out: string[] = [];
    for (const value of values) {
        for (const part of value.split(',')) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            if (!isUuid(trimmed)) return null;
            out.push(normalizeUuid(trimmed));
        }
    }
    return out;
}

/** Same as {@link parseJellyfinIdList} for entry ids (`PlaylistItemId`). */
export function parseEntryIdList(values: readonly string[]): number[] | null {
    const out: number[] = [];
    for (const value of values) {
        for (const part of value.split(',')) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const id = jellyfinToPlaylistEntryId(trimmed);
            if (id === null) return null;
            out.push(id);
        }
    }
    return out;
}

/** Map a Jellyfin `MediaType` to a Lumastra playlist type. */
export function playlistTypeForMediaType(
    mediaType: string | null | undefined,
): 'music' | 'video' | null {
    switch ((mediaType ?? '').toLowerCase()) {
        case 'audio':
            return 'music';
        case 'video':
            return 'video';
        default:
            return null;
    }
}

const MUSIC_MEDIA_TYPES = new Set(['track', 'album', 'artist']);
const VIDEO_MEDIA_TYPES = new Set(['movie', 'tv', 'season', 'episode']);

/**
 * Jellyfin infers a playlist's media type from the first item when the client
 * sends none; Lumastra's equivalent is the playlist type. Falls back to
 * 'general' when nothing is conclusive (Jellyfin would pick Audio, but a
 * general playlist is visible to both music and video clients).
 */
export async function inferPlaylistType(
    sql: postgres.Sql,
    mediaIds: readonly string[],
): Promise<PlaylistTypeValue> {
    if (mediaIds.length === 0) return 'general';
    const summaries = await getMediaSummariesForIds(sql, mediaIds.slice(0, 20));
    for (const id of mediaIds) {
        const type = summaries.get(id)?.media_type;
        if (!type) continue;
        if (MUSIC_MEDIA_TYPES.has(type)) return 'music';
        if (VIDEO_MEDIA_TYPES.has(type)) return 'video';
    }
    return 'general';
}

/** Whether the caller may make a playlist public (PLAYLIST_PUBLIC_GROUPS). */
export function mayPublish(user: UserContext): boolean {
    return canCreatePublicPlaylist(user.userGroups ?? []);
}

export interface AddItemsOutcome {
    /** Media ids that produced at least one new entry. */
    added: string[];
    /** Ids skipped: unknown, not visible to the caller, unsupported type, or already present. */
    skipped: string[];
}

/**
 * Add media items to a playlist the way Jellyfin's AddToPlaylistInternal does:
 * ids that do not resolve to an item the caller can see are skipped silently,
 * containers expand to their playable children (series → episodes,
 * season → episodes, album → tracks), and the rest is appended — or inserted
 * at `position` when given (≤ 0 = front, past the end = append).
 *
 * Lumastra stores one row per media item per playlist, so re-adding an item
 * that is already there is a no-op instead of Jellyfin's duplicate entry.
 */
export async function addJellyfinItems(
    sql: postgres.Sql,
    access: JfPlaylistAccess,
    user: UserContext,
    mediaIds: readonly string[],
    position?: number | null,
): Promise<AddItemsOutcome> {
    const outcome: AddItemsOutcome = { added: [], skipped: [] };
    if (mediaIds.length === 0) return outcome;

    const before =
        position !== undefined && position !== null
            ? new Set((await getPlaylistEntries(sql, access.playlistId)).map((e) => e.id))
            : null;

    const unique = [...new Set(mediaIds)];
    const summaries = await getMediaSummariesForIds(sql, unique);

    for (const mediaId of unique) {
        const summary = summaries.get(mediaId);
        if (!summary || !(await checkMediaAccess(sql, mediaId, user))) {
            outcome.skipped.push(mediaId);
            continue;
        }

        // A season is not a container playlistItemManager expands; add its
        // episodes one by one (Jellyfin adds the season's children too).
        const leaves =
            summary.media_type === 'season'
                ? await expandSeason(sql, summary.id)
                : [{ id: summary.id, media_type: summary.media_type, title: summary.title }];

        let addedAny = false;
        for (const leaf of leaves) {
            const result = await playlistItemManager.addItems({
                sql,
                playlistId: access.playlistId,
                playlistType: access.playlistType ?? undefined,
                externalIds: { internal: leaf.id },
                mediaType: leaf.media_type,
                title: leaf.title,
                username: user.username,
                surface: 'v1',
            });
            if (!result || result.type === 'rejected') continue;
            if (result.type === 'expanded' && !result.episodesAdded) continue;
            if (result.type === 'single' && !result.item) continue;
            addedAny = true;
        }

        if (addedAny) {
            outcome.added.push(mediaId);
        } else {
            outcome.skipped.push(mediaId);
        }
    }

    if (outcome.added.length > 0 && access.playlistType === 'watchlist') {
        await invalidateWatchlist(user.userId, outcome.added);
    }

    if (before && outcome.added.length > 0) {
        const insertAt = position as number;
        await reorderEntries(sql, access.playlistId, (entries) => {
            const fresh = entries.filter((e) => !before.has(e.id)).map((e) => e.id);
            const rest = entries.filter((e) => before.has(e.id)).map((e) => e.id);
            const at = Math.max(0, Math.min(insertAt, rest.length));
            return [...rest.slice(0, at), ...fresh, ...rest.slice(at)];
        });
    }

    return outcome;
}

async function expandSeason(
    sql: postgres.Sql,
    seasonId: string,
): Promise<Array<{ id: string; media_type: string; title: string }>> {
    const episodeIds = await getSeasonEpisodeIds(sql, seasonId);
    const summaries = await getMediaSummariesForIds(sql, episodeIds);
    return episodeIds
        .map((id) => summaries.get(id))
        .filter((s): s is NonNullable<typeof s> => s !== undefined);
}

/**
 * Re-number a playlist's entries inside one transaction, under the same
 * per-playlist advisory lock the item manager takes for inserts and deletes.
 * `compute` receives the current entries in order and returns the new order
 * of ids (or null to leave the playlist untouched).
 */
async function reorderEntries(
    sql: postgres.Sql,
    playlistId: number,
    compute: (entries: Array<{ id: number; media_id: string }>) => number[] | null,
): Promise<boolean> {
    return withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT pg_advisory_xact_lock(${playlistId})`;
        const entries = await getPlaylistEntries(tx, playlistId);
        const order = compute(entries);
        if (!order) return false;
        const current = new Map(entries.map((e) => [e.id, e.position]));
        for (let i = 0; i < order.length; i++) {
            if (current.get(order[i]) !== i) {
                await updateItemPosition(tx, order[i], playlistId, i);
            }
        }
        await touchPlaylist(tx, playlistId);
        return true;
    });
}

/**
 * Remove entries by `PlaylistItemId`. Ids that are not entries of this
 * playlist are ignored (Jellyfin ignores them too). With `visibleMediaIds`,
 * entries whose item is hidden from the caller are ignored as well — their ids
 * were never handed out to that caller. Returns how many went.
 */
export async function removeEntries(
    sql: postgres.Sql,
    access: JfPlaylistAccess,
    user: UserContext,
    entryIds: readonly number[],
    visibleMediaIds?: ReadonlySet<string>,
): Promise<number> {
    if (entryIds.length === 0) return 0;
    const { removed, mediaIds } = await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT pg_advisory_xact_lock(${access.playlistId})`;
        const wanted = new Set(entryIds);
        const targets = (await getPlaylistEntries(tx, access.playlistId)).filter(
            (e) => wanted.has(e.id) && (!visibleMediaIds || visibleMediaIds.has(e.media_id)),
        );
        if (targets.length === 0) return { removed: 0, mediaIds: [] as string[] };
        const count = await bulkDeletePlaylistItems(
            tx,
            access.playlistId,
            targets.map((t) => t.id),
        );
        await recalculatePositions(tx, access.playlistId);
        await touchPlaylist(tx, access.playlistId);
        return { removed: count, mediaIds: targets.map((t) => t.media_id) };
    });
    if (removed > 0 && access.playlistType === 'watchlist') {
        await invalidateWatchlist(user.userId, mediaIds);
    }
    return removed;
}

/**
 * Replace the playlist's item list (UpdatePlaylistDto.Ids). Like Jellyfin, the
 * existing entries go first, then the new ids are added with the usual
 * visibility and type rules.
 *
 * Only the entries the caller can SEE are replaced: an entry whose item is
 * hidden from the caller (library or age restriction) stays where it is, the
 * same rule DELETE …/Items and Move apply. Otherwise a restricted editor could
 * wipe items the owner added from libraries the editor cannot see.
 */
export async function replaceItems(
    sql: postgres.Sql,
    access: JfPlaylistAccess,
    user: UserContext,
    mediaIds: readonly string[],
): Promise<void> {
    const visible = new Set(await getVisibleMediaIds(sql, access, user));
    const existing = await getPlaylistEntries(sql, access.playlistId);
    await removeEntries(
        sql,
        access,
        user,
        existing.map((e) => e.id),
        visible,
    );
    await addJellyfinItems(sql, access, user, mediaIds);
}

/**
 * Move one entry to `newIndex`. The index is a position in the list the
 * caller SEES (GET /Playlists/{id}/Items filters out items hidden from them),
 * so — as Jellyfin's MoveItemAsync does — the entry lands right after the
 * visible item that will precede it, keeping hidden entries where they are.
 *
 * Returns false when the entry is not part of this playlist (or is hidden
 * from the caller).
 */
export async function moveEntry(
    sql: postgres.Sql,
    access: JfPlaylistAccess,
    entryId: number,
    newIndex: number,
    visibleMediaIds: ReadonlySet<string>,
): Promise<boolean> {
    let found = false;
    await reorderEntries(sql, access.playlistId, (entries) => {
        // An entry hidden from the caller is "not found": its id was never
        // handed out to them, and moving it would act on an item they can't see.
        const moving = entries.find((e) => e.id === entryId);
        if (!moving || !visibleMediaIds.has(moving.media_id)) return null;
        found = true;
        const others = entries.filter((e) => e.id !== entryId);
        const visible = others.filter((e) => visibleMediaIds.has(e.media_id));
        let insertAt: number;
        if (newIndex <= 0) {
            insertAt = visible.length > 0 ? others.indexOf(visible[0]) : 0;
        } else if (newIndex >= visible.length) {
            insertAt = others.length;
        } else {
            insertAt = others.indexOf(visible[newIndex - 1]) + 1;
        }
        const ids = others.map((e) => e.id);
        ids.splice(insertAt, 0, entryId);
        return ids;
    });
    return found;
}

async function invalidateWatchlist(userId: UserId, mediaIds: readonly string[]): Promise<void> {
    // Best-effort, matching WatchlistManager: a cache-layer failure must not
    // fail a write that already committed.
    for (const mediaId of mediaIds) {
        try {
            await cacheInvalidation.onWatchlistChange(userId, mediaId);
        } catch (error) {
            logger.warn('Failed to invalidate cache after /j watchlist change', {
                mediaId,
                error: String(error),
            });
        }
    }
}

// ── Shares (playlist members) ───────────────────────────────────────────────

export function memberToPermissions(member: PlaylistMemberRow): JellyfinPlaylistUserPermissions {
    return { UserId: toJellyfinId(member.user_id), CanEdit: member.role === 'editor' };
}

/**
 * The playlist's shares as Jellyfin `PlaylistUserPermissions`, pending invites
 * included (they are shares the owner made; they only grant access once
 * accepted). Only the owner sees every member — Lumastra's members list is
 * owner-only — so anyone else gets just their own share, if they have one.
 */
export async function getShares(
    sql: postgres.Sql,
    access: JfPlaylistAccess,
    user: UserContext,
): Promise<JellyfinPlaylistUserPermissions[]> {
    const members = await getPlaylistMembers(sql, access.playlistId);
    const visible =
        access.role === 'owner' ? members : members.filter((m) => m.user_id === user.userId);
    return visible.map(memberToPermissions);
}

/** One user's share, or null when they have none. */
export async function getShareFor(
    sql: postgres.Sql,
    access: JfPlaylistAccess,
    targetUserId: string,
): Promise<JellyfinPlaylistUserPermissions | null> {
    const members = await getPlaylistMembers(sql, access.playlistId);
    const member = members.find((m) => m.user_id === targetUserId);
    return member ? memberToPermissions(member) : null;
}

export type ShareUpdateResult = 'ok' | 'user_not_found' | 'self';

/**
 * Add or update one share (owner only — checked by the caller). An existing
 * member keeps its status and gets the new role; anyone else is invited.
 */
export async function upsertShare(
    sql: postgres.Sql,
    access: JfPlaylistAccess,
    targetUserId: string,
    canEdit: boolean,
): Promise<ShareUpdateResult> {
    if (targetUserId === access.ownerUserId) return 'self';
    const target = await getUserById(sql, targetUserId);
    if (!target) return 'user_not_found';
    const role = canEdit ? 'editor' : 'readonly';
    const id = toUserId(targetUserId);
    const updated = await updateMemberRole(sql, access.playlistId, id, role);
    if (!updated) {
        await inviteMember(sql, access.playlistId, id, role);
    }
    return 'ok';
}

/** Remove one share; false when the user had none. */
export async function removeShare(
    sql: postgres.Sql,
    access: JfPlaylistAccess,
    targetUserId: string,
): Promise<boolean> {
    const id = toUserId(targetUserId);
    return withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const removed = await deleteMember(tx, access.playlistId, id);
        if (removed) await deleteMemberWatchedStatus(tx, access.playlistId, id);
        return removed;
    });
}

/**
 * Make the share list exactly `shares` (UpdatePlaylistDto.Users / CreatePlaylistDto.Users):
 * missing users are removed, listed users are invited or re-roled. Unknown
 * users and the owner are skipped, as Jellyfin stores whatever it is given.
 */
export async function setShares(
    sql: postgres.Sql,
    access: JfPlaylistAccess,
    shares: ReadonlyArray<{ userId: string; canEdit: boolean }>,
): Promise<void> {
    const wanted = new Map(shares.map((s) => [s.userId, s.canEdit]));
    if (wanted.size > MAX_SHARES_PER_REQUEST) {
        throw new Error(`At most ${MAX_SHARES_PER_REQUEST} users per share list`);
    }
    const members = await getPlaylistMembers(sql, access.playlistId);
    for (const member of members) {
        if (!wanted.has(member.user_id)) {
            await removeShare(sql, access, member.user_id);
        }
    }
    for (const [userId, canEdit] of wanted) {
        await upsertShare(sql, access, userId, canEdit);
    }
}

/** Most distinct users one request may share a playlist with (each is a lookup + invite). */
export const MAX_SHARES_PER_REQUEST = 100;

/**
 * Parse `PlaylistUserPermissions[]` from a request body. Returns null when the
 * value is present but malformed or names more than MAX_SHARES_PER_REQUEST
 * distinct users; undefined when absent. A user listed twice keeps the last
 * entry.
 */
export function parseShares(
    value: unknown,
): Array<{ userId: string; canEdit: boolean }> | null | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) return null;
    const byUser = new Map<string, boolean>();
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') return null;
        const record = entry as Record<string, unknown>;
        const rawId = record.UserId ?? record.userId;
        if (typeof rawId !== 'string' || !isUuid(rawId)) return null;
        const canEdit = record.CanEdit ?? record.canEdit;
        const userId = normalizeUuid(rawId);
        byUser.delete(userId);
        byUser.set(userId, canEdit === true);
        if (byUser.size > MAX_SHARES_PER_REQUEST) return null;
    }
    return [...byUser].map(([userId, canEdit]) => ({ userId, canEdit }));
}
