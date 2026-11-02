// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Active Streams — merging AudiobookShelf's own listeners into our session view.
 *
 * Active Streams must show two kinds of audiobook listener:
 *
 * 1. **Ours** — someone listening through Lumastra. An ordinary `play_sessions`
 *    row with `source = 'audiobookshelf'` (migration 16.178.0), already present
 *    in the session read model before this module runs.
 * 2. **Direct** — someone in the AudiobookShelf mobile app, who has no Lumastra
 *    session at all. Only AudiobookShelf knows about them, via admin
 *    `GET /api/sessions/open`.
 *
 * **The trap this module exists to avoid:** while a user listens through
 * Lumastra we hold an AudiobookShelf session open on their behalf, so *our*
 * sessions also appear in `/api/sessions/open`. A naive merge double-counts
 * every Lumastra listener — one row for the stream, and a second, near-identical
 * row for the upstream session backing it. We therefore subtract every upstream
 * id that one of our own rows already claims via `play_sessions.source_session_id`
 * (surfaced as `playSessionId`). What remains is the genuinely direct listeners.
 * That subtraction is the whole reason `'audiobookshelf'` is a distinct `source`.
 *
 * Two rules the caller depends on:
 *
 * - **The subtraction must run against the UNFILTERED session list.** If it ran
 *   after the privacy filter, a listener who has `hide_streams` set would have
 *   their Lumastra row removed, fail to claim its upstream id, and reappear as a
 *   "direct" row — leaking exactly the person who asked not to be shown.
 * - **Merged rows are read-only** (`isReadOnly: true`). We cannot stop playback
 *   inside someone else's app; a Stop button would be a silent no-op and the
 *   next poll would resurrect the row.
 *
 * @module server/services/audiobookshelf-direct-sessions.service
 */

import { apiUrl } from '$lib/shared/api-urls.js';
import { audiobookImageSet } from './image-descriptor/resources.js';
import { aiDbService } from './database.service.js';
import { features } from '../config.js';
import { Logger } from '../utils/logger.js';
import { getOrComputeSingleFlight } from '../cache/single-flight.js';
import {
    resolveAudiobooksByAbsItemIds,
    type AudiobookSessionIdentity,
} from '../database/queries/audiobooks.queries.js';
import { resolveUsernamesToUsers } from '../database/queries/users.queries.js';
import { getLiveDownloadAbsSessionIds } from '../database/queries/play-sessions.queries.js';
import type { AudiobookSession } from '../audiobookshelf.js';
import type { StreamSession } from '../types.js';
import { detectFormFactor } from '$lib/utils/user-agent.js';

const logger = Logger.for('AbsDirectSessions');

/**
 * How stale an upstream session's `updatedAt` may be before we drop it.
 *
 * AudiobookShelf lingers open sessions after a client crash — it has no
 * client-liveness signal of its own — so `/api/sessions/open` will happily
 * report a phantom listener indefinitely. Its clients sync progress roughly
 * every 10–15s while playing, so five minutes is ~20x the heartbeat: wide enough
 * to survive a paused client or a brief network drop, tight enough that a
 * crashed app disappears within a poll or two.
 */
export const ABS_SESSION_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * TTL of the shared upstream fetch.
 *
 * The caller's own single-flight is keyed per VIEWER (groups, username,
 * permissions, language), so on a busy home page it does not collapse the
 * upstream HTTP call at all — ten distinct viewers would mean ten hits on the
 * AudiobookShelf server. This second, viewer-independent cache is what actually
 * bounds that to one call per window. It is shorter than the staleness threshold
 * by two orders of magnitude, so it cannot itself hold a session alive.
 */
const UPSTREAM_CACHE_TTL_SECONDS = 10;

/** Everything the merge needs to know about the viewer asking. */
export interface DirectSessionViewer {
    /** Admins see direct listeners that have no Lumastra account. */
    isAdmin: boolean;
    /** Watch-permissioned viewers do too. */
    hasWatchPermission: boolean;
}

/**
 * Fetch AudiobookShelf's open-session list, shared across viewers.
 *
 * Errors are swallowed to `[]`: a stale or unreachable AudiobookShelf must
 * degrade Active Streams to "our own sessions only", never fail the widget. The
 * client already logs connection failures once and latches them.
 *
 * The client is imported LAZILY, and must stay that way. `audiobookshelf.ts`
 * constructs its singleton at module scope off `config.AUDIOURL`, so a static
 * import here would pull that side effect into the import graph of
 * active-sessions-view — and thence into every consumer of the Active Streams
 * widget, including ones that never touch audiobooks.
 */
async function fetchUpstreamSessions(): Promise<AudiobookSession[]> {
    try {
        const json = await getOrComputeSingleFlight({
            cacheKey: 'sf:abs-open-sessions:v1',
            ttlSeconds: UPSTREAM_CACHE_TTL_SECONDS,
            lockTtlSeconds: 15,
            compute: async () => {
                const { audiobookshelfClient } = await import('../audiobookshelf.js');
                return JSON.stringify(
                    await audiobookshelfClient.getSessions({ allowStaleForDisplay: true }),
                );
            },
        });
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? (parsed as AudiobookSession[]) : [];
    } catch (error) {
        logger.debug('Upstream AudiobookShelf session fetch failed; serving local sessions only', {
            error: error instanceof Error ? error.message : String(error),
        });
        return [];
    }
}

/**
 * Ids of upstream sessions that one of OUR rows already represents.
 *
 * `playSessionId` carries `play_sessions.source_session_id`, which the audiobook
 * playback lane writes with the AudiobookShelf session id it opened. Restricted
 * to `sessionSource === 'audiobookshelf'` so a Jellyfin `PlaySessionId` that
 * happens to collide with an ABS id can never suppress a real direct listener.
 */
export function claimedUpstreamSessionIds(sessions: readonly StreamSession[]): Set<string> {
    const claimed = new Set<string>();
    for (const session of sessions) {
        if (session.sessionSource === 'audiobookshelf' && session.playSessionId) {
            claimed.add(session.playSessionId);
        }
    }
    return claimed;
}

/**
 * Narrow an upstream list to the genuinely direct, currently-live listeners.
 *
 * Pure — no I/O — so the subtraction and staleness rules are unit-testable
 * without a server or a database.
 */
export function selectDirectSessions(
    upstream: readonly AudiobookSession[],
    claimed: ReadonlySet<string>,
    now: number,
): AudiobookSession[] {
    return upstream.filter((session) => {
        if (!session?.id || claimed.has(session.id)) return false;
        // A session with no usable timestamp is treated as live rather than
        // dropped: AudiobookShelf reported it as open, and inventing a
        // staleness verdict from a missing field would hide real listeners.
        const updatedAt = typeof session.updatedAt === 'number' ? session.updatedAt : null;
        if (updatedAt === null) return true;
        return now - updatedAt <= ABS_SESSION_STALE_AFTER_MS;
    });
}

/** Build the display title for a merged row, preferring our own catalog copy. */
function titleFor(session: AudiobookSession, local: AudiobookSessionIdentity | undefined): string {
    return local?.title || session.displayTitle || session.mediaMetadata?.title || 'Audiobook';
}

/** Chapter label at the session's current position, when ABS supplies chapters. */
function chapterAt(session: AudiobookSession): string | undefined {
    if (!Array.isArray(session.chapters) || session.chapters.length === 0) return undefined;
    const position = typeof session.currentTime === 'number' ? session.currentTime : 0;
    const current = session.chapters.find(
        (chapter) => position >= chapter.start && position < chapter.end,
    );
    return current?.title || undefined;
}

/**
 * Convert one upstream session into a `StreamSession`.
 *
 * `matched` is the Lumastra account behind the ABS username, when there is one.
 * When there is, we key the row on the CANONICAL Lumastra username and `userId`,
 * so the downstream privacy filter honours that person's `hide_streams` setting
 * and the card renders their avatar. When there isn't, the raw ABS name is shown
 * and the caller has already restricted the row to privileged viewers.
 */
function toStreamSession(
    session: AudiobookSession,
    local: AudiobookSessionIdentity | undefined,
    matched: { id: string; username: string } | undefined,
): StreamSession {
    const positionSecs = typeof session.currentTime === 'number' ? session.currentTime : 0;
    // The minified session shape carries `duration`; fall back to the local row
    // so the progress bar still has a denominator when it does not.
    const durationSecs =
        (typeof session.duration === 'number' && session.duration > 0
            ? session.duration
            : (local?.runtimeSeconds ?? null)) ?? undefined;
    const streamProgress =
        durationSecs && durationSecs > 0
            ? Math.min((positionSecs / durationSecs) * 100, 100)
            : undefined;

    // No local row → no UUID. `mediaItemId` stays the ABS id, which the
    // translation overlay's UUID_RE guard skips and the card treats as
    // unlinkable. That is the right trade: showing an unlinked row beats
    // hiding a real listener because the sweep has not ingested the book yet.
    const mediaId = local?.mediaId ?? session.libraryItemId;

    const author = session.displayAuthor || session.mediaMetadata?.authorName || undefined;

    return {
        // Namespaced so a merged row can never collide with a play_sessions UUID
        // in the widget's `itemsById` keying or the recently-stopped guard.
        __id: `abs-direct-${session.id}`,
        id: mediaId,
        mediaItemId: mediaId,
        title: titleFor(session, local),
        overview: local?.overview ?? undefined,
        year: local?.year ?? undefined,
        mediaType: 'audiobook',
        duration: durationSecs,
        author,
        chapter: chapterAt(session),
        username: matched?.username ?? session.user?.username ?? 'unknown',
        userId: matched?.id,
        clientname: session.mediaPlayer || 'AudiobookShelf',
        browsername: session.deviceInfo?.browserName || 'AudiobookShelf',
        formFactor: detectFormFactor(session.deviceInfo?.browserName, session.mediaPlayer),
        // Deliberately NOT set to the ABS session id: `playSessionId` is the
        // key the device-client enrichment and the stop path look up, and this
        // session belongs to another server. Leaving it unset keeps both from
        // matching something that isn't ours.
        deviceId: '',
        playCurrentTime: positionSecs,
        playItemDuration: durationSecs,
        streamProgress,
        // ABS's open-session list reports no play/pause state, and guessing
        // would put a live "▶" on a session that has been paused for minutes.
        //
        // `imageId` is the ABS library-item id, not the UUID: the audiobook
        // cover route proxies AudiobookShelf's own `/api/items/:id/cover` and
        // resolves ABS ids. It renders whether or not the sweep has ingested
        // the book yet.
        images: local
            ? audiobookImageSet('internal', local.mediaId, local.imageRevision ?? '0')
            : {
                  primary: {
                      href: `${apiUrl('internal', `/image/audiobook/${encodeURIComponent(session.libraryItemId)}`)}?v=0`,
                      revision: '0',
                      source: 'provider',
                  },
              },
        externalIds: local ? { internal: local.mediaId } : undefined,
        sessionSource: 'audiobookshelf',
        isReadOnly: true,
    };
}

/**
 * Merge AudiobookShelf's direct listeners into an active-session list.
 *
 * Returns `sessions` unchanged — same array identity — whenever the merge cannot
 * contribute anything: audiobooks disabled, no database, or nothing left after
 * subtraction. Never throws; an upstream failure degrades to the local sessions.
 *
 * @param sessions The FULL, unfiltered active-session list (see module docs).
 * @param viewer   Drives whether unmatched listeners are included.
 */
export async function mergeDirectAudiobookshelfSessions(
    sessions: StreamSession[],
    viewer: DirectSessionViewer,
): Promise<StreamSession[]> {
    if (!features.audiobooks) return sessions;

    try {
        const upstream = await fetchUpstreamSessions();
        if (upstream.length === 0) return sessions;

        const sql = await aiDbService.getSql();
        // Without a database we cannot resolve the book or the listener, and an
        // unresolved row would be an unlinkable card attributed to a raw ABS
        // name. Serve the local sessions instead.
        if (!sql) return sessions;

        // Our own offline downloads hold an upstream session open for days but are
        // not in the session list (they are not streams), so the claim above never
        // covers them: claim them here, or every download shows up as a "direct"
        // AudiobookShelf listener.
        const claimed = claimedUpstreamSessionIds(sessions);
        for (const id of await getLiveDownloadAbsSessionIds(
            sql,
            upstream.flatMap((session) => (session?.id ? [session.id] : [])),
        )) {
            claimed.add(id);
        }

        const direct = selectDirectSessions(upstream, claimed, Date.now());
        if (direct.length === 0) return sessions;

        const absItemIds = [
            ...new Set(direct.map((s) => s.libraryItemId).filter((id): id is string => !!id)),
        ];
        const absUsernames = [
            ...new Set(
                direct
                    .map((s) => s.user?.username)
                    .filter((name): name is string => typeof name === 'string' && name.length > 0),
            ),
        ];

        const [localByAbsId, usersByName] = await Promise.all([
            resolveAudiobooksByAbsItemIds(sql, absItemIds),
            resolveUsernamesToUsers(sql, absUsernames),
        ]);

        // A listener with no Lumastra account has no `hide_streams` setting —
        // no privacy choice they ever got to make — so their row is shown only
        // to viewers who are admin or watch-permissioned. Matched listeners flow
        // on to the ordinary per-user privacy filter downstream.
        const canSeeUnmatched = viewer.isAdmin || viewer.hasWatchPermission;

        const merged: StreamSession[] = [];
        for (const session of direct) {
            const matched = usersByName.get((session.user?.username ?? '').toLowerCase());
            if (!matched && !canSeeUnmatched) continue;
            merged.push(toStreamSession(session, localByAbsId.get(session.libraryItemId), matched));
        }

        if (merged.length === 0) return sessions;

        logger.debug('Merged direct AudiobookShelf listeners into Active Streams', {
            upstream: upstream.length,
            direct: direct.length,
            merged: merged.length,
        });

        return [...sessions, ...merged];
    } catch (error) {
        // Active Streams is a widget, not a critical path — degrade, never fail.
        logger.warn('Direct AudiobookShelf session merge failed; serving local sessions only', {
            error: error instanceof Error ? error.message : String(error),
        });
        return sessions;
    }
}
