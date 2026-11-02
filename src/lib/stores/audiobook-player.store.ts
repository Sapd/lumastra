// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The audiobook player store.
 *
 * Sits beside `music-player.store.ts` on the same {@link AudioBackend}, and is
 * a separate store rather than a mode of that one for the reason the design
 * measured rather than assumed: `MiniPlayer.svelte` is 2239 lines with 172
 * store references and `FullScreenPlayer.svelte` 1481 with 116 — crossfade
 * prediction, the queue panel, alchemy, mood colours and radio now-playing are
 * woven through both. There is no shell to extract. The audio *layer*
 * underneath is right; the music *shape* is not.
 *
 * ## What this store owns
 *
 * - The virtual timeline: one book position, read three ways
 *   (`$lib/utils/audiobook-timeline`).
 * - Advancing across file boundaries, including re-applying playback rate,
 *   which both crossfade-capable backends reset to 1 on every load.
 * - MediaSession, entirely — `nexttrack` moves a CHAPTER, and
 *   `setPositionState` reports BOOK time. The backend is initialised with
 *   `manageMediaSession: false` so the two never fight over the lock screen.
 * - Accidental-seek protection (§3 of the design): a mis-tap in a 20-hour book
 *   is a data-loss bug, because ABS's `PATCH /api/me/progress` is
 *   last-write-wins over one row with no history.
 *
 * ## What it does NOT own
 *
 * The transport. {@link AudiobookPlayerDeps} is injected: opening the
 * AudiobookShelf playback session, reporting progress, and closing the session
 * all happen server-side, because the per-user ABS key must never reach the
 * browser. The store never calls AudiobookShelf directly.
 *
 * That boundary carries one ORDERING CONSTRAINT that is not negotiable and is
 * restated on {@link AudiobookPlayerDeps.openSession}: the `play_sessions` row
 * must be committed before any HLS segment is requested, because ABS serves
 * `/hls/:sid/*` with no authentication of its own and that row is the only
 * thing pinning a session id to this user and this book.
 */

import { writable, derived, get, type Readable } from 'svelte/store';
import { createAudiobookBackend, type AudioBackend, type TimeUpdateInfo } from '$lib/audio';
import {
    buildPlaybackAudiobookTimeline,
    chapterProgress,
    clampBookMs,
    findChapterAt,
    nextTrack as nextTrackAfter,
    resolveFilePosition,
    seekChapterTarget,
    type AudiobookChapterSpan,
    type AudiobookTimeline,
    type AudiobookTrack,
} from '$lib/utils/audiobook-timeline';
import type {
    AudiobookPlayMethod,
    AudiobookProgressAck,
    AudiobookProgressReport as AudiobookProgressBody,
    AudiobookSessionPayload as LegacyAudiobookSessionPayload,
    OpenAudiobookSessionRequest,
} from '$lib/schemas/api-audiobook-session';
import {
    clearMediaSession,
    initMediaSession,
    updateMediaSessionPlaybackState,
    updateMediaSessionPositionState,
} from '$lib/utils/media-session';
import {
    audiobookCodecNeedsRemux,
    engineCanDecodeAudiobookCodec,
} from '$lib/shared/audiobook-remux-codecs';
import { claimAudio, registerAudioParticipant, releaseAudio } from './audio-exclusivity';
import { loadAudiobookVolume, saveAudiobookVolume } from './audiobook-player-persistence';
import { toasts } from './toast.store';
import { reportUserFacingFailure } from '$lib/client-diagnostics/web-reporter';
import * as m from '$lib/paraglide/messages';

import type { PlaybackStartResponse } from '$lib/schemas/playback-start.js';
import { maintainPlaybackGrant } from '$lib/utils/playback-grant.js';

/** Player timeline projection of the public start envelope; no upstream identifiers. */
export type AudiobookSessionPayload = Omit<
    LegacyAudiobookSessionPayload,
    'absSessionId' | 'streamToken'
> & {
    playbackSessionId: string;
    start: PlaybackStartResponse;
};

// ---------------------------------------------------------------------------
// Transport contract
// ---------------------------------------------------------------------------

/** The public start envelope is projected into the existing virtual timeline in the API adapter. */
export type {
    AudiobookPlayMethod,
    AudiobookProgressAck,
    AudiobookProgressBody,
    OpenAudiobookSessionRequest,
};

/**
 * What the store hands `openSession`.
 *
 * `positionMs` is omitted on a normal load so the server answers with
 * AudiobookShelf's own saved progress — the position both systems already agree
 * on. It is supplied only when the caller genuinely means "start HERE".
 */
export type AudiobookOpenSessionInput = OpenAudiobookSessionRequest;

/**
 * A position report, plus the session it belongs to.
 *
 * `playbackSessionId` is NOT part of the wire body — it travels in the request path
 * — but the store has to name the session it is reporting for, so it rides on
 * the transport's argument and the transport strips it.
 */
export interface AudiobookProgressReport extends AudiobookProgressBody {
    /** Lumastra play_sessions row id. */
    playbackSessionId: string;
    status?: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
}

export interface AudiobookPlayerDeps {
    /**
     * Open an AudiobookShelf playback session through Lumastra.
     *
     * **The implementation MUST have committed the `play_sessions` row (source
     * `'audiobookshelf'`, ABS session id in `source_session_id`, status
     * `ACTIVE`) before this promise resolves.** The byte proxy checks that row
     * on every HLS segment, because ABS itself serves `/hls/:sid/*` with no
     * authentication and the stream token pins the media id, not the session.
     * Resolving early does not fail open — it fails as a hard 404 on every
     * segment — but it does fail.
     */
    openSession(input: AudiobookOpenSessionInput): Promise<AudiobookSessionPayload>;
    /**
     * Push position + listening time after dwell or at a pause/leave checkpoint.
     *
     * The ack matters: `sessionLost` means the upstream session is gone (ABS
     * sessions are in-memory and die on a restart or its other-device rule),
     * after which direct-play bytes keep flowing while every sync 404s. The
     * design's policy is to reopen a session at the current position and carry
     * on — never to interrupt playback for a bookkeeping failure — and without
     * this return value the store would sync into a void every 15 s for the rest
     * of the book.
     */
    reportProgress(report: AudiobookProgressReport): Promise<AudiobookProgressAck>;
    /** Refresh session liveness without sending or changing position. */
    heartbeat(input: {
        playbackSessionId: string;
        mediaId: string;
        status: 'ACTIVE' | 'PAUSED';
        bookPositionMs: number;
    }): Promise<AudiobookProgressAck>;
    /** Close the ABS session and the `play_sessions` row. */
    closeSession(report: AudiobookProgressReport): Promise<AudiobookProgressAck>;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How much real playback must elapse at a seek-derived position before it is
 * reported periodically. Pause and leave checkpoints persist the current position.
 *
 * This is the first of the design's three layers against accidental seeks. It
 * governs the ONE call the store makes, which is why both propagation lanes —
 * the live session and the local `user_media_events` append — are covered by
 * construction: the server fans out from a single request. Explicit checkpoints
 * bypass this delay so a seek followed by pause or close remains resumable.
 */
export const SEEK_DWELL_MS = 10_000;

/** A seek larger than this raises the undo affordance. */
export const UNDO_SEEK_THRESHOLD_MS = 5 * 60_000;

/** Steady-state reporting cadence while playing. */
const REPORT_INTERVAL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * How many times a lost upstream session is reopened before the live reporting
 * lane is abandoned to the reconciling sweep.
 *
 * Reset by any report that lands, so this bounds a RUN of failures rather than
 * the session's lifetime.
 */
const MAX_LOST_SESSION_RECOVERIES = 3;

/**
 * How long a pause has to last before pressing play re-reads the server's
 * position instead of trusting this tab's.
 *
 * Mirrors the server's own PAUSED grace (`staleSessionCondition`, 30 minutes),
 * which is what makes the threshold more than a guess: past it the session has
 * been reaped, so the row the byte proxy checks is gone and resuming from the
 * element alone plays until the next range request 404s. Below it the session
 * is alive and this tab's position is still the one the server holds, so an
 * ordinary coffee-break resume costs nothing.
 *
 * A pause SHORTER than this can still be a hand-off — phone picked up, ten
 * minutes listened — and this deliberately does not chase that: a tab that has
 * heard nothing and made no seek of its own pushes no position (see flushReport
 * and closeAudiobookSession), so what remains is only that this tab resumes where
 * IT was paused, which is a defensible thing for it to do.
 */
const STALE_PAUSE_MS = 30 * 60_000;

/**
 * How far ahead of the server this tab must be before its own position wins a
 * re-anchor. Below it the two are the same fact, and the difference is our last
 * report's own rounding.
 */
const REANCHOR_TOLERANCE_MS = 5_000;

/**
 * How many times `load()` tries to open the FIRST session before giving up.
 *
 * AudiobookShelf's session bookkeeping is in-memory and genuinely flaps for a
 * few seconds around another client opening or closing a session on the same
 * book — observed in production (2026-08-12): a churn window under a minute
 * during which every open attempt failed. Without a retry here, that window
 * left the listener on a dead player with no recourse but to back fully out
 * and reopen the book by hand — `recoverLostSession` only covers a session
 * that dies AFTER `load()` already succeeded.
 */
const MAX_SESSION_OPEN_ATTEMPTS = 3;

/**
 * User-facing text for a refused `POST /play-sessions`, keyed on the
 * problem+json `code` that `AudiobookSessionError` carries (duck-typed so the
 * store keeps no import on the API module). `permanent` refusals are not
 * retried: a stream limit or a missing AudiobookShelf link will not clear up
 * inside the retry window, and retrying only delays the message. Returns
 * undefined for anything else, so the caller keeps its own fallback.
 */
export function describeAudiobookSessionRefusal(
    err: unknown,
): { message: string; permanent: boolean } | undefined {
    if (!(err instanceof Error)) return undefined;
    const { code, status } = err as Error & { code?: unknown; status?: unknown };
    if (code === 'stream_limit') {
        return { message: m.playback_refusal_stream_limit_generic(), permanent: true };
    }
    if (code === 'forbidden' || (code === undefined && status === 403)) {
        return { message: m.audiobook_refusal_no_abs_link(), permanent: true };
    }
    if (code === 'dependency_unavailable') {
        return { message: m.audiobook_refusal_unavailable(), permanent: false };
    }
    return undefined;
}
const SESSION_OPEN_RETRY_DELAY_MS = 2_000;

/** Default lock-screen / button skip offsets. */
export const SKIP_BACK_MS = 30_000;
export const SKIP_FORWARD_MS = 30_000;

/**
 * Floor for the plausible-listening window.
 *
 * Sized above the backend's 50 ms tick so a foreground run is not rejecting
 * its own normal deltas, and small enough that a real scrub — measured in
 * minutes, not fractions of a second — never slips through as listening time.
 */
const MIN_LISTEN_WINDOW_MS = 500;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * `transcode_unsupported` and `session_failed` mean "the book never started".
 *
 * `playback_failed` is the one kind set after a start, and only for the AUDIO
 * failing: a file that 500s at a boundary, on a resume, on a restart-on-seek,
 * or mid-stream. A bookkeeping or session failure still never interrupts
 * playback — the design's rule — so nothing else downstream of a start sets an
 * error.
 */
export type AudiobookPlayerErrorKind =
    'transcode_unsupported' | 'session_failed' | 'playback_failed';

export interface AudiobookPlayerError {
    kind: AudiobookPlayerErrorKind;
    message: string;
}

/** A seek the listener can take back. Cleared by undo, or by the next seek. */
export interface PendingSeekUndo {
    fromMs: number;
    toMs: number;
}

export interface AudiobookPlayerState {
    mediaId: string | null;
    book: AudiobookSessionPayload['book'] | null;
    timeline: AudiobookTimeline | null;
    playMethod: AudiobookPlayMethod;
    playbackSessionId: string | null;

    isLoading: boolean;
    isPlaying: boolean;
    /** Book time, ms — the single source of truth for position. */
    bookPositionMs: number;
    durationMs: number;

    currentChapter: AudiobookChapterSpan | null;
    /** Position within the current chapter — what the interactive scrubber shows. */
    chapterPositionMs: number;
    chapterDurationMs: number;

    playbackRate: number;
    /** 0-1, backend-space (already curve-applied by the UI before it gets here). */
    volume: number;
    isMuted: boolean;
    /** False on iOS (`PlainAudioBackend`) — hardware-only volume there. */
    supportsVolumeControl: boolean;
    error: AudiobookPlayerError | null;
    pendingUndo: PendingSeekUndo | null;
    /** True while a seek-derived position is still withheld from the server. */
    isDwelling: boolean;
}

const INITIAL_STATE: AudiobookPlayerState = {
    mediaId: null,
    book: null,
    timeline: null,
    playMethod: 'direct',
    playbackSessionId: null,
    isLoading: false,
    isPlaying: false,
    bookPositionMs: 0,
    durationMs: 0,
    currentChapter: null,
    chapterPositionMs: 0,
    chapterDurationMs: 0,
    playbackRate: 1,
    volume: 1,
    isMuted: false,
    supportsVolumeControl: true,
    error: null,
    pendingUndo: null,
    isDwelling: false,
};

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

/** Keep a server-provided remux URL; only its seek offset is client-owned. */
export function audiobookSeekUrl(href: string, startMs: number): string {
    const url = new URL(href, 'https://playback.invalid');
    url.searchParams.set('startPositionSeconds', String(Math.max(0, Math.floor(startMs)) / 1000));
    return url.pathname + url.search;
}

// ---------------------------------------------------------------------------
// Capability probes
// ---------------------------------------------------------------------------

function probe(el: HTMLAudioElement, type: string): boolean {
    try {
        return el.canPlayType(type) !== '';
    } catch {
        return false;
    }
}

/** MIME types to offer ABS, from what this engine says it can decode. */
export function detectSupportedMimeTypes(el: HTMLAudioElement): string[] {
    const candidates: Array<[string, string]> = [
        ['audio/mpeg', 'audio/mpeg'],
        ['audio/mp4', 'audio/mp4; codecs="mp4a.40.2"'],
        ['audio/m4b', 'audio/mp4; codecs="mp4a.40.2"'],
        ['audio/flac', 'audio/flac'],
        ['audio/ogg', 'audio/ogg; codecs="opus"'],
        ['audio/opus', 'audio/ogg; codecs="opus"'],
        ['audio/aac', 'audio/aac'],
        ['audio/wav', 'audio/wav'],
    ];
    const seen = new Set<string>();
    for (const [advertise, test] of candidates) {
        if (probe(el, test)) seen.add(advertise);
    }
    return [...seen];
}

/** Whether this engine plays HLS natively. Only Safari and iOS do. */
export function supportsNativeHls(el: HTMLAudioElement): boolean {
    return probe(el, 'application/vnd.apple.mpegurl') || probe(el, 'application/x-mpegURL');
}

/**
 * Does THIS engine need Lumastra to remux THIS file?
 *
 * Two independent facts, and both are required:
 *
 *  1. The **server** flagged the file, from the persisted per-file codec — the
 *     value AudiobookShelf's own MIME-type negotiation never consults.
 *  2. This **engine** cannot decode that codec. WebKit plays E-AC-3 natively
 *     (`canPlayType('audio/mp4; codecs="ec-3"') === 'probably'`, measured), so
 *     remuxing there would burn CPU to produce something worse than the original.
 *
 * The server flag alone is not enough (it would remux on Safari) and the codec
 * alone is not enough (a transcode session's synthetic track reports `codec:
 * null`). `needsRemux` is absent on a payload from an older server, and the codec
 * check then stands in for it — which is why this reads the codec rather than
 * trusting the flag to be present.
 *
 * ## Why an unflagged track with NO codec still returns false
 *
 * Reaching the engine probe with an unknown codec always answers "remux"
 * (`engineCanDecodeAudiobookCodec` is deliberately pessimistic). Letting the
 * unknown case fall through to it therefore does not mean "verify" here — it means
 * *remux every file whose codec this payload did not carry*, which on an older
 * server that reports no codecs at all is the whole library.
 *
 * The distinction that makes an unknown codec suspicious — unknown for THIS file
 * while its siblings reported one — needs the whole book, which only the server
 * has. `annotateRemuxTracks` makes exactly that call and expresses it by setting
 * `needsRemux`, so a suspicious file arrives flagged and never reaches the early
 * return below. Do not "fix" this by probing on an absent codec.
 */
export function trackNeedsRemux(
    track: Pick<AudiobookTrack, 'ino' | 'codec'> & { remuxUrl?: string } & { needsRemux?: boolean },
    el: HTMLAudioElement,
): boolean {
    // No inode means no file to fetch: the synthetic whole-book track of a
    // transcode session, which is an HLS playlist and a different mechanism.
    if (!track.remuxUrl && track.ino === null) return false;
    if (!track.needsRemux && !audiobookCodecNeedsRemux(track.codec)) return false;
    return !engineCanDecodeAudiobookCodec(track.codec, (type) => {
        try {
            return el.canPlayType(type);
        } catch {
            return '';
        }
    });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Exported so tests get a FRESH instance per case.
 *
 * The singleton below carries session state, a registered exclusivity
 * participant and document-level flush listeners; sharing one across cases
 * makes each test depend on the order of the ones before it.
 */
export function createAudiobookPlayerStore() {
    const persistedVolume = loadAudiobookVolume();
    const store = writable<AudiobookPlayerState>({
        ...INITIAL_STATE,
        volume: persistedVolume.volume,
        isMuted: persistedVolume.isMuted,
    });

    let backend: AudioBackend | null = null;
    let deps: AudiobookPlayerDeps | null = null;
    let deviceId = 'lumastra-web';
    let backendInit: Promise<AudioBackend | null> | null = null;
    let unregisterParticipant: (() => void) | null = null;
    /** Bumped when another tab claims audio (audio-exclusivity.ts). */
    let otherTabClaimEpoch = 0;
    /** `otherTabClaimEpoch` as of this tab's last claim; a mismatch after a load means yield. */
    let ownClaimEpoch = 0;
    let probeElement: HTMLAudioElement | null = null;

    /** Session-scoped, not state: nothing renders these. */
    let session: AudiobookSessionPayload | null = null;
    let stopGrantRenewal: (() => void) | undefined;
    let grantReloadPending = false;
    let currentTrack: AudiobookTrack | null = null;
    /** Book time of the START of the file the backend is currently playing. */
    let fileBaseMs = 0;

    /** Reporting bookkeeping. */
    let lastReportAt = 0;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let lastTickBookMs: number | null = null;
    let lastTickAt: number | null = null;
    /** Most recent position accepted by playback dwell or a pause/leave checkpoint. */
    let lastTrustedBookMs = 0;
    let unreportedListenedMs = 0;
    /** A seek needs saving even when no additional audio has been heard. */
    let unreportedSeek = false;
    /**
     * When the current pause started, or null while playing.
     *
     * Wall-clock rather than a flag because what matters on resume is HOW LONG
     * the deck has been sitting — see {@link STALE_PAUSE_MS}.
     */
    let pausedAt: number | null = null;
    /** Remaining playback the dwell gate still wants before it opens. */
    let dwellRemainingMs = 0;
    let cleanupFlushHandlers: (() => void) | null = null;
    /** Guards against a burst of 404 reports each opening its own session. */
    let recoveringSession = false;
    /** Reopen attempts since the last report that actually landed. */
    let lostSessionRecoveries = 0;
    /** Latest close remains visible after its session object is cleared. */
    let pendingSessionClose: Promise<void> | null = null;
    /**
     * AudiobookShelf progress is last-write-wins, so session mutations must land
     * in the order the player emitted them. In particular, a pause heartbeat
     * carries the server's previous position and must never overtake the forced
     * progress report that follows it.
     */
    let sessionMutationTail: Promise<void> = Promise.resolve();

    // -- Derived position bookkeeping ------------------------------------------

    function applyPosition(state: AudiobookPlayerState, bookMs: number): AudiobookPlayerState {
        const timeline = state.timeline;
        if (!timeline) return { ...state, bookPositionMs: bookMs };
        const clamped = clampBookMs(timeline, bookMs);
        const progress = chapterProgress(timeline, clamped);
        return {
            ...state,
            bookPositionMs: clamped,
            currentChapter: progress?.chapter ?? null,
            chapterPositionMs: progress?.positionMs ?? 0,
            chapterDurationMs: progress?.durationMs ?? 0,
        };
    }

    function setPosition(bookMs: number): void {
        store.update((s) => applyPosition(s, bookMs));
    }

    // -- MediaSession ----------------------------------------------------------

    /**
     * The store owns the lock screen outright.
     *
     * `nexttrack`/`previoustrack` move a CHAPTER, not a file — on a book where
     * `chapters.length === audioFiles.length` (the common shape) those happen
     * to coincide, but on a single-file 24-hour book a file skip would be the
     * end of the book. And `setPositionState` gets BOOK time: the backend's
     * clock is file time, which on file two onwards would put the lock-screen
     * scrubber back at the start.
     */
    function registerMediaSession(): void {
        const state = get(store);
        if (!state.book) return;
        initMediaSession(
            {
                title: state.book.title,
                artist: state.book.author ?? '',
                album: state.currentChapter?.title ?? '',
                artwork: state.book.images.primary?.href,
            },
            {
                onPlay: () => void resume(),
                onPause: () => pause(),
                onStop: () => void stop(),
                onNextTrack: () => void skipChapter(1),
                onPreviousTrack: () => void skipChapter(-1),
                onSeekTo: (seconds) => void seekTo(seconds * 1000, { source: 'seek' }),
                onSeekBackward: (offset) => void skipBy(-(offset ? offset * 1000 : SKIP_BACK_MS)),
                onSeekForward: (offset) => void skipBy(offset ? offset * 1000 : SKIP_FORWARD_MS),
            },
            // NOT trackControlsOnly: an audiobook wants the podcast-style skip
            // buttons that setting exists to suppress for music.
            { trackControlsOnly: false },
        );
        syncMediaSessionPosition();
    }

    function syncMediaSessionPosition(): void {
        const state = get(store);
        if (state.durationMs <= 0) return;
        updateMediaSessionPositionState(
            state.durationMs / 1000,
            Math.min(state.bookPositionMs, state.durationMs) / 1000,
            state.playbackRate,
        );
    }

    // -- Reporting -------------------------------------------------------------

    /**
     * Accumulate audio actually heard.
     *
     * Only forward movement of a plausible size counts. A jump is a seek and
     * contributes nothing — reporting position deltas as listening time is how
     * a scrub inflates ABS's statistics.
     */
    function accumulateListening(bookMs: number, rate: number): void {
        const now = Date.now();
        const elapsedWallMs = lastTickAt === null ? 0 : Math.max(0, now - lastTickAt);
        lastTickAt = now;

        if (lastTickBookMs === null) {
            lastTickBookMs = bookMs;
            return;
        }
        const delta = bookMs - lastTickBookMs;
        lastTickBookMs = bookMs;
        if (delta <= 0) return;
        // The plausible window comes from ACTUAL wall time, not from the
        // backend's nominal 50 ms interval. Chrome throttles background timers,
        // so ticks a second apart are normal in exactly the phone-in-pocket
        // case this player is for — and a hardcoded 50 ms window would reject
        // that real listening as "a seek", under-counting time and leaving the
        // dwell gate stuck closed.
        const plausibleMs = Math.max(MIN_LISTEN_WINDOW_MS, elapsedWallMs * rate * 1.5);
        if (delta > plausibleMs) return;
        unreportedListenedMs += delta;
        if (dwellRemainingMs > 0) {
            dwellRemainingMs = Math.max(0, dwellRemainingMs - delta);
            if (dwellRemainingMs === 0) store.update((s) => ({ ...s, isDwelling: false }));
        }
    }

    function buildReport(isFinished: boolean): AudiobookProgressReport | null {
        const state = get(store);
        if (!state.mediaId || !state.playbackSessionId) return null;
        return {
            mediaId: state.mediaId,
            playbackSessionId: state.playbackSessionId,
            bookPositionMs: Math.round(state.bookPositionMs),
            listenedMs: Math.round(unreportedListenedMs),
            isFinished,
            status: isFinished ? 'COMPLETED' : state.isPlaying ? 'ACTIVE' : 'PAUSED',
        };
    }

    function enqueueSessionMutation(label: string, mutation: () => Promise<void>): Promise<void> {
        const queued = sessionMutationTail.then(mutation);
        const settled = queued.catch((err) => {
            // Playback remains authoritative. The periodic reconciliation sweep
            // repairs bookkeeping that a transient live-lane failure drops.
            console.warn(`[AudiobookPlayer] ${label} failed`, err);
        });
        sessionMutationTail = settled;
        return settled;
    }

    /** Periodic reports respect dwell; pause/leave checkpoints also save seeks. */
    function flushReport(
        options: { force?: boolean; checkpoint?: boolean; isFinished?: boolean } = {},
    ): boolean {
        if (!deps) return false;
        if (dwellRemainingMs > 0 && !options.checkpoint) return false;
        // A position change is independent of listening time. An idle paused
        // tab with neither must stay silent: another device may have moved on.
        if (unreportedListenedMs <= 0 && !unreportedSeek && options.isFinished !== true) {
            return false;
        }

        const now = Date.now();
        if (!options.force && now - lastReportAt < REPORT_INTERVAL_MS) return false;

        const report = buildReport(options.isFinished === true);
        if (!report) return false;

        if (options.checkpoint) {
            dwellRemainingMs = 0;
            lastTrustedBookMs = report.bookPositionMs;
            store.update((s) => ({ ...s, isDwelling: false }));
        }
        lastReportAt = now;
        unreportedListenedMs = 0;
        unreportedSeek = false;
        const transport = deps;
        const generation = loadGeneration;
        void enqueueSessionMutation('progress report', async () => {
            const ack = await transport.reportProgress(report);
            const current = get(store);
            const stillCurrent =
                generation === loadGeneration &&
                current.mediaId === report.mediaId &&
                current.playbackSessionId === report.playbackSessionId;
            if (stillCurrent) {
                if (ack.superseded === true) {
                    closeSupersededPlayer();
                    return;
                }
                // A landed report is the only evidence the session is healthy,
                // and it is what re-arms the recovery budget.
                if (ack.sessionLost !== true) {
                    lostSessionRecoveries = 0;
                    return;
                }
                await recoverLostSession();
            }
        });
        return true;
    }

    function sendHeartbeat(): void {
        const state = get(store);
        if (!deps || !state.mediaId || !state.playbackSessionId) return;
        const generation = loadGeneration;
        const { mediaId, playbackSessionId } = state;
        const transport = deps;
        void enqueueSessionMutation('heartbeat', async () => {
            const ack = await transport.heartbeat({
                playbackSessionId,
                mediaId,
                status: state.isPlaying ? 'ACTIVE' : 'PAUSED',
                bookPositionMs: Math.round(lastTrustedBookMs),
            });
            const current = get(store);
            if (
                generation !== loadGeneration ||
                current.mediaId !== mediaId ||
                current.playbackSessionId !== playbackSessionId
            ) {
                return;
            }
            if (ack.superseded === true) {
                closeSupersededPlayer();
                return;
            }
            if (ack.sessionLost === true) await recoverLostSession();
        });
    }

    /**
     * The listener started this book somewhere else; this deck is finished.
     *
     * `stop()` without the close, because there is nothing left to close: the
     * server terminated the row when it opened the other session, and a DELETE
     * against it would 404 — or, worse, arrive as this deck's stale position if
     * the row somehow still lived.
     *
     * Deliberately silent. The tab this happens to is one nobody is at; the
     * listener is on the device they just started, and a toast on the laptop
     * they walked away from is for no one.
     */
    function closeSupersededPlayer(): void {
        loadGeneration++;
        stopHeartbeat();
        backend?.stop();
        releaseAudio('audiobook');
        clearMediaSession();
        resetSessionBookkeeping();
        const current = get(store);
        store.set({
            ...INITIAL_STATE,
            playbackRate: current.playbackRate,
            volume: current.volume,
            isMuted: current.isMuted,
            supportsVolumeControl: current.supportsVolumeControl,
        });
    }

    function startHeartbeat(): void {
        stopHeartbeat();
        heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    }

    function stopHeartbeat(): void {
        if (heartbeatInterval !== null) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
    }

    /**
     * The upstream session vanished. Open a new one and keep playing.
     *
     * AudiobookShelf sessions are in-memory: they die on an ABS restart and on
     * ABS's own rule that a new session for the same (user, device) closes any
     * other. Afterwards direct-play bytes keep flowing — the item-file endpoint
     * is session-independent — so the listener notices nothing while every sync
     * 404s and their position stops being recorded anywhere.
     *
     * Deliberately does NOT touch the backend: playback continues untouched and
     * only the bookkeeping is re-established. That is the design's rule — never
     * interrupt playback for a session-bookkeeping failure — and it is why this
     * only swaps the session id and token rather than re-issuing `play()`.
     *
     * On the TRANSCODE path the old playlist URL dies with the session, so there
     * is nothing to salvage; that case falls back to the 5-minute reconciling
     * sweep rather than restarting audio under the listener.
     */
    async function recoverLostSession(): Promise<void> {
        const state = get(store);
        if (!deps || !state.mediaId || session === null) return;
        if (recoveringSession) return;
        // Only a deck that is still live may reopen: playing, or paused recently
        // enough that the server would still be holding its session.
        //
        // Past that, a lost session means the row was reaped — and reopening
        // costs twice. It re-claims a concurrent-stream slot for a deck nobody
        // is at, and the open SUPERSEDES the listener's other paused session
        // for this book, which is the device they actually moved to. Pausing
        // is not that case: the deck was playing a second ago, so a 404 there
        // is a vanished upstream rather than a listener who has left, and the
        // reopen is what keeps their book ready. Nothing is lost by declining
        // the rest — whatever presses play next goes through resume(), which
        // re-anchors from the server past the same threshold.
        const pausedForMs = pausedAt === null ? 0 : Date.now() - pausedAt;
        if (!state.isPlaying && pausedForMs >= STALE_PAUSE_MS) return;
        if (state.playMethod === 'transcode') return;
        // Bounded, like the video player's reconnect ceiling. Without a bound, a
        // server that keeps answering 404 — our own row reaped, say, not just a
        // dead ABS session — would mint a fresh AudiobookShelf session every
        // reporting interval for the rest of a 20-hour book. Past the ceiling the
        // live lane is given up on and the 5-minute reconciling sweep carries the
        // position instead; playback is never touched either way.
        if (lostSessionRecoveries >= MAX_LOST_SESSION_RECOVERIES) return;
        lostSessionRecoveries++;
        recoveringSession = true;
        const generation = loadGeneration;
        const lostPlaybackSessionId = state.playbackSessionId;
        try {
            const payload = await openSessionAt(state.mediaId, state.bookPositionMs, false);
            if (!payload) return;
            const current = get(store);
            if (
                generation !== loadGeneration ||
                current.mediaId !== state.mediaId ||
                current.playbackSessionId !== lostPlaybackSessionId ||
                session === null
            ) {
                discardSession(payload);
                return;
            }
            // Keep the listener where they are: adoptSession would rebase the
            // position onto the new payload's startPositionMs, and the server
            // answers that from AudiobookShelf's saved progress, which is exactly
            // the value that stopped being updated.
            setSessionPayload(payload);
            store.update((s) => ({
                ...s,
                playbackSessionId: payload.playbackSessionId,
                playMethod: payload.playMethod,
            }));
            // openSession creates an ACTIVE row. When recovery was triggered by
            // a paused heartbeat, correct that row before this queue slot
            // completes. Calling sendHeartbeat() here would enqueue behind the
            // mutation currently awaiting us and deadlock if it were awaited.
            if (!get(store).isPlaying) {
                await deps.heartbeat({
                    playbackSessionId: payload.playbackSessionId,
                    mediaId: state.mediaId,
                    status: 'PAUSED',
                    bookPositionMs: Math.round(payload.startPositionMs),
                });
            }
        } catch (err) {
            console.warn('[AudiobookPlayer] could not reopen a lost session', err);
        } finally {
            recoveringSession = false;
        }
    }

    // -- Advance ---------------------------------------------------------------

    /** Ask the backend to pre-roll the next file, if it can. */
    function scheduleAdvance(): void {
        const state = get(store);
        if (!backend || !session || !currentTrack || !state.timeline) return;
        // A paused deck never reaches its boundary, so the scheduler's 25 ms
        // poll would spin until the next pause/resume — on the phone this
        // player is built for.
        if (!state.isPlaying) return;
        // A transcode session is ONE track (the playlist); there is no boundary
        // to advance across.
        if (state.playMethod === 'transcode') return;
        if (!backend.supportsGaplessAdvance) return;

        const next = nextTrackAfter(state.timeline, currentTrack);
        // No inode means no file to fetch — the transcode path's synthetic
        // whole-book track. Unreachable behind the playMethod guard above, and
        // guarded anyway rather than interpolating `null` into a URL.
        if (!next?.url) return;

        backend.scheduleGaplessAdvance({
            // The next file gets the same treatment as the current one. `t` is 0
            // because an advance starts at the head, which is also why
            // `onAdvanceCommitted` can keep rebasing on `next.startOffsetMs`.
            src: deliveryTrackUrl(next, 0),
            metadata: { title: state.book?.title ?? '', artist: state.book?.author },
            startAtMs: 0,
            // Re-applied here because both crossfade-capable backends hard-set a
            // freshly loaded deck to rate 1. Without this a 1.5x listener drops
            // to 1x at every boundary — roughly every nine minutes.
            playbackRate: state.playbackRate,
            preservePitch: true,
        });
    }

    /** The backend swapped decks. Rebase the timeline onto the new file. */
    function onAdvanceCommitted(info: { src: string; positionMs: number }): void {
        const state = get(store);
        if (!state.timeline || !currentTrack) return;
        const next = nextTrackAfter(state.timeline, currentTrack);
        if (!next) return;

        currentTrack = next;
        fileBaseMs = next.startOffsetMs;
        // `positionMs` is MEASURED, not the requested 0: the incoming deck has
        // been playing for the lead. Rebasing on the request would lose that
        // much book position at every boundary.
        setPosition(fileBaseMs + info.positionMs);
        lastTickBookMs = null;
        registerMediaSession();
        scheduleAdvance();
    }

    /**
     * A boundary the gapless path did not handle — an unsupported backend, a
     * missed arm point, or the end of the book.
     */
    async function onTrackEnded(): Promise<void> {
        const state = get(store);
        if (!state.timeline || !currentTrack || !session) return;

        const next = nextTrackAfter(state.timeline, currentTrack);
        if (!next) {
            await finishBook();
            return;
        }
        await playTrack(next, 0);
    }

    async function finishBook(): Promise<void> {
        const state = get(store);
        setPosition(state.durationMs);
        store.update((s) => ({ ...s, isPlaying: false }));
        updateMediaSessionPlaybackState('paused');
        sendHeartbeat();
        // Same reasoning as pause(): a book left open at the end is idle, not
        // playing, and must not keep pinging every 10 s forever.
        stopHeartbeat();
        // Forces past the reporting INTERVAL but not past the dwell gate.
        //
        // "Reached the end" and "mis-tapped near the end and let the tail play
        // out" are indistinguishable here — the lock-screen scrubber is
        // whole-book, so a far-right mis-tap lands seconds from the end. Zeroing
        // the dwell would let one such tap stamp `isFinished` on a 40-hour book
        // in a history-less upstream row.
        //
        // Nothing is lost by respecting it: actual playback DRAINS the dwell, so
        // finishing a book normally (no seek) forces immediately, and finishing
        // after a seek forces as soon as ten seconds have genuinely been heard.
        flushReport({ force: true, isFinished: true });
    }

    // -- Loading ---------------------------------------------------------------

    /**
     * Never null in practice — a concurrent caller AWAITS the in-flight init
     * rather than being turned away.
     *
     * It used to return null while another init was running, which stranded both
     * taps: the second load bailed with no error set (so its caller could only
     * toast a generic message), and its generation bump then made the FIRST load
     * discard its own payload too. Two taps, nothing playing.
     */
    async function ensureBackend(): Promise<AudioBackend | null> {
        if (backend) return backend;
        if (backendInit) return backendInit;
        backendInit = (async () => {
            backend = await createAudiobookBackend();
            const initialVolumeState = get(store);
            store.update((s) => ({
                ...s,
                supportsVolumeControl: backend?.supportsVolumeControl ?? true,
            }));
            backend.init(
                {
                    onTrackEnded: () => void orFailPlayback(onTrackEnded),
                    onPlaybackError: (err) => handlePlaybackError(err),
                    onTimeUpdate: (info) => handleTimeUpdate(info),
                    onGaplessAdvanceCommitted: (info) => onAdvanceCommitted(info),
                },
                {
                    onPlay: () => void resume(),
                    onPause: () => pause(),
                    onNextTrack: () => void skipChapter(1),
                    onPreviousTrack: () => void skipChapter(-1),
                    onSeekTo: (seconds) => void seekTo(seconds * 1000, { source: 'seek' }),
                    onSeekForward: (offset) =>
                        void skipBy(offset ? offset * 1000 : SKIP_FORWARD_MS),
                    onSeekBackward: (offset) =>
                        void skipBy(-(offset ? offset * 1000 : SKIP_BACK_MS)),
                    onStop: () => void stop(),
                },
                // The store owns the lock screen; see registerMediaSession().
                { manageMediaSession: false },
            );
            // Applied AFTER init(): both WebAudioBackend and SafariAudioBackend
            // create their decks (and, for WebAudioBackend, hardcode gain to 1)
            // inside init() — a setVolume()/mute() call before that either hits
            // no deck yet or gets clobbered by init()'s own reset a moment later.
            // Mirrors the ordering fix already applied to toggleMute() in
            // 713b92126 — setVolume(0) is a no-op on PlainAudioBackend (iOS), so
            // the muted case must go through mute() instead.
            backend.setVolume(initialVolumeState.volume);
            if (initialVolumeState.isMuted) backend.mute();

            unregisterParticipant?.();
            unregisterParticipant = registerAudioParticipant(
                'audiobook',
                () => {
                    void stop();
                },
                {
                    // Music or another book started in another tab: pause here
                    // (heartbeat + progress flush included), keep the place.
                    pauseForOtherTab: () => {
                        otherTabClaimEpoch++;
                        if (get(store).isPlaying) pause();
                    },
                },
            );
            cleanupFlushHandlers?.();
            cleanupFlushHandlers = registerFlushHandlers();
            return backend;
        })();
        try {
            return await backendInit;
        } finally {
            // Cleared either way: a failed init must not be cached as a
            // permanently-pending promise that every later load awaits forever.
            backendInit = null;
        }
    }

    /**
     * Chrome throttles background timers, so a fixed reporting interval becomes
     * unreliable exactly when a phone-in-pocket listen needs it. Flushing on
     * these two events is what makes a backgrounded or closed tab land its last
     * position instead of losing up to a reporting interval of progress.
     *
     * Leaving is a checkpoint, including a seek with no newly heard audio.
     */
    function registerFlushHandlers(): () => void {
        if (typeof document === 'undefined') return () => {};
        const onHide = (): void => {
            flushReport({ force: true, checkpoint: true });
        };
        const onVisibility = (): void => {
            if (document.visibilityState === 'hidden') {
                onHide();
                return;
            }
            // Android's shadow-audio path cancels any armed advance when the
            // tab is hidden (a single element has no B deck). Re-arming on the
            // way back means only the boundary that fell inside the background
            // window degrades to a cold start, rather than every boundary until
            // the next seek or rate change.
            scheduleAdvance();
            // Coming back to a paused deck is the one moment it can discover it
            // has been replaced: the periodic ping is stopped while paused (it
            // is what used to squat on the stream slot), so nothing else asks.
            // It is also exactly when a stale player would be looked at. The
            // ping does not extend the server's paused grace — `paused_at` is
            // stamped once and never refreshed — so this cannot resurrect the
            // slot-squatting it replaced.
            if (session !== null && !get(store).isPlaying) sendHeartbeat();
        };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pagehide', onHide);
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('pagehide', onHide);
        };
    }

    function handleTimeUpdate(info: TimeUpdateInfo): void {
        const state = get(store);
        if (!state.timeline) return;
        const bookMs = fileBaseMs + info.currentTimeMs;
        const chapterBefore = state.currentChapter?.index ?? null;
        setPosition(bookMs);
        // A single-file book with real chapters crosses chapter boundaries
        // without any load, so nothing else would refresh the lock-screen label.
        if ((get(store).currentChapter?.index ?? null) !== chapterBefore) {
            registerMediaSession();
        }
        accumulateListening(bookMs, info.playbackRate || 1);
        if (dwellRemainingMs === 0) lastTrustedBookMs = bookMs;
        flushReport();
        syncMediaSessionPosition();
    }

    function getProbeElement(): HTMLAudioElement | null {
        if (typeof document === 'undefined') return null;
        probeElement ??= document.createElement('audio');
        return probeElement;
    }

    /**
     * Does this file have to go through the server-side remux on THIS engine?
     *
     * Asked per track rather than once per session: a book may mix codecs, and the
     * probe element only exists in a browser.
     */
    function useRemuxFor(track: AudiobookTrack): boolean {
        // The server decides: it only attaches `remuxUrl` to a file whose persisted codec
        // needs one, and `needsRemux` / the codec say the same on an older payload.
        return !!track.remuxUrl && (!!track.needsRemux || audiobookCodecNeedsRemux(track.codec));
    }

    function deliveryTrackUrl(track: AudiobookTrack, startMs: number): string {
        const href = useRemuxFor(track) ? track.remuxUrl : track.url;
        if (!href) throw new Error('Audiobook track delivery unavailable');
        return useRemuxFor(track) ? audiobookSeekUrl(href, startMs) : href;
    }

    /** Point the backend at one file, starting at `fileMs` inside it. */
    async function playTrack(track: AudiobookTrack, fileMs: number): Promise<void> {
        const b = backend;
        const state = get(store);
        if (!b || !session) return;
        // Only the direct path addresses files, and only files have inodes.
        // Reaching here with a null one would mean the transcode path routed
        // into the file player.
        if (!track.url) return;

        const remux = deliveryTrackUrl(track, 0).includes('/remux/');
        currentTrack = track;
        // ── The remux base is NOT the file's start ────────────────────────────
        // A remux stream begins AT the requested offset — the server ran ffmpeg
        // with `-ss`, so element time 0 is `fileMs` into the file. Leaving
        // fileBaseMs at the file's own start would under-report the listener's
        // position by exactly the seek offset, and the dwell gate would then
        // push that wrong position into AudiobookShelf's last-write-wins
        // progress row.
        fileBaseMs = remux ? track.startOffsetMs + fileMs : track.startOffsetMs;
        lastTickBookMs = null;

        await b.play(
            deliveryTrackUrl(track, fileMs),
            { title: state.book?.title ?? '', artist: state.book?.author },
            {
                // A piped encode answers no Range, so there is nothing to seek
                // within: the offset was already spent on the URL.
                startAtMs: remux ? 0 : fileMs,
                playbackRate: state.playbackRate,
                preservePitch: true,
            },
        );

        store.update((s) => ({ ...s, isPlaying: true }));
        updateMediaSessionPlaybackState('playing');
        setPosition(track.startOffsetMs + fileMs);
        registerMediaSession();
        scheduleAdvance();
        sendHeartbeat();
        yieldIfClaimedElsewhere();
    }

    /**
     * Point the backend at the HLS playlist of the current transcode session.
     *
     * **`fileBaseMs` is 0 here, and that is a measurement, not an assumption.**
     * A transcode session's playlist spans the WHOLE book: one track with
     * `startOffset: 0` and the book's full duration, 4355 segments summing to
     * 26128 s for a 7.25-hour book — identical whether the session's own
     * `startTime` was 0 or 7200 (measured against the live server 2026-07-29).
     * So the element's clock IS book time and there is no per-session offset to
     * add. Treating `startPositionMs` as a base instead — which an earlier
     * revision did — double-counts the resume position at every tick.
     *
     * The resume position is therefore an ordinary element seek, expressed in
     * book time like every other position in this store.
     */
    async function playTranscode(startAtBookMs?: number): Promise<void> {
        const b = backend;
        const state = get(store);
        if (!b || !session || !state.timeline) return;

        currentTrack = state.timeline.tracks[0] ?? null;
        fileBaseMs = 0;
        lastTickBookMs = null;

        const startMs = startAtBookMs ?? state.bookPositionMs ?? session.startPositionMs;

        await b.play(
            session.start.delivery.kind === 'multipart-audio'
                ? (session.start.delivery.tracks.find(
                      (track) => track.mime === 'application/vnd.apple.mpegurl',
                  )?.url ?? '')
                : '',
            { title: state.book?.title ?? '', artist: state.book?.author },
            { startAtMs: startMs, playbackRate: state.playbackRate, preservePitch: true },
        );

        store.update((s) => ({ ...s, isPlaying: true }));
        updateMediaSessionPlaybackState('playing');
        setPosition(startMs);
        registerMediaSession();
        sendHeartbeat();
        yieldIfClaimedElsewhere();
    }

    /**
     * Another tab claimed audio while this book was still loading. It was not
     * playing yet, so that claim could not pause it — pause now that it is, or
     * the book and the other tab's audio play together.
     */
    function yieldIfClaimedElsewhere(): void {
        if (otherTabClaimEpoch !== ownClaimEpoch) pause();
    }

    /**
     * `positionMs` is OMITTED, not zero, when the caller has no opinion.
     *
     * Zero would be an instruction to start at the beginning of the book. The
     * server distinguishes the two: absent means "answer with AudiobookShelf's
     * own saved progress", which is what a resume wants.
     */
    async function openSessionAt(
        mediaId: string,
        positionMs: number | undefined,
        forceTranscode: boolean,
    ): Promise<AudiobookSessionPayload | null> {
        if (!deps) return null;
        const el = getProbeElement();
        return deps.openSession({
            mediaId,
            ...(positionMs === undefined
                ? {}
                : { positionMs: Math.max(0, Math.round(positionMs)) }),
            deviceId,
            supportedMimeTypes: el ? detectSupportedMimeTypes(el) : ['audio/mpeg', 'audio/mp4'],
            requestedMethod: forceTranscode ? 'full_transcode' : undefined,
        });
    }

    function setSessionPayload(payload: AudiobookSessionPayload): void {
        session = payload;
        stopGrantRenewal?.();
        stopGrantRenewal = maintainPlaybackGrant(payload.start, async () => {
            const state = get(store);
            if (session !== payload) return;
            if (!state.isPlaying) {
                grantReloadPending = true;
                return;
            }
            if (state.playMethod === 'transcode') await playTranscode(state.bookPositionMs);
            else if (currentTrack)
                await playTrack(currentTrack, state.bookPositionMs - currentTrack.startOffsetMs);
        });
    }

    function adoptSession(payload: AudiobookSessionPayload): AudiobookTimeline {
        setSessionPayload(payload);
        lastTrustedBookMs = payload.startPositionMs;
        const timeline = buildPlaybackAudiobookTimeline(payload.tracks, payload.chapters, {
            synthesizeChapterTitle: synthesizeChapterTitle ?? undefined,
            untaggedTailTitle: untaggedTailTitle ?? undefined,
            totalDurationMs: payload.durationMs,
        });
        store.update((s) =>
            applyPosition(
                {
                    ...s,
                    mediaId: payload.mediaId,
                    book: payload.book,
                    timeline,
                    playMethod: payload.playMethod,
                    playbackSessionId: payload.playbackSessionId,
                    durationMs: timeline.durationMs,
                    error: null,
                },
                payload.startPositionMs,
            ),
        );
        return timeline;
    }

    let synthesizeChapterTitle: ((n: number, track: AudiobookTrack) => string) | null = null;
    let untaggedTailTitle: string | null = null;

    // -- Public API ------------------------------------------------------------

    /**
     * Wire the transport. Must be called before {@link load}.
     *
     * Injected rather than imported so the store can be exercised without a
     * server, and so the session lifecycle stays server-owned — the per-user
     * ABS key must never reach the browser.
     */
    function configure(options: {
        deps: AudiobookPlayerDeps;
        deviceId?: string;
        /** Localised label for a synthesised chapter, e.g. `(n) => 'Teil ' + n`. */
        synthesizeChapterTitle?: (partNumber: number, track: AudiobookTrack) => string;
        /**
         * Localised label for the stretch of book past the end of ABS's chapter
         * list. Set here rather than substituted at render time because this
         * title also reaches the lock screen (`MediaMetadata.album`) and the
         * mini player, neither of which goes through the chapter sheet.
         */
        untaggedTailTitle?: string;
    }): void {
        deps = options.deps;
        if (options.deviceId) deviceId = options.deviceId;
        synthesizeChapterTitle = options.synthesizeChapterTitle ?? null;
        untaggedTailTitle = options.untaggedTailTitle ?? null;
    }

    /**
     * Monotonic load id.
     *
     * `load()` awaits a network round trip while `session` / `currentTrack` are
     * plain closure variables. Two overlapping loads — closing one book's modal
     * while its open is in flight and starting another — would otherwise both
     * see `session === null` at the top, skip closing anything, and then race:
     * the later `adoptSession` wins the state while the earlier call goes on to
     * `playTrack` with the OTHER book's stream token, and one committed ABS
     * session is orphaned. Every await in `load()` is followed by a staleness
     * check against this.
     */
    let loadGeneration = 0;
    /** Latest {@link orFailPlayback} call; see there. */
    let playAttempt = 0;

    function wait(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Tell the server to close an ABS session WITHOUT touching local state.
     *
     * Needed on every give-up path after `openSession` has resolved: by then the
     * `play_sessions` row is committed (that ordering is the whole point of the
     * contract), so an early return that just forgets the payload leaves the
     * byte proxy honouring a session nobody is playing until a reaper notices.
     */
    function discardSession(payload: AudiobookSessionPayload): void {
        void deps
            ?.closeSession({
                mediaId: payload.mediaId,
                playbackSessionId: payload.playbackSessionId,
                bookPositionMs: Math.round(payload.startPositionMs),
                listenedMs: 0,
                isFinished: false,
            })
            .catch((err) => {
                console.warn('[AudiobookPlayer] discardSession failed', err);
            });
    }

    /**
     * Open a book and begin playing. Resolves false when nothing is playing.
     *
     * The boolean is load-bearing for the caller, not a convenience: on failure
     * `book` stays null, and BOTH player surfaces are gated on `book !== null`,
     * so `state.error` has nowhere to render. A caller that ignored the result
     * would close its modal and leave the listener with no player and no
     * message — the failure would be completely silent.
     *
     * Must be called from a user gesture: WebKit refuses both `play()` and
     * `AudioContext` without a trusted one (measured), so a resume-after-
     * navigation that skips the gesture silently produces nothing.
     */
    async function load(
        mediaId: string,
        options: {
            autoplay?: boolean;
            /**
             * Start HERE rather than where the listener left off.
             *
             * Omitted means "resume", which is the normal case and is what the
             * server answers with AudiobookShelf's own saved progress. A 0 here
             * genuinely means the start of the book.
             */
            positionMs?: number;
        } = {},
    ): Promise<boolean> {
        if (!deps) {
            store.update((s) => ({
                ...s,
                error: { kind: 'session_failed', message: 'Player transport not configured' },
            }));
            return false;
        }

        const generation = ++loadGeneration;
        stopHeartbeat();

        // Switching books directly leaves the previous ABS session and its
        // ACTIVE `play_sessions` row open — which the byte proxy keeps honouring
        // until a reaper notices — and carries the previous book's unreported
        // listening time into the new book's first report.
        if (session !== null) closeCurrentSession();
        const previousClose = pendingSessionClose ?? Promise.resolve();

        store.update((s) => ({ ...s, isLoading: true, error: null }));
        // Backend FIRST, because ensureBackend() is what registers this store
        // with the arbiter. Claiming before it resolves leaves a window where
        // the audiobook owns audio with no stop handler attached — music
        // claiming in that window would find nothing to stop, and both would
        // end up playing.
        const [b] = await Promise.all([ensureBackend(), previousClose]);
        if (!b) {
            // A concurrent load() is still initialising the backend. Clear the
            // spinner rather than leaving it up until that other call finishes.
            store.update((s) => ({ ...s, isLoading: false }));
            return false;
        }
        if (generation !== loadGeneration) return false;
        claimAudio('audiobook');
        ownClaimEpoch = otherTabClaimEpoch;

        try {
            let payload: AudiobookSessionPayload | null = null;
            for (let attempt = 1; ; attempt++) {
                try {
                    payload = await openSessionAt(mediaId, options.positionMs, false);
                    break;
                } catch (err) {
                    if (
                        attempt >= MAX_SESSION_OPEN_ATTEMPTS ||
                        describeAudiobookSessionRefusal(err)?.permanent
                    ) {
                        throw err;
                    }
                    console.warn(
                        `[AudiobookPlayer] session open attempt ${attempt} failed, retrying`,
                        err,
                    );
                    await wait(SESSION_OPEN_RETRY_DELAY_MS);
                    if (generation !== loadGeneration) return false;
                }
            }
            if (!payload) throw new Error('no session payload');
            if (generation !== loadGeneration) {
                discardSession(payload);
                return false;
            }
            const timeline = adoptSession(payload);

            const el = getProbeElement();
            // ── No second session for an undecodable codec ────────────────────
            // This used to re-open the session with `forceTranscode`, which got
            // an ABS HLS playlist — and then died in the block below on every
            // engine but Safari, because nothing here plays HLS. The files are
            // now served through `…/remux/{ino}`, decided per track in
            // `playTrack`, so the direct session that is already open stays open.
            // Nothing is discarded, nothing is re-negotiated, and Chromium plays
            // the book (measured: the remuxed stream decodes, the original does
            // not).

            if (payload.playMethod === 'transcode' && el && !supportsNativeHls(el)) {
                // An actionable error beats a silently dead <audio> element —
                // and the session must not be left open for a book this engine
                // is never going to play.
                discardSession(payload);
                resetSessionBookkeeping();
                store.set({
                    ...INITIAL_STATE,
                    playbackRate: get(store).playbackRate,
                    volume: get(store).volume,
                    isMuted: get(store).isMuted,
                    supportsVolumeControl: get(store).supportsVolumeControl,
                    error: {
                        kind: 'transcode_unsupported',
                        message:
                            "This book's format needs transcoding, which this browser cannot play yet.",
                    },
                });
                releaseAudio('audiobook');
                reportUserFacingFailure({ key: 'audiobook_transcode_unsupported' });
                return false;
            }

            startHeartbeat();
            store.update((s) => ({ ...s, isLoading: false }));

            if (options.autoplay === false) {
                registerMediaSession();
                return true;
            }

            if (payload.playMethod === 'transcode') {
                await playTranscode(payload.startPositionMs);
            } else {
                const pos = resolveFilePosition(timeline, payload.startPositionMs);
                if (!pos) throw new Error('book has no playable files');
                await playTrack(pos.track, pos.fileMs);
            }
            return generation === loadGeneration;
        } catch (err) {
            console.error('[AudiobookPlayer] load failed', err);
            // EVERYTHING here is generation-gated, not just the close.
            //
            // A superseded load fails routinely — a second `play()` interrupts
            // the first and the first's promise rejects with AbortError. Wiping
            // the store and releasing the audio claim unconditionally would
            // therefore tear down the NEWER load that is already playing: the
            // mini player unmounts over live audio, and the arbiter forgets who
            // owns the output.
            if (generation !== loadGeneration) return false;
            // The caller shows `error.message` (untagged); this is the tagged
            // report with the error behind it, e.g. "Jump back in" failing.
            reportUserFacingFailure({ key: 'audiobook_session_failed', error: err });
            // Whatever was adopted before the throw is not playable; close it
            // rather than leaving the byte proxy serving it.
            stopHeartbeat();
            if (session !== null) void closeCurrentSession();
            store.set({
                ...INITIAL_STATE,
                playbackRate: get(store).playbackRate,
                volume: get(store).volume,
                isMuted: get(store).isMuted,
                supportsVolumeControl: get(store).supportsVolumeControl,
                error: {
                    kind: 'session_failed',
                    message:
                        describeAudiobookSessionRefusal(err)?.message ??
                        (err instanceof Error ? err.message : 'Could not start this book'),
                },
            });
            releaseAudio('audiobook');
            return false;
        }
    }

    function pause(): void {
        backend?.pause();
        pausedAt = Date.now();
        store.update((s) => ({ ...s, isPlaying: false }));
        updateMediaSessionPlaybackState('paused');
        // Put liveness first: this makes Active Streams show PAUSED immediately.
        // The serialized progress report then lands last upstream with the newer
        // position, so the heartbeat cannot move AudiobookShelf backwards.
        sendHeartbeat();
        // Pause saves the position shown by the player, including a fresh seek.
        flushReport({ force: true, checkpoint: true });
        // Stop the periodic ping AFTER the one above has gone out. Left
        // running, it fires every 10 s regardless of play state and keeps
        // last_seen_at fresh forever — exactly what let a tab paused overnight
        // squat on the listener's concurrent-stream slot indefinitely (the
        // server now reaps a paused-and-abandoned session from paused_at, which
        // this stops refreshing; see staleSessionCondition). resume() restarts
        // it, and the immediate heartbeat it sends is what surfaces a session
        // the server reaped while paused — that heartbeat 404s, the transport
        // maps it to `sessionLost: true`, and recoverLostSession() reopens one
        // at the current position. Nothing is lost by not pinging while idle.
        stopHeartbeat();
    }

    /**
     * Press play on a tab that has been paused for {@link STALE_PAUSE_MS} and
     * this runs first: reopen the book from the server rather than from this
     * deck's memory.
     *
     * Two things are wrong with the deck by then. Its position is however old
     * the pause is — the listener may well have finished a chapter on their
     * phone since — and its SESSION is gone, reaped at the same 30-minute mark,
     * so the row `authenticateAudiobookStream` checks no longer exists and the
     * next range request 404s mid-file. `load()` fixes both: it closes what is
     * left (asserting no position, because nothing has been heard — see
     * `closeAudiobookSession`), opens a new session, and adopts the
     * `startPositionMs` the server answers from AudiobookShelf's saved progress.
     *
     * Not a blind adopt, though. If a report of ours never landed, the server is
     * BEHIND us and that listening exists nowhere else — so a position this tab
     * remembers from further along wins, which is the same rule the iOS player
     * applies to its own offline record. The case it gets wrong is a deliberate
     * rewind on the other device, which this tab would override; that is the
     * cheaper mistake, and it is what happened before this existed anyway.
     */
    async function reanchorFromServer(): Promise<void> {
        const { mediaId, bookPositionMs } = get(store);
        if (!deps || !mediaId) return;
        // Preserve positions accepted by dwell or a pause checkpoint. A seek
        // made while already paused is still pending until its own checkpoint.
        const remembered = dwellRemainingMs > 0 ? lastTrustedBookMs : bookPositionMs;
        // load() owns its own failure: it surfaces a session error into the
        // state both player surfaces render. Falling back to resuming the dead
        // deck would be silence with no explanation.
        if (!(await load(mediaId, { autoplay: true }))) return;
        if (remembered > get(store).bookPositionMs + REANCHOR_TOLERANCE_MS) {
            // 'internal': the position is the server's own answer or this tab's
            // own trusted one, so there is nothing for the dwell gate to
            // withhold and nothing for the listener to undo.
            await seekTo(remembered, { source: 'internal' });
        }
    }

    async function resume(): Promise<void> {
        claimAudio('audiobook');
        ownClaimEpoch = otherTabClaimEpoch;

        const pausedForMs = pausedAt === null ? 0 : Date.now() - pausedAt;
        pausedAt = null;
        if (pausedForMs >= STALE_PAUSE_MS && get(store).mediaId) {
            await reanchorFromServer();
            return;
        }

        const state = get(store);
        // `load(…, { autoplay: false })` adopts a session and registers the lock
        // screen without putting a source on the backend — which is the whole
        // point of that flow, and also means `resume()` is the FIRST thing that
        // has to load one. Calling backend.resume() on an empty deck reports
        // "playing" over silence.
        if (state.timeline && (currentTrack === null || grantReloadPending) && session !== null) {
            grantReloadPending = false;
            const timeline = state.timeline;
            await orFailPlayback(async () => {
                if (state.playMethod === 'transcode') {
                    await playTranscode();
                } else {
                    const pos = resolveFilePosition(timeline, state.bookPositionMs);
                    if (pos) await playTrack(pos.track, pos.fileMs);
                }
            });
            return;
        }

        backend?.resume();
        store.update((s) => ({ ...s, isPlaying: true }));
        updateMediaSessionPlaybackState('playing');
        // Every other playback mutator (playTrack, onAdvanceCommitted, the
        // chapter-change branch of handleTimeUpdate) redeclares the full
        // MediaMetadata — this was the one path that only touched
        // playbackState. Safari's macOS Now Playing widget has been observed
        // to drop artwork across a playback-state transition when metadata
        // isn't freshly declared at that transition; title/artist keep
        // showing regardless since they don't depend on it.
        registerMediaSession();
        lastTickBookMs = null;
        lastTickAt = null;
        scheduleAdvance();
        startHeartbeat();
        sendHeartbeat();
    }

    /**
     * Run something that starts a source, and stop with an error if the source
     * fails.
     *
     * For every such path EXCEPT `load()`, whose own catch reports the failure
     * to its caller (who toasts it). Here nobody is waiting: the file boundary,
     * a resume and a restart-on-seek are all fired from buttons, the lock screen
     * or a backend callback, and a rejection would otherwise be unhandled over a
     * player still saying "playing".
     *
     * Gated twice. By generation, like `load()`'s catch: a play started for a
     * book the listener has since replaced must not tear the newer one down
     * when it fails late. And by attempt: two quick scrubs across files are two
     * restart-on-seeks in ONE generation, and the first failing after the
     * second already plays is not the current source failing.
     */
    async function orFailPlayback(start: () => Promise<void>): Promise<void> {
        const generation = loadGeneration;
        const attempt = ++playAttempt;
        try {
            await start();
        } catch (err) {
            if (generation !== loadGeneration || attempt !== playAttempt) return;
            failPlayback(err);
        }
    }

    /**
     * The current source failed after `play()` returned: a mid-stream network
     * drop or decode error. A failure while `play()` is pending rejects that
     * call instead, and reaches {@link orFailPlayback} or `load()`'s catch.
     */
    function handlePlaybackError(err: unknown): void {
        if (session === null || currentTrack === null) return;
        failPlayback(err);
    }

    /**
     * Stop, and say why. No skip to the next file and no retry, matching the
     * music player and iOS.
     *
     * `stop()` closes the session at the position reached, which is right: the
     * book did play up to there. The toast is what the listener actually sees —
     * with `book` null both player surfaces unmount, so `state.error` has
     * nowhere to render.
     */
    function failPlayback(err: unknown): void {
        console.error('[AudiobookPlayer] playback failed', err);
        void stop();
        const message = m.audiobook_playback_failed();
        store.update((s) => ({ ...s, error: { kind: 'playback_failed', message } }));
        toasts.error(message, { diagnosticKey: 'audiobook_playback_failed', diagnosticError: err });
    }

    async function stop(): Promise<void> {
        // Invalidate any in-flight load(). Without this, a load awaiting
        // openSession survives the stop — including the stop the audio arbiter
        // triggers when music starts — and then adopts its session and calls
        // play(), leaving book and music both audible while the arbiter believes
        // music owns the output.
        loadGeneration++;
        stopHeartbeat();
        backend?.stop();
        releaseAudio('audiobook');
        clearMediaSession();
        const close = closeCurrentSession();
        store.set({
            ...INITIAL_STATE,
            playbackRate: get(store).playbackRate,
            volume: get(store).volume,
            isMuted: get(store).isMuted,
            supportsVolumeControl: get(store).supportsVolumeControl,
        });
        await close;
    }

    /** Close with the current position, including a seek still inside dwell. */
    function closeCurrentSession(): Promise<void> {
        const report = buildReport(false);
        const transport = deps;
        const close =
            report && transport
                ? enqueueSessionMutation('closeSession', async () => {
                      // The ack is ignored on purpose: this session is being
                      // abandoned, so "already gone" is not actionable.
                      await transport.closeSession(report);
                  })
                : null;
        resetSessionBookkeeping();
        if (!close) return pendingSessionClose ?? Promise.resolve();
        const tracked = close.finally(() => {
            if (pendingSessionClose === tracked) pendingSessionClose = null;
        });
        pendingSessionClose = tracked;
        return tracked;
    }

    /**
     * Drop everything scoped to one book.
     *
     * Shared by stop() and destroy(): a destroy() that skipped this would carry
     * one book's unreported listening time and dwell window into the next one.
     */
    function resetSessionBookkeeping(): void {
        grantReloadPending = false;
        stopGrantRenewal?.();
        stopGrantRenewal = undefined;
        session = null;
        pausedAt = null;
        currentTrack = null;
        fileBaseMs = 0;
        lastTickBookMs = null;
        lastTickAt = null;
        lastTrustedBookMs = 0;
        unreportedListenedMs = 0;
        unreportedSeek = false;
        dwellRemainingMs = 0;
        lastReportAt = 0;
    }

    /**
     * Move to an absolute book position.
     *
     * `source` distinguishes a listener-driven jump (which arms the accidental-
     * seek protections) from an internal correction (which must not).
     */
    async function seekTo(
        bookMs: number,
        options: { source?: 'seek' | 'internal' | 'undo' } = {},
    ): Promise<void> {
        const state = get(store);
        const timeline = state.timeline;
        if (!timeline || !backend || !session) return;

        const from = state.bookPositionMs;
        const target = clampBookMs(timeline, bookMs);
        const source = options.source ?? 'seek';
        if (target !== from) unreportedSeek = true;

        if (source === 'seek') {
            armSeekProtection(from, target, timeline);
        } else if (source === 'undo') {
            // Undo restores a position that was never pushed, so nothing needs
            // withholding — and re-arming the gate would delay the correction.
            dwellRemainingMs = 0;
            store.update((s) => ({ ...s, isDwelling: false, pendingUndo: null }));
        }

        lastTickBookMs = null;

        if (state.playMethod === 'transcode') {
            await seekTranscode(target);
            return;
        }

        const pos = resolveFilePosition(timeline, target);
        if (!pos) return;

        if (currentTrack && pos.track.index === currentTrack.index && !useRemuxFor(pos.track)) {
            // Same file: a byte-range seek. The backend cancels any scheduled
            // advance itself, because the boundary it was armed against moved.
            backend.seekTo(pos.fileMs);
            setPosition(target);
            scheduleAdvance();
        } else {
            // RESTART-ON-SEEK. A remuxed file is a piped ffmpeg with no
            // byte↔time map, so `Accept-Ranges: none` is the truth and an element
            // seek would either do nothing or wedge the element at 0. Moving
            // inside such a file is a new request at a new `?startPositionSeconds=`, which is what
            // re-issuing playTrack does. Measured cost: ~1.7 s to first audio.
            await orFailPlayback(() => playTrack(pos.track, pos.fileMs));
        }
        syncMediaSessionPosition();
    }

    /**
     * Seeking a transcoded book is an ordinary element seek in book time.
     *
     * An earlier revision restarted the ABS session at the target offset for a
     * far-forward scrub. That is measurably inert: re-opening a session does
     * NOT change the playlist (still `startOffset: 0`, still the whole book),
     * and ABS derives a session's `startTime` from the listener's saved
     * progress and ignores a requested one — so the "new session at that
     * offset" the design called for does not exist as an operation. What
     * actually moves the encoder is requesting the segment, which is what
     * seeking the element does.
     *
     * What remains true is that a listed segment may not exist yet:
     * `output-0.ts` appeared ~1.5 s after session creation and the encoder then
     * walked forward at roughly 700 segments/second on a copy-remuxable book.
     * **A 404 on a listed segment means "not yet", never "gone"** — the proxy
     * passes those through deliberately and the player must not treat one as
     * fatal, or it aborts on the entirely normal first second of every
     * transcode session.
     */
    async function seekTranscode(target: number): Promise<void> {
        backend?.seekTo(target);
        setPosition(target);
    }

    /**
     * Layers 1 and 2 of the accidental-seek protection.
     *
     * Layer 3 — recovery beyond the toast — needs no client code: the local
     * `user_media_events` log is append-only, so yesterday's position is still
     * recoverable from it. That is a property Lumastra has and AudiobookShelf,
     * whose progress row is last-write-wins with no history, does not.
     */
    function armSeekProtection(from: number, to: number, timeline: AudiobookTimeline): void {
        // Keep the accepted anchor through repeated seeks until playback or
        // a pause/leave checkpoint accepts the final landing position.
        if (dwellRemainingMs === 0) lastTrustedBookMs = from;
        dwellRemainingMs = SEEK_DWELL_MS;

        const distance = Math.abs(to - from);
        const fromChapter = findChapterAt(timeline, from);
        const backwardsPastChapter = to < (fromChapter?.startMs ?? 0);
        const notable = distance > UNDO_SEEK_THRESHOLD_MS || backwardsPastChapter;

        store.update((s) => ({
            ...s,
            isDwelling: true,
            // A transient affordance, not a confirm dialog: those get
            // muscle-memoried away, and then protect nothing.
            pendingUndo: notable ? { fromMs: from, toMs: to } : null,
        }));
    }

    /** Take back the last notable seek. */
    async function undoSeek(): Promise<void> {
        const pending = get(store).pendingUndo;
        if (!pending) return;
        await seekTo(pending.fromMs, { source: 'undo' });
    }

    function dismissUndo(): void {
        store.update((s) => ({ ...s, pendingUndo: null }));
    }

    /** Relative skip — the ±30s buttons and their lock-screen equivalents. */
    async function skipBy(deltaMs: number): Promise<void> {
        const state = get(store);
        if (!state.timeline) return;
        await seekTo(state.bookPositionMs + deltaMs, { source: 'seek' });
    }

    /** Chapter navigation. Returns false at the end of the book. */
    async function skipChapter(direction: 1 | -1): Promise<boolean> {
        const state = get(store);
        if (!state.timeline) return false;
        const target = seekChapterTarget(state.timeline, state.bookPositionMs, direction);
        if (target === null) return false;
        await seekTo(target, { source: 'seek' });
        return true;
    }

    async function seekToChapter(index: number): Promise<void> {
        const state = get(store);
        const chapter = state.timeline?.chapters[index];
        if (!chapter) return;
        await seekTo(chapter.startMs, { source: 'seek' });
    }

    /**
     * Playback speed, 0.5–3×.
     *
     * Pitch preservation is stated explicitly because the interface's other
     * caller — BPM matching — wants the opposite, and an inherited default is
     * chipmunks at 2×.
     */
    function setPlaybackRate(rate: number): void {
        const clamped = Math.min(3, Math.max(0.5, rate));
        store.update((s) => ({ ...s, playbackRate: clamped }));
        backend?.setPlaybackRate(clamped, { preservePitch: true });
        // A scheduled advance carries the OLD rate in its request and its arm
        // point was computed from the old wall-clock remaining. Re-scheduling
        // is cheaper than trying to patch it.
        scheduleAdvance();
        syncMediaSessionPosition();
    }

    /**
     * Volume, 0-1. No LUFS/loudness normalization — unlike the music player,
     * audiobooks have no per-track loudness data to correct for.
     */
    function setVolume(vol: number): void {
        const clamped = Math.max(0, Math.min(1, vol));
        store.update((s) => ({ ...s, volume: clamped, isMuted: clamped === 0 }));
        backend?.setVolume(clamped);
        saveAudiobookVolume({ volume: clamped, isMuted: clamped === 0 });
    }

    function toggleMute(): void {
        const state = get(store);
        if (state.isMuted) {
            const restoreVolume = state.volume > 0 ? state.volume : 1;
            store.update((s) => ({ ...s, isMuted: false, volume: restoreVolume }));
            backend?.unmute(restoreVolume);
            saveAudiobookVolume({ volume: restoreVolume, isMuted: false });
        } else {
            store.update((s) => ({ ...s, isMuted: true }));
            backend?.mute();
            saveAudiobookVolume({ volume: state.volume, isMuted: true });
        }
    }

    function destroy(): void {
        // Same reason as stop(): a load resolving after teardown would re-register
        // handlers on a destroyed backend.
        loadGeneration++;
        stopHeartbeat();
        cleanupFlushHandlers?.();
        cleanupFlushHandlers = null;
        unregisterParticipant?.();
        unregisterParticipant = null;
        releaseAudio('audiobook');
        backend?.destroy();
        backend = null;
        resetSessionBookkeeping();
    }

    return {
        subscribe: store.subscribe,
        configure,
        load,
        pause,
        resume,
        stop,
        seekTo,
        skipBy,
        skipChapter,
        seekToChapter,
        setPlaybackRate,
        setVolume,
        toggleMute,
        undoSeek,
        dismissUndo,
        destroy,
        /**
         * Test seam. Stripped from production builds, like the music store's.
         * These have no other reader — the UI renders from the store state.
         */
        ...(import.meta.env.DEV
            ? {
                  _debug: {
                      getDwellRemainingMs: () => dwellRemainingMs,
                      getCurrentTrackUrl: () => currentTrack?.url ?? null,
                      getFileBaseMs: () => fileBaseMs,
                      getUnreportedListenedMs: () => unreportedListenedMs,
                  },
              }
            : {}),
    };
}

export const audiobookPlayerStore = createAudiobookPlayerStore();

/** True when the mini-player should be mounted. */
export const isAudiobookPlayerVisible: Readable<boolean> = derived(
    audiobookPlayerStore,
    ($s) => $s.book !== null,
);
