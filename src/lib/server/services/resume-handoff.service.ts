// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Implicit resume handoff: a paused player asks whether the viewer carried on
 * from where it stands on another device, and where that playback is now.
 *
 * "Carried on" is chain continuity, worked out on the server from facts every
 * client already reports. Starting from the asking player's position (the
 * anchor), a session continues its predecessor when it
 *   (a) resumed the same item within {@link LINK_POSITION_SLACK_MS} of where the
 *       predecessor stood, or
 *   (b) started the next episode (autoplay order) near 0 after the predecessor
 *       finished its episode,
 * and started after the predecessor last moved (at most {@link LINK_MAX_GAP_MS}
 * later). The newest session of the chain on another device leads, if it is
 * "caught up": not rewound more than {@link CAUGHT_UP_SLACK_MS} below the
 * furthest point it reached. Only a session opened to keep watching
 * (`entry` continue / next_up / autoplay / resume) joins a chain; an explicit
 * pick (an episode, a start time, a watch party) and a client that names no
 * entry never do. The
 * anchor itself has no age limit: a tab left for two weeks still follows a
 * chain that started after its last action.
 *
 * Design: docs/superpowers/specs/2026-10-22-implicit-resume-handoff.md.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import type { ResumeHandoffTarget } from '$lib/schemas/resume-handoff.js';
import { completionThresholdFor } from '$lib/server/utils/watch-constants.js';
import {
    getHandoffAnchorMedia,
    loadHandoffSessions,
    type HandoffSessionRow,
} from '$lib/server/database/queries/resume-handoff.queries.js';

/** A resume counts as a continuation within this distance of where the predecessor stood. */
export const LINK_POSITION_SLACK_MS = 90_000;

/** A link may span at most this long between the predecessor's last move and the next start. */
export const LINK_MAX_GAP_MS = 7 * 24 * 60 * 60_000;

/** A leader rewound further than this below its furthest point is not watching linearly. */
export const CAUGHT_UP_SLACK_MS = 120_000;

/** A same-item position closer than this to the anchor is no handoff. */
export const HANDOFF_SAME_ITEM_DEAD_BAND_MS = 30_000;

/**
 * A predecessor's last event may land this long after its successor started
 * (the final report of a quality switch or a rebuilt session).
 */
export const LINK_START_TOLERANCE_MS = 5000;

/** Items that hand off; Live TV, music and audiobooks have their own resume. */
const HANDOFF_MEDIA_TYPES = new Set(['episode', 'movie']);

/** Entries that join a chain: opened to keep watching. */
const LINEAR_ENTRIES = new Set(['continue', 'next_up', 'autoplay', 'resume']);

export interface HandoffAnchor {
    mediaId: string;
    mediaType: string;
    positionMs: number;
    runtimeMs: number | null;
    /** Device of the asking player; never followed. */
    deviceId: string;
    /** Chains that start before this (the player's last own action) are older news. */
    since: Date;
}

export interface ChainLeader {
    leader: HandoffSessionRow;
    /** First session of the chain: the asking player's Undo declines this chain. */
    rootSessionId: string;
}

function isFinished(mediaType: string, positionMs: number, runtimeMs: number | null): boolean {
    const runtime = runtimeMs ?? 0;
    if (runtime <= 0) return false;
    return positionMs / runtime >= completionThresholdFor(mediaType, runtime);
}

export function sessionFinished(s: HandoffSessionRow): boolean {
    return s.completed || isFinished(s.media_type, s.last_position_ms, s.runtime_ms);
}

interface ChainPoint {
    mediaId: string;
    positionMs: number;
    finished: boolean;
    /** When this point was last true (anchor: its `since`). */
    at: Date;
    /** Root session of the chain this point belongs to; null for the anchor. */
    rootSessionId: string | null;
}

function links(
    p: ChainPoint,
    s: HandoffSessionRow,
    nextOf: ReadonlyMap<string, string | null>,
    isAnchor: boolean,
): boolean {
    const startedAt = s.started_at.getTime();
    if (startedAt + (isAnchor ? 0 : LINK_START_TOLERANCE_MS) < p.at.getTime()) return false;
    if (!isAnchor && startedAt - p.at.getTime() > LINK_MAX_GAP_MS) return false;
    if (s.media_id === p.mediaId) {
        return Math.abs(s.start_position_ms - p.positionMs) <= LINK_POSITION_SLACK_MS;
    }
    return (
        p.finished &&
        nextOf.get(p.mediaId) === s.media_id &&
        s.start_position_ms <= LINK_POSITION_SLACK_MS
    );
}

/**
 * Pure: walk the sessions (oldest first) as chains from the anchor and return
 * the leader, or null. `nextOf` maps a finished item to the episode autoplay
 * would open after it.
 */
export function walkHandoffChain(
    anchor: HandoffAnchor,
    sessions: HandoffSessionRow[],
    nextOf: ReadonlyMap<string, string | null>,
): ChainLeader | null {
    const anchorPoint: ChainPoint = {
        mediaId: anchor.mediaId,
        positionMs: anchor.positionMs,
        finished: isFinished(anchor.mediaType, anchor.positionMs, anchor.runtimeMs),
        at: anchor.since,
        rootSessionId: null,
    };
    const reached: Array<{ session: HandoffSessionRow; point: ChainPoint }> = [];

    for (const s of sessions) {
        if (!s.entry_mode || !LINEAR_ENTRIES.has(s.entry_mode)) continue;
        if (s.started_at.getTime() <= anchor.since.getTime()) continue;
        let root: string | null = null;
        if (links(anchorPoint, s, nextOf, true)) {
            root = s.session_id;
        } else {
            // Newest predecessor first: the most direct continuation names the chain.
            for (let i = reached.length - 1; i >= 0; i--) {
                if (links(reached[i].point, s, nextOf, false)) {
                    root = reached[i].point.rootSessionId;
                    break;
                }
            }
        }
        if (root === null) continue;
        reached.push({
            session: s,
            point: {
                mediaId: s.media_id,
                positionMs: s.last_position_ms,
                finished: sessionFinished(s),
                at: s.moved_at ?? s.started_at,
                rootSessionId: root,
            },
        });
    }

    let best: { session: HandoffSessionRow; root: string } | null = null;
    for (const { session, point } of reached) {
        if (session.device_id === anchor.deviceId || session.moved_at === null) continue;
        if (!best || session.moved_at.getTime() > (best.session.moved_at?.getTime() ?? 0)) {
            best = { session, root: point.rootSessionId! };
        }
    }
    if (!best) return null;

    const { session } = best;
    // A rewind below the furthest point is rewatching, until playback passes it again.
    if (
        session.high_water_ms !== null &&
        !session.completed &&
        session.last_position_ms < session.high_water_ms - CAUGHT_UP_SLACK_MS
    ) {
        return null;
    }
    return { leader: session, rootSessionId: best.root };
}

export type HandoffMove =
    | { kind: 'stay' }
    | { kind: 'move'; mediaId: string; positionMs: number }
    /** The leader finished `episodeId`: go to the episode after it, at 0. */
    | { kind: 'next_after'; episodeId: string };

/**
 * Pure: where the anchor goes, given the leader. Forward-only across episodes
 * (an earlier episode never pulls the player back), a dead band on the same item.
 */
export function decideHandoffMove(
    anchor: { mediaId: string; positionMs: number; orderKey: number | null },
    leader: HandoffSessionRow & { orderKey: number | null },
): HandoffMove {
    const sameItem = leader.media_id === anchor.mediaId;
    if (!sameItem) {
        if (anchor.orderKey === null || leader.orderKey === null) return { kind: 'stay' };
        if (leader.orderKey <= anchor.orderKey) return { kind: 'stay' };
    }
    if (sessionFinished(leader)) {
        if (leader.media_type !== 'episode') return { kind: 'stay' };
        return { kind: 'next_after', episodeId: leader.media_id };
    }
    if (
        sameItem &&
        Math.abs(leader.last_position_ms - anchor.positionMs) < HANDOFF_SAME_ITEM_DEAD_BAND_MS
    ) {
        return { kind: 'stay' };
    }
    return { kind: 'move', mediaId: leader.media_id, positionMs: leader.last_position_ms };
}

interface EpisodeNumbers {
    id: string;
    season_number: number;
    episode_number: number;
}

export interface ResumeHandoffDeps {
    getEpisodeOrderKeys: (
        sql: postgres.Sql,
        ids: string[],
    ) => Promise<Array<EpisodeNumbers & { order_key: number }>>;
    findNextEpisode: (
        sql: postgres.Sql,
        seriesId: string,
        episodeId: string,
    ) => Promise<EpisodeNumbers | null>;
    episodesShareFile: (sql: postgres.Sql, fromId: string, otherId: string) => Promise<boolean>;
    now: () => Date;
}

function defaultDeps(): ResumeHandoffDeps {
    return {
        getEpisodeOrderKeys: async (sql, ids) => {
            const { getEpisodeOrderKeys } =
                await import('$lib/server/database/queries/watch-state.queries.js');
            return getEpisodeOrderKeys.all(sql, { ids });
        },
        findNextEpisode: async (sql, seriesId, episodeId) => {
            const { findNextSequentialEpisode } =
                await import('$lib/server/database/queries/episode-search.queries.js');
            // Playback chaining options: what autoplay would open next.
            return findNextSequentialEpisode(sql, seriesId, episodeId, {
                afterCurrentFile: true,
                playableOnly: true,
                specialsStayInSeason: true,
            });
        },
        episodesShareFile: async (sql, fromId, otherId) => {
            const { episodesShareFile } =
                await import('$lib/server/database/queries/watch-state.queries.js');
            return episodesShareFile(sql, fromId, otherId);
        },
        now: () => new Date(),
    };
}

/**
 * Where the asking player should go, or null to stay. Access to the anchor
 * and the returned item is NOT checked here; the endpoint does that.
 */
export async function resolveResumeHandoff(
    sql: postgres.Sql,
    input: {
        userId: UserId;
        mediaId: string;
        positionMs: number;
        deviceId: string;
        /** Time since the asking player's last own action (play, pause, seek, landing). */
        idleMs: number;
        /** When idleMs was received, before any access or metadata queries. */
        requestedAt?: Date;
    },
    deps: ResumeHandoffDeps = defaultDeps(),
): Promise<ResumeHandoffTarget | null> {
    const now = input.requestedAt ?? deps.now();
    const media = await getHandoffAnchorMedia(sql, input.mediaId);
    if (!media || !HANDOFF_MEDIA_TYPES.has(media.media_type)) return null;
    const anchor: HandoffAnchor = {
        mediaId: media.media_id,
        mediaType: media.media_type,
        positionMs: input.positionMs,
        runtimeMs: media.runtime_ms,
        deviceId: input.deviceId,
        since: new Date(now.getTime() - input.idleMs),
    };

    const sessions = await loadHandoffSessions(sql, {
        userId: input.userId,
        mediaId: media.media_id,
        seriesId: media.series_id,
        since: anchor.since,
    });
    if (sessions.length === 0) return null;

    // Successors of every finished point the chain could pass through.
    const nextOf = new Map<string, EpisodeNumbers | null>();
    if (media.series_id) {
        const finishedMedia = new Set<string>();
        if (isFinished(anchor.mediaType, anchor.positionMs, anchor.runtimeMs)) {
            finishedMedia.add(anchor.mediaId);
        }
        for (const s of sessions) if (sessionFinished(s)) finishedMedia.add(s.media_id);
        for (const id of finishedMedia) {
            nextOf.set(id, await deps.findNextEpisode(sql, media.series_id, id));
        }
    }
    const nextIds = new Map([...nextOf].map(([id, next]) => [id, next?.id ?? null]));

    const chain = walkHandoffChain(anchor, sessions, nextIds);
    if (!chain) return null;
    const { leader } = chain;

    const keys = media.series_id
        ? await deps.getEpisodeOrderKeys(sql, [...new Set([media.media_id, leader.media_id])])
        : [];
    const keyOf = (id: string): number | null => {
        const k = keys.find((row) => row.id === id)?.order_key;
        return k === undefined ? null : Number(k);
    };

    const move = decideHandoffMove(
        { mediaId: media.media_id, positionMs: input.positionMs, orderKey: keyOf(media.media_id) },
        { ...leader, orderKey: keyOf(leader.media_id) },
    );
    if (move.kind === 'stay') return null;

    let target: { mediaId: string; positionMs: number; numbers?: EpisodeNumbers };
    if (move.kind === 'next_after') {
        const next =
            nextOf.get(move.episodeId) ??
            (media.series_id
                ? await deps.findNextEpisode(sql, media.series_id, move.episodeId)
                : null);
        if (!next) return null;
        target = { mediaId: next.id, positionMs: 0, numbers: next };
    } else {
        target = {
            mediaId: move.mediaId,
            positionMs: move.positionMs,
            numbers: keys.find((row) => row.id === move.mediaId),
        };
    }

    const sameMedia = target.mediaId === media.media_id;
    return {
        mediaId: target.mediaId,
        positionMs: Math.max(0, Math.round(target.positionMs)),
        relation: sameMedia ? 'same_media' : 'later_episode',
        sameFileAsFrom: sameMedia
            ? false
            : await deps.episodesShareFile(sql, media.media_id, target.mediaId),
        ...(target.numbers
            ? {
                  seasonNumber: target.numbers.season_number,
                  episodeNumber: target.numbers.episode_number,
              }
            : {}),
        deviceName: leader.device_name ?? undefined,
        chainId: chain.rootSessionId,
        updatedAt: (leader.moved_at ?? leader.started_at).toISOString(),
        serverNow: now.toISOString(),
    };
}
