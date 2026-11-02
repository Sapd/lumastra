// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * truncated_video detection (Windows e2e 2026-09-27, S3): the last KEYFRAME
 * is up to a GOP before the real end, so short files with a ~10 s keyint were
 * all flagged "damaged".
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import {
    assessTruncation,
    clearFalseTruncationIssues,
    detectHealthIssues,
    isMaterialStreamLoss,
} from './media-probe.js';

const probeStreamTailsMock = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/utils/ffprobe.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/ffprobe.js')>()),
    probeStreamTails: (...args: unknown[]) => probeStreamTailsMock(...args),
}));

// The reported clip: container 15.023 s, last frame 14.958 s, keyframes 0 / 10.417.
const CLIP_KEYFRAMES = [0, 10.417];
const CLIP_DURATION = 15.023;
const CLIP_LAST_FRAME = 14.958;

beforeEach(() => {
    probeStreamTailsMock.mockReset();
    probeStreamTailsMock.mockResolvedValue({
        success: true,
        videoEnd: 965,
        audioEnd: null,
        hasAudio: false,
        endedPrematurely: false,
    });
});

describe('isMaterialStreamLoss', () => {
    // Measured on prod 2026-10-21: 52 complete files whose container header
    // over-reports (subtitle tracks, old mkvmerge; one claims 13600 s for a
    // 1360 s episode) end video and audio together at the real runtime.
    it('ignores a complete file whose container over-reports (13600 s claimed, video 1355 s, audio 1360 s)', () => {
        expect(
            isMaterialStreamLoss({
                containerDuration: 13_600,
                videoEnd: 1_355,
                audioEnd: 1_360,
                hasAudio: true,
                endedPrematurely: false,
            }),
        ).toBe(false);
    });

    // Measured: 13 files really cut off; `File ended prematurely` on stderr.
    it('flags a premature EOF (container 10317 s, video and audio end at 988 s)', () => {
        expect(
            isMaterialStreamLoss({
                containerDuration: 10_317,
                videoEnd: 988,
                audioEnd: 988,
                hasAudio: true,
                endedPrematurely: true,
            }),
        ).toBe(true);
    });

    // Measured: 26 files where audio runs materially past the video end.
    it('flags audio that continues past the video end (container 1422 s, video 1203 s, audio 1419 s)', () => {
        expect(
            isMaterialStreamLoss({
                containerDuration: 1_422,
                videoEnd: 1_203,
                audioEnd: 1_419,
                hasAudio: true,
                endedPrematurely: false,
            }),
        ).toBe(true);
    });

    it('flags a video that ends well short of the container when there is no audio (600 s of 1400 s)', () => {
        expect(
            isMaterialStreamLoss({
                containerDuration: 1_400,
                videoEnd: 600,
                audioEnd: null,
                hasAudio: false,
                endedPrematurely: false,
            }),
        ).toBe(true);
    });

    it('does not flag a container that over-reports by less than the tolerance', () => {
        // gap 6 s is under max(10 s, 5 % of 1360 s = 68 s)
        expect(
            isMaterialStreamLoss({
                containerDuration: 1_360,
                videoEnd: 1_354,
                audioEnd: null,
                hasAudio: false,
                endedPrematurely: false,
            }),
        ).toBe(false);
    });
});

describe('detectHealthIssues with stream tails', () => {
    // A 1360 s episode whose container header claims 13600 s.
    const KEYFRAMES = Array.from({ length: 137 }, (_, i) => i * 10); // 0..1360 s

    it('still reports truncated_video without tails (backwards compatible)', () => {
        const issues = detectHealthIssues(KEYFRAMES, 13_600, 1_355);
        expect(issues.map((i) => i.type)).toEqual(['truncated_video']);
    });

    it('drops truncated_video when the stream tails show complete video and audio', () => {
        const issues = detectHealthIssues(KEYFRAMES, 13_600, 1_355, {
            videoEnd: 1_355,
            audioEnd: 1_360,
            hasAudio: true,
            endedPrematurely: false,
        });
        expect(issues).toEqual([]);
    });

    it('keeps truncation when aligned partial tails came from failed subprocesses', () => {
        expect(
            detectHealthIssues(KEYFRAMES, 13_600, 1_355, {
                success: false,
                videoEnd: 1_355,
                audioEnd: 1_360,
                hasAudio: true,
                endedPrematurely: false,
            }).map((issue) => issue.type),
        ).toEqual(['truncated_video']);
    });

    it('keeps truncated_video when the tails show a premature EOF', () => {
        const issues = detectHealthIssues(KEYFRAMES, 13_600, 1_355, {
            videoEnd: 1_355,
            audioEnd: 1_355,
            hasAudio: true,
            endedPrematurely: true,
        });
        expect(issues.map((i) => i.type)).toEqual(['truncated_video']);
    });
});

describe('assessTruncation', () => {
    it('does not flag the reported 15 s clip when the last packet PTS is known', () => {
        expect(assessTruncation(CLIP_KEYFRAMES, CLIP_DURATION, CLIP_LAST_FRAME).truncated).toBe(
            false,
        );
    });

    it('does not flag the reported clip from keyframes alone (one GOP of tolerance)', () => {
        expect(assessTruncation(CLIP_KEYFRAMES, CLIP_DURATION).truncated).toBe(false);
    });

    it('flags a real truncation: video stops at 16 min in a 3 h container', () => {
        const keyframes = Array.from({ length: 97 }, (_, i) => i * 10); // 0..960 s
        const r = assessTruncation(keyframes, 10_800, 965);
        expect(r.truncated).toBe(true);
        expect(r.videoEndSeconds).toBe(965);
        expect(assessTruncation(keyframes, 10_800).truncated).toBe(true);
    });

    it('flags a feature cut 15 min short when the last packet PTS is known', () => {
        const keyframes = Array.from({ length: 631 }, (_, i) => i * 10); // 0..6300 s
        expect(assessTruncation(keyframes, 7_200, 6_305).truncated).toBe(true);
    });

    it('tolerates a small tail (audio/subtitles a few seconds past the video)', () => {
        const keyframes = Array.from({ length: 720 }, (_, i) => i * 10);
        expect(assessTruncation(keyframes, 7_200, 7_192).truncated).toBe(false);
    });

    it('never flags with fewer than two keyframes and no packet PTS (GOP unknown)', () => {
        expect(assessTruncation([0], 15).truncated).toBe(false);
    });

    it('never flags without a usable container duration', () => {
        expect(assessTruncation([0, 10], null).truncated).toBe(false);
        expect(assessTruncation([0, 10], 0).truncated).toBe(false);
    });
});

describe('detectHealthIssues', () => {
    it('reports no issue for the reported clip', () => {
        expect(detectHealthIssues(CLIP_KEYFRAMES, CLIP_DURATION, CLIP_LAST_FRAME)).toEqual([]);
    });

    it('reports the real video end (not the last keyframe) as actual_duration', () => {
        const keyframes = Array.from({ length: 97 }, (_, i) => i * 10);
        const [issue] = detectHealthIssues(keyframes, 10_800, 965.4);
        expect(issue).toMatchObject({
            type: 'truncated_video',
            expected_duration: 10_800,
            actual_duration: 965,
        });
    });

    it('still reports no_keyframes', () => {
        expect(detectHealthIssues([], 100)).toEqual([
            expect.objectContaining({ type: 'no_keyframes' }),
        ]);
    });
});

describe('clearFalseTruncationIssues', () => {
    interface Call {
        text: string;
        values: unknown[];
    }

    function makeSql(rows: Array<{ id: string; health_issues: Array<Record<string, unknown>> }>): {
        sql: postgres.Sql<Record<string, never>>;
        calls: Call[];
        current: Map<string, Array<Record<string, unknown>>>;
    } {
        const calls: Call[] = [];
        const current = new Map(rows.map((row) => [row.id, [...row.health_issues]]));
        let selects = 0;
        const tag = ((strings: TemplateStringsArray | string, ...values: unknown[]) => {
            // postgres.js also accepts identifier calls in composed predicates.
            if (typeof strings === 'string') return strings;
            const text = strings.join('?');
            calls.push({ text, values });
            if (/SELECT id, keyframes/.test(text)) {
                selects++;
                return Promise.resolve(selects === 1 ? rows : []);
            }
            if (/SELECT health_issues/.test(text)) {
                return Promise.resolve([{ health_issues: current.get(values[0] as string) }]);
            }
            if (/RETURNING health_issues/.test(text)) {
                const reviewed = values[0] as Array<Record<string, unknown>>;
                const id = values[1] as string;
                const remaining = (current.get(id) ?? []).filter(
                    (issue) => !reviewed.some((r) => JSON.stringify(r) === JSON.stringify(issue)),
                );
                current.set(id, remaining);
                return Promise.resolve([{ health_issues: remaining.length ? remaining : null }]);
            }
            return Promise.resolve(Object.assign([], { count: 1 }));
        }) as unknown as postgres.Sql<Record<string, never>> & {
            begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
            json: (v: unknown) => unknown;
        };
        tag.json = vi.fn((v: unknown) => v) as unknown as typeof tag.json;
        tag.begin = ((fn: (tx: unknown) => Promise<unknown>) =>
            fn(tag)) as unknown as typeof tag.begin;
        return { sql: tag, calls, current };
    }

    it('clears a false truncated_video, resolves its failure events, keeps a real one', async () => {
        const falseRow = {
            id: '11111111-1111-1111-1111-111111111111',
            file_path: '/media/clip.mkv',
            keyframes: CLIP_KEYFRAMES,
            duration_seconds: CLIP_DURATION,
            health_issues: [
                {
                    type: 'truncated_video',
                    detected_at: 'x',
                    expected_duration: 15,
                    actual_duration: 10,
                },
            ],
        };
        const realRow = {
            id: '22222222-2222-2222-2222-222222222222',
            file_path: '/media/real.mkv',
            keyframes: Array.from({ length: 97 }, (_, i) => i * 10),
            duration_seconds: 10_800,
            health_issues: [{ type: 'truncated_video', detected_at: 'x' }],
        };
        probeStreamTailsMock.mockImplementation(async (path: string) => ({
            success: true,
            videoEnd: path === falseRow.file_path ? CLIP_LAST_FRAME : 965,
            audioEnd: null,
            hasAudio: false,
            endedPrematurely: false,
        }));
        const { sql, calls } = makeSql([falseRow, realRow]);

        const cleared = await clearFalseTruncationIssues(sql);

        expect(cleared).toBe(1);
        const updates = calls.filter((c) => /RETURNING health_issues/.test(c.text));
        expect(updates).toHaveLength(1);
        expect(updates[0].values).toContain(falseRow.id);
        const resolves = calls.filter((c) => /UPDATE plugin_failure_events/.test(c.text));
        expect(resolves).toHaveLength(1);
        expect(resolves[0].values).toEqual(expect.arrayContaining(['media-probe', falseRow.id]));
    });

    it('re-judges video_ends_early with the stream tails: clears a complete file, keeps a cut one', async () => {
        const overReported = {
            id: '33333333-3333-3333-3333-333333333333',
            file_path: '/media/overreported.mkv',
            keyframes: null,
            duration_seconds: 13_600,
            health_issues: [{ type: 'video_ends_early', detected_at: 'x' }],
        };
        const cut = {
            id: '44444444-4444-4444-4444-444444444444',
            file_path: '/media/cut.mkv',
            keyframes: null,
            duration_seconds: 1_400,
            health_issues: [{ type: 'video_ends_early', detected_at: 'x' }],
        };
        probeStreamTailsMock.mockImplementation(async (path: string) =>
            path === overReported.file_path
                ? {
                      success: true,
                      videoEnd: 1_355,
                      audioEnd: 1_360,
                      hasAudio: true,
                      endedPrematurely: false,
                  }
                : {
                      success: true,
                      videoEnd: 600,
                      audioEnd: null,
                      hasAudio: false,
                      endedPrematurely: false,
                  },
        );
        const { sql, calls } = makeSql([overReported, cut]);

        const cleared = await clearFalseTruncationIssues(sql);

        expect(cleared).toBe(1);
        expect(probeStreamTailsMock).toHaveBeenCalledWith(
            overReported.file_path,
            expect.objectContaining({ timeoutMs: 30_000 }),
        );
        expect(probeStreamTailsMock).toHaveBeenCalledWith(
            cut.file_path,
            expect.objectContaining({ timeoutMs: 30_000 }),
        );
        const updates = calls.filter((c) => /RETURNING health_issues/.test(c.text));
        expect(updates).toHaveLength(1);
        expect(updates[0].values).toContain(overReported.id);
        expect(updates[0].values).not.toContain(cut.id);
    });
    it('retains concurrent unrelated and newer same-type issues during scheduled cleanup', async () => {
        const early = { type: 'video_ends_early', detected_at: 'old' };
        const newer = { type: 'video_ends_early', detected_at: 'new' };
        const gap = { type: 'video_decode_gaps', detected_at: 'new' };
        const row = {
            id: '55555555-5555-5555-5555-555555555555',
            file_path: '/media/concurrent.mkv',
            keyframes: null,
            duration_seconds: 13_600,
            health_issues: [early],
        };
        const { sql, calls, current } = makeSql([row]);
        probeStreamTailsMock.mockImplementation(async () => {
            current.set(row.id, [early, newer, gap]);
            return {
                success: true,
                videoEnd: 1355,
                audioEnd: 1360,
                hasAudio: true,
                endedPrematurely: false,
            };
        });
        expect(await clearFalseTruncationIssues(sql)).toBe(1);
        expect(current.get(row.id)).toEqual([newer, gap]);
        expect(calls.some((call) => /pg_advisory_xact_lock/.test(call.text))).toBe(true);
        expect(calls.some((call) => /UPDATE plugin_failure_events/.test(call.text))).toBe(false);
    });
});
