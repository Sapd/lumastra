// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `POST /api/items/:id/play` against the REAL AudiobookShelf.
 *
 * Two claims in `audiobook-session.service.ts` and the player store are
 * behavioural facts about somebody else's server, not properties of our code,
 * so they can only be pinned here:
 *
 *  1. **A requested start offset is ignored** — the session's `startTime` comes
 *     from the caller's own saved progress. The whole reason `positionMs` is
 *     answered to the CLIENT rather than pushed upstream.
 *  2. **A transcode session's playlist spans the WHOLE book** — one track,
 *     `startOffset: 0`, the book's full duration, and an `#EXTINF` sum equal to
 *     that duration, no matter what `startTime` was. The whole reason
 *     `fileBaseMs` is 0 on the transcode path.
 *
 * If AudiobookShelf ever changes either, this test goes red and the two
 * comments that depend on it stop being true — which is the point. A unit test
 * with a stubbed client would keep passing forever.
 *
 * Env-gated, so it skips silently in CI:
 *
 * ```
 * AUDIOURL=… AUDIOAPIKEY=… \
 *   npm run test:integration src/lib/server/audiobookshelf.play-session.live.integration.test.ts
 * ```
 *
 * Optional: `AUDIOBOOKSHELF_TEST_ITEM_ID` pins a specific book; otherwise the
 * first multi-file book of the first library is used.
 *
 * **This test writes.** It moves the operator account's own progress for the
 * chosen book to prove claim 1, and restores the prior value in `afterAll`. It
 * closes every session it opens.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE = (process.env.AUDIOURL ?? '').replace(/\/+$/, '');
const KEY = process.env.AUDIOAPIKEY ?? '';
const SKIP = !BASE || !KEY;

const H = {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
};

/** 2 h in, comfortably inside any book long enough to be worth testing. */
const PROBE_POSITION_SECONDS = 7200;

interface PlayTrack {
    index: number;
    ino?: string;
    startOffset: number;
    duration: number;
    contentUrl: string;
    mimeType?: string;
}

interface PlaySession {
    id: string;
    playMethod: number;
    duration: number;
    startTime: number;
    currentTime: number;
    audioTracks: PlayTrack[];
    chapters: Array<{ start: number; end?: number; title?: string }>;
}

async function openSession(
    itemId: string,
    opts: { forceTranscode?: boolean; startTime?: number; deviceId: string },
): Promise<PlaySession> {
    const response = await fetch(`${BASE}/api/items/${itemId}/play`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
            deviceInfo: {
                deviceId: opts.deviceId,
                clientName: 'Lumastra-test',
                clientVersion: '0.0.0',
            },
            supportedMimeTypes: ['audio/mpeg', 'audio/mp4'],
            mediaPlayer: 'html5',
            forceTranscode: opts.forceTranscode === true,
            // Deliberately sent in the direct case, to prove it is ignored.
            ...(opts.startTime === undefined ? {} : { startTime: opts.startTime }),
        }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as PlaySession;
}

async function closeSession(sessionId: string): Promise<void> {
    await fetch(`${BASE}/api/session/${sessionId}/close`, {
        method: 'POST',
        headers: H,
        body: '{}',
    }).catch(() => {});
}

async function readProgress(itemId: string): Promise<{ currentTime: number } | null> {
    const me = (await (await fetch(`${BASE}/api/me`, { headers: H })).json()) as {
        mediaProgress?: Array<{ libraryItemId: string; currentTime: number }>;
    };
    return me.mediaProgress?.find((p) => p.libraryItemId === itemId) ?? null;
}

async function writeProgress(itemId: string, currentTime: number, duration: number): Promise<void> {
    await fetch(`${BASE}/api/me/progress/${itemId}`, {
        method: 'PATCH',
        headers: H,
        body: JSON.stringify({ currentTime, duration }),
    });
}

describe.skipIf(SKIP)('AudiobookShelf play session (live)', () => {
    let itemId: string;
    let duration: number;
    let originalProgress: number | null = null;
    const openedSessions: string[] = [];

    beforeAll(async () => {
        if (process.env.AUDIOBOOKSHELF_TEST_ITEM_ID) {
            itemId = process.env.AUDIOBOOKSHELF_TEST_ITEM_ID;
        } else {
            const libs = (await (await fetch(`${BASE}/api/libraries`, { headers: H })).json()) as {
                libraries: Array<{ id: string }>;
            };
            const items = (await (
                await fetch(
                    `${BASE}/api/libraries/${libs.libraries[0].id}/items?limit=25&minified=1`,
                    {
                        headers: H,
                    },
                )
            ).json()) as {
                results: Array<{ id: string; media: { duration: number; numAudioFiles?: number } }>;
            };
            // A book long enough that 2 h is inside it — otherwise claim 1's
            // probe position clamps and proves nothing.
            const candidate = items.results.find(
                (r) => r.media.duration > PROBE_POSITION_SECONDS * 2,
            );
            expect(candidate, 'no book longer than 4 h in the first library').toBeDefined();
            itemId = candidate!.id;
        }

        const existing = await readProgress(itemId);
        originalProgress = existing?.currentTime ?? null;
    }, 30_000);

    afterAll(async () => {
        for (const id of openedSessions) await closeSession(id);
        // Put the operator account's progress back where it was. `null` means
        // there was no row; ABS has no delete-progress on this path, so the
        // closest restoration is 0.
        if (itemId) {
            await writeProgress(itemId, originalProgress ?? 0, duration || 1).catch(() => {});
        }
    }, 30_000);

    it('derives startTime from SAVED PROGRESS and ignores a requested one', async () => {
        await writeProgress(itemId, 0, 1);
        const atZero = await openSession(itemId, {
            deviceId: 'lumastra-live-1',
            // Ignored — this is the claim.
            startTime: 3600,
        });
        openedSessions.push(atZero.id);
        duration = atZero.duration;

        expect(atZero.startTime).toBe(0);
        await closeSession(atZero.id);

        await writeProgress(itemId, PROBE_POSITION_SECONDS, duration);
        const atProgress = await openSession(itemId, { deviceId: 'lumastra-live-1' });
        openedSessions.push(atProgress.id);

        // Asked for nothing, got the saved progress.
        expect(atProgress.startTime).toBeCloseTo(PROBE_POSITION_SECONDS, 0);
        await closeSession(atProgress.id);
    }, 60_000);

    it('a direct session addresses files by inode under /api/items', async () => {
        const session = await openSession(itemId, { deviceId: 'lumastra-live-2' });
        openedSessions.push(session.id);
        duration = session.duration;

        expect(session.playMethod).not.toBe(2);
        expect(session.audioTracks.length).toBeGreaterThan(0);
        for (const track of session.audioTracks) {
            expect(track.ino, 'a direct-play track must carry an inode').toBeTruthy();
            expect(track.contentUrl).toBe(`/api/items/${itemId}/file/${track.ino}`);
        }
        // Accumulated by the server, not re-derived — the first file starts at 0.
        expect(session.audioTracks[0].startOffset).toBe(0);

        await closeSession(session.id);
    }, 60_000);

    it('a transcode playlist spans the WHOLE book regardless of startTime', async () => {
        // Open at a position deep in the book. If the playlist were scoped to
        // the session's start offset, its duration and EXTINF sum would be the
        // REMAINDER, not the whole book — which is exactly the reading that put
        // a spurious `fileBaseMs` on the client's transcode path.
        await writeProgress(itemId, PROBE_POSITION_SECONDS, duration || 26_128);
        const session = await openSession(itemId, {
            deviceId: 'lumastra-live-3',
            forceTranscode: true,
        });
        openedSessions.push(session.id);
        duration = session.duration;

        expect(session.playMethod).toBe(2);
        expect(session.audioTracks).toHaveLength(1);

        const track = session.audioTracks[0];
        expect(track.startOffset).toBe(0);
        expect(track.duration).toBeCloseTo(session.duration, 3);
        expect(track.contentUrl).toBe(`/hls/${session.id}/output.m3u8`);
        expect(session.startTime).toBeCloseTo(PROBE_POSITION_SECONDS, 0);

        // The manifest itself, which is what the media element's clock is built
        // from. ABS serves /hls with no credential at all — asserted here too,
        // because that fact is the entire reason the byte proxy re-checks the
        // session id against our own play_sessions row.
        const playlistResponse = await fetch(`${BASE}${track.contentUrl}`);
        expect(playlistResponse.status).toBe(200);
        const playlist = await playlistResponse.text();

        const extinfSum = playlist
            .split('\n')
            .filter((line) => line.startsWith('#EXTINF:'))
            .reduce((total, line) => total + Number.parseFloat(line.slice('#EXTINF:'.length)), 0);
        expect(extinfSum).toBeCloseTo(session.duration, 1);

        // And it starts at segment 0, not at the segment covering startTime.
        expect(playlist).toContain('output-0.ts');

        await closeSession(session.id);
    }, 60_000);

    it('sync and close both acknowledge a live session', async () => {
        const session = await openSession(itemId, { deviceId: 'lumastra-live-4' });
        openedSessions.push(session.id);
        duration = session.duration;

        const sync = await fetch(`${BASE}/api/session/${session.id}/sync`, {
            method: 'POST',
            headers: H,
            body: JSON.stringify({ currentTime: 60, timeListened: 5, duration: session.duration }),
        });
        expect(sync.status).toBe(200);

        const close = await fetch(`${BASE}/api/session/${session.id}/close`, {
            method: 'POST',
            headers: H,
            body: JSON.stringify({ currentTime: 60, timeListened: 0, duration: session.duration }),
        });
        expect(close.status).toBe(200);

        // A second close is the "session already gone" case the client code
        // treats as non-fatal. Pinned so `syncSessionAs` returning false rather
        // than throwing stays justified.
        const again = await fetch(`${BASE}/api/session/${session.id}/sync`, {
            method: 'POST',
            headers: H,
            body: JSON.stringify({ currentTime: 60, timeListened: 0, duration: session.duration }),
        });
        expect(again.status).toBe(404);
    }, 60_000);
});
