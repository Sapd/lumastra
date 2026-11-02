// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * E2E: a Jellyfin client resuming mid-file must not run two encodes at once.
 *
 * jellyfin-androidtv resumes like this (prod 2026-10-02): PlaybackInfo carries
 * StartTimeTicks, so the server starts transcoding at the resume point T; then
 * ExoPlayer requests segment 0 first and only afterwards jumps to T. The probe
 * used to start a second encode at 0 next to the one at T, and the jump spawned
 * a THIRD and threw the first away — with a 4K HDR burn-in, ~23 s to resume.
 *
 * Now the generation started at T is parked while the probe reads segment 0 and
 * reclaimed when the client returns: the job serving T after the jump is the
 * very job that was started for it. A real seek to 0 (the client keeps reading
 * from the start) still moves playback to 0.
 *
 * Everything over HTTP against the real server and FFmpeg: Quick Connect for a
 * /j token, PlaybackInfo, the /j master playlist and segments, and
 * /api/admin/ffmpeg-jobs to see which job is current.
 *
 * Run with: npm run test:e2e:api -- jellyfin-compat-resume-probe
 */

import type { APIRequestContext } from '@playwright/test';
import { sameOriginAdminTest as test, expect } from './fixtures/auth';
import {
    LONG_FIXTURE_SECONDS,
    TRANSCODE_ONLY_PROFILE,
    endJellyfinPlayback,
    jellyfinToken as quickConnectToken,
    seedLongFixtureMovie,
} from './helpers/jellyfin-compat';

const ITEM_ID = 'e2e00000-0000-4000-8000-0000000000ab';
/** 240 s tracked fixture: resume at 120 s. */
const FIXTURE_SECONDS = LONG_FIXTURE_SECONDS;
const RESUME_SECONDS = 120;
const DEVICE_PROFILE = TRANSCODE_ONLY_PROFILE;

const jellyfinToken = (request: APIRequestContext) =>
    quickConnectToken(request, 'e2e-resume-probe');
const seedLongVideo = () => seedLongFixtureMovie(ITEM_ID, 'E2E Resume Probe Video');

interface ResumedPlayback {
    playSessionId: string;
    segmentUrls: string[];
    resumeSegment: number;
}

/** PlaybackInfo with StartTimeTicks, then the master playlist — as Android TV does. */
async function startResumedPlayback(
    request: APIRequestContext,
    token: string,
): Promise<ResumedPlayback | null> {
    const headers = { 'X-Emby-Token': token, 'X-Forwarded-User': '' };
    const info = await request.post(
        `/j/Items/${ITEM_ID}/PlaybackInfo?StartTimeTicks=${RESUME_SECONDS * 10_000_000}&IsPlayback=true`,
        { headers, data: { DeviceProfile: DEVICE_PROFILE } },
    );
    expect(info.ok(), `PlaybackInfo ${info.status()}`).toBe(true);
    const body = (await info.json()) as {
        PlaySessionId: string;
        MediaSources: Array<{ TranscodingUrl?: string }>;
    };
    const transcodingUrl = body.MediaSources[0]?.TranscodingUrl;
    expect(transcodingUrl, 'a transcode-only profile must get a TranscodingUrl').toBeTruthy();
    expect(transcodingUrl).toContain('StartTimeTicks=');

    const master = await request.get(`/j${transcodingUrl}`, { headers });
    if (master.status() === 503) {
        const reason = await master.text();
        // Only a server without FFmpeg may skip; any other 503 is a failure.
        if (reason.includes('HLS transcoding is not enabled')) return null;
        throw new Error(`master.m3u8 503: ${reason}`);
    }
    expect(master.ok(), `master.m3u8 ${master.status()}`).toBe(true);
    const playlist = await master.text();
    // Segment length is the server's FFMPEG_SEGMENT_DURATION: read it from the
    // playlist instead of assuming one, and find the segment holding T.
    const segmentUrls: string[] = [];
    const starts: number[] = [];
    let elapsed = 0;
    let pending: number | undefined;
    for (const raw of playlist.split('\n')) {
        const line = raw.trim();
        const extinf = /^#EXTINF:([\d.]+)/.exec(line);
        if (extinf) pending = Number(extinf[1]);
        else if (line && !line.startsWith('#')) {
            segmentUrls.push(line);
            starts.push(elapsed);
            elapsed += pending ?? 0;
            pending = undefined;
        }
    }
    // The whole film, not "film minus the resume point": the client seeks to T
    // inside this playlist (segment names are absolute).
    expect(elapsed).toBeGreaterThanOrEqual(FIXTURE_SECONDS - 6);
    expect(segmentUrls.length).toBeGreaterThan(8);
    const resumeSegment = starts.findLastIndex((start) => start <= RESUME_SECONDS);
    // Far enough in that the probe at 0 cannot reach it on its own.
    expect(resumeSegment).toBeGreaterThan(6);
    const playSessionId = new URL(segmentUrls[0], 'http://x').searchParams.get('PlaySessionId');
    expect(playSessionId).toBeTruthy();
    return {
        playSessionId: playSessionId!,
        segmentUrls,
        resumeSegment,
    };
}

interface AdminJob {
    jobId: string;
    playSessionId: string;
    segmentOffset: number;
    seekCount: number;
}

async function currentJob(
    request: APIRequestContext,
    playSessionId: string,
): Promise<AdminJob | undefined> {
    const res = await request.get('/api/admin/ffmpeg-jobs');
    expect(res.ok(), `ffmpeg-jobs ${res.status()}`).toBe(true);
    const { jobs } = (await res.json()) as { jobs: AdminJob[] };
    const fold = (id: string) => id.replace(/-/g, '').toLowerCase();
    return jobs.find((job) => fold(job.playSessionId) === fold(playSessionId));
}

async function getSegment(request: APIRequestContext, url: string, token: string): Promise<number> {
    const res = await request.get(url.startsWith('/') ? url : `/j/Videos/${ITEM_ID}/${url}`, {
        headers: { 'X-Emby-Token': token, 'X-Forwarded-User': '' },
        timeout: 90_000,
    });
    return res.status();
}

test.describe('/j resume probe (Android TV: segment 0 first, then the resume point)', () => {
    test.describe.configure({ mode: 'serial', timeout: 240_000 });

    test.beforeAll(async () => {
        await seedLongVideo();
    });

    test('the jump back to the resume point spawns no third encode', async ({ request }) => {
        const token = await jellyfinToken(request);
        const playback = await startResumedPlayback(request, token);
        test.skip(!playback, 'HLS transcoding is not available on this server');
        const { playSessionId, segmentUrls, resumeSegment } = playback!;
        try {
            const started = await currentJob(request, playSessionId);
            expect(started, 'the master playlist starts a job').toBeTruthy();
            expect(started!.segmentOffset).toBeGreaterThanOrEqual(resumeSegment - 1);

            // ExoPlayer's probe: segments 0 and 1 first.
            expect(await getSegment(request, segmentUrls[0], token)).toBe(200);
            expect(await getSegment(request, segmentUrls[1], token)).toBe(200);
            expect((await currentJob(request, playSessionId))?.segmentOffset).toBe(0);

            // Then the jump to the resume point. It is served by the generation
            // started for it — reclaimed while still encoding, or straight from
            // its files once it finished (a fast host encodes this fixture in
            // seconds) — never by a third encode. The parked/reclaimed process
            // states are asserted with a never-ending encode in
            // ffmpeg-transcode.service.probe-reclaim.integration.test.ts.
            expect(await getSegment(request, segmentUrls[resumeSegment + 1], token)).toBe(200);
            const after = await currentJob(request, playSessionId);
            expect(after, 'the session is still playing').toBeTruthy();
            expect(after!.seekCount).toBeLessThanOrEqual(1);
            expect([0, started!.segmentOffset]).toContain(after!.segmentOffset);

            // And it keeps playing from there.
            expect(await getSegment(request, segmentUrls[resumeSegment + 2], token)).toBe(200);
        } finally {
            await endJellyfinPlayback(request, token, ITEM_ID, playSessionId);
        }
    });

    test('a real seek to 0 keeps playing from the start', async ({ request }) => {
        const token = await jellyfinToken(request);
        const playback = await startResumedPlayback(request, token);
        test.skip(!playback, 'HLS transcoding is not available on this server');
        const { playSessionId, segmentUrls } = playback!;
        try {
            for (const index of [0, 1, 2, 3]) {
                expect(await getSegment(request, segmentUrls[index], token)).toBe(200);
            }
            const after = await currentJob(request, playSessionId);
            expect(after?.segmentOffset).toBe(0);
            expect(after!.seekCount).toBe(1);
        } finally {
            await endJellyfinPlayback(request, token, ITEM_ID, playSessionId);
        }
    });
});
