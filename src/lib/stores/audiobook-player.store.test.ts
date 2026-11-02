// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import type { AudioBackend, AudioBackendCallbacks, GaplessAdvanceRequest } from '$lib/audio';
import { playbackStartFixture } from '$lib/utils/playback-start.fixture.js';
import liveSession from '$lib/utils/__fixtures__/audiobook-play-session.fahrenheit451.json';
import {
    audiobookSeekUrl,
    createAudiobookPlayerStore,
    SEEK_DWELL_MS,
    trackNeedsRemux,
    type AudiobookPlayerDeps,
    type AudiobookProgressAck,
    type AudiobookSessionPayload,
} from './audiobook-player.store';
import {
    AUDIO_CLAIM_CHANNEL,
    type AudioClaimMessage,
    claimAudio,
    getAudioOwner,
    registerAudioParticipant,
    resetAudioExclusivity,
} from './audio-exclusivity';
import { initMediaSession, updateMediaSessionPositionState } from '$lib/utils/media-session';
import { MediaPlaybackError } from '$lib/audio/audio-element-helpers';
import { toasts } from '$lib/stores/toast.store';
import * as m from '$lib/paraglide/messages';
import {
    buildAudiobookTimeline,
    buildPlaybackAudiobookTimeline,
} from '$lib/utils/audiobook-timeline';
import {
    annotateRemuxTracks,
    projectAbsChapters,
    projectAbsTracks,
} from '$lib/shared/audiobook-session-shape';

// Project the real ABS fixture, then model the public millisecond/URL payload.
// The store must use the returned URLs and rounded offsets, not upstream inodes
// or the sub-millisecond precision of the raw ABS fixture.
function toPlaybackTracks(
    tracks: ReturnType<typeof projectAbsTracks>,
): AudiobookSessionPayload['tracks'] {
    return tracks.map(({ ino, startOffset, duration, ...track }) => ({
        ...track,
        startMs: Math.round(startOffset * 1000),
        durationMs: duration == null ? null : Math.round(duration * 1000),
        url: ino
            ? `/api/v1/audiobooks/media-uuid/files/${track.index}?grant=stream_abc&PlaySessionId=abs-session-1`
            : '/api/v1/audiobook/media-uuid/hls/playback/abs-session-1/output.m3u8?grant=stream_abc',
        ...(ino
            ? {
                  remuxUrl: `/api/v1/audiobooks/media-uuid/remux/${track.index}?grant=stream_abc&PlaySessionId=abs-session-1`,
              }
            : {}),
    }));
}
function toPlaybackChapters(
    chapters: ReturnType<typeof projectAbsChapters>,
): AudiobookSessionPayload['chapters'] {
    return chapters.map(({ start, end, ...chapter }) => ({
        ...chapter,
        startMs: Math.round(start * 1000),
        durationMs: Math.round(((end ?? start) - start) * 1000),
    }));
}

const FIXTURE_TRACKS = projectAbsTracks(liveSession.audioTracks);
// The duration is passed for the same reason the endpoint passes it: the
// projection normalises the spans against the book's length.
const FIXTURE_CHAPTERS = projectAbsChapters(liveSession.chapters, liveSession.duration * 1000);

const reportUserFacingFailure = vi.hoisted(() => vi.fn());
vi.mock('$lib/client-diagnostics/web-reporter', () => ({ reportUserFacingFailure }));

vi.mock('$lib/utils/media-session', () => ({
    initMediaSession: vi.fn(),
    updateMediaSessionMetadata: vi.fn(),
    updateMediaSessionPlaybackState: vi.fn(),
    updateMediaSessionPositionState: vi.fn(),
    clearMediaSession: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface MockBackend extends AudioBackend {
    callbacks: AudioBackendCallbacks;
    lastPlay: { src: string; startAtMs?: number; playbackRate?: number } | null;
    lastAdvance: GaplessAdvanceRequest | null;
    seeks: number[];
    volumeCalls: number[];
    muteCalls: Array<{ type: 'mute' } | { type: 'unmute'; restoreVolume: number }>;
    supportsVolumeControl: boolean;
    rates: Array<{ rate: number; preservePitch: boolean }>;
    /** Drive the store's clock: position within the CURRENT file, ms. */
    tick(fileMs: number, rate?: number): void;
}

let mockBackend: MockBackend;

function makeMockBackend(supportsGapless: boolean): MockBackend {
    const noop = (): void => {};
    const backend = {
        callbacks: {} as AudioBackendCallbacks,
        lastPlay: null as MockBackend['lastPlay'],
        lastAdvance: null as GaplessAdvanceRequest | null,
        seeks: [] as number[],
        rates: [] as Array<{ rate: number; preservePitch: boolean }>,
        supportsCrossfade: false,
        supportsVolumeControl: true,
        normalizationStyle: 'instant' as const,
        supportsGaplessAdvance: supportsGapless,
        init(cb: AudioBackendCallbacks) {
            backend.callbacks = cb;
        },
        destroy: noop,
        async play(
            src: string,
            _meta: unknown,
            options?: { startAtMs?: number; playbackRate?: number },
        ) {
            backend.lastPlay = {
                src,
                startAtMs: options?.startAtMs,
                playbackRate: options?.playbackRate,
            };
        },
        pause: noop,
        resume: noop,
        stop: noop,
        seekTo(ms: number) {
            backend.seeks.push(ms);
        },
        volumeCalls: [] as number[],
        setVolume(volume: number) {
            backend.volumeCalls.push(volume);
        },
        muteCalls: [] as MockBackend['muteCalls'],
        mute() {
            backend.muteCalls.push({ type: 'mute' });
        },
        unmute(restoreVolume: number) {
            backend.muteCalls.push({ type: 'unmute', restoreVolume });
        },
        async triggerCrossfade() {},
        cancelCrossfade: noop,
        normalizePlaybackRate: noop,
        setPlaybackRate(rate: number, options: { preservePitch: boolean }) {
            backend.rates.push({ rate, preservePitch: options.preservePitch });
        },
        scheduleGaplessAdvance(request: GaplessAdvanceRequest | null) {
            backend.lastAdvance = request;
            return supportsGapless && request !== null;
        },
        getCurrentTimeMs: () => 0,
        getDurationMs: () => 0,
        getPlaybackRate: () => 1,
        isCrossfading: () => false,
        getAudioElement: () => null,
        getAllAudioElements: () => [],
        async preload() {
            return { resumed: false };
        },
        async reloadCurrentSrc() {
            return true;
        },
        prefetchNext: noop,
        tick(fileMs: number, rate = 1) {
            backend.callbacks.onTimeUpdate?.({
                currentTimeMs: fileMs,
                durationMs: 0,
                playbackRate: rate,
            });
        },
    };
    return backend as unknown as MockBackend;
}

/**
 * Example names are fictional; production shapes and measurements are retained.
 * When set, `createAudiobookBackend` waits on this before resolving — which is
 * how a test holds open the window between "load() started" and "the store is
 * registered with the exclusivity arbiter".
 */
let backendGate: Promise<void> | null = null;

vi.mock('$lib/audio', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        createAudiobookBackend: vi.fn(async () => {
            if (backendGate) await backendGate;
            return mockBackend;
        }),
    };
});

const BOOK: AudiobookSessionPayload['book'] = {
    title: 'Lanternlight 451',
    author: 'Ray Bradbury',
    images: {},
};

function withStart(
    payload: Omit<AudiobookSessionPayload, 'start'> & { grantToken?: string },
): AudiobookSessionPayload {
    const start = playbackStartFixture(
        payload.mediaId,
        payload.playbackSessionId,
        payload.grantToken ?? 'stream_abc',
    );
    const hlsUrl = `/api/v1/audiobook/${payload.mediaId}/hls/playback/${payload.playbackSessionId}/output.m3u8?grant=${start.grant.token}`;
    start.kind = 'audiobook';
    start.delivery = {
        kind: 'multipart-audio',
        tracks: payload.tracks.map((t) => ({
            index: t.index,
            url:
                payload.playMethod === 'transcode'
                    ? hlsUrl
                    : t.url.replace('stream_abc', start.grant.token),
            startMs: t.startMs,
            durationMs: t.durationMs ?? 0,
            mime: t.mimeType ?? 'audio/mpeg',
        })),
        chapters: payload.chapters.map((c, index) => ({
            index,
            name: c.title ?? '',
            startMs: c.startMs,
            endMs: c.startMs + c.durationMs,
        })),
        startPositionMs: payload.startPositionMs,
        durationMs: payload.durationMs ?? null,
    };
    return {
        ...payload,
        tracks: payload.tracks.map((t) => ({
            ...t,
            url: t.url.replace('stream_abc', start.grant.token),
            remuxUrl: t.remuxUrl?.replace('stream_abc', start.grant.token),
        })),
        start,
    };
}

function directPayload(
    overrides: Partial<AudiobookSessionPayload> & { grantToken?: string } = {},
): AudiobookSessionPayload {
    return withStart({
        playbackSessionId: 'abs-session-1',
        mediaId: 'media-uuid',
        playMethod: 'direct',
        grantToken: 'stream_abc',
        tracks: toPlaybackTracks(FIXTURE_TRACKS),
        chapters: toPlaybackChapters(FIXTURE_CHAPTERS),
        startPositionMs: 0,
        book: BOOK,
        ...overrides,
    });
}

/**
 * A transcode payload as the live server ACTUALLY returns it: exactly one track,
 * NO inode (it is served as an HLS playlist, not as a file), `startOffset: 0`
 * and the whole book's duration.
 *
 * The transcode cases used to reuse `directPayload({ playMethod: 'transcode' })`
 * — the direct-play file list with the method flag flipped — so every track had
 * an inode. That hid a real bug: `buildAudiobookTimeline` dropped inode-less
 * tracks, so a genuine transcode session produced an EMPTY timeline,
 * `durationMs` 0, every position clamped to 0, and position 0 pushed into
 * AudiobookShelf's last-write-wins progress row.
 */
function transcodePayload(
    overrides: Partial<AudiobookSessionPayload> & { grantToken?: string } = {},
): AudiobookSessionPayload {
    return withStart({
        playbackSessionId: 'abs-session-1',
        mediaId: 'media-uuid',
        playMethod: 'transcode',
        grantToken: 'stream_abc',
        tracks: toPlaybackTracks(
            projectAbsTracks([
                {
                    index: 1,
                    startOffset: 0,
                    duration: liveSession.duration,
                    title: 'Lanternlight 451',
                    contentUrl: '/hls/abs-session-1/output.m3u8',
                    mimeType: 'application/vnd.apple.mpegurl',
                    codec: null,
                },
            ]),
        ),
        chapters: toPlaybackChapters(FIXTURE_CHAPTERS),
        startPositionMs: 0,
        durationMs: Math.round(liveSession.duration * 1000),
        book: BOOK,
        ...overrides,
    });
}

function makeDeps(payloads: AudiobookSessionPayload[]): {
    deps: AudiobookPlayerDeps;
    reports: Parameters<AudiobookPlayerDeps['reportProgress']>[0][];
    heartbeats: Parameters<AudiobookPlayerDeps['heartbeat']>[0][];
    closes: Parameters<AudiobookPlayerDeps['closeSession']>[0][];
    opens: Parameters<AudiobookPlayerDeps['openSession']>[0][];
    acks: { report: AudiobookProgressAck; heartbeat: AudiobookProgressAck };
} {
    const reports: Parameters<AudiobookPlayerDeps['reportProgress']>[0][] = [];
    const heartbeats: Parameters<AudiobookPlayerDeps['heartbeat']>[0][] = [];
    const closes: Parameters<AudiobookPlayerDeps['closeSession']>[0][] = [];
    const opens: Parameters<AudiobookPlayerDeps['openSession']>[0][] = [];
    // Mutable so a case can make the NEXT report answer "session gone".
    const acks: { report: AudiobookProgressAck; heartbeat: AudiobookProgressAck } = {
        report: { synced: true },
        heartbeat: { synced: true },
    };
    let i = 0;
    return {
        opens,
        reports,
        heartbeats,
        closes,
        acks,
        deps: {
            async openSession(input) {
                opens.push(input);
                return payloads[Math.min(i++, payloads.length - 1)];
            },
            async reportProgress(report) {
                reports.push(report);
                return acks.report;
            },
            async heartbeat(input) {
                heartbeats.push(input);
                return acks.heartbeat;
            },
            async closeSession(report) {
                closes.push(report);
                return { synced: true };
            },
        },
    };
}

/**
 * happy-dom reports canPlayType '' for everything; force HLS support.
 *
 * MUST await inside: restoring the spy synchronously around an async
 * call puts the real `createElement` back before the probe runs, and the
 * store then takes the transcode-unsupported branch instead of playing.
 */
async function withNativeHls<T>(fn: () => Promise<T>): Promise<T> {
    const el = document.createElement('audio');
    vi.spyOn(el, 'canPlayType').mockReturnValue('maybe');
    const spy = vi.spyOn(document, 'createElement').mockReturnValue(el);
    try {
        return await fn();
    } finally {
        spy.mockRestore();
    }
}

const TIMELINE = buildPlaybackAudiobookTimeline(
    toPlaybackTracks(FIXTURE_TRACKS),
    toPlaybackChapters(FIXTURE_CHAPTERS),
);
/** Book time of the second file / second chapter, ms. */
const BOUNDARY_2 = TIMELINE.tracks[1].startOffsetMs;

// ---------------------------------------------------------------------------

describe('audiobook player store', () => {
    let store: ReturnType<typeof createAudiobookPlayerStore>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        resetAudioExclusivity();
        mockBackend = makeMockBackend(true);
        backendGate = null;
        store = createAudiobookPlayerStore();
    });

    afterEach(() => {
        store.destroy();
        vi.useRealTimers();
    });

    describe('URL construction', () => {
        it('passes a server-built track URL to the backend unchanged', async () => {
            const payload = directPayload();
            payload.tracks[0].url = '/server/audio/opaque?grant=opaque';
            const { deps } = makeDeps([payload]);
            store.configure({ deps });
            await store.load('media-uuid');
            expect(mockBackend.lastPlay?.src).toBe('/server/audio/opaque?grant=opaque');
        });

        it('puts the direct-play token in the query', () => {
            const payload = directPayload();
            expect(payload.start.delivery.kind).toBe('multipart-audio');
            if (payload.start.delivery.kind === 'multipart-audio')
                expect(payload.start.delivery.tracks[0].url).toContain('?grant=stream_abc');
        });

        it('carries the HLS grant in the query, with an inert path component', () => {
            const delivery = transcodePayload().start.delivery;
            const playlist = delivery.kind === 'multipart-audio' ? delivery.tracks[0].url : '';
            expect(playlist).toBe(
                '/api/v1/audiobook/media-uuid/hls/playback/abs-session-1/output.m3u8?grant=stream_abc',
            );
            expect(new URL(playlist, 'https://x.test').pathname).not.toContain('stream_abc');
        });
    });

    describe('a play button that means "resume"', () => {
        // What a card/hover-popup play affordance does: playAudiobook(mediaId)
        // → load(mediaId) with no options. The listener may have continued in
        // the ABS app since our row was rendered, so a client that sends its
        // own idea of the position can overwrite theirs. A client that never
        // sends one structurally cannot.
        it('omits positionMs entirely — not 0 — so the server answers with ABS progress', async () => {
            const { deps, opens } = makeDeps([directPayload({ startPositionMs: 7_000_000 })]);
            store.configure({ deps });

            await store.load('media-uuid');

            expect(opens).toHaveLength(1);
            // `in`, not `=== undefined`: 0 is a real instruction ("start at the
            // beginning"), so the KEY must be absent, and JSON.stringify would
            // drop an explicit undefined and hide the difference.
            expect('positionMs' in opens[0]).toBe(false);
        });

        it('resumes mid-book from the position the server answered with', async () => {
            const { deps } = makeDeps([directPayload({ startPositionMs: 7_000_000 })]);
            store.configure({ deps });

            await store.load('media-uuid');

            // ~1h56m in, i.e. the third file — not the start of the book.
            expect(get(store).bookPositionMs).toBeCloseTo(7_000_000, 3);
            expect(mockBackend.lastPlay?.src).toContain('/files/3');
        });

        it('writes no position just from opening the book', async () => {
            const { deps, reports, closes } = makeDeps([
                directPayload({ startPositionMs: 7_000_000 }),
            ]);
            store.configure({ deps });

            await store.load('media-uuid');

            // Nothing has been listened to yet. A report here would push our
            // number back at ABS on every card click.
            expect(reports).toEqual([]);
            expect(closes).toEqual([]);
        });
    });

    describe('loading a real ABS session', () => {
        it('plays the file covering the resume position, seeked in place', async () => {
            const { deps } = makeDeps([directPayload({ startPositionMs: 7_000_000 })]);
            store.configure({ deps });
            await store.load('media-uuid');

            // Third file, offset inside it — not "play file 1 then seek", which
            // would stream from the wrong file entirely.
            expect(mockBackend.lastPlay?.src).toContain('/files/3');
            expect(mockBackend.lastPlay?.startAtMs).toBeCloseTo(
                7_000_000 - TIMELINE.tracks[2].startOffsetMs,
                3,
            );
        });

        it('reports book time, not file time, once past the first file', async () => {
            const { deps } = makeDeps([directPayload({ startPositionMs: BOUNDARY_2 })]);
            store.configure({ deps });
            await store.load('media-uuid');

            mockBackend.tick(30_000);
            expect(get(store).bookPositionMs).toBeCloseTo(BOUNDARY_2 + 30_000, 3);
            // Fed raw file time, every surface downstream would show 0:30 into a
            // 4-hour book and highlight chapter 1.
            expect(get(store).currentChapter?.index).toBe(1);
        });

        it('surfaces an actionable error instead of a dead element when HLS is unplayable', async () => {
            // happy-dom's canPlayType returns '' for everything, so this is the
            // Chrome/Firefox/Android row of the platform matrix.
            const { deps } = makeDeps([directPayload({ playMethod: 'transcode' })]);
            store.configure({ deps });
            await store.load('media-uuid');

            expect(get(store).error?.kind).toBe('transcode_unsupported');
            expect(mockBackend.lastPlay).toBeNull();
            expect(reportUserFacingFailure).toHaveBeenCalledWith({
                key: 'audiobook_transcode_unsupported',
            });
        });
    });

    describe('a session that briefly fails to open', () => {
        // AudiobookShelf's session bookkeeping is in-memory and genuinely flaps
        // for a few seconds around another client opening or closing a session
        // on the same book (observed in production, 2026-08-12: a churn window
        // under a minute). Without a retry, that transient window used to
        // strand the listener on a dead player with no recourse but to back
        // fully out and reopen the book by hand.
        it('retries and succeeds once the upstream session stops flapping', async () => {
            const payload = directPayload({ startPositionMs: 7_000_000 });
            let calls = 0;
            const deps: AudiobookPlayerDeps = {
                async openSession() {
                    calls++;
                    if (calls === 1) throw new Error('AudiobookShelf is temporarily unreachable');
                    return payload;
                },
                async reportProgress() {
                    return { synced: true };
                },
                async heartbeat() {
                    return { synced: true };
                },
                async closeSession() {
                    return { synced: true };
                },
            };
            store.configure({ deps });

            const loadPromise = store.load('media-uuid');
            await vi.advanceTimersByTimeAsync(5_000);
            expect(await loadPromise).toBe(true);

            expect(calls).toBe(2);
            expect(get(store).error).toBeNull();
            expect(get(store).bookPositionMs).toBeCloseTo(7_000_000, 3);
        });

        it('gives up and surfaces an error once retries are exhausted', async () => {
            let calls = 0;
            const deps: AudiobookPlayerDeps = {
                async openSession() {
                    calls++;
                    throw new Error('AudiobookShelf is temporarily unreachable');
                },
                async reportProgress() {
                    return { synced: true };
                },
                async heartbeat() {
                    return { synced: true };
                },
                async closeSession() {
                    return { synced: true };
                },
            };
            store.configure({ deps });

            const loadPromise = store.load('media-uuid');
            await vi.advanceTimersByTimeAsync(30_000);
            expect(await loadPromise).toBe(false);

            expect(calls).toBeGreaterThan(1);
            expect(get(store).error?.kind).toBe('session_failed');
            // The "Jump back in" case: the failure leaves a tagged diagnostic.
            expect(reportUserFacingFailure).toHaveBeenCalledWith(
                expect.objectContaining({ key: 'audiobook_session_failed' }),
            );
        });

        // Regression: a stream-policy refusal (503 `stream_limit`) was retried
        // three times and then toasted the server's default Live TV wording
        // ("Stream slot limit reached — no viewer slot available") in English.
        it.each([
            ['stream_limit', 503, () => m.playback_refusal_stream_limit_generic()],
            ['forbidden', 403, () => m.audiobook_refusal_no_abs_link()],
        ])(
            'does not retry a %s refusal and shows the specific message',
            async (code, status, expected) => {
                let calls = 0;
                const deps: AudiobookPlayerDeps = {
                    async openSession() {
                        calls++;
                        throw Object.assign(new Error('server text'), { status, code });
                    },
                    async reportProgress() {
                        return { synced: true };
                    },
                    async heartbeat() {
                        return { synced: true };
                    },
                    async closeSession() {
                        return { synced: true };
                    },
                };
                store.configure({ deps });

                const loadPromise = store.load('media-uuid');
                await vi.advanceTimersByTimeAsync(30_000);
                expect(await loadPromise).toBe(false);

                expect(calls).toBe(1);
                expect(get(store).error?.message).toBe(expected());
            },
        );
    });

    describe('file-boundary advance', () => {
        it('pre-rolls the next file with the CURRENT rate re-applied', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            store.setPlaybackRate(1.5);

            // Both crossfade-capable backends hard-set a freshly loaded deck to
            // rate 1, so a 1.5x listener silently drops to 1x at every boundary
            // unless the advance carries the rate.
            expect(mockBackend.lastAdvance?.playbackRate).toBe(1.5);
            expect(mockBackend.lastAdvance?.preservePitch).toBe(true);
            expect(mockBackend.lastAdvance?.src).toContain('/files/2');
        });

        it('rebases on the MEASURED swap position, not the requested offset', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            // The incoming deck has been playing for the lead at the swap, so it
            // is past 0. Rebasing on the request would lose that much book
            // position at every boundary — every nine minutes on a real book.
            mockBackend.callbacks.onGaplessAdvanceCommitted?.({
                src: '/api/v1/audiobooks/media-uuid/files/2?grant=stream_abc&PlaySessionId=abs-session-1',
                positionMs: 150,
            });

            expect(store._debug?.getCurrentTrackUrl()).toBe(directPayload().tracks[1].url);
            expect(get(store).bookPositionMs).toBeCloseTo(BOUNDARY_2 + 150, 3);
            expect(get(store).currentChapter?.index).toBe(1);
        });

        it('schedules the NEXT advance after committing one', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            mockBackend.callbacks.onGaplessAdvanceCommitted?.({ src: 'x', positionMs: 0 });
            expect(mockBackend.lastAdvance?.src).toContain('/files/3');
        });

        it('falls back to a cold start when the backend cannot butt-join', async () => {
            mockBackend = makeMockBackend(false);
            store.destroy();
            store = createAudiobookPlayerStore();
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            expect(mockBackend.lastAdvance).toBeNull();
            await mockBackend.callbacks.onTrackEnded?.();
            expect(mockBackend.lastPlay?.src).toContain('/files/2');
            expect(mockBackend.lastPlay?.startAtMs).toBe(0);
        });

        it('does not schedule an advance on the transcode path', async () => {
            // A transcode session is ONE track — the playlist. There is no
            // boundary to butt-join across.
            const payload = transcodePayload();
            const { deps } = makeDeps([payload]);
            const el = document.createElement('audio');
            vi.spyOn(el, 'canPlayType').mockReturnValue('maybe');
            vi.spyOn(document, 'createElement').mockReturnValue(el);

            store.configure({ deps });
            await store.load('media-uuid');
            vi.mocked(document.createElement).mockRestore();

            expect(mockBackend.lastAdvance).toBeNull();
            expect(mockBackend.lastPlay?.src).toContain('/hls/playback/abs-session-1/');
        });
    });

    describe('seeking across a boundary', () => {
        it('loads the target file and lands at the right book position', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            await store.seekTo(BOUNDARY_2 + 60_000);

            expect(mockBackend.lastPlay?.src).toContain('/files/2');
            expect(mockBackend.lastPlay?.startAtMs).toBeCloseTo(60_000, 3);
            expect(get(store).bookPositionMs).toBeCloseTo(BOUNDARY_2 + 60_000, 3);
        });

        it('seeks in place within the same file', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            mockBackend.lastPlay = null;

            await store.seekTo(120_000);

            expect(mockBackend.lastPlay).toBeNull();
            expect(mockBackend.seeks).toEqual([120_000]);
        });

        it('lands a chapter jump on the file that STARTS at the boundary', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            await store.seekToChapter(1);

            // The other resolution would land on the last sample of file one,
            // where `ended` fires immediately and advances — arriving one
            // chapter from where the listener tapped.
            expect(mockBackend.lastPlay?.src).toContain('/files/2');
            expect(mockBackend.lastPlay?.startAtMs).toBe(0);
        });
    });

    describe('MediaSession', () => {
        it('registers with the skip actions music deliberately suppresses', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            const [, callbacks, options] = vi.mocked(initMediaSession).mock.calls.at(-1)!;
            expect(options?.trackControlsOnly).toBe(false);
            expect(callbacks.onSeekForward).toBeTypeOf('function');
            expect(callbacks.onSeekBackward).toBeTypeOf('function');
        });

        it('maps nexttrack to a CHAPTER, not a file', async () => {
            // On a single-file 24-hour book a file skip is the end of the book.
            const singleFile = directPayload({
                tracks: [{ index: 1, url: '/server/audio', startMs: 0, durationMs: 3_600_000 }],
                chapters: [
                    { title: 'One', startMs: 0, durationMs: 1_200_000 },
                    { title: 'Two', startMs: 1_200_000, durationMs: 1_200_000 },
                    { title: 'Three', startMs: 2_400_000, durationMs: 1_200_000 },
                ],
            });
            const { deps } = makeDeps([singleFile]);
            store.configure({ deps });
            await store.load('media-uuid');

            const [, callbacks] = vi.mocked(initMediaSession).mock.calls.at(-1)!;
            callbacks.onNextTrack!();
            await vi.advanceTimersByTimeAsync(0);

            expect(get(store).bookPositionMs).toBe(1_200_000);
            expect(get(store).currentChapter?.title).toBe('Two');
        });

        it('reports BOOK time to the lock screen', async () => {
            const { deps } = makeDeps([directPayload({ startPositionMs: BOUNDARY_2 })]);
            store.configure({ deps });
            await store.load('media-uuid');
            vi.mocked(updateMediaSessionPositionState).mockClear();

            mockBackend.tick(45_000);

            const [duration, position] = vi
                .mocked(updateMediaSessionPositionState)
                .mock.calls.at(-1)!;
            expect(duration).toBeCloseTo(liveSession.duration, 3);
            // File time would put the scrubber back near zero on every file
            // after the first.
            expect(position).toBeCloseTo((BOUNDARY_2 + 45_000) / 1000, 3);
        });

        it('re-declares metadata (including artwork) on a plain pause/resume', async () => {
            // Safari's macOS Now Playing widget has been observed to drop
            // artwork across a playback-state transition unless the page
            // redeclares MediaMetadata at that transition — title/artist
            // keep showing (they're independent of this), only the artwork
            // silently disappears. Every OTHER playback mutator in this store
            // (playTrack, onAdvanceCommitted, the chapter-change branch of
            // handleTimeUpdate) re-registers the full metadata; resume() was
            // the one path that only touched playbackState.
            const coverUrl = '/api/media/media-uuid/images/poster';
            const { deps } = makeDeps([
                directPayload({
                    book: {
                        ...BOOK,
                        images: { primary: { href: coverUrl, revision: '1', source: 'self' } },
                    },
                }),
            ]);
            store.configure({ deps });
            await store.load('media-uuid');

            store.pause();
            vi.mocked(initMediaSession).mockClear();

            await store.resume();

            const call = vi.mocked(initMediaSession).mock.calls.at(-1);
            expect(call).toBeDefined();
            const [metadata] = call!;
            expect(metadata.artwork).toBe(coverUrl);
        });
    });

    describe('a tab left paused while another device takes over', () => {
        it('does not re-push the paused position when the tab is hidden or closed', async () => {
            const { deps, reports } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            for (let t = 0; t <= 40_000; t += 100) mockBackend.tick(t);
            store.pause();
            await vi.advanceTimersByTimeAsync(0);
            const afterPause = reports.length;
            expect(afterPause).toBeGreaterThanOrEqual(1);

            // The listener has gone to their phone and this tab is just sitting
            // there. A flush with nothing newly heard re-pushes the stale paused
            // position into a last-write-wins upstream and rewinds the phone.
            window.dispatchEvent(new Event('pagehide'));
            await vi.advanceTimersByTimeAsync(0);

            expect(reports).toHaveLength(afterPause);
        });

        it('re-anchors to the server when play is pressed after the paused grace', async () => {
            // The listener paused here, listened on their phone, and came back
            // to this tab an hour later. Our in-memory position is an hour old
            // and the server has since reaped the session, so resuming from it
            // both drops them backwards and pushes that stale position on the
            // first report.
            const { deps, opens, reports } = makeDeps([
                directPayload(),
                directPayload({ playbackSessionId: 'abs-session-2', startPositionMs: 3_600_000 }),
            ]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 40_000; t += 100) mockBackend.tick(t);
            store.pause();
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(31 * 60_000);
            await store.resume();
            await vi.advanceTimersByTimeAsync(0);

            expect(opens).toHaveLength(2);
            // Omitted, not zero: the server answers an absent position with
            // AudiobookShelf's own saved progress, which is the whole point.
            expect(opens[1].positionMs).toBeUndefined();
            expect(get(store).bookPositionMs).toBe(3_600_000);
            expect(get(store).playbackSessionId).toBe('abs-session-2');
            expect(reports.every((r) => r.bookPositionMs < 3_600_000 + 1)).toBe(true);
        });

        it('keeps this tab position when the server has not heard our last report', async () => {
            // The mirror image, and why this is not a blind adopt: a pause
            // report that never landed leaves the server BEHIND us, and that
            // listening exists nowhere else.
            const { deps } = makeDeps([
                directPayload(),
                directPayload({ playbackSessionId: 'abs-session-2', startPositionMs: 5_000 }),
            ]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 40_000; t += 100) mockBackend.tick(t);
            store.pause();
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(31 * 60_000);
            await store.resume();
            await vi.advanceTimersByTimeAsync(0);

            expect(get(store).bookPositionMs).toBeCloseTo(40_000, -2);
        });

        it('closes the player when a report says the book was taken over elsewhere', async () => {
            const { deps, acks, opens } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 40_000; t += 100) mockBackend.tick(t);
            await vi.advanceTimersByTimeAsync(0);

            acks.report = { synced: false, superseded: true };
            store.pause();
            await vi.advanceTimersByTimeAsync(0);

            // Not `sessionLost`, which means "reopen one and keep playing".
            // There is nothing here to keep playing.
            expect(opens).toHaveLength(1);
            expect(get(store).book).toBeNull();
            expect(get(store).mediaId).toBeNull();
            expect(get(store).isPlaying).toBe(false);
        });

        it('closes the player when a heartbeat says the book was taken over elsewhere', async () => {
            const { deps, acks, opens } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 40_000; t += 100) mockBackend.tick(t);
            store.pause();
            await vi.advanceTimersByTimeAsync(0);

            acks.heartbeat = { synced: false, superseded: true };
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(0);

            expect(opens).toHaveLength(1);
            expect(get(store).book).toBeNull();
        });

        it('checks in with the server when a paused tab comes back into view', async () => {
            const { deps, heartbeats } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 40_000; t += 100) mockBackend.tick(t);
            store.pause();
            await vi.advanceTimersByTimeAsync(0);
            const before = heartbeats.length;

            // The periodic ping is stopped while paused, so looking at the tab
            // again is the only moment this deck can find out it has been
            // replaced — and it is exactly when a stale player would be seen.
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(0);

            expect(heartbeats.length).toBe(before + 1);
            expect(heartbeats.at(-1)!.status).toBe('PAUSED');
        });

        it('retains a seek saved at pause when the server missed that report', async () => {
            // Pause accepts the seek. If the server missed that checkpoint,
            // re-anchor should preserve the more recent position held here.
            const { deps } = makeDeps([
                directPayload(),
                directPayload({ playbackSessionId: 'abs-session-2', startPositionMs: 40_000 }),
            ]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 40_000; t += 100) mockBackend.tick(t);
            await vi.advanceTimersByTimeAsync(0);

            await store.seekTo(10_000_000);
            store.pause();
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(31 * 60_000);
            await store.resume();
            await vi.advanceTimersByTimeAsync(0);

            expect(get(store).bookPositionMs).toBe(10_000_000);
        });

        it('does not reopen a session for a paused deck whose check-in finds it gone', async () => {
            // A reaped row answers 404, which the transport maps to sessionLost
            // — "reopen one and keep playing". There is nothing playing. Worse,
            // the reopen supersedes the listener's OTHER paused session, which
            // is the device they actually moved to.
            const { deps, acks, opens } = makeDeps([
                directPayload(),
                directPayload({ playbackSessionId: 'abs-session-2' }),
            ]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 40_000; t += 100) mockBackend.tick(t);
            store.pause();
            await vi.advanceTimersByTimeAsync(0);

            // Long enough that a 404 means the row was REAPED — which is the
            // only way a check-in gets one, and the state in which the listener
            // has plausibly moved elsewhere. A 404 at pause time is a different
            // animal (the deck was playing a second ago) and still recovers.
            await vi.advanceTimersByTimeAsync(31 * 60_000);
            acks.heartbeat = { synced: false, sessionLost: true };
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(0);

            expect(opens).toHaveLength(1);
        });

        it('resumes a short pause without re-opening anything', async () => {
            const { deps, opens } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 40_000; t += 100) mockBackend.tick(t);
            store.pause();
            await vi.advanceTimersByTimeAsync(0);

            // A coffee break is not a hand-off. Re-opening the session here
            // would put a spinner and a fresh element load in front of every
            // ordinary play/pause.
            await vi.advanceTimersByTimeAsync(60_000);
            await store.resume();
            await vi.advanceTimersByTimeAsync(0);

            expect(opens).toHaveLength(1);
            expect(get(store).isPlaying).toBe(true);
        });

        it('still flushes a hide that DID hear something since the last report', async () => {
            const { deps, reports } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            for (let t = 0; t <= 40_000; t += 100) mockBackend.tick(t);
            await vi.advanceTimersByTimeAsync(0);
            const before = reports.length;

            // Backgrounding a PLAYING tab is the case the flush exists for:
            // Chrome throttles the timer, so this is the last chance to land
            // the position.
            for (let t = 40_100; t <= 50_000; t += 100) mockBackend.tick(t);
            window.dispatchEvent(new Event('pagehide'));
            await vi.advanceTimersByTimeAsync(0);

            expect(reports.length).toBeGreaterThan(before);
            expect(reports.at(-1)!.bookPositionMs).toBeCloseTo(50_000, -2);
        });
    });

    describe('seek checkpoint persistence', () => {
        it.each(['pause', 'pagehide', 'visibilitychange', 'stop'] as const)(
            'persists three forward skips on %s even without newly heard audio',
            async (checkpoint) => {
                const payload = directPayload({
                    startPositionMs: 30_735,
                    book: { title: 'The Clockwork Orchard', author: 'Mira Vale', images: {} },
                });
                const { deps, reports, closes } = makeDeps([payload]);
                store.configure({ deps });
                await store.load('media-uuid');
                await vi.advanceTimersByTimeAsync(0);

                // The previous heartbeat saved 0:30.735. Three quick skips
                // update the UI, then the listener leaves before another tick.
                for (let i = 0; i < 3; i++) await store.skipBy(30_000);
                expect(get(store).bookPositionMs).toBe(120_735);
                expect(get(store).isDwelling).toBe(true);
                if (checkpoint === 'pause') store.pause();
                else if (checkpoint === 'pagehide') window.dispatchEvent(new Event('pagehide'));
                else if (checkpoint === 'visibilitychange') {
                    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
                    document.dispatchEvent(new Event('visibilitychange'));
                    vi.restoreAllMocks();
                } else await store.stop();
                await vi.advanceTimersByTimeAsync(0);

                const writes = checkpoint === 'stop' ? closes : reports;
                expect(writes.at(-1)).toMatchObject({
                    bookPositionMs: 120_735,
                    listenedMs: 0,
                    isFinished: false,
                });
            },
        );
    });

    describe('accidental-seek protection', () => {
        it('withholds a seek-derived position until real playback has elapsed', async () => {
            const { deps, reports } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            await store.seekTo(10_000_000);
            expect(get(store).isDwelling).toBe(true);

            // Playing, but not yet enough of it. ABS's progress row is
            // last-write-wins with no history, so a pushed mis-tap destroys the
            // position on both sides.
            const base = 10_000_000 - TIMELINE.tracks[3].startOffsetMs;
            mockBackend.tick(base);
            mockBackend.tick(base + 2_000);
            mockBackend.tick(base + 4_000);
            expect(reports).toHaveLength(0);
        });

        it('opens the gate once the dwell has been played out', async () => {
            const { deps, reports } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            await store.seekTo(600_000);
            const start = 600_000;
            // Advance in plausible steps — a single jump would read as a seek.
            for (let t = 0; t <= SEEK_DWELL_MS + 500; t += 100) {
                mockBackend.tick(start + t);
            }
            await vi.advanceTimersByTimeAsync(0);
            expect(get(store).isDwelling).toBe(false);
            // The first push happens as soon as the gate opens — the position is
            // trustworthy from that moment, there is nothing to wait for.
            expect(reports.length).toBeGreaterThanOrEqual(1);

            store.pause();
            expect(reports.at(-1)!.bookPositionMs).toBeGreaterThanOrEqual(600_000);
        });

        it('pause saves a seek during dwell without inventing listening time', async () => {
            const { deps, reports } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            await store.seekTo(600_000);
            store.pause();

            await vi.advanceTimersByTimeAsync(0);
            expect(reports.at(-1)).toMatchObject({ bookPositionMs: 600_000, listenedMs: 0 });
            expect(get(store).isDwelling).toBe(false);
        });

        it('closes the session on stop mid-dwell with the current position', async () => {
            const { deps, closes } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 40_000; t += 100) mockBackend.tick(t);

            await store.seekTo(600_000);
            await store.stop();

            expect(closes).toHaveLength(1);
            expect(closes[0].bookPositionMs).toBe(600_000);
        });

        it('closing after two seeks saves the latest landing position', async () => {
            // Multiple seeks must close at the final target.
            const { deps, closes } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 40_000; t += 100) mockBackend.tick(t);

            await store.seekTo(9_000_000); // mis-tap
            await store.seekTo(9_500_000); // correction, still inside the dwell
            await store.stop();

            expect(closes).toHaveLength(1);
            expect(closes[0].bookPositionMs).toBe(9_500_000);
        });

        it('does not stamp a book finished while a seek is still being withheld', async () => {
            // The lock-screen scrubber is whole-book, so a far-right mis-tap
            // lands seconds from the end and the tail plays out. Forcing past
            // the gate there would mark a 40-hour book read in a history-less
            // upstream row.
            const { deps, reports } = makeDeps([
                directPayload({ startPositionMs: TIMELINE.tracks[4].startOffsetMs }),
            ]);
            store.configure({ deps });
            await store.load('media-uuid');

            await store.seekTo(TIMELINE.durationMs - 2_000);
            await mockBackend.callbacks.onTrackEnded?.();

            expect(reports).toHaveLength(0);
        });

        it('still marks a book finished when the tail was genuinely played out', async () => {
            const { deps, reports } = makeDeps([
                directPayload({ startPositionMs: TIMELINE.tracks[4].startOffsetMs }),
            ]);
            store.configure({ deps });
            await store.load('media-uuid');

            const seekTarget = TIMELINE.durationMs - 30_000;
            await store.seekTo(seekTarget);
            // Playback DRAINS the dwell, so a real listen reopens the gate.
            const base = seekTarget - TIMELINE.tracks[4].startOffsetMs;
            for (let t = 0; t <= 15_000; t += 100) mockBackend.tick(base + t);
            await mockBackend.callbacks.onTrackEnded?.();
            await vi.advanceTimersByTimeAsync(0);

            expect(reports.at(-1)).toMatchObject({
                playbackSessionId: 'abs-session-1',
                status: 'COMPLETED',
                isFinished: true,
            });
        });

        it('raises an undo affordance for a large jump', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            mockBackend.tick(400_000);

            await store.seekTo(0);

            expect(get(store).pendingUndo).toEqual({ fromMs: 400_000, toMs: 0 });
        });

        it('raises it for a backwards jump past the chapter start, however small', async () => {
            const { deps } = makeDeps([directPayload({ startPositionMs: BOUNDARY_2 + 1_000 })]);
            store.configure({ deps });
            await store.load('media-uuid');
            mockBackend.tick(1_000);

            await store.seekTo(BOUNDARY_2 - 2_000);

            expect(get(store).pendingUndo).not.toBeNull();
        });

        it('stays quiet for an ordinary skip-back', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            mockBackend.tick(400_000);

            await store.skipBy(-30_000);

            expect(get(store).pendingUndo).toBeNull();
        });

        it('undo restores the prior position and does not re-arm the gate', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            mockBackend.tick(400_000);
            await store.seekTo(0);

            await store.undoSeek();

            expect(get(store).bookPositionMs).toBeCloseTo(400_000, 3);
            expect(get(store).pendingUndo).toBeNull();
            // Re-arming would delay the correction behind another ten seconds.
            expect(get(store).isDwelling).toBe(false);
        });
    });

    describe('listening time', () => {
        it('counts audio heard, never position deltas', async () => {
            const { deps, reports } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            for (let t = 0; t <= 5_000; t += 100) mockBackend.tick(t);
            // A 40-minute scrub forward.
            await store.seekTo(2_400_000);
            for (let t = 0; t <= 3_000; t += 100) mockBackend.tick(2_400_000 + t);

            store.pause();
            const listened = reports.at(-1)?.listenedMs ?? store._debug!.getUnreportedListenedMs();
            // 8 s of audio heard. Counting the jump would have reported 40 min
            // and inflated ABS's listening statistics by that much.
            expect(listened).toBeLessThan(12_000);
        });

        it('does not count the jump at a gapless boundary', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 2_000; t += 100) mockBackend.tick(t);

            mockBackend.callbacks.onGaplessAdvanceCommitted?.({ src: 'x', positionMs: 150 });
            mockBackend.tick(200);

            expect(store._debug!.getUnreportedListenedMs()).toBeLessThan(3_000);
        });
    });

    describe('exclusive ownership', () => {
        it('never owns audio before its stop handler is registered', async () => {
            // `ensureBackend()` is what registers this store with the arbiter,
            // and it awaits a dynamic import. Claiming before that resolves
            // leaves a window where the audiobook owns audio with no stop
            // handler attached — music claiming in that window finds nothing to
            // stop, and both end up playing.
            //
            // The gate holds that window open; without it the import resolves on
            // the next microtask and both orderings look identical, which is a
            // test that proves nothing.
            let openBackend: (() => void) | null = null;
            backendGate = new Promise<void>((resolve) => {
                openBackend = () => resolve();
            });

            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            const loading = store.load('media-uuid');
            await vi.advanceTimersByTimeAsync(0);

            expect(getAudioOwner()).not.toBe('audiobook');

            openBackend!();
            await loading;
            expect(getAudioOwner()).toBe('audiobook');
        });

        it('starting a book stops music', async () => {
            const stopMusic = vi.fn();
            registerAudioParticipant('music', stopMusic);
            claimAudio('music');

            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            expect(stopMusic).toHaveBeenCalledTimes(1);
        });

        it('another tab claiming audio while the book is still loading pauses it once loaded', async () => {
            // BroadcastChannel delivery is a real macrotask, not a timer.
            vi.useRealTimers();
            let finishPlay: () => void = () => {};
            let playStarted = false;
            mockBackend.play = async () => {
                playStarted = true;
                await new Promise<void>((resolve) => {
                    finishPlay = resolve;
                });
            };
            const pauseSpy = vi.spyOn(mockBackend, 'pause');
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });

            const loading = store.load('media-uuid');
            await vi.waitFor(() => expect(playStarted).toBe(true));
            // Not playing yet: this claim cannot pause anything right now.
            expect(get(store).isPlaying).toBe(false);
            const otherTab = new BroadcastChannel(AUDIO_CLAIM_CHANNEL);
            otherTab.postMessage({
                owner: 'music',
                tabId: 'other-tab',
            } satisfies AudioClaimMessage);
            await new Promise((resolve) => setTimeout(resolve, 30));
            otherTab.close();
            finishPlay();
            await loading;

            expect(get(store).isPlaying).toBe(false);
            expect(pauseSpy).toHaveBeenCalled();
            // Paused, not closed: the book keeps its place.
            expect(get(store).book).not.toBeNull();
        });

        it('music claiming audio stops the book', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            registerAudioParticipant('music', vi.fn());

            claimAudio('music');
            await vi.advanceTimersByTimeAsync(0);

            expect(get(store).isPlaying).toBe(false);
            expect(get(store).book).toBeNull();
        });
    });

    describe('a lost upstream session', () => {
        /**
         * AudiobookShelf sessions are in-memory: they die on an ABS restart and
         * on ABS's own rule that a new session for the same (user, device) closes
         * any other. Direct-play bytes keep flowing afterwards, so the listener
         * notices nothing while every sync 404s and their position stops being
         * recorded anywhere. The design's policy is to reopen and carry on.
         */
        it('reopens a session and keeps playing when a report says it is gone', async () => {
            const second = directPayload({
                playbackSessionId: 'abs-session-2',
                grantToken: 'stream_second',
                startPositionMs: 0,
            });
            const { deps, opens, acks } = makeDeps([directPayload(), second]);
            store.configure({ deps });
            await store.load('media-uuid');
            const opensBefore = opens.length;
            const srcBefore = mockBackend.lastPlay?.src;

            // Play a while with a healthy lane first, so the recovery happens at
            // a real position rather than at 0 — reopening at 0 would be the bug
            // this assertion is here to catch.
            for (let t = 0; t <= 20_000; t += 1_000) {
                mockBackend.tick(t);
                await vi.advanceTimersByTimeAsync(1_000);
            }
            expect(get(store).bookPositionMs).toBeGreaterThan(0);

            // Then the lane goes 404. Reports fire every 15 s, so this window
            // carries exactly one — the realistic shape of an ABS restart.
            acks.report = { synced: false, sessionLost: true };
            for (let t = 21_000; t <= 40_000; t += 1_000) {
                mockBackend.tick(t);
                await vi.advanceTimersByTimeAsync(1_000);
            }

            expect(opens.length).toBe(opensBefore + 1);
            expect(get(store).playbackSessionId).toBe('abs-session-2');
            // Playback was NOT restarted — a bookkeeping failure must never
            // interrupt audio.
            expect(mockBackend.lastPlay?.src).toBe(srcBefore);
            expect(get(store).isPlaying).toBe(true);
            // And it reopens at where the listener actually is, not at 0.
            expect(opens.at(-1)?.positionMs).toBeGreaterThan(0);
        });

        /**
         * A server that keeps answering 404 — our own row reaped, not just a dead
         * ABS session — must not make the store mint a fresh AudiobookShelf
         * session every reporting interval for the rest of a 20-hour book.
         */
        it('stops reopening after a bounded number of failures', async () => {
            const { deps, opens, acks } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            const opensBefore = opens.length;

            acks.report = { synced: false, sessionLost: true };
            for (let t = 0; t <= 180_000; t += 1_000) {
                mockBackend.tick(t);
                await vi.advanceTimersByTimeAsync(1_000);
            }

            // Twelve reporting intervals elapsed; the ceiling is 3.
            expect(opens.length - opensBefore).toBe(3);
            // And playback carried on regardless.
            expect(get(store).isPlaying).toBe(true);
        });
    });

    describe('transcode seeking', () => {
        /**
         * MEASURED against the live server 2026-07-29: a transcode session's
         * playlist spans the WHOLE book (one track, `startOffset: 0`, the
         * book's full duration; 4355 segments summing to 26128 s), identically
         * whether the session's `startTime` was 0 or 7200. So the element's
         * clock IS book time.
         *
         * This is the test that would have caught the earlier revision, which
         * used `startPositionMs` as a base and therefore reported 100 minutes
         * for a book that had played 50.
         */
        it('does NOT add the resume offset to the element clock', async () => {
            const payload = transcodePayload({ startPositionMs: 3_000_000 });
            const { deps } = makeDeps([payload]);
            store.configure({ deps });
            await withNativeHls(() => store.load('media-uuid'));

            // The resume position is an element seek, not a base offset.
            expect(mockBackend.lastPlay?.startAtMs).toBe(3_000_000);
            expect(get(store).bookPositionMs).toBe(3_000_000);

            // One minute later the element reports 3_060_000 in ITS clock,
            // which is already book time. Adding the session offset would
            // report 6_060_000.
            mockBackend.tick(3_060_000);
            expect(get(store).bookPositionMs).toBe(3_060_000);
        });

        it('seeks the element in book time rather than restarting the session', async () => {
            // Re-opening a session at an offset is measurably inert: the
            // playlist comes back identical (`startOffset: 0`, whole book), and
            // ABS derives `startTime` from the listener's SAVED PROGRESS and
            // ignores a requested one. What actually moves the encoder is
            // asking for the segment — which is what seeking the element does.
            const payload = transcodePayload({ startPositionMs: 3_000_000 });
            const { deps, opens } = makeDeps([payload]);
            store.configure({ deps });
            await withNativeHls(() => store.load('media-uuid'));
            const before = opens.length;
            mockBackend.seeks.length = 0;

            // Backwards, far past the position the session opened at — the case
            // the old code restarted the session for.
            await withNativeHls(() => store.seekTo(500_000));

            expect(opens).toHaveLength(before);
            expect(mockBackend.seeks).toEqual([500_000]);
            expect(get(store).bookPositionMs).toBe(500_000);
            expect(get(store).playbackSessionId).toBe('abs-session-1');
        });

        /**
         * The case the old fixtures could not express.
         *
         * A real transcode payload has ONE track with no inode. When the
         * timeline dropped inode-less tracks, this produced an empty timeline,
         * `durationMs` 0, and `clampBookMs` pinned every position to 0 — so the
         * player reported position 0 into AudiobookShelf's history-less
         * last-write-wins progress row and the listener lost their place.
         */
        it('builds a usable whole-book timeline from an inode-less HLS track', async () => {
            const payload = transcodePayload({ startPositionMs: 1_800_000 });
            const { deps } = makeDeps([payload]);
            store.configure({ deps });
            await withNativeHls(() => store.load('media-uuid'));

            const state = get(store);
            expect(state.timeline?.tracks).toHaveLength(1);
            expect(state.durationMs).toBeCloseTo(liveSession.duration * 1000, 0);
            // Not clamped to 0.
            expect(state.bookPositionMs).toBe(1_800_000);
            expect(state.currentChapter).not.toBeNull();
        });

        it('reports the real position, not 0, on the transcode path', async () => {
            const payload = transcodePayload({ startPositionMs: 1_800_000 });
            const { deps, reports } = makeDeps([payload]);
            store.configure({ deps });
            await withNativeHls(() => store.load('media-uuid'));

            // Play without seeking, advancing the clock past the reporting
            // interval so a SECOND report fires — the first one lands at the
            // resume position and would pass even if nothing moved.
            for (let t = 1_800_000; t <= 1_840_000; t += 1_000) {
                mockBackend.tick(t);
                await vi.advanceTimersByTimeAsync(1_000);
            }

            expect(reports.length).toBeGreaterThan(1);
            expect(reports.at(-1)!.bookPositionMs).toBeGreaterThan(1_800_000);
        });

        it('seeks in place for a small forward move', async () => {
            const payload = transcodePayload({ startPositionMs: 0 });
            const { deps, opens } = makeDeps([payload]);
            store.configure({ deps });
            await withNativeHls(() => store.load('media-uuid'));
            const before = opens.length;
            mockBackend.seeks.length = 0;

            await withNativeHls(() => store.seekTo(20_000));

            expect(opens).toHaveLength(before);
            expect(mockBackend.seeks).toEqual([20_000]);
        });
    });

    describe('bookkeeping does not bleed between books', () => {
        it('destroy clears listening time and the dwell window', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 5_000; t += 100) mockBackend.tick(t);
            await store.seekTo(600_000);
            expect(store._debug!.getDwellRemainingMs()).toBeGreaterThan(0);
            expect(store._debug!.getUnreportedListenedMs()).toBeGreaterThan(0);

            store.destroy();

            // Carried over, the next book's first report would include the
            // previous book's listening time and be gated by its stale dwell.
            expect(store._debug!.getDwellRemainingMs()).toBe(0);
            expect(store._debug!.getUnreportedListenedMs()).toBe(0);
        });
    });

    describe('session lifecycle', () => {
        it('heartbeats playing and paused state with the trusted book position', async () => {
            const { deps, heartbeats } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            expect(heartbeats).toEqual([
                expect.objectContaining({
                    playbackSessionId: 'abs-session-1',
                    mediaId: 'media-uuid',
                    status: 'ACTIVE',
                }),
            ]);

            store.pause();
            await vi.advanceTimersByTimeAsync(0);
            expect(heartbeats.at(-1)).toEqual({
                playbackSessionId: 'abs-session-1',
                mediaId: 'media-uuid',
                status: 'PAUSED',
                bookPositionMs: 0,
            });

            await store.resume();
            expect(heartbeats.at(-1)).toEqual({
                playbackSessionId: 'abs-session-1',
                mediaId: 'media-uuid',
                status: 'ACTIVE',
                bookPositionMs: 0,
            });

            await vi.advanceTimersByTimeAsync(10_000);
            expect(heartbeats).toHaveLength(4);

            await store.stop();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(heartbeats).toHaveLength(4);
        });

        // Regression: the periodic heartbeat used to keep firing every 10 s
        // regardless of play state, so a tab left paused refreshed
        // last_seen_at forever and the server's stale-session reap (which
        // measures a paused book from paused_at, not last_seen_at — see
        // staleSessionCondition) never saw it as abandoned. A book paused
        // overnight squatted on the listener's concurrent-stream slot
        // indefinitely. Only the ONE heartbeat sent AT the pause transition
        // should land; nothing more until resume() restarts the interval.
        it('stops pinging while paused and resumes on resume()', async () => {
            const { deps, heartbeats } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            store.pause();
            await vi.advanceTimersByTimeAsync(0);
            const pausedCount = heartbeats.length;
            expect(heartbeats.at(-1)?.status).toBe('PAUSED');

            // Long past the interval's 10 s period, and past the server's
            // 30-minute paused grace — the whole point is that NOTHING pings
            // during this window.
            await vi.advanceTimersByTimeAsync(60 * 60_000);
            expect(heartbeats).toHaveLength(pausedCount);

            await store.resume();
            expect(heartbeats).toHaveLength(pausedCount + 1);
            expect(heartbeats.at(-1)?.status).toBe('ACTIVE');

            // The interval is running again.
            await vi.advanceTimersByTimeAsync(10_000);
            expect(heartbeats).toHaveLength(pausedCount + 2);

            await store.stop();
        });

        it('serializes pause liveness before the newer upstream progress write', async () => {
            const { deps } = makeDeps([directPayload({ startPositionMs: 2_520_000 })]);
            const calls: string[] = [];
            let upstreamPositionMs = 2_400_000;
            let releaseReport!: () => void;
            const reportGate = new Promise<void>((resolve) => {
                releaseReport = resolve;
            });

            deps.heartbeat = async (input) => {
                calls.push(`heartbeat:${input.status}`);
                // The heartbeat is positionless and the server reads its previous
                // durable value, exactly the stale value from the production race.
                upstreamPositionMs = 2_400_000;
                return { synced: true };
            };
            // Only the PAUSE report is held open. The tick loop below opens the
            // session's first report, and gating that one would leave the
            // pause's heartbeat queued behind it forever — the mutation queue is
            // serial, so nothing would land and the ordering under test would
            // never be exercised.
            let reportCalls = 0;
            deps.reportProgress = async (report) => {
                const held = ++reportCalls > 1;
                calls.push('report:start');
                if (held) await reportGate;
                upstreamPositionMs = report.bookPositionMs;
                calls.push('report:finish');
                return { synced: true };
            };
            store.configure({ deps });
            await store.load('media-uuid');
            await vi.advanceTimersByTimeAsync(0);

            // Real listening before the pause, which is what makes the upstream
            // value stale in the first place: a pause that heard nothing has
            // nothing newer to write, and flushReport withholds it (see "a tab
            // left paused while another device takes over").
            const fileStart = mockBackend.lastPlay!.startAtMs ?? 0;
            for (let t = fileStart; t <= fileStart + 5_000; t += 100) mockBackend.tick(t);
            await vi.advanceTimersByTimeAsync(0);
            calls.length = 0;

            store.pause();
            await vi.advanceTimersByTimeAsync(0);

            expect(calls).toEqual(['heartbeat:PAUSED', 'report:start']);
            releaseReport();
            await vi.advanceTimersByTimeAsync(0);
            expect(calls).toEqual(['heartbeat:PAUSED', 'report:start', 'report:finish']);
            expect(upstreamPositionMs).toBe(2_525_000);
        });

        it('ignores a stale heartbeat result after switching books', async () => {
            const second = directPayload({
                mediaId: 'other-book',
                playbackSessionId: 'abs-session-2',
            });
            const { deps, opens } = makeDeps([directPayload(), second]);
            let resolveFirstHeartbeat!: (ack: AudiobookProgressAck) => void;
            const firstHeartbeat = new Promise<AudiobookProgressAck>((resolve) => {
                resolveFirstHeartbeat = resolve;
            });
            let heartbeatCalls = 0;
            deps.heartbeat = async () => {
                heartbeatCalls++;
                return heartbeatCalls === 1 ? firstHeartbeat : { synced: true };
            };
            store.configure({ deps });

            await store.load('media-uuid');
            const switching = store.load('other-book');
            await vi.advanceTimersByTimeAsync(0);

            // Closing cannot overtake an in-flight upstream heartbeat. The
            // switch remains pending until that bounded transport call settles.
            expect(opens).toHaveLength(1);

            resolveFirstHeartbeat({ synced: false, sessionLost: true });
            await expect(switching).resolves.toBe(true);

            // The old session's late 404 must not reopen or replace the new book.
            expect(opens).toHaveLength(2);
            expect(get(store).playbackSessionId).toBe('abs-session-2');
            expect(get(store).mediaId).toBe('other-book');
        });

        it('closes the previous session when a second book is loaded', async () => {
            const second = directPayload({
                mediaId: 'other-book',
                playbackSessionId: 'abs-session-2',
            });
            const { deps, closes } = makeDeps([directPayload(), second]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 5_000; t += 100) mockBackend.tick(t);

            await store.load('other-book');

            // Leaving it open keeps an ACTIVE play_sessions row the byte proxy
            // honours, and carries book one's listening time into book two.
            expect(closes).toHaveLength(1);
            expect(closes[0].playbackSessionId).toBe('abs-session-1');
            expect(store._debug!.getUnreportedListenedMs()).toBe(0);
        });

        it('waits for the previous close before reopening the same book', async () => {
            const reopened = directPayload({
                playbackSessionId: 'abs-session-2',
                startPositionMs: 2_520_000,
            });
            const { deps, opens, closes } = makeDeps([directPayload(), reopened]);
            let releaseClose!: () => void;
            const closeGate = new Promise<void>((resolve) => {
                releaseClose = resolve;
            });
            deps.closeSession = async (report) => {
                closes.push(report);
                await closeGate;
                return { synced: true };
            };
            store.configure({ deps });
            await store.load('media-uuid');
            await vi.advanceTimersByTimeAsync(0);

            const loading = store.load('media-uuid');
            await vi.advanceTimersByTimeAsync(0);

            expect(closes).toHaveLength(1);
            expect(opens).toHaveLength(1);
            releaseClose();
            await expect(loading).resolves.toBe(true);
            expect(opens).toHaveLength(2);
            expect(get(store).playbackSessionId).toBe('abs-session-2');
        });

        it('keeps a pending close visible across three rapid loads', async () => {
            const { deps, opens, closes } = makeDeps([
                directPayload(),
                directPayload({ mediaId: 'third-book', playbackSessionId: 'abs-session-3' }),
            ]);
            let releaseClose!: () => void;
            const closeGate = new Promise<void>((resolve) => {
                releaseClose = resolve;
            });
            deps.closeSession = async (report) => {
                closes.push(report);
                await closeGate;
                return { synced: true };
            };
            store.configure({ deps });
            await store.load('media-uuid');

            const second = store.load('second-book');
            const third = store.load('third-book');
            await vi.advanceTimersByTimeAsync(0);

            expect(closes).toHaveLength(1);
            expect(opens).toHaveLength(1);
            releaseClose();
            await expect(second).resolves.toBe(false);
            await expect(third).resolves.toBe(true);
            expect(opens).toHaveLength(2);
            expect(opens[1].mediaId).toBe('third-book');
        });

        it('recovers when a heartbeat reports that the session is gone', async () => {
            const reopened = directPayload({ playbackSessionId: 'abs-session-2' });
            const { deps, opens, acks } = makeDeps([directPayload(), reopened]);
            acks.heartbeat = { synced: false, sessionLost: true };
            store.configure({ deps });

            await store.load('media-uuid');
            await vi.advanceTimersByTimeAsync(0);

            expect(opens).toHaveLength(2);
            expect(get(store).playbackSessionId).toBe('abs-session-2');
            expect(get(store).isPlaying).toBe(true);
        });

        it('restores PAUSED immediately when a paused session is recovered', async () => {
            const reopened = directPayload({ playbackSessionId: 'abs-session-2' });
            const { deps, heartbeats } = makeDeps([directPayload(), reopened]);
            store.configure({ deps });
            await store.load('media-uuid');
            await vi.advanceTimersByTimeAsync(0);
            heartbeats.length = 0;
            let calls = 0;
            deps.heartbeat = async (input) => {
                heartbeats.push(input);
                calls++;
                return calls === 1
                    ? { synced: false, sessionLost: true }
                    : { synced: true, sessionLost: false };
            };
            store.pause();
            await vi.advanceTimersByTimeAsync(0);

            expect(get(store).isPlaying).toBe(false);
            expect(get(store).playbackSessionId).toBe('abs-session-2');
            expect(heartbeats).toEqual([
                {
                    playbackSessionId: 'abs-session-1',
                    mediaId: 'media-uuid',
                    status: 'PAUSED',
                    bookPositionMs: 0,
                },
                {
                    playbackSessionId: 'abs-session-2',
                    mediaId: 'media-uuid',
                    status: 'PAUSED',
                    bookPositionMs: 0,
                },
            ]);
        });

        it('resume after a no-autoplay load actually loads a source', async () => {
            const { deps } = makeDeps([directPayload({ startPositionMs: 400_000 })]);
            store.configure({ deps });
            await store.load('media-uuid', { autoplay: false });
            expect(mockBackend.lastPlay).toBeNull();

            await store.resume();

            // Otherwise the store reports "playing" over an empty deck.
            expect(mockBackend.lastPlay?.src).toContain('/files/1');
            expect(mockBackend.lastPlay?.startAtMs).toBeCloseTo(400_000, 3);
        });

        it('does not arm the advance scheduler while paused', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            store.pause();
            mockBackend.lastAdvance = null;

            await store.seekTo(120_000);

            // A paused deck never reaches its boundary; arming would spin the
            // scheduler's 25 ms poll until the next resume.
            expect(mockBackend.lastAdvance).toBeNull();
        });
    });

    describe('playback rate', () => {
        it('states pitch preservation explicitly and clamps to 0.5–3x', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            store.setPlaybackRate(2);
            expect(mockBackend.rates.at(-1)).toEqual({ rate: 2, preservePitch: true });

            store.setPlaybackRate(9);
            expect(get(store).playbackRate).toBe(3);
            store.setPlaybackRate(0.1);
            expect(get(store).playbackRate).toBe(0.5);
        });

        it('survives a file-boundary advance', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            store.setPlaybackRate(1.75);

            mockBackend.callbacks.onGaplessAdvanceCommitted?.({ src: 'x', positionMs: 0 });

            expect(get(store).playbackRate).toBe(1.75);
            expect(mockBackend.lastAdvance?.playbackRate).toBe(1.75);
        });

        it('carries into the cold-start advance path too', async () => {
            mockBackend = makeMockBackend(false);
            store.destroy();
            store = createAudiobookPlayerStore();
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            store.setPlaybackRate(1.25);

            await mockBackend.callbacks.onTrackEnded?.();

            expect(mockBackend.lastPlay?.playbackRate).toBe(1.25);
        });
    });

    describe('volume', () => {
        it('defaults to volume 1, not muted, and reports backend support', async () => {
            store.configure({ deps: makeDeps([directPayload()]).deps });
            await store.load('media-uuid');

            const state = get(store);
            expect(state.volume).toBe(1);
            expect(state.isMuted).toBe(false);
            expect(state.supportsVolumeControl).toBe(true);
        });

        it('setVolume updates state, clamps to [0,1], and calls the backend', async () => {
            store.configure({ deps: makeDeps([directPayload()]).deps });
            await store.load('media-uuid');
            mockBackend.volumeCalls = [];

            store.setVolume(0.3);
            expect(get(store).volume).toBeCloseTo(0.3);
            expect(get(store).isMuted).toBe(false);
            expect(mockBackend.volumeCalls).toEqual([0.3]);

            store.setVolume(5); // out of range
            expect(get(store).volume).toBe(1);

            store.setVolume(-1); // out of range
            expect(get(store).volume).toBe(0);
        });

        it('setVolume(0) marks the player muted', async () => {
            store.configure({ deps: makeDeps([directPayload()]).deps });
            await store.load('media-uuid');

            store.setVolume(0);
            expect(get(store).isMuted).toBe(true);
        });

        it('toggleMute silences the backend and remembers the volume to restore', async () => {
            store.configure({ deps: makeDeps([directPayload()]).deps });
            await store.load('media-uuid');
            store.setVolume(0.6);
            mockBackend.muteCalls = [];

            // toggleMute() must go through mute()/unmute(), not setVolume(0) —
            // PlainAudioBackend.setVolume() is a documented no-op on iOS
            // (HTMLMediaElement.volume is ignored there), while mute()/unmute()
            // use the .muted property, which does work.
            store.toggleMute();
            expect(get(store).isMuted).toBe(true);
            expect(get(store).volume).toBeCloseTo(0.6); // remembered, not zeroed
            expect(mockBackend.muteCalls).toEqual([{ type: 'mute' }]);

            store.toggleMute();
            expect(get(store).isMuted).toBe(false);
            expect(get(store).volume).toBeCloseTo(0.6);
            expect(mockBackend.muteCalls).toEqual([
                { type: 'mute' },
                { type: 'unmute', restoreVolume: 0.6 },
            ]);
        });

        it('volume survives stop() the way playbackRate already does', async () => {
            store.configure({ deps: makeDeps([directPayload()]).deps });
            await store.load('media-uuid');
            store.setVolume(0.25);

            await store.stop();
            expect(get(store).volume).toBeCloseTo(0.25);
        });

        it('supportsVolumeControl survives stop() the way volume already does', async () => {
            mockBackend.supportsVolumeControl = false;
            store.configure({ deps: makeDeps([directPayload()]).deps });
            await store.load('media-uuid');
            expect(get(store).supportsVolumeControl).toBe(false);

            await store.stop();
            expect(get(store).supportsVolumeControl).toBe(false);
        });

        it('a backend without volume support is reflected in state', async () => {
            mockBackend.supportsVolumeControl = false;
            store.configure({ deps: makeDeps([directPayload()]).deps });
            await store.load('media-uuid');

            expect(get(store).supportsVolumeControl).toBe(false);
            // setVolume still updates local state even though the backend can't
            // act on it — same contract PlainAudioBackend.setVolume already has
            // (a documented no-op), the store doesn't need to special-case it.
            store.setVolume(0.4);
            expect(get(store).volume).toBeCloseTo(0.4);
        });
    });

    describe('end of book', () => {
        it('reports completion immediately when the book was simply played out', async () => {
            const { deps, reports } = makeDeps([
                directPayload({ startPositionMs: TIMELINE.tracks[4].startOffsetMs }),
            ]);
            store.configure({ deps });
            await store.load('media-uuid');
            for (let t = 0; t <= 5_000; t += 100) {
                mockBackend.tick(TIMELINE.tracks[4].durationMs - 5_000 + t);
            }

            await mockBackend.callbacks.onTrackEnded?.();
            await vi.advanceTimersByTimeAsync(0);

            // No seek means no open dwell, so the one report that marks a book
            // read is not withheld by the interval throttle either.
            expect(reports.at(-1)).toMatchObject({
                playbackSessionId: 'abs-session-1',
                status: 'COMPLETED',
                isFinished: true,
            });
            expect(get(store).isPlaying).toBe(false);
        });
    });

    // backend.play() rejects with MediaPlaybackError on a failed source (HTTP
    // 4xx/5xx, network, undecodable body). load() already catches that; every
    // OTHER path that starts a source used to leave it an unhandled rejection
    // over a player still claiming to play.
    describe('a stream that fails to play', () => {
        let toastError: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            toastError = vi.spyOn(toasts, 'error').mockImplementation(() => 0);
        });

        afterEach(() => {
            toastError.mockRestore();
        });

        /** Make every play() whose src matches reject the way a 500 does. */
        function failPlaysMatching(fragment: string): void {
            const realPlay = mockBackend.play.bind(mockBackend);
            mockBackend.play = async (src, meta, options) => {
                if (src.includes(fragment)) {
                    throw new MediaPlaybackError(4, 'MEDIA_ERR_SRC_NOT_SUPPORTED');
                }
                return realPlay(src, meta, options);
            };
        }

        function expectStoppedWithError(closes: unknown[]): void {
            const state = get(store);
            expect(state.isPlaying).toBe(false);
            expect(state.error?.kind).toBe('playback_failed');
            expect(state.book).toBeNull();
            expect(getAudioOwner()).toBeNull();
            // The session must not stay open for a book nothing is playing.
            expect(closes).toHaveLength(1);
            // Both player surfaces unmount with book === null, so the toast is
            // the only place the listener learns anything went wrong.
            expect(toastError).toHaveBeenCalledTimes(1);
            expect(toastError).toHaveBeenCalledWith(
                m.audiobook_playback_failed(),
                expect.objectContaining({ diagnosticKey: 'audiobook_playback_failed' }),
            );
        }

        it('stops with an error when the next file fails at a file boundary', async () => {
            mockBackend = makeMockBackend(false);
            store.destroy();
            store = createAudiobookPlayerStore();
            const { deps, closes } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            const stop = vi.spyOn(mockBackend, 'stop');
            failPlaysMatching('/files/2');

            mockBackend.callbacks.onTrackEnded?.();
            await vi.advanceTimersByTimeAsync(0);

            expect(stop).toHaveBeenCalled();
            expectStoppedWithError(closes);
        });

        it('stops with an error when resume() loads a source that fails', async () => {
            const { deps, closes } = makeDeps([directPayload({ startPositionMs: 400_000 })]);
            store.configure({ deps });
            await store.load('media-uuid', { autoplay: false });
            failPlaysMatching('/files/1');

            await expect(store.resume()).resolves.toBeUndefined();
            await vi.advanceTimersByTimeAsync(0);

            expectStoppedWithError(closes);
        });

        it('stops with an error when a transcode resume() fails', async () => {
            const { deps, closes } = makeDeps([transcodePayload()]);
            const el = document.createElement('audio');
            vi.spyOn(el, 'canPlayType').mockReturnValue('maybe');
            vi.spyOn(document, 'createElement').mockReturnValue(el);
            store.configure({ deps });
            await store.load('media-uuid', { autoplay: false });
            vi.mocked(document.createElement).mockRestore();
            failPlaysMatching('/hls/');

            await expect(store.resume()).resolves.toBeUndefined();
            await vi.advanceTimersByTimeAsync(0);

            expectStoppedWithError(closes);
        });

        it('stops with an error when a restart-on-seek fails', async () => {
            const { deps, closes } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            failPlaysMatching('/files/2');

            await expect(store.seekTo(BOUNDARY_2 + 60_000)).resolves.toBeUndefined();
            await vi.advanceTimersByTimeAsync(0);

            expectStoppedWithError(closes);
        });

        it('stops with an error on a mid-stream failure after play() returned', async () => {
            const { deps, closes } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            expect(get(store).isPlaying).toBe(true);

            mockBackend.callbacks.onPlaybackError?.(new MediaPlaybackError(2, 'MEDIA_ERR_NETWORK'));
            await vi.advanceTimersByTimeAsync(0);

            expectStoppedWithError(closes);
        });

        it('ignores a playback error when no book is loaded', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');
            await store.stop();

            mockBackend.callbacks.onPlaybackError?.(new MediaPlaybackError(2, 'MEDIA_ERR_NETWORK'));

            expect(get(store).error).toBeNull();
            expect(toastError).not.toHaveBeenCalled();
        });

        it('does not tear down a newer book when a superseded seek fails late', async () => {
            const { deps, closes } = makeDeps([
                directPayload(),
                directPayload({ playbackSessionId: 'abs-session-2', mediaId: 'other-book' }),
            ]);
            store.configure({ deps });
            await store.load('media-uuid');

            let failSeek!: () => void;
            const realPlay = mockBackend.play.bind(mockBackend);
            mockBackend.play = (src, meta, options) =>
                src.includes('/files/2')
                    ? new Promise<void>((_resolve, reject) => {
                          failSeek = () =>
                              reject(new MediaPlaybackError(4, 'MEDIA_ERR_SRC_NOT_SUPPORTED'));
                      })
                    : realPlay(src, meta, options);

            const seek = store.seekTo(BOUNDARY_2 + 60_000);
            expect(await store.load('other-book')).toBe(true);
            failSeek();
            await seek;
            await vi.advanceTimersByTimeAsync(0);

            const state = get(store);
            expect(state.mediaId).toBe('other-book');
            expect(state.isPlaying).toBe(true);
            expect(state.error).toBeNull();
            expect(getAudioOwner()).toBe('audiobook');
            // Only the first book's session, closed by the switch itself.
            expect(closes.map((c) => c.playbackSessionId)).toEqual(['abs-session-1']);
            expect(toastError).not.toHaveBeenCalled();
        });

        it('does not stop a newer seek when an older one on the same book fails late', async () => {
            const { deps, closes } = makeDeps([directPayload()]);
            store.configure({ deps });
            await store.load('media-uuid');

            let failFirstSeek!: () => void;
            const realPlay = mockBackend.play.bind(mockBackend);
            mockBackend.play = (src, meta, options) =>
                src.includes('/files/2')
                    ? new Promise<void>((_resolve, reject) => {
                          failFirstSeek = () =>
                              reject(new MediaPlaybackError(2, 'MEDIA_ERR_NETWORK'));
                      })
                    : realPlay(src, meta, options);

            const first = store.seekTo(BOUNDARY_2 + 60_000);
            // A second scrub, back into the first file, before the first landed.
            await store.seekTo(TIMELINE.tracks[0].startOffsetMs + 30_000);
            failFirstSeek();
            await first;
            await vi.advanceTimersByTimeAsync(0);

            expect(get(store).isPlaying).toBe(true);
            expect(get(store).error).toBeNull();
            expect(closes).toHaveLength(0);
            expect(toastError).not.toHaveBeenCalled();
        });

        it('leaves a failed load() to its caller, without a toast of its own', async () => {
            const { deps } = makeDeps([directPayload()]);
            store.configure({ deps });
            failPlaysMatching('/files/');

            expect(await store.load('media-uuid')).toBe(false);

            // playAudiobook()'s callers toast audiobookStartFailureMessage();
            // a second toast from the store would say the same thing twice.
            expect(get(store).error?.kind).toBe('session_failed');
            expect(toastError).not.toHaveBeenCalled();
        });
    });
});

// These two used to call `needsTranscodeDespiteNegotiation`, a whole-timeline
// wrapper whose only remaining callers were these assertions — the load path that
// used it was deleted with the `forceTranscode` re-open block, so they pinned
// behaviour no caller could reach. They now drive `trackNeedsRemux`, which is what
// the player actually asks (via `useRemuxFor`), over the same timeline input.
describe('codec negotiation ABS cannot do', () => {
    it('flags an E-AC-3 track when the engine cannot decode it', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 100, codec: 'eac3' }],
            [],
        );
        const el = document.createElement('audio');
        vi.spyOn(el, 'canPlayType').mockReturnValue('');
        // ABS negotiates on MIME type only, and an E-AC-3 track inside an m4b
        // advertises audio/mp4 — so this check is the client's job or Chromium
        // throws EncodingError on a book that "direct plays".
        expect(timeline.tracks.some((track) => trackNeedsRemux(track, el))).toBe(true);
    });

    it('leaves it alone where the engine does decode it', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 100, codec: 'eac3' }],
            [],
        );
        const el = document.createElement('audio');
        vi.spyOn(el, 'canPlayType').mockReturnValue('probably');
        expect(timeline.tracks.some((track) => trackNeedsRemux(track, el))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The E-AC-3 remux path
// ---------------------------------------------------------------------------
//
// 39 of 3384 files in the measured library are E-AC-3 inside an `.m4b`.
// AudiobookShelf direct-plays them (its negotiation matches bare container MIME
// types), and real Chrome then fails with `EncodingError: Unable to decode audio
// data` while real WebKit plays them — both measured through Playwright.
//
// What this used to do was re-open the session with `forceTranscode`, get an ABS
// HLS playlist, and then hard-error on every engine but Safari because nothing
// here plays HLS. These cases pin the replacement.

describe('E-AC-3 remux', () => {
    let store: ReturnType<typeof createAudiobookPlayerStore>;
    let canPlay: ReturnType<typeof vi.spyOn>;

    /** Two E-AC-3 files, annotated by the SAME function the endpoint uses. */
    function eac3Payload(
        overrides: Partial<AudiobookSessionPayload> & { grantToken?: string } = {},
    ): AudiobookSessionPayload {
        const tracks = annotateRemuxTracks(
            projectAbsTracks([
                { index: 1, ino: 'a', startOffset: 0, duration: 100, codec: 'eac3' },
                { index: 2, ino: 'b', startOffset: 100, duration: 100, codec: 'eac3' },
            ]),
            // The PERSISTED per-file codec map, which is what the server decides
            // from — not the container MIME type.
            { a: 'eac3', b: 'eac3' },
        );
        return withStart({
            playbackSessionId: 'abs-session-1',
            mediaId: 'media-uuid',
            playMethod: 'direct',
            grantToken: 'stream_abc',
            tracks: toPlaybackTracks(tracks),
            chapters: [],
            startPositionMs: 0,
            durationMs: 200_000,
            book: BOOK,
            ...overrides,
        });
    }

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        resetAudioExclusivity();
        mockBackend = makeMockBackend(true);
        backendGate = null;
        // happy-dom answers '' for every type, which IS the Chrome answer for
        // `audio/mp4; codecs="ec-3"`. Spied anyway so each case states the engine
        // it is describing rather than relying on the DOM double's default.
        canPlay = vi.spyOn(window.HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
        store = createAudiobookPlayerStore();
    });

    afterEach(() => {
        store.destroy();
        canPlay.mockRestore();
        vi.useRealTimers();
    });

    it('serves the file through the remux route on an engine that cannot decode it', async () => {
        const { deps, opens } = makeDeps([eac3Payload()]);
        store.configure({ deps });
        await store.load('media-uuid');

        expect(mockBackend.lastPlay?.src).toContain('/api/v1/audiobooks/media-uuid/remux/1');
        expect(mockBackend.lastPlay?.src).toContain('grant=stream_abc');
        // The ABS session id is what pins every spawned ffmpeg to a live
        // play_sessions row, which is what makes the job visible in admin.
        expect(mockBackend.lastPlay?.src).toContain('PlaySessionId=abs-session-1');
        expect(mockBackend.lastPlay?.src).toContain('startPositionSeconds=0');
        // NO second session: the old path opened one with forceTranscode and then
        // died on Chrome because it got HLS back.
        expect(opens).toHaveLength(1);
        expect(opens[0].requestedMethod).toBeFalsy();
        expect(get(store).error).toBeNull();
    });

    it('uses the server-selected remux even when this engine could decode the original', async () => {
        // WebKit: canPlayType('audio/mp4; codecs="ec-3"') === 'probably'
        // (measured). Remuxing there would burn CPU to produce something worse.
        canPlay.mockReturnValue('probably');
        const { deps } = makeDeps([eac3Payload()]);
        store.configure({ deps });
        await store.load('media-uuid');

        expect(mockBackend.lastPlay?.src).toContain('/api/v1/audiobooks/media-uuid/remux/1');
        expect(mockBackend.lastPlay?.src).toContain('grant=stream_abc');
    });

    it('spends the start offset on the URL, not on an element seek', async () => {
        const { deps } = makeDeps([eac3Payload({ startPositionMs: 30_000 })]);
        store.configure({ deps });
        await store.load('media-uuid');

        // A piped encode answers no Range, so there is nothing to seek within.
        expect(mockBackend.lastPlay?.startAtMs).toBe(0);
        expect(mockBackend.lastPlay?.src).toContain('startPositionSeconds=30');
    });

    it('keeps book position correct across the remux offset', async () => {
        // The remux stream STARTS at the offset, so element time 0 is 30 s into
        // the file. Rebasing on the file's own start instead would under-report
        // by exactly the offset — and the dwell gate would then push that wrong
        // position into AudiobookShelf's last-write-wins progress row.
        const { deps } = makeDeps([eac3Payload({ startPositionMs: 30_000 })]);
        store.configure({ deps });
        await store.load('media-uuid');

        mockBackend.tick(0);
        expect(get(store).bookPositionMs).toBe(30_000);

        mockBackend.tick(5_000);
        expect(get(store).bookPositionMs).toBe(35_000);
    });

    it('RESTARTS the stream on a same-file seek instead of seeking the element', async () => {
        const { deps } = makeDeps([eac3Payload()]);
        store.configure({ deps });
        await store.load('media-uuid');

        await store.seekTo(45_000);

        // An element seek on a non-seekable stream either does nothing or wedges
        // the element at 0, so the offset has to move to a new request.
        expect(mockBackend.seeks).toEqual([]);
        expect(mockBackend.lastPlay?.src).toContain('/remux/1');
        expect(mockBackend.lastPlay?.src).toContain('startPositionSeconds=45');
        expect(mockBackend.lastPlay?.startAtMs).toBe(0);
        expect(get(store).bookPositionMs).toBe(45_000);
    });

    it('still element-seeks a book that needs no remux', async () => {
        // The control: without this, a bug that routed EVERY seek through a
        // restart would pass every case above.
        const { deps } = makeDeps([directPayload()]);
        store.configure({ deps });
        await store.load('media-uuid');
        const before = mockBackend.lastPlay?.src;

        await store.seekTo(5_000);

        expect(mockBackend.seeks).toEqual([5_000]);
        expect(mockBackend.lastPlay?.src).toBe(before);
    });

    it('preloads the NEXT file through the remux route too', async () => {
        const { deps } = makeDeps([eac3Payload()]);
        store.configure({ deps });
        await store.load('media-uuid');

        expect(mockBackend.lastAdvance?.src).toContain('/api/v1/audiobooks/media-uuid/remux/2');
        // An advance starts at the head of the file, which is also why
        // onAdvanceCommitted can keep rebasing on the track's own start offset.
        expect(mockBackend.lastAdvance?.src).toContain('startPositionSeconds=0');
        expect(mockBackend.lastAdvance?.startAtMs).toBe(0);
    });

    it('uses the server-selected delivery for each file in a mixed book', async () => {
        // A mixed book: only the flagged-and-undecodable file is remuxed.
        canPlay.mockImplementation((type: string) =>
            type === 'audio/mp4; codecs="ec-3"' ? 'probably' : '',
        );
        const mixed = annotateRemuxTracks(
            projectAbsTracks([
                { index: 1, ino: 'a', startOffset: 0, duration: 100, codec: 'eac3' },
                { index: 2, ino: 'b', startOffset: 100, duration: 100, codec: 'wmav2' },
            ]),
            { a: 'eac3', b: 'wmav2' },
        );
        const { deps } = makeDeps([eac3Payload({ tracks: toPlaybackTracks(mixed) })]);
        store.configure({ deps });
        await store.load('media-uuid');

        // eac3 is playable on this engine → direct.
        expect(mockBackend.lastPlay?.src).toContain('/remux/1');
        // wmav2 has no playable type on any engine measured → remux.
        expect(mockBackend.lastAdvance?.src).toContain('/remux/2');
    });
});

describe('audiobookRemuxUrl', () => {
    it('carries the token, the session and the offset in seconds', () => {
        expect(
            audiobookSeekUrl(
                '/api/v1/audiobooks/m%201/remux/1?grant=stream_x&PlaySessionId=sess%201',
                90_500,
            ),
        ).toBe(
            '/api/v1/audiobooks/m%201/remux/1?grant=stream_x&PlaySessionId=sess+1&startPositionSeconds=90.5',
        );
    });

    it('never emits a negative offset', () => {
        expect(audiobookSeekUrl('/api/v1/audiobooks/m/remux/1?grant=t', -5)).toContain(
            'startPositionSeconds=0',
        );
    });
});

describe('public audiobook fixture contract', () => {
    it('contains milliseconds and URLs without exposing file inodes', () => {
        const track = directPayload().tracks[0];
        expect(track.url).toBeTruthy();
        expect(track).toHaveProperty('startMs');
        expect(track).toHaveProperty('durationMs');
        expect(track).not.toHaveProperty('ino');
        expect(track).not.toHaveProperty('startOffset');
    });
    it('identifies the Lumastra playback session in reports', () => {
        expect(directPayload()).toHaveProperty('playbackSessionId');
        expect(directPayload()).not.toHaveProperty('absSessionId');
    });
});
