// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The audiobook playback-session lifecycle, server side.
 *
 * The player store never talks to AudiobookShelf: the per-user ABS key must not
 * reach the browser, and the ABS address must not appear in client markup. So
 * everything session-shaped happens here — open, report, close — and the client
 * gets a payload plus a `stream_…` credential for the byte proxy.
 *
 * ## THE ORDERING CONSTRAINT
 *
 * `openAudiobookSession` does not resolve until the `play_sessions` row is
 * COMMITTED. That is not tidiness. ABS serves `/hls/:sid/*` with **no
 * authentication of its own** (measured: a segment fetched with no credential
 * returns 200, while the sibling `/api/items/:id/file/:ino` returns 401), and
 * the stream token pins the media id rather than the session — so a listener
 * holding a valid token for a book they may read could otherwise name another
 * user's in-flight session id and stream that book. `audiobook-stream-auth.ts`
 * closes that hole by checking `{absSessionId}` against exactly the row this
 * function writes. Resolving before the write does not fail open; it fails as a
 * hard 404 on every segment. A player that opens a session and fetches the
 * playlist in the same tick would hit it every time.
 *
 * ## Two measured facts about `POST /api/items/:id/play` (2026-07-29)
 *
 * Both were verified against the live server in both directions, and both
 * contradict what a reading of the endpoint's shape suggests:
 *
 *  1. **A requested start offset is ignored.** ABS derives the session's
 *     `startTime` from the CALLER'S OWN saved progress. Asking for
 *     `startTime: 3600` against progress 0 returned `startTime: 0`; asking for
 *     nothing against progress 7200 returned `startTime: 7200`. So an explicit
 *     `positionMs` cannot be pushed upstream at open time — and must not be,
 *     since ABS's progress row is last-write-wins with no history and the
 *     position may not have survived the player's dwell gate yet. It is
 *     returned to the client as `startPositionMs` instead, and the client seeks
 *     its own element.
 *  2. **A transcode session's playlist spans the WHOLE book.** One track with
 *     `startOffset: 0` and the book's full duration; 4355 segments summing to
 *     26128 s for a 7.25-hour book, identical whether `startTime` was 0 or
 *     7200. So on the transcode path the element's clock IS book time. There is
 *     no per-session offset to add, and re-opening a session at an offset
 *     changes nothing about the playlist — which is why the client seeks
 *     instead of restarting.
 */

import type { SessionUpdateInternal } from '$lib/schemas/session-update.js';
import { audiobookImageSet } from './image-descriptor/resources.js';
import { getAudiobookImageRevisions } from '$lib/server/database/queries/resource-images.queries.js';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import type { UserId } from '$lib/shared/user-id.js';
import { audiobookDeliveryUrl, type ApiSurface } from '$lib/shared/api-urls.js';
import type { PlaySurface } from '$lib/server/api/play-surface.js';
import { withTx } from '../database/with-tx.js';
import {
    advanceAudiobookSessionPosition,
    ratchetAudiobookSessionElapsed,
    AUDIOBOOK_ELAPSED_KEY,
    resolveAudiobookPlaybackTarget,
    touchAudiobookSessionHeartbeat,
    type AudiobookPlaybackTarget,
} from '../database/queries/audiobooks.queries.js';
import { config } from '../config';
import {
    claimAudiobookSessionClose,
    countLiveDownloadSessions,
    getAudiobookClosePayload,
    getSessionBySourceKey,
    getSessionById,
    markAudiobookSessionCloseDone,
    prepareAudiobookSessionClose,
    releaseAudiobookSessionClose,
    supersedePreviousDownloadSessions,
    supersedeReplacedAudiobookSessions,
    upsertExternalSession,
    AUDIOBOOK_PURPOSE_KEY,
    type SessionRow,
} from '../database/queries/play-sessions.queries.js';
import { notifySessionTerminated } from './play-session-events.service.js';
import { enforceStreamPolicy, isPolicyError, type PolicyError } from './play-sessions.service.js';
import {
    mintPlaybackGrant,
    buildGrantedHref,
    revokeGrantsForPlaySession,
    type MintedPlaybackGrant,
} from './playback-grant.js';
import { getConfigState } from '../config/config.service.js';
import { resolveUserApiKey, type AbsCredentialDeps } from './audiobookshelf-credentials.service.js';
import { PluginSecrets } from '../tasks/secrets.js';
import type { AudiobookPlaySession, AudiobookshelfClient } from '../audiobookshelf.js';
import type {
    AudiobookPlayMethod,
    AudiobookSessionPayload,
    AbsAudioTrack,
    AbsChapter,
} from '$lib/schemas/api-audiobook-session.js';
import {
    annotateRemuxTracks,
    projectAbsChapters,
    projectAbsTracks,
} from '$lib/shared/audiobook-session-shape.js';
import { Logger } from '../utils/logger.js';
import {
    ABS_TIMESTAMP_TOLERANCE_MS,
    readAudiobookProgress,
    readAudiobookResume,
} from './audiobook-resume.service.js';

const logger = Logger.for('AudiobookSession');

const CLIENT_NAME = 'Lumastra';

/**
 * How long a session may sit paused before the position its close carries stops
 * counting as evidence — see `closeAudiobookSession`.
 *
 * Deliberately far below the reaper's own 30-minute PAUSED grace rather than
 * equal to it: past that grace the row is terminal and no client close reaches
 * this code at all (`prepareAudiobookSessionClose` matches ACTIVE/PAUSED only),
 * so a 30-minute threshold here would be dead code. Five minutes is long enough
 * that pausing to answer the door and then closing the book still records where
 * you stopped, and short enough that a hand-off to another device is not
 * overwritten when you eventually close the tab you left behind.
 */
const STALE_CLOSE_PAUSE_MS = 5 * 60_000;

/** ABS `PlayMethod.TRANSCODE`. */
const ABS_PLAY_METHOD_TRANSCODE = 2;

/**
 * The two upstream surfaces this service uses, injected so the whole lifecycle
 * is testable without an AudiobookShelf.
 *
 * The ABS client is imported LAZILY by {@link defaultSessionDeps} for the same
 * reason every other audiobook module does: `audiobookshelf.ts` builds its
 * singleton at module scope off `config.AUDIOURL`, and a static import drags
 * that construction into every test that touches a route on this surface.
 */
export interface AudiobookSessionDeps {
    client: Pick<
        AudiobookshelfClient,
        | 'startPlaybackSessionAs'
        | 'syncSessionAs'
        | 'closeSessionAs'
        | 'markFinishedAs'
        | 'patchProgressAs'
        | 'getMeAs'
    > &
        Partial<Pick<AudiobookshelfClient, 'getProgressAs'>>;
    credentials: AbsCredentialDeps;
}

export async function defaultSessionDeps(): Promise<AudiobookSessionDeps> {
    const { audiobookshelfClient } = await import('../audiobookshelf.js');
    return {
        client: audiobookshelfClient,
        credentials: {
            listUsers: () => audiobookshelfClient.listUsers(),
            createApiKey: (input) => audiobookshelfClient.createApiKey(input),
            deactivateApiKey: (id) => audiobookshelfClient.deactivateApiKey(id),
            createUser: (input) => audiobookshelfClient.createUser(input),
        },
    };
}

export type AudiobookSessionFailure =
    | { kind: 'not_an_audiobook' }
    | { kind: 'no_abs_link' }
    | { kind: 'abs_unavailable'; message: string }
    | { kind: 'stream_policy'; error: PolicyError };

export type OpenAudiobookSessionResult =
    | {
          ok: true;
          payload: AudiobookSessionPayload;
          /** Private source map for the unified start builder. */
          sourceTracks: AbsAudioTrack[];
          sourceChapters: AbsChapter[];
          playbackSessionId: string;
          grant: MintedPlaybackGrant;
      }
    | ({ ok: false } & AudiobookSessionFailure);

export interface OpenAudiobookSessionInput {
    sql: postgres.Sql;
    /**
     * Which URL prefix the caller is mounted on.
     *
     * The payload carries a cover URL, and this def is mounted on BOTH `/api`
     * and `/api/v1` — so a hardcoded prefix hands a bearer-only client (tvOS, a
     * third-party player) a URL it cannot authenticate against. This is the
     * `no-hardcoded-api-path` rule's whole point; it did not fire only because
     * the string was built here rather than in the def.
     */
    surface: ApiSurface;
    /**
     * Which API surface the LISTENER came through, for admin stats attribution.
     * Distinct from `surface` above, which is the mount (`internal`/`v1`) used
     * to build image URLs — this one separates our web player from our native
     * apps from third parties, which the mount cannot do (/api/v1 is dual-auth
     * and our own apps use it). Derived from the Principal, never a literal:
     * our audiobook player runs on web and native alike.
     */
    playSurface: PlaySurface;
    userId: UserId;
    username: string;
    mediaId: string;
    deviceId: string;
    clientIp: string;
    castTarget?: boolean;
    clientName?: string;
    clientVersion?: string;
    positionMs?: number;
    supportedMimeTypes?: string[];
    /**
     * Why this session is being opened.
     *
     * `'playback'` (the default) means a listener is starting the book here,
     * which is what makes ending the sessions it replaces correct (see
     * `supersedeReplacedAudiobookSessions`). `'download'` means a client only
     * needs the track list and a stream token to fetch files for offline use —
     * the listener is not moving, and superseding their other sessions for
     * that would silently evict the device they are actually using. Long
     * downloads refresh their token repeatedly, so it would also do it more
     * than once. The row is a real `purpose = 'download'` session, so no later
     * playback open supersedes it either. It sends no reports and may run for
     * days, so it is kept alive by its grants (up to seven days, see
     * `DOWNLOAD_SESSION_GRANT_HOURS`) instead of by heartbeats; it takes no
     * stream slot, appears in no "playing now" list, and never writes a
     * listening position (reports and closes against it are ignored). The user
     * may hold only `DOWNLOAD_SESSIONS_MAX_PER_USER` of them at once.
     */
    purpose?: 'playback' | 'download';
    forceTranscode?: boolean;
    userAgent?: string | null;
    /**
     * SHA-256 of the PAT that opened this session, when auth was a PAT.
     * Threaded into the minted stream_ token so revoking that PAT cascades
     * to this token too (see mintSessionGrant's use of it) — mirrors the
     * retained per-item playback token minter.
     */
    parentTokenHash?: string;
    deviceSessionId?: string;
    mintedByAdmin?: boolean;
    deps?: AudiobookSessionDeps;
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export async function openAudiobookSession(
    input: OpenAudiobookSessionInput,
): Promise<OpenAudiobookSessionResult> {
    // Also bound metadata for callers that mint audiobook sessions directly.
    input = {
        ...input,
        clientName: input.clientName?.trim().slice(0, 200) || undefined,
        clientVersion: input.clientVersion?.trim().slice(0, 200) || undefined,
        userAgent: input.userAgent?.trim().slice(0, 200) || undefined,
    };
    const { sql, userId, username, mediaId } = input;

    const target = await resolveAudiobookPlaybackTarget(sql, mediaId);
    if (!target) return { ok: false, kind: 'not_an_audiobook' };

    const deps = input.deps ?? (await defaultSessionDeps());

    const apiKey = await resolveListenerKey(sql, userId, username, deps);
    if (apiKey === null) return { ok: false, kind: 'no_abs_link' };

    let absSession: AudiobookPlaySession;
    try {
        absSession = await deps.client.startPlaybackSessionAs(apiKey, target.absItemId, {
            deviceId: input.deviceId,
            clientName: CLIENT_NAME,
            clientVersion: input.clientVersion,
            // ABS negotiates direct-vs-transcode on MIME type alone. An empty
            // list would make it transcode everything, so fall back to the two
            // containers every engine here decodes rather than to nothing.
            supportedMimeTypes: input.supportedMimeTypes?.length
                ? input.supportedMimeTypes
                : ['audio/mpeg', 'audio/mp4'],
            forceTranscode: input.forceTranscode,
        });
    } catch (error) {
        logger.warn('AudiobookShelf refused to open a playback session', {
            mediaId,
            username,
            error: String(error),
        });
        return { ok: false, kind: 'abs_unavailable', message: String(error) };
    }

    // The persisted per-file codec decides `needsRemux`, not the container MIME
    // type ABS negotiated on and not the session's own (null on a transcode
    // session) codec field. See annotateRemuxTracks.
    const tracks = annotateRemuxTracks(
        projectAbsTracks(absSession.audioTracks ?? []),
        target.audioFileCodecs,
    );
    const playMethod = derivePlayMethod(absSession);
    const durationMs = secondsToMs(absSession.duration) || (target.runtimeSeconds ?? 0) * 1000;
    // Normalised against the book's length, so the spans on the wire are
    // contiguous and every client reads the same chapter for a position.
    const chapters = projectAbsChapters(absSession.chapters ?? [], durationMs);

    // Explicit seeks, including zero, win. Otherwise compare the saved local
    // bookmark with ABS's activity timestamp, rather than trusting an empty or
    // stale upstream session after an outage.
    let resumeMs = input.positionMs ?? secondsToMs(absSession.startTime ?? absSession.currentTime);
    if (input.positionMs === undefined) {
        try {
            const resume = await readAudiobookResume({
                sql,
                userId,
                mediaId,
                absItemId: target.absItemId,
                apiKey,
                client: deps.client,
                ...(deps.client.getProgressAs
                    ? {
                          readProgress: () =>
                              deps.client.getProgressAs!(apiKey, target.absItemId, undefined),
                      }
                    : {}),
                fallbackPositionMs: resumeMs,
            });
            resumeMs = resume.isFinished ? 0 : resume.positionMs;
        } catch (error) {
            // The successful /play response is fresher evidence than a local
            // position whose age cannot be compared while ABS is unavailable.
            logger.warn('Could not read AudiobookShelf resume progress', {
                mediaId,
                error: String(error),
            });
        }
    }
    const startPositionMs =
        durationMs > 0 ? Math.min(Math.max(0, resumeMs), durationMs) : Math.max(0, resumeMs);

    // ── THE ORDERING CONSTRAINT ──────────────────────────────────────────────
    // The row goes in BEFORE this function returns, because the byte proxy
    // checks it on every segment and ABS guards /hls by session-id obscurity
    // alone. See the module header.
    const committed = await commitPlaySessionRow({
        sql,
        userId,
        username,
        target,
        absSessionId: absSession.id,
        playMethod,
        startPositionMs,
        durationMs,
        deviceId: input.deviceId,
        clientIp: input.clientIp,
        clientName: input.clientName,
        clientVersion: input.clientVersion,
        userAgent: input.userAgent ?? null,
        playSurface: input.playSurface,
        purpose: input.purpose ?? 'playback',
    });
    if (!committed.ok) {
        // The upstream session is already open; close it rather than leaving
        // ABS holding a session for playback that is not going to happen. Best
        // effort — a failure here must not mask the policy error.
        await deps.client
            .closeSessionAs(apiKey, absSession.id, {
                currentTime: startPositionMs / 1000,
                timeListened: 0,
                duration: durationMs / 1000,
            })
            .catch(() => {});
        return { ok: false, kind: 'stream_policy', error: committed.error };
    }
    try {
        announceSuperseded(committed.superseded, mediaId);
        const grant = await mintSessionGrant({
            userId,
            mediaId,
            playbackSessionId: committed.playbackSessionId,
            clientIp: input.clientIp,
            castTarget: input.castTarget,
            parentTokenHash: input.parentTokenHash,
            deviceSessionId: input.deviceSessionId,
            mintedByAdmin: input.mintedByAdmin,
            surface: input.surface,
            download: input.purpose === 'download',
        });

        return {
            ok: true,
            playbackSessionId: committed.playbackSessionId,
            grant,
            sourceTracks: tracks,
            sourceChapters: chapters,
            payload: {
                playbackSessionId: committed.playbackSessionId,
                streamToken: grant.token,
                mediaId,
                playMethod,
                tracks: tracks.map(({ ino, startOffset, duration, ...track }) => {
                    const path = `/audiobooks/${mediaId}`;
                    const query = {
                        PlaySessionId: committed.playbackSessionId,
                    };
                    return {
                        ...track,
                        startMs: secondsToMs(startOffset),
                        durationMs: duration == null ? null : secondsToMs(duration),
                        url: buildGrantedHref(
                            grant,
                            audiobookDeliveryUrl(
                                playMethod === 'transcode'
                                    ? `/audiobook/${mediaId}/hls/playback/${committed.playbackSessionId}/output.m3u8`
                                    : `${path}/files/${track.index}`,
                            ),
                            query,
                        ),
                        ...(ino && track.needsRemux
                            ? {
                                  remuxUrl: buildGrantedHref(
                                      grant,
                                      audiobookDeliveryUrl(`${path}/remux/${track.index}`),
                                      query,
                                  ),
                              }
                            : {}),
                    };
                }),
                chapters: chapters.map(({ start, end, ...chapter }) => ({
                    ...chapter,
                    startMs: secondsToMs(start),
                    durationMs: Math.max(0, secondsToMs((end ?? start) - start)),
                })),
                startPositionMs,
                ...(durationMs > 0 ? { durationMs } : {}),
                book: {
                    title: target.title || absSession.displayTitle || '',
                    ...(target.authors.length ? { author: target.authors.join(', ') } : {}),
                    ...(target.narrators.length ? { narrator: target.narrators.join(', ') } : {}),
                    // The standard entity-image route, derived from the surface.
                    // It resolves audiobook covers because `_getImageByCatalogIdImpl`
                    // short-circuits to the AudiobookShelf image provider for these
                    // rows — so this needs no audiobook-specific URL, and unlike
                    // `/api/image/audiobook/{absId}` it exists on both surfaces.
                    images: audiobookImageSet(
                        input.surface,
                        target.mediaId,
                        (await getAudiobookImageRevisions(sql, [target.mediaId])).get(
                            target.mediaId,
                        ) ?? '0',
                    ),
                },
            },
        };
    } catch (error) {
        const { endPlaySession } = await import('./play-sessions.service.js');
        await endPlaySession(
            input.sql,
            committed.playbackSessionId,
            startPositionMs,
            'error',
            input.userId,
        );
        throw error;
    }
}

/** Thrown inside the commit transaction so a policy refusal rolls it back. */
class PolicyRefusal extends Error {
    constructor(readonly policyError: PolicyError) {
        super('stream policy refused the audiobook session');
    }
}

type CommitResult =
    | { ok: true; superseded: SessionRow[]; playbackSessionId: string }
    | { ok: false; error: PolicyError };

/**
 * Write the row the byte proxy validates, under the same stream-policy gate
 * every other first-party stream passes — and end the sessions it replaces, in
 * the same transaction.
 *
 * Enforcement is not optional here even though the row is written through the
 * external-session upsert: `UNMETERED_SOURCES` deliberately EXCLUDES
 * `'audiobookshelf'`, so these rows already count against a user's concurrent
 * limit. Counting without enforcing would be the worst of both — an audiobook
 * could 429 the user's next video while itself being unlimited.
 *
 * The supersede runs BEFORE the gate counts, inside the transaction:
 *
 *  - Before, because at a one-stream limit the session this open replaces
 *    holds the only slot (the deck left on another device, or the row a
 *    crashed app left on this one). Superseding it after the gate would refuse
 *    the takeover one line before the code that frees it. This is the rule
 *    `enforceStreamPolicy` already applies to itself: it reaps stale rows
 *    before counting.
 *  - Inside, because the supersede now reaches sessions that are still
 *    PLAYING. A refusal for some other reason (a disallowed play method, an IP
 *    restriction) must not stop the listener's TV and then give their phone
 *    nothing. The refusal throws, and the rollback restores what was
 *    superseded.
 *  - Under the per-user advisory lock `enforceStreamPolicy` also takes (it is
 *    re-entrant), so two near-simultaneous opens of the same book on two
 *    devices run one after the other. The second one sees the first one's row
 *    and supersedes it, instead of both seeing nothing and both staying live
 *    and overwriting each other's progress.
 */
async function commitPlaySessionRow(args: {
    sql: postgres.Sql;
    userId: UserId;
    username: string;
    target: AudiobookPlaybackTarget;
    absSessionId: string;
    playMethod: AudiobookPlayMethod;
    startPositionMs: number;
    durationMs: number;
    deviceId: string;
    clientIp: string;
    clientName?: string;
    clientVersion?: string;
    userAgent: string | null;
    playSurface: PlaySurface;
    purpose: 'playback' | 'download';
}): Promise<CommitResult> {
    try {
        const committed = await withTx(args.sql, async (txSql) => {
            const db = txSql as unknown as postgres.Sql;

            await db`SELECT pg_advisory_xact_lock(hashtextextended(${args.userId}::text, 0))`;

            const replaced =
                args.purpose === 'download'
                    ? await supersedePreviousDownloadSessions(db, {
                          userId: args.userId,
                          mediaId: args.target.mediaId,
                          deviceId: args.deviceId,
                          keepSourceSessionId: args.absSessionId,
                      })
                    : await supersedeReplacedAudiobookSessions(db, {
                          userId: args.userId,
                          mediaId: args.target.mediaId,
                          deviceId: args.deviceId,
                          keepSourceSessionId: args.absSessionId,
                      });

            for (const old of replaced) {
                await revokeGrantsForPlaySession(old.id, db, 'superseded');
            }

            const policyError = await enforceStreamPolicy(
                db,
                args.userId,
                args.username,
                args.clientIp,
                absPlayMethodColumn(args.playMethod),
                {
                    // Excluding (device, media) is what lets the same listener
                    // re-open the same book on the same device — a reload —
                    // without the row they are replacing blocking them.
                    device_id: args.deviceId,
                    media_id: args.target.mediaId,
                    // A download is not a stream: no slot is needed (or consumed).
                    download: args.purpose === 'download',
                },
            );
            if (policyError) throw new PolicyRefusal(policyError);

            if (args.purpose === 'download') {
                // enforceStreamPolicy has just reaped downloads whose grants are gone, so
                // this counts live ones; the user lock above makes check-then-insert safe.
                const limit = config.DOWNLOAD_SESSIONS_MAX_PER_USER;
                const active = await countLiveDownloadSessions(db, args.userId);
                if (active >= limit) {
                    throw new PolicyRefusal({ kind: 'download_limit_exceeded', active, limit });
                }
            }

            const session = await upsertExternalSession(db, {
                source: 'audiobookshelf',
                surface: args.playSurface,
                source_session_id: args.absSessionId,
                media_id: args.target.mediaId,
                user_id: args.userId,
                device_id: args.deviceId,
                client_name: args.clientName ?? null,
                client_version: args.clientVersion ?? null,
                user_agent: args.userAgent,
                ip_address: args.clientIp,
                play_method: absPlayMethodColumn(args.playMethod),
                status: 'ACTIVE',
                position_ms: Math.round(args.startPositionMs),
                runtime_ms: args.durationMs > 0 ? Math.round(args.durationMs) : null,
                // The column is what every reader filters on. The payload key is
                // kept as well for pods still running the previous release during a
                // rolling deploy, which only look at the key.
                ...(args.purpose === 'download'
                    ? {
                          purpose: 'download' as const,
                          external_payload: { [AUDIOBOOK_PURPOSE_KEY]: 'download' },
                      }
                    : {}),
            });

            return { superseded: replaced, playbackSessionId: session.row.id };
        });
        return { ok: true, ...committed };
    } catch (error) {
        if (error instanceof PolicyRefusal) return { ok: false, error: error.policyError };
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Report / close
// ---------------------------------------------------------------------------

export interface AudiobookReportInput {
    /** Internal preparation phase: commit local state before any ABS calls. */
    deferUpstream?: boolean;
    sql: postgres.Sql;
    userId: UserId;
    username: string;
    absSessionId: string;
    mediaId: string;
    bookPositionMs: number;
    listenedMs: number;
    isFinished?: boolean;
    deps?: AudiobookSessionDeps;
}

export interface AudiobookReportResult {
    /** Unified live report advanced the local progress mirror. */
    wroteToDurable?: boolean;
    /** False when there was no row of ours to report against. */
    ok: boolean;
    /** True when ABS no longer knows this session. */
    sessionLost: boolean;
    /**
     * True when this session was terminated because a newer open replaced it
     * (the same book somewhere else, or any book on the same device) — see
     * `supersedeReplacedAudiobookSessions`.
     */
    superseded?: boolean;
}

/**
 * The wire body both live endpoints answer with, shaped once.
 *
 * `synced` is "did this reach AudiobookShelf", so a superseded session is not
 * synced — there was nothing left to sync into. Kept here rather than restated
 * in each def so the two can never disagree about what a superseded report
 * looks like on the wire.
 */
export function toProgressAck(result: AudiobookReportResult): {
    synced: boolean;
    sessionLost?: boolean;
    superseded?: boolean;
} {
    return {
        synced: !result.sessionLost && result.superseded !== true,
        ...(result.sessionLost ? { sessionLost: true } : {}),
        ...(result.superseded ? { superseded: true } : {}),
    };
}

export interface AudiobookHeartbeatInput {
    sql: postgres.Sql;
    userId: UserId;
    username: string;
    absSessionId: string;
    mediaId: string;
    status: 'ACTIVE' | 'PAUSED';
    deps?: AudiobookSessionDeps;
}

export interface RetryAudiobookCloseInput {
    /** Internal claim acquired during unified report preparation. */
    claimedClose?: { claimId: string; row: SessionRow };
    sql: postgres.Sql;
    userId: UserId;
    username: string;
    absSessionId: string;
    deps?: AudiobookSessionDeps;
}

/**
 * Apply the immutable close payload persisted on the session row. Returning
 * `processed: false` keeps both normal-close and stale-reaper work retryable.
 *
 * `state: 'failed'` counts as processed: the row exhausted `MAX_REAP_ATTEMPTS`
 * and has been retired, so the caller must stop treating it as outstanding work
 * rather than spinning on it every cycle.
 */
export async function retryPendingAudiobookSessionClose(
    input: RetryAudiobookCloseInput,
): Promise<{ processed: boolean; sessionLost: boolean }> {
    const row =
        input.claimedClose?.row ??
        (await getSessionBySourceKey(input.sql, 'audiobookshelf', input.absSessionId));
    if (!row || row.user_id !== input.userId) return { processed: false, sessionLost: false };
    const payload = getAudiobookClosePayload(row);
    if (!payload || payload.state === 'done' || payload.state === 'failed') {
        return { processed: true, sessionLost: false };
    }
    const claimId = input.claimedClose?.claimId ?? randomUUID();
    const claimed =
        input.claimedClose?.row ??
        (await claimAudiobookSessionClose(input.sql, input.absSessionId, claimId));
    if (!claimed) return { processed: false, sessionLost: false };
    const claimedPayload = getAudiobookClosePayload(claimed);
    if (!claimedPayload) {
        await releaseAudiobookSessionClose(input.sql, input.absSessionId, claimId);
        return { processed: false, sessionLost: false };
    }

    // Survives a failed attempt: a retry that already closed the session upstream
    // must not close it a second time (ABS answers 404, which the caller would
    // read as "the session was lost").
    let upstreamClosed = claimedPayload.upstreamClosed === true;
    try {
        const deps = input.deps ?? (await defaultSessionDeps());
        const apiKey = await resolveListenerKey(input.sql, input.userId, input.username, deps);
        if (apiKey === null) {
            const retired = await releaseAudiobookSessionClose(
                input.sql,
                input.absSessionId,
                claimId,
                { upstreamClosed },
            );
            if (retired) logGiveUp(input.absSessionId, 'no usable listener credential');
            return { processed: retired, sessionLost: false };
        }
        // Inspect before closing: a close itself may bump ABS lastUpdate.
        // Keep retries from reasserting an old flag over another client's act.
        let stale = false;
        if (claimedPayload.absItemId) {
            const upstream = deps.client.getProgressAs
                ? await deps.client.getProgressAs(apiKey, claimedPayload.absItemId)
                : await readAudiobookProgress(deps.client, apiKey, claimedPayload.absItemId);
            const closeAt = claimed.stopped_at ? new Date(claimed.stopped_at).getTime() : 0;
            stale = !!upstream && upstream.lastUpdate > closeAt + ABS_TIMESTAMP_TOLERANCE_MS;
        }
        let closed = true;
        if (!upstreamClosed) {
            // `syncPosition: false` — a reaper's close. It ends the upstream
            // session without asserting a position. Retries also close without
            // sync data: the first response may have been lost, and a later
            // listen may already own the bookmark. The durable position queue
            // handles recovery without replaying additive timeListened.
            // Absent means true: that is a client-initiated close, whose
            // position is the listener's own final word on where they stopped.
            const syncBody =
                stale || claimedPayload.syncPosition === false || (claimedPayload.attempts ?? 0) > 0
                    ? null
                    : {
                          currentTime: claimedPayload.positionMs / 1000,
                          timeListened: claimedPayload.listenedMs / 1000,
                          duration: claimedPayload.runtimeMs / 1000,
                      };
            closed = await deps.client.closeSessionAs(apiKey, input.absSessionId, syncBody);
            upstreamClosed = true;
        }
        if (claimedPayload.absItemId && !stale) {
            // Ordinary stops persist no item ID. An explicit false must survive
            // close/retry just like true, without turning every stop into unfinish.
            if (claimedPayload.isFinished) {
                if (!(await deps.client.markFinishedAs(apiKey, claimedPayload.absItemId)))
                    throw new Error('AudiobookShelf refused finish');
            } else {
                if (
                    !(await deps.client.patchProgressAs(apiKey, claimedPayload.absItemId, {
                        isFinished: false,
                    }))
                )
                    throw new Error('AudiobookShelf refused unfinish');
            }
        }
        await markAudiobookSessionCloseDone(input.sql, input.absSessionId, claimId);
        return { processed: true, sessionLost: !closed };
    } catch (error) {
        const retired = await releaseAudiobookSessionClose(input.sql, input.absSessionId, claimId, {
            upstreamClosed,
        });
        logger.warn('AudiobookShelf session close failed', {
            absSessionId: input.absSessionId,
            error: String(error),
        });
        if (retired) logGiveUp(input.absSessionId, String(error));
        // A retired row is not outstanding work any more, even though it never
        // succeeded — reporting it as unprocessed would keep the reaper spinning.
        return { processed: retired, sessionLost: false };
    }
}

/**
 * Burn one attempt against a close that can never be applied — the listener no
 * longer exists, or the row lost the AudiobookShelf session id the close needs.
 *
 * Claim-then-release rather than a direct write, so this respects the same lease
 * as a real attempt and can't stomp a peer replica mid-close.
 */
export async function abandonAudiobookSessionClose(
    sql: postgres.Sql,
    row: SessionRow,
): Promise<void> {
    if (!row.source_session_id) return;
    const claimId = randomUUID();
    const claimed = await claimAudiobookSessionClose(sql, row.source_session_id, claimId);
    if (!claimed) return;
    const retired = await releaseAudiobookSessionClose(sql, row.source_session_id, claimId);
    if (retired) logGiveUp(row.source_session_id, 'close is not applicable to any live listener');
}

function logGiveUp(absSessionId: string, reason: string): void {
    logger.error(
        'AudiobookShelf session close retired after repeated failures; the upstream ' +
            'session may still be open and needs an operator to close it',
        new Error(reason),
        { absSessionId },
    );
}

/**
 * Persist the listener's own progress before attempting ABS. Local playback is
 * a pushable source: a session lost on an ABS restart cannot repair this via
 * session sync/close. The scheduled push coalesces these events by (user, book)
 * and PATCHes the latest arbitrated position without replaying listening time.
 * Only a pulled ABS event uses `audiobookshelf-sync`; it must not echo back.
 */
async function mirrorPositionLocally(args: {
    isFinished?: boolean;
    sessionId?: string;
    /**
     * The session's cumulative listening time, or null when no client has
     * reported one. Never the position: this row is `lumastra-player`, whose
     * `session_elapsed_ms` readers take as real playing time.
     */
    sessionElapsedMs: number | null;
    sql: postgres.Sql;
    userId: UserId;
    mediaId: string;
    positionMs: number;
    runtimeMs: number;
}): Promise<void> {
    // This write is part of the report transaction. Let failures abort it so
    // progressSaved can never acknowledge a bookmark with no durable retry.
    const { appendEventAndRebuild } = await import('./watch-state-rebuilder.service.js');
    // Explicit playback flags are user acts, just like library marks. The
    // session ID keeps an unfinish eligible for playback recovery when generic
    // watch-state export is disabled. A later finish replaces that same intent.
    if (args.isFinished !== undefined) {
        await appendEventAndRebuild(args.sql, {
            user_id: args.userId,
            media_id: args.mediaId,
            event_type: args.isFinished ? 'mark_watched' : 'mark_unwatched',
            source: 'lumastra-user-mark',
            position_ms: args.isFinished ? null : args.positionMs,
            runtime_ms: args.runtimeMs > 0 ? args.runtimeMs : null,
            source_event_id: null,
            session_id: args.sessionId ?? null,
            event_seq: null,
            occurred_at: new Date().toISOString(),
        });
    }

    await appendEventAndRebuild(args.sql, {
        user_id: args.userId,
        media_id: args.mediaId,
        event_type: 'progress',
        source: 'lumastra-player',
        position_ms: args.positionMs,
        runtime_ms: args.runtimeMs > 0 ? args.runtimeMs : null,
        source_event_id: null,
        session_id: null,
        event_seq: null,
        session_elapsed_ms: args.sessionElapsedMs,
        occurred_at: new Date().toISOString(),
    });
}

/**
 * The highest cumulative listening time this session has reported, as ratcheted
 * into `external_payload` by `ratchetAudiobookSessionElapsed`. The unified
 * report path ratchets inside the same transaction before the row is re-read, so
 * this already includes the report being handled. Null when nothing was reported.
 */
function sessionElapsedMs(row: SessionRow): number | null {
    const payload = row.external_payload;
    if (payload === null || typeof payload !== 'object') return null;
    const value = Number((payload as Record<string, unknown>)[AUDIOBOOK_ELAPSED_KEY]);
    return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Tell the owners of superseded sessions, after the transaction that ended
 * them has committed.
 *
 * The push lane. Its absence is not a failure: the displaced client also learns
 * from the next live-lane call it makes (see terminalResult) — the next report
 * for a deck still playing, or the moment someone touches a paused one again.
 */
function announceSuperseded(rows: readonly SessionRow[], mediaId: string): void {
    for (const row of rows) notifySessionTerminated(row.id, 'superseded');
    if (rows.length > 0) {
        logger.info('Superseded audiobook sessions replaced by a new open', {
            mediaId,
            count: rows.length,
        });
    }
}

/**
 * What a live-lane call should answer for a row that is no longer live.
 *
 * Only supersession earns a 200. Everything else — reaped, closed, finished —
 * stays a 404, which the client already reads as "the session is gone, reopen
 * one and keep playing". Supersession is the one case where reopening is
 * exactly wrong.
 */
function terminalResult(row: SessionRow): AudiobookReportResult {
    if (row.stop_reason === 'superseded') {
        return { ok: true, sessionLost: true, superseded: true };
    }
    return { ok: false, sessionLost: false };
}

/** Refresh both local and AudiobookShelf liveness from server-owned position. */
export async function heartbeatAudiobookSession(
    input: AudiobookHeartbeatInput,
): Promise<AudiobookReportResult> {
    const row = await touchAudiobookSessionHeartbeat(input.sql, input);
    if (!row) {
        // No LIVE row — but the reason matters. A session the listener replaced
        // by starting the book elsewhere must not be reopened, and the paused
        // client's heartbeat is the first thing that asks after it.
        const terminal = await getSessionBySourceKey(
            input.sql,
            'audiobookshelf',
            input.absSessionId,
        );
        if (!terminal || terminal.user_id !== input.userId) {
            return { ok: false, sessionLost: false };
        }
        return terminalResult(terminal);
    }

    const deps = input.deps ?? (await defaultSessionDeps());
    const apiKey = await resolveListenerKey(input.sql, input.userId, input.username, deps);
    if (apiKey === null) return { ok: true, sessionLost: false };

    try {
        const synced = await deps.client.syncSessionAs(apiKey, input.absSessionId, {
            currentTime: row.positionMs / 1000,
            timeListened: 0,
            duration: (row.runtimeMs ?? 0) / 1000,
        });
        return { ok: true, sessionLost: !synced };
    } catch (error) {
        logger.warn('AudiobookShelf heartbeat failed', {
            absSessionId: input.absSessionId,
            error: String(error),
        });
        return { ok: true, sessionLost: false };
    }
}

/**
 * Push one position report upstream and onto our own row.
 *
 * The caller (the store) has already passed the dwell gate; this function does
 * not second-guess that. What it DOES guard is ownership: the row must be one
 * we opened, for this user and this book, or a caller could sync arbitrary
 * positions into someone else's session — the same hole the byte proxy closes,
 * on the write side.
 */
export async function reportAudiobookProgress(
    input: AudiobookReportInput,
): Promise<AudiobookReportResult> {
    const row = await getSessionBySourceKey(input.sql, 'audiobookshelf', input.absSessionId);
    if (!row || row.user_id !== input.userId || row.media_id !== input.mediaId) {
        return { ok: false, sessionLost: false };
    }

    // A download is not listening: whatever a client reports against it, no position
    // reaches AudiobookShelf or the local progress.
    if (row.purpose === 'download') {
        return row.status === 'ACTIVE' || row.status === 'PAUSED'
            ? { ok: true, sessionLost: false }
            : terminalResult(row);
    }

    const durationMs = row.runtime_ms ?? 0;
    const positionMs = Math.max(0, Math.round(input.bookPositionMs));

    // A conditional UPDATE, not an upsert. The upsert path would set
    // `status = 'ACTIVE'` and clear `stopped_at`, so a report that lands just
    // after a close — pause() forces a report and stop() closes, as two
    // independent requests with no ordering guarantee — would resurrect a
    // COMPLETED session and the byte proxy would serve its segments again.
    // Ownership and liveness are checked inside the same statement as the write,
    // so the read above is only for `runtime_ms`.
    const updated = await advanceAudiobookSessionPosition(input.sql, {
        absSessionId: input.absSessionId,
        userId: input.userId,
        mediaId: input.mediaId,
        positionMs,
    });
    // Already terminal. Reporting upstream anyway would push a position for a
    // session ABS has also been told to close.
    if (updated === 0) return terminalResult(row);

    await mirrorPositionLocally({
        sql: input.sql,
        userId: input.userId,
        mediaId: input.mediaId,
        positionMs,
        runtimeMs: durationMs,
        isFinished: input.isFinished,
        sessionId: row.id,
        sessionElapsedMs: sessionElapsedMs(row),
    });

    if (input.deferUpstream) return { ok: true, sessionLost: false };

    const deps = input.deps ?? (await defaultSessionDeps());
    const apiKey = await resolveListenerKey(input.sql, input.userId, input.username, deps);
    if (apiKey === null) return { ok: true, sessionLost: false };

    try {
        const synced = await deps.client.syncSessionAs(apiKey, input.absSessionId, {
            currentTime: positionMs / 1000,
            // Elapsed audio, never a position delta — a scrub would otherwise
            // inflate ABS's listening statistics by the size of the jump.
            timeListened: Math.max(0, input.listenedMs) / 1000,
            duration: durationMs / 1000,
        });
        return { ok: true, sessionLost: !synced };
    } catch (error) {
        // Never interrupt playback for a bookkeeping failure. The reconciling
        // sweep drains whatever the live lane drops.
        logger.warn('AudiobookShelf progress sync failed', {
            absSessionId: input.absSessionId,
            error: String(error),
        });
        return { ok: true, sessionLost: false };
    }
}

/** Close both sides with a durable, immutable upstream retry payload. */
export async function closeAudiobookSession(
    input: AudiobookReportInput,
): Promise<AudiobookReportResult> {
    const row = await getSessionBySourceKey(input.sql, 'audiobookshelf', input.absSessionId);
    if (!row || row.user_id !== input.userId || row.media_id !== input.mediaId) {
        return { ok: false, sessionLost: false };
    }

    // A download is not listening. Closing one ends the session and tells ABS nothing
    // about a position, a finish or listening time, whatever the client claims.
    const isDownload = row.purpose === 'download';
    const durationMs = Math.max(0, row.runtime_ms ?? 0);
    const positionMs = isDownload
        ? Math.max(0, Math.round(Number(row.position_ms)))
        : Math.max(0, Math.round(input.bookPositionMs));
    const listenedMs = isDownload ? 0 : Math.max(0, Math.round(input.listenedMs));
    const target =
        input.isFinished !== undefined && !isDownload
            ? await resolveAudiobookPlaybackTarget(input.sql, input.mediaId)
            : null;

    /**
     * Does this close have any evidence for the position it carries?
     *
     * The answer is the age of the pause in front of it, which `paused_at`
     * measures exactly: it is stamped once on the ACTIVE-to-PAUSED transition
     * and never refreshed. A close arriving on a session that has been sitting
     * paused is restating a position from before whatever the listener did next
     * — and if that was picking the book up somewhere else, writing it drags
     * them backwards in a progress row that is last-write-wins with no history.
     * `stop()` on a tab paused since this morning is exactly that.
     *
     * Nothing is lost by declining it. The position a close carries was already
     * reported: pause() forces a flush, and past the dwell gate every reporting
     * interval does. This only refuses to re-stamp an old value.
     *
     * `listenedMs` is the tempting test and it is the wrong one, in both
     * directions. A close can carry listening the client genuinely did but has
     * not reported yet, and a third-party client that simply does not track the
     * field would have every close it makes discarded.
     *
     * A finish is exempt: that is a fact about the book rather than about where
     * the listener is, and it is what `markFinishedAs` needs.
     */
    // `last_seen_at` when there is no `paused_at`, because the absence of one is
    // itself a failure mode: `pause()` sends a single fire-and-forget heartbeat
    // and stops the periodic ping in the same breath, so one dropped request
    // leaves the row ACTIVE with a NULL `paused_at` and the position just as
    // stale. Both columns answer the same question — when did we last have
    // evidence of this listener — and a session that is genuinely playing
    // refreshes `last_seen_at` every reporting interval, so it still reads fresh.
    const lastLivenessAt = row.paused_at ?? row.last_seen_at;
    const pausedForMs =
        lastLivenessAt === null ? 0 : Date.now() - new Date(lastLivenessAt).getTime();
    /**
     * Liveness first, and it is not redundant with the pause age.
     *
     * A row that is already terminal — reaped, superseded, or closed once
     * already — has a frozen upstream payload and belongs to the drain now, so
     * this call has nothing to add. What it can still do is write the MIRROR:
     * `prepareAudiobookSessionClose` returns the row whatever its status (its
     * UNION ALL branch has no status filter, which is what makes a repeat close
     * the documented no-op), so without this the position would sail through to
     * `user_media_state` — the one the iOS player resumes from. The report path
     * has always had this check, inside `advanceAudiobookSessionPosition`'s own
     * WHERE clause; the close path never did.
     *
     * A finish is exempt from the pause age but NOT from this: a completion
     * asserted against a session that was terminated minutes ago is not a
     * completion anyone just performed.
     */
    const isLive = row.status === 'ACTIVE' || row.status === 'PAUSED';
    const assertsPosition =
        !isDownload && isLive && (input.isFinished === true || pausedForMs < STALE_CLOSE_PAUSE_MS);

    const prepared = await prepareAudiobookSessionClose(input.sql, {
        sourceSessionId: input.absSessionId,
        userId: input.userId,
        mediaId: input.mediaId,
        stopReason: input.isFinished === true && !isDownload ? 'finished' : 'user_stopped',
        payload: {
            positionMs,
            listenedMs,
            runtimeMs: durationMs,
            isFinished: input.isFinished === true && !isDownload,
            absItemId: target?.absItemId ?? null,
            ...(assertsPosition ? {} : { syncPosition: false }),
        },
    });
    if (!prepared) return { ok: false, sessionLost: false };
    await revokeGrantsForPlaySession(row.id, input.sql, 'stopped');

    // The listener's final word on this session, and often newer than the last
    // periodic report — stop() closes without a report of its own. Gated on the
    // same evidence as the upstream write: the local mirror is what the iOS
    // player resumes from, so a stale position landing HERE is the same bug one
    // layer down.
    if (assertsPosition) {
        await mirrorPositionLocally({
            sql: input.sql,
            userId: input.userId,
            mediaId: input.mediaId,
            positionMs,
            runtimeMs: durationMs,
            isFinished: input.isFinished === true ? true : undefined,
            sessionId: row.id,
            sessionElapsedMs: sessionElapsedMs(row),
        });
    }

    if (input.deferUpstream) return { ok: true, sessionLost: false };

    const result = await retryPendingAudiobookSessionClose({
        sql: input.sql,
        userId: input.userId,
        username: input.username,
        absSessionId: input.absSessionId,
        deps: input.deps,
    });
    return {
        ok: true,
        sessionLost: result.sessionLost,
        // A repeat close stays the documented no-op (ok), but a client closing a
        // session that was taken over should still hear about it.
        ...(row.stop_reason === 'superseded' ? { superseded: true } : {}),
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `play_sessions.play_method` vocabulary, which is NOT this module's own.
 *
 * The column is CHECK-constrained to `direct | remux | audio_transcode |
 * full_transcode` — there is no bare `'transcode'`. An HLS session from
 * AudiobookShelf re-encodes the audio and nothing else, so it is
 * `audio_transcode`. Writing `'transcode'` raises
 * `play_sessions_play_method_check` at INSERT time, which on this path means
 * the session opens upstream and then fails to be recorded — leaving ABS
 * holding a session the byte proxy will refuse to serve.
 *
 * The same vocabulary reaches `enforceStreamPolicy`, whose
 * `allowed_play_methods` policy lists these exact values: an operator who
 * disallows transcoding for a user expects that to cover audiobooks too, and a
 * name outside the vocabulary would silently never match the deny list.
 */
function absPlayMethodColumn(method: AudiobookPlayMethod): 'direct' | 'audio_transcode' {
    return method === 'transcode' ? 'audio_transcode' : 'direct';
}

/** Null means "this account has no AudiobookShelf counterpart"; throws bubble. */
/**
 * Whether to provision an ABS account for a listener who has none.
 *
 * `getConfigState()` rather than `get()`: config.ts falls back to env-only
 * config outside a full
 * SvelteKit context, where `get()` throws. The schema default here is ON, so
 * "config did not load" and "config loaded with the default" must behave
 * identically.
 */
function autoCreateAbsUsers(): boolean {
    const state = getConfigState();
    return state ? state.values['AUDIOBOOK_AUTO_CREATE_USERS'] !== false : true;
}

async function resolveListenerKey(
    sql: postgres.Sql,
    userId: UserId,
    username: string,
    deps: AudiobookSessionDeps,
): Promise<string | null> {
    return resolveUserApiKey({
        secrets: new PluginSecrets(sql),
        deps: deps.credentials,
        userId,
        username,
        reenablePull: true,
        // Interactive playback: somebody is waiting on a player right now, so
        // this is the one path allowed to provision the account. Scheduled sync
        // deliberately does not pass it — it must not create accounts for
        // people who have never opened an audiobook.
        autoCreate: autoCreateAbsUsers(),
    });
}

async function mintSessionGrant(args: {
    surface: ApiSurface;
    playbackSessionId: string;
    userId: UserId;
    mediaId: string;
    clientIp: string;
    castTarget?: boolean;
    parentTokenHash?: string;
    deviceSessionId?: string;
    mintedByAdmin?: boolean;
    download?: boolean;
}): Promise<MintedPlaybackGrant> {
    const result = await mintPlaybackGrant({
        userId: args.userId,
        mediaId: args.mediaId,
        playbackSessionId: args.playbackSessionId,
        kind: 'audiobook',
        clientIp: args.clientIp,
        castTarget: args.castTarget,
        parentTokenHash: args.parentTokenHash,
        deviceSessionId: args.deviceSessionId,
        mintedByAdmin: args.mintedByAdmin,
        surface: args.surface,
        download: args.download,
    });
    return result;
}

/**
 * Direct-vs-transcode, from what the session actually contains.
 *
 * `playMethod` is checked first because it is the field ABS documents, but the
 * track shape is checked too: a single track whose `contentUrl` is under `/hls/`
 * IS a transcode session whatever the numeric field says, and getting this wrong
 * points the client's URL builder at the wrong route entirely.
 */
function derivePlayMethod(session: AudiobookPlaySession): AudiobookPlayMethod {
    if (session.playMethod === ABS_PLAY_METHOD_TRANSCODE) return 'transcode';
    const tracks = session.audioTracks ?? [];
    if (tracks.length === 1 && (tracks[0]?.contentUrl ?? '').startsWith('/hls/')) {
        return 'transcode';
    }
    return 'direct';
}

function secondsToMs(seconds: number | null | undefined): number {
    return typeof seconds === 'number' && Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

export { isPolicyError };

/** Unified report adapter. ABS identifiers never come from a client. */
export async function reportAudiobookPlaybackSession(input: {
    sql: postgres.Sql;
    playbackSessionId: string;
    userId: UserId;
    username: string;
    report: SessionUpdateInternal;
    deps?: AudiobookSessionDeps;
}): Promise<AudiobookReportResult> {
    // Only local claims and mirror writes run under the lock. ABS can stall;
    // the immutable close payload and its durable claim survive this transaction.
    const prepared = await withTx(input.sql, async (txSql) => {
        const tx = txSql as unknown as postgres.Sql;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.playbackSessionId}::text, 5))`;
        const row = await getSessionById(tx, input.playbackSessionId);
        if (
            !row ||
            row.user_id !== input.userId ||
            row.media_type !== 'audiobook' ||
            !row.source_session_id
        ) {
            return { result: { ok: false, sessionLost: false } };
        }
        const base = {
            sql: tx,
            userId: input.userId,
            username: input.username,
            absSessionId: row.source_session_id,
            mediaId: row.media_id,
            deps: input.deps,
        };
        const absSessionId = row.source_session_id;
        const claimClose = async (): Promise<{ claimId: string; row: SessionRow } | null> => {
            const claimId = randomUUID();
            const claimed = await claimAudiobookSessionClose(tx, absSessionId, claimId);
            return claimed ? { claimId, row: claimed } : null;
        };
        if (row.status !== 'ACTIVE' && row.status !== 'PAUSED') {
            if (input.report.status === 'COMPLETED' && getAudiobookClosePayload(row)) {
                return {
                    close: base,
                    claimedClose: await claimClose(),
                    superseded: row.stop_reason === 'superseded',
                };
            }
            return { result: terminalResult(row) };
        }
        const closing = input.report.status === 'COMPLETED' || input.report.finished === true;
        // A download is not listening: a progress report against it moves nothing
        // (a close is handled in closeAudiobookSession).
        if (!closing && row.purpose === 'download')
            return { result: { ok: true, sessionLost: false } };
        if (!closing && input.report.event_seq <= Number(row.last_event_seq)) {
            return { result: { ok: true, sessionLost: false } };
        }
        // `session_elapsed_ms` is cumulative; AudiobookShelf adds each timeListened.
        // Without an explicit per-interval `listened_ms`, forward only what the
        // session has not reported before.
        const elapsed = input.report.session_elapsed_ms ?? 0;
        const previous = await ratchetAudiobookSessionElapsed(tx, row.id, elapsed);
        // A closing report skips the event_seq gate so a close always lands, but an
        // explicit per-interval delta is only forwarded once: a retried closing
        // report (seq already applied) must not add the same time to ABS again.
        const replayedClose = closing && input.report.event_seq <= Number(row.last_event_seq);
        const listenedMs = replayedClose
            ? 0
            : (input.report.listened_ms ?? Math.max(0, elapsed - previous));
        const report = {
            ...base,
            bookPositionMs: input.report.position_ms,
            listenedMs,
            isFinished: input.report.finished,
            deferUpstream: true,
        };
        let result: AudiobookReportResult;
        let heartbeatOnly = false;
        if (closing) {
            result = await closeAudiobookSession(report);
        } else {
            const live = await touchAudiobookSessionHeartbeat(tx, {
                ...base,
                status: input.report.status as 'ACTIVE' | 'PAUSED',
            });
            heartbeatOnly =
                input.report.finished === undefined &&
                report.listenedMs === 0 &&
                report.bookPositionMs === Number(row.position_ms);
            result = !live
                ? terminalResult(row)
                : heartbeatOnly
                  ? { ok: true, sessionLost: false }
                  : await reportAudiobookProgress(report);
        }
        if (!result.ok || result.superseded) return { result };
        await tx`UPDATE play_sessions SET last_event_seq = GREATEST(last_event_seq, ${input.report.event_seq}) WHERE id = ${row.id}::uuid`;
        if (closing) return { close: base, claimedClose: await claimClose(), superseded: false };
        if (heartbeatOnly) return { result };
        return { progress: report, runtimeMs: row.runtime_ms ?? 0 };
    });
    if (prepared.result) return prepared.result;
    if (prepared.close) {
        const result = prepared.claimedClose
            ? await retryPendingAudiobookSessionClose({
                  ...prepared.close,
                  sql: input.sql,
                  claimedClose: prepared.claimedClose,
              })
            : { sessionLost: false };
        return {
            ok: true,
            sessionLost: result.sessionLost,
            ...(prepared.superseded ? { superseded: true } : {}),
        };
    }
    if (!prepared.progress) return { ok: false, sessionLost: false };
    const report = prepared.progress;
    const deps = input.deps ?? (await defaultSessionDeps());
    const apiKey = await resolveListenerKey(input.sql, input.userId, input.username, deps);
    if (apiKey === null) return { ok: true, sessionLost: false, wroteToDurable: true };
    try {
        const synced = await deps.client.syncSessionAs(apiKey, report.absSessionId, {
            currentTime: report.bookPositionMs / 1000,
            timeListened: Math.max(0, report.listenedMs) / 1000,
            duration: prepared.runtimeMs / 1000,
        });
        if (synced && report.isFinished === false) {
            const target = await resolveAudiobookPlaybackTarget(input.sql, report.mediaId);
            if (target) {
                await deps.client.patchProgressAs(apiKey, target.absItemId, { isFinished: false });
            }
        }
        return { ok: true, sessionLost: !synced, wroteToDurable: true };
    } catch (error) {
        logger.warn('AudiobookShelf progress sync failed', { error: String(error) });
        return { ok: true, sessionLost: false, wroteToDurable: true };
    }
}
