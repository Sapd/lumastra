// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    resetPeerTakeoverMemoryForTests,
    restoreHlsJobIfMissing,
    settlePrewarmForTests,
} from './job-restoration.js';
import { isOutputMarkerPath } from './output-marker.js';
import type { PersistedJobMetadata } from '../transcode-job-persistence.service.js';
import type { TranscodeJob } from '../transcoding/types.js';
import { ShutdownInterruptedError } from '$lib/server/lifecycle/shutdown-interrupted.js';
import * as shutdown from '$lib/server/lifecycle/web-shutdown.js';

function metadata(overrides: Partial<PersistedJobMetadata> = {}): PersistedJobMetadata {
    return {
        play_session_id: 'play',
        job_id: 'job',
        item_id: 'item',
        user_id: null,
        status: 'stopped',
        mode: 'audio_transcode',
        output_dir: '/tmp/hls',
        segment_offset: 0,
        // D-HLS-2 (fix c): the restore binding now also requires
        // config.itemId to agree with item_id — every fixture here uses the
        // SAME 'item' id on both unless a test overrides it to build a
        // self-inconsistent row on purpose.
        config: { itemId: 'item' } as PersistedJobMetadata['config'],
        transcode_decision: null,
        pod_name: null,
        can_restore: true,
        error_message: null,
        created_at: new Date(0),
        updated_at: new Date(0),
        last_accessed_at: new Date(0),
        expires_at: new Date(0),
        ...overrides,
    } as PersistedJobMetadata;
}

/** A disk whose output dir is stamped for `itemId` (as a real spawn stamps
 *  it) and whose every other file reads as the 7-byte `segment`. */
function readFileStampedFor(itemId: string) {
    return async (filePath?: string): Promise<Buffer> =>
        filePath !== undefined && isOutputMarkerPath(filePath)
            ? Buffer.from(JSON.stringify({ itemId, podName: 'pod-b', jobId: 'job' }))
            : Buffer.from('segment');
}

const baseOptions = {
    job: undefined,
    itemId: 'item',
    // Fix plan 6 (C1): the restore path now requires the persisted row's
    // item_id to match {internalId, itemId} normalized — every fixture here
    // uses the SAME 'item' id on both sides unless a test overrides it.
    internalId: 'item',
    playSessionId: 'play',
    segmentPath: 'stream_0/segment_00000.m4s',
    corsHeaders: {
        'Access-Control-Allow-Origin': '*',
    },
    contentTypes: {
        '.m4s': 'video/mp4',
    },
    currentPodName: 'pod-a',
    restoreWaitTimeoutMs: 20,
    restorePollIntervalMs: 0,
    jobPersistence: {
        getJob: async () => metadata(),
        updateStatus: async () => undefined,
        updateLastAccessed: async () => undefined,
        claimJobForRestoration: async () => true,
        takeOverStaleJob: async () => true,
    },
    transcodeService: {
        getJobByPlaySession: (): TranscodeJob | undefined => undefined,
        restoreJob: async () =>
            ({
                id: 'restored',
                outputDir: '/tmp/hls',
            }) as TranscodeJob,
    },
    accessFile: async () => undefined,
    readFile: readFileStampedFor('item'),
    trackHlsSegment: () => undefined,
    sleep: () => Promise.resolve(),
    logInfo: () => undefined,
    logWarn: () => undefined,
    logError: () => undefined,
};

afterEach(() => {
    vi.restoreAllMocks();
    resetPeerTakeoverMemoryForTests();
    vi.useRealTimers();
});

describe('restoreHlsJobIfMissing', () => {
    it('keeps serving an existing healthy job during draining', async () => {
        vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(true);
        const job = { id: 'healthy', status: 'running' } as TranscodeJob;
        expect(await restoreHlsJobIfMissing({ ...baseOptions, job })).toEqual({ job });
    });

    it('logs and persists a real restoration bug during draining', async () => {
        const draining = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(false);
        const logError = vi.fn();
        const updateStatus = vi.fn();
        const bug = new Error('real restoration bug');
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            accessFile: async () => {
                throw new Error('missing');
            },
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async () => {
                    draining.mockReturnValue(true);
                    throw bug;
                },
            },
            jobPersistence: { ...baseOptions.jobPersistence, updateStatus },
            logError,
        });
        expect(result.response?.status).toBe(500);
        expect(logError).toHaveBeenCalledWith(
            'Failed to restore transcode job',
            bug,
            expect.anything(),
        );
        expect(updateStatus).toHaveBeenCalledWith(
            'play',
            'error',
            expect.stringContaining('real restoration bug'),
            undefined,
            'pod-a',
        );
    });

    it('does not restart a missing job on a draining pod', async () => {
        vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(true);
        const restoreJob = vi.fn(baseOptions.transcodeService.restoreJob);
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            accessFile: async () => {
                throw new Error('missing');
            },
            transcodeService: { ...baseOptions.transcodeService, restoreJob },
        });
        expect(result.response?.status).toBe(503);
        expect(result.response?.headers.get('Retry-After')).toBe('2');
        expect(restoreJob).not.toHaveBeenCalled();
    });

    it('does not log or persist a failure when shutdown interrupts a restored segment wait', async () => {
        const draining = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(false);
        const updateStatus = vi.fn();
        const logError = vi.fn();
        const restored = { id: 'restored', outputDir: '/tmp/hls', config: {} } as TranscodeJob;
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            transcodeService: { ...baseOptions.transcodeService, restoreJob: async () => restored },
            accessFile: async () => {
                throw new Error('missing');
            },
            sleep: async () => {
                draining.mockReturnValue(true);
                Object.assign(restored, { shutdownKillRequested: true, killRequested: true });
            },
            jobPersistence: { ...baseOptions.jobPersistence, updateStatus },
            logError,
        });
        expect(result.response?.status).toBe(503);
        expect(result.response?.headers.get('Retry-After')).toBe('2');
        expect(logError).not.toHaveBeenCalled();
        expect(updateStatus).not.toHaveBeenCalled();
    });

    it('returns a retry without marking a restoration failure if shutdown races restoreJob', async () => {
        const draining = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(false);
        const updateStatus = vi.fn();
        const logError = vi.fn();
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            accessFile: async () => {
                throw new Error('missing');
            },
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async () => {
                    draining.mockReturnValue(true);
                    throw new ShutdownInterruptedError();
                },
            },
            jobPersistence: { ...baseOptions.jobPersistence, updateStatus },
            logError,
        });
        expect(result.response?.status).toBe(503);
        expect(result.response?.headers.get('Retry-After')).toBe('2');
        expect(logError).not.toHaveBeenCalled();
        expect(updateStatus).not.toHaveBeenCalled();
    });

    for (const [presentFile, expectedPresent] of [
        ['segment_00000.m4s', true],
        ['segment_00003.m4s', false],
    ] as const) {
        it(`checks physical GOP file 0 for public entry 3 when only ${presentFile} exists`, async () => {
            const row = metadata({
                segment_offset: 3,
                config: { itemId: 'item', gopSegments: true } as PersistedJobMetadata['config'],
            });
            let restoreOptions: unknown;
            const restored = { config: row.config } as TranscodeJob;
            const result = await restoreHlsJobIfMissing({
                ...baseOptions,
                segmentPath: 'stream_0/segment_00003.m4s',
                jobPersistence: { ...baseOptions.jobPersistence, getJob: async () => row },
                accessFile: async (filePath) => {
                    if (!filePath.endsWith(presentFile)) throw new Error('missing');
                },
                transcodeService: {
                    ...baseOptions.transcodeService,
                    restoreJob: async (_metadata, options) => {
                        restoreOptions = options;
                        return restored;
                    },
                },
            });
            expect(result.job).toBe(restored);
            expect(restoreOptions).toMatchObject({ segmentPresentOnDisk: expectedPresent });
        });
    }

    it('restores a GOP playlist instead of serving the generation-relative producer timeline', async () => {
        // A resumed generation starts at source time 23.5, but its private
        // assembler playlist names physical files from zero. The public VOD
        // playlist must still declare all entries from source time zero.
        const raw = [
            '#EXTM3U',
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-PLAYLIST-TYPE:EVENT',
            '#EXT-X-MAP:URI="init_0.mp4"',
            '#EXTINF:11.500000,',
            'segment_00000.m4s',
            '#EXTINF:8.000000,',
            'segment_00001.m4s',
            '#EXT-X-ENDLIST',
        ].join('\n');
        const row = metadata({
            segment_offset: 2,
            config: {
                itemId: 'item',
                gopSegments: true,
                startTimeSeconds: 24,
                keyframeData: [0, 10.25, 23.5, 35],
                totalDurationSeconds: 43,
            } as PersistedJobMetadata['config'],
        });
        const restored = {
            id: 'restored',
            outputDir: row.output_dir,
            config: row.config,
        } as TranscodeJob;
        let restoreOptions: unknown;
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            segmentPath: 'stream_0/index.m3u8',
            jobPersistence: { ...baseOptions.jobPersistence, getJob: async () => row },
            readFile: async (filePath) =>
                isOutputMarkerPath(filePath)
                    ? readFileStampedFor('item')(filePath)
                    : Buffer.from(raw),
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async (_metadata, options) => {
                    restoreOptions = options;
                    return restored;
                },
            },
        });

        // Before the fix, this response was the raw playlist: file 0 was
        // advertised at t=0 although its media PTS begins at t=23.5. The normal
        // handler cannot synthesize the full timeline if restoration returns a response.
        expect(result.response).toBeUndefined();
        expect(result.job).toBe(restored);
        expect(restoreOptions).toMatchObject({ segmentPresentOnDisk: true });
    });

    it('returns the existing job without touching persistence', async () => {
        const job = { id: 'job' } as TranscodeJob;
        let called = false;

        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            job,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => {
                    called = true;
                    return null;
                },
            },
        });

        expect(result.job).toBe(job);
        expect(called).toBe(false);
    });

    it('returns 410 when persistence has no session', async () => {
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => null,
            },
        });

        expect(result.response?.status).toBe(410);
        await expect(result.response?.text()).resolves.toBe('Session expired');
        expect(result.response?.headers.get('X-Lumastra-Diagnostic-Code')).toBe('session-expired');
    });

    it('asks clients to retry when the job is active on another pod that is still serving', async () => {
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () =>
                    metadata({
                        status: 'running',
                        pod_name: 'pod-b',
                        last_accessed_at: new Date(), // owner served a segment just now → defer
                    }),
            },
        });

        expect(result.response?.status).toBe(503);
        expect(result.response?.headers.get('Retry-After')).toBe('2');
    });

    it('claims the job when the owner pod has gone stale (rolling-recreate misroute)', async () => {
        // Regression: a rolling recreate can leave a session's owner != its sticky-hash
        // target, so every retry lands on the peer and the owner never serves it. Once the
        // owner's last_accessed_at goes stale the peer must claim + restore instead of
        // deferring forever (the 503 loop that halted playback on a deploy).
        const restored = { id: 'restored', outputDir: '/tmp/hls' } as TranscodeJob;
        let claimed = false;
        let accessAttempts = 0;

        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () =>
                    metadata({
                        status: 'running',
                        pod_name: 'pod-b',
                        last_accessed_at: new Date(0), // owner hasn't served in ages
                    }),
                claimJobForRestoration: async () => {
                    claimed = true;
                    return true;
                },
                takeOverStaleJob: async () => true,
            },
            transcodeService: { ...baseOptions.transcodeService, restoreJob: async () => restored },
            accessFile: async () => {
                accessAttempts += 1;
                if (accessAttempts === 1) throw new Error('not yet');
            },
        });

        expect(result.response?.status).not.toBe(503); // NOT deferred into a retry loop
        expect(claimed).toBe(true);
        expect(result.job).toBe(restored);
    });

    // Prod 2026-10-15: the stale owner was alive and still writing; a respawn
    // into its output_dir mixed both FFmpeg runs and tripped GOP mode.
    for (const [label, podName, expected] of [
        ['a peer with an active row', 'pod-b', true],
        ['this pod', 'pod-a', false],
    ] as const) {
        it(`tells restoreJob whether the previous owner may still write (${label})`, async () => {
            let restoreOptions: unknown;
            await restoreHlsJobIfMissing({
                ...baseOptions,
                jobPersistence: {
                    ...baseOptions.jobPersistence,
                    getJob: async () =>
                        metadata({
                            status: 'running',
                            pod_name: podName,
                            last_accessed_at: new Date(0),
                        }),
                },
                transcodeService: {
                    ...baseOptions.transcodeService,
                    restoreJob: async (_metadata, options) => {
                        restoreOptions = options;
                        return { id: 'restored', outputDir: '/tmp/hls/gen-0002' } as TranscodeJob;
                    },
                },
                accessFile: async () => {
                    throw new Error('missing');
                },
            });
            expect(restoreOptions).toMatchObject({ previousOwnerMayStillWrite: expected });
        });
    }

    it('remembers a takeover that only served a file: the next missing-segment restore still avoids the old directory', async () => {
        // Request 1 hits an existing segment: the stale peer's row is taken over
        // (pod_name flips to this pod) and the file is served; nothing is restored.
        // Request 2 asks for a missing segment and sees an own, active row.
        const peerRow = metadata({
            status: 'running',
            pod_name: 'pod-b',
            last_accessed_at: new Date(0),
        });
        let row = peerRow;
        const jobPersistence = {
            ...baseOptions.jobPersistence,
            getJob: async () => row,
            takeOverStaleJob: async () => {
                row = { ...peerRow, pod_name: 'pod-a', last_accessed_at: new Date() };
                return true;
            },
        };
        // The background restore (prewarm) fails here, so nothing is restored and
        // the takeover memory must survive for the on-demand restore below.
        await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence,
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async () => {
                    throw new Error('prewarm failed');
                },
            },
        });
        await settlePrewarmForTests();
        expect(row.pod_name).toBe('pod-a');

        let restoreOptions: unknown;
        await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence,
            accessFile: async () => {
                throw new Error('missing');
            },
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async (_metadata, options) => {
                    restoreOptions = options;
                    return { id: 'restored', outputDir: '/tmp/hls/gen-0002' } as TranscodeJob;
                },
            },
        });
        expect(restoreOptions).toMatchObject({ previousOwnerMayStillWrite: true });

        // Once restored into a directory of its own, the memory is spent.
        restoreOptions = undefined;
        await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence,
            accessFile: async () => {
                throw new Error('missing');
            },
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async (_metadata, options) => {
                    restoreOptions = options;
                    return { id: 'restored', outputDir: '/tmp/hls/gen-0002' } as TranscodeJob;
                },
            },
        });
        expect(restoreOptions).toMatchObject({ previousOwnerMayStillWrite: false });
    });

    it('serves existing persisted segment files directly', async () => {
        const tracked: number[] = [];
        let accessed = false;

        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                updateLastAccessed: async () => {
                    accessed = true;
                },
            },
            trackHlsSegment: (bytes) => tracked.push(bytes),
        });

        expect(result.response?.status).toBe(200);
        expect(result.response?.headers.get('Content-Length')).toBe('7');
        expect(result.response?.headers.get('Cache-Control')).toBe('private, no-cache');
        await expect(result.response?.text()).resolves.toBe('segment');
        expect(accessed).toBe(true);
        expect(tracked).toEqual([7]);
    });

    // HLS re-measure 2026-09-27 §6.3: output_dir is per session, so after a
    // cross-pod item switch the path can hold ANOTHER item's segments. Present
    // but not stamped for the row's item is treated as absent: no disk-serve,
    // and restoreJob is told the segment is not there (it wipes the dir).
    for (const [label, stamp] of [
        ['stamped for another item', readFileStampedFor('other-item')],
        ['unstamped (legacy dir)', async () => Buffer.from('segment')],
    ] as const) {
        it(`does not disk-serve output ${label}; restores instead`, async () => {
            let restoreOptions: unknown;
            const restored = { id: 'restored', outputDir: '/tmp/hls' } as TranscodeJob;

            const result = await restoreHlsJobIfMissing({
                ...baseOptions,
                readFile: stamp,
                transcodeService: {
                    ...baseOptions.transcodeService,
                    restoreJob: async (_metadata, options) => {
                        restoreOptions = options;
                        return restored;
                    },
                },
            });

            expect(result.response).toBeUndefined();
            expect(result.job).toBe(restored);
            expect(restoreOptions).toMatchObject({ segmentPresentOnDisk: false });
        });
    }

    it('never serves the output marker itself', async () => {
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            segmentPath: '.lumastra-output.json',
        });

        expect(result.response?.status).toBe(400);
    });

    it('restores the job when persisted files are missing', async () => {
        const restored = {
            id: 'restored',
            outputDir: '/tmp/hls',
        } as TranscodeJob;
        let claimed = false;
        let accessAttempts = 0;

        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                claimJobForRestoration: async () => {
                    claimed = true;
                    return true;
                },
                takeOverStaleJob: async () => true,
            },
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async () => restored,
            },
            accessFile: async () => {
                accessAttempts += 1;
                if (accessAttempts === 1) {
                    throw new Error('not yet');
                }
            },
        });

        expect(result.job).toBe(restored);
        expect(claimed).toBe(true);
    });

    it.each(['starting', 'running', 'ready'] as const)(
        'does not mark a superseded restore as error when the current generation is %s',
        async (status) => {
            vi.useFakeTimers();
            const restored = {
                id: 'restored',
                generationIndex: 1,
                outputDir: '/tmp/hls/gen-0001',
                status: 'running',
            } as TranscodeJob;
            const newer = {
                ...restored,
                id: 'newer',
                generationIndex: 2,
                outputDir: '/tmp/hls/gen-0002',
                status,
            };
            let current = restored;
            const updateStatus = vi.fn(async () => undefined);
            const result = await restoreHlsJobIfMissing({
                ...baseOptions,
                jobPersistence: { ...baseOptions.jobPersistence, updateStatus },
                transcodeService: {
                    restoreJob: async () => restored,
                    getJobByPlaySession: () => current,
                },
                accessFile: async () => {
                    throw new Error('old generation segment missing');
                },
                sleep: async () => {
                    // A concurrent seek promotes a new generation while this
                    // request is still waiting in the restored directory.
                    current = newer;
                    restored.generationRole = 'previous';
                    vi.advanceTimersByTime(baseOptions.restoreWaitTimeoutMs);
                },
            });

            expect(current).toBe(newer);
            expect(current.status).toBe(status);
            expect(updateStatus).not.toHaveBeenCalled();
            expect(result.response?.status).toBe(503);
            expect(result.response?.headers.get('X-Lumastra-Diagnostic-Code')).toBe(
                'upstream-timeout',
            );
        },
    );

    it.each(['same', 'missing', 'error', 'stopped', 'stopping'] as const)(
        'keeps a restored-segment timeout fatal with %s current generation',
        async (replacement) => {
            const restored = {
                id: 'restored',
                generationIndex: 1,
                outputDir: '/tmp/hls/gen-0001',
                status: 'running',
            } as TranscodeJob;
            const current =
                replacement === 'same'
                    ? restored
                    : replacement === 'missing'
                      ? undefined
                      : { ...restored, id: 'newer', generationIndex: 2, status: replacement };
            const updateStatus = vi.fn(async () => undefined);
            const result = await restoreHlsJobIfMissing({
                ...baseOptions,
                restoreWaitTimeoutMs: 0,
                jobPersistence: { ...baseOptions.jobPersistence, updateStatus },
                transcodeService: {
                    restoreJob: async () => restored,
                    getJobByPlaySession: () => current,
                },
                accessFile: async () => {
                    throw new Error('missing');
                },
            });

            expect(updateStatus).toHaveBeenCalledExactlyOnceWith(
                'play',
                'error',
                'Segment timeout after FFmpeg restart',
                undefined,
                'pod-a',
            );
            expect(result.response?.status).toBe(503);
            expect(result.response?.headers.get('X-Lumastra-Diagnostic-Code')).toBe(
                'upstream-timeout',
            );
        },
    );

    it('labels a failed restoration with a safe diagnostic code', async () => {
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            accessFile: async () => {
                throw new Error('missing');
            },
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async () => {
                    throw new Error('FFmpeg unavailable');
                },
            },
        });

        expect(result.response?.status).toBe(500);
        expect(result.response?.headers.get('X-Lumastra-Diagnostic-Code')).toBe(
            'transcoder-start-failed',
        );
    });

    it('keeps the diagnostic code after a restoration failure is persisted', async () => {
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => metadata({ status: 'error' }),
            },
            accessFile: async () => {
                throw new Error('missing');
            },
        });

        expect(result.response?.status).toBe(500);
        expect(result.response?.headers.get('X-Lumastra-Diagnostic-Code')).toBe(
            'transcoder-start-failed',
        );
    });
});

// ============================================================================
// C1 (fix plan 6): job->item binding on restore
// ============================================================================
//
// A persisted job row must belong to the SAME item the request's auth gate
// checked (bound = {internalId, raw itemId}, normalized). Without this, a
// foreign PlaySessionId for someone else's session could take over, disk-
// serve, and respawn another user's transcode job through THIS item's URL.
describe('restoreHlsJobIfMissing — C1 job->item binding', () => {
    // Fix round 1, Important #2: `status:'stopped', pod_name:null` (the old
    // fixture) makes isActiveStatus() false, so the stale-owner/takeover
    // block is UNREACHABLE regardless of where the binding check sits —
    // `tookOver`/`claimed` would read false whether the check runs before or
    // after that block. `status:'running'` + a DIFFERENT, stale-owner
    // `pod_name` makes the takeover branch reachable, so these assertions
    // only pass because the check runs BEFORE it, not because the branch was
    // never going to fire. `readFile` is spied so the disk-serve path (which
    // would otherwise run right after takeover) is also provably untouched.
    it('rejects a persisted job whose item_id belongs to a different item (404, no takeover/claim/restore/disk-read)', async () => {
        let claimed = false;
        let tookOver = false;
        let restored = false;
        let readFileCalled = false;

        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            itemId: 'item-x',
            internalId: 'item-x',
            readFile: async () => {
                readFileCalled = true;
                return baseOptions.readFile();
            },
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () =>
                    metadata({
                        item_id: 'item-y',
                        status: 'running',
                        pod_name: 'pod-b', // a DIFFERENT, stale pod
                        last_accessed_at: new Date(0), // hasn't served in ages -> takeover branch reachable
                    }),
                claimJobForRestoration: async () => {
                    claimed = true;
                    return true;
                },
                takeOverStaleJob: async () => {
                    tookOver = true;
                    return true;
                },
            },
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async () => {
                    restored = true;
                    return { id: 'restored', outputDir: '/tmp/hls' } as TranscodeJob;
                },
            },
        });

        expect(result.response?.status).toBe(404);
        expect(claimed).toBe(false);
        expect(tookOver).toBe(false);
        expect(restored).toBe(false);
        expect(readFileCalled).toBe(false);
    });

    // A /j PlaySessionId has no play_sessions row, so the segment handler's
    // ownership check (play_sessions-backed) passes it as "row absent". The
    // transcode row's own owner is the only thing left to refuse another user.
    it("refuses another user's persisted job (404, no takeover/claim/restore/disk-read)", async () => {
        let touched = false;
        const mark = async () => {
            touched = true;
            return true;
        };

        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            username: 'mallory',
            readFile: async () => {
                touched = true;
                return baseOptions.readFile();
            },
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () =>
                    metadata({
                        status: 'running',
                        pod_name: 'pod-b',
                        last_accessed_at: new Date(0),
                        config: {
                            itemId: 'item',
                            username: 'alice',
                        } as PersistedJobMetadata['config'],
                    }),
                claimJobForRestoration: mark,
                takeOverStaleJob: mark,
            },
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async () => {
                    touched = true;
                    return { id: 'restored', outputDir: '/tmp/hls' } as TranscodeJob;
                },
            },
        });

        expect(result.response?.status).toBe(404);
        expect(touched).toBe(false);
    });

    it("restores the requesting user's own persisted job", async () => {
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            username: 'alice',
            accessFile: (() => {
                let attempts = 0;
                return async () => {
                    attempts += 1;
                    if (attempts === 1) throw new Error('not yet');
                };
            })(),
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () =>
                    metadata({
                        config: {
                            itemId: 'item',
                            username: 'alice',
                        } as PersistedJobMetadata['config'],
                    }),
            },
        });

        expect(result.job?.id).toBe('restored');
    });

    // Discriminating control, same "stale owner" shape as above but a
    // MATCHING item: proves the takeover/disk-serve machinery in this
    // fixture genuinely fires when the binding allows it through — so the
    // reject test's false assertions above are meaningful, not vacuous.
    it('control: the SAME "stale owner" shape with a MATCHING item takes over and reads the segment', async () => {
        let tookOver = false;
        let readFileCalled = false;

        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            itemId: 'item-x',
            internalId: 'item-x',
            readFile: async (filePath: string) => {
                readFileCalled = true;
                return readFileStampedFor('item-x')(filePath);
            },
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () =>
                    metadata({
                        item_id: 'item-x',
                        config: { itemId: 'item-x' } as PersistedJobMetadata['config'],
                        status: 'running',
                        pod_name: 'pod-b',
                        last_accessed_at: new Date(0),
                    }),
                takeOverStaleJob: async () => {
                    tookOver = true;
                    return true;
                },
            },
        });

        expect(result.response?.status).toBe(200);
        expect(tookOver).toBe(true);
        expect(readFileCalled).toBe(true);
    });

    it('control: a persisted job whose item_id MATCHES the request still restores normally', async () => {
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            itemId: 'item-x',
            internalId: 'item-x',
            readFile: readFileStampedFor('item-x'),
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () =>
                    metadata({
                        item_id: 'item-x',
                        config: { itemId: 'item-x' } as PersistedJobMetadata['config'],
                    }),
            },
        });

        expect(result.response?.status).toBe(200);
    });

    it('admits a dashed/dashless respelling of the same UUID item', async () => {
        const dashed = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const dashless = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            itemId: dashless,
            internalId: dashed,
            readFile: readFileStampedFor(dashless),
            jobPersistence: {
                ...baseOptions.jobPersistence,
                // The persisted row stores the dashed (DB-canonical) form; its
                // config carries the DASHLESS respelling — the D-HLS-2 self-
                // consistency check must normalize both sides, not compare
                // raw strings (no regression of S-C1a normalization).
                getJob: async () =>
                    metadata({
                        item_id: dashed,
                        config: { itemId: dashless } as PersistedJobMetadata['config'],
                    }),
            },
        });

        expect(result.response?.status).toBe(200);
    });

    it('fails closed (404) when internalId is missing, even if item_id happens to equal the raw itemId', async () => {
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            itemId: 'item',
            internalId: undefined,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => metadata({ item_id: 'item' }),
            },
        });

        expect(result.response?.status).toBe(404);
    });

    it('rejects an audiobook remux row even when item_id matches (shares this table, never legitimately served here)', async () => {
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            itemId: 'item',
            internalId: 'item',
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () =>
                    metadata({
                        item_id: 'item',
                        config: { type: 'audiobook' } as unknown as PersistedJobMetadata['config'],
                        can_restore: false,
                    }),
            },
        });

        expect(result.response?.status).toBe(404);
    });
});

// ============================================================================
// D-HLS-2 (security runtime pass 2026-09-26, fix c): a row whose two id
// fields disagree (item_id vs config.itemId — D-HLS-1's cross-process/
// case-variant collision) must be refused BEFORE takeover/claim/restore, not
// just refused for its BYTES afterward (that backstop —
// `post-restore-foreign-item` in lumastra-segment-handler.ts — is untouched
// and stays as defence-in-depth).
// ============================================================================
describe('restoreHlsJobIfMissing — D-HLS-2 self-inconsistent row', () => {
    // Same "active + stale owner" shape as the C1 binding tests above: it
    // makes the takeover/claim/restore/disk-read branches all REACHABLE, so
    // a false assertion below would be meaningful, not vacuous.
    function mismatchedRowMetadata(overrides: Partial<PersistedJobMetadata> = {}) {
        return metadata({
            item_id: 'item-x',
            config: { itemId: 'item-y' } as PersistedJobMetadata['config'],
            status: 'running',
            pod_name: 'pod-b',
            last_accessed_at: new Date(0),
            ...overrides,
        });
    }

    it("gated on X (item_id's own spelling): refuses a mismatched row — no takeover/claim/restore/disk-read", async () => {
        let claimed = false;
        let tookOver = false;
        let restored = false;
        let readFileCalled = false;

        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            itemId: 'item-x',
            internalId: 'item-x',
            readFile: async () => {
                readFileCalled = true;
                return baseOptions.readFile();
            },
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => mismatchedRowMetadata(),
                claimJobForRestoration: async () => {
                    claimed = true;
                    return true;
                },
                takeOverStaleJob: async () => {
                    tookOver = true;
                    return true;
                },
            },
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async () => {
                    restored = true;
                    return { id: 'restored', outputDir: '/tmp/hls' } as TranscodeJob;
                },
            },
        });

        expect(result.response?.status).toBe(404);
        expect(claimed).toBe(false);
        expect(tookOver).toBe(false);
        expect(restored).toBe(false);
        expect(readFileCalled).toBe(false);
    });

    it("gated on Y (config.itemId's spelling): also refused — no takeover/claim/restore/disk-read", async () => {
        let claimed = false;
        let tookOver = false;
        let restored = false;
        let readFileCalled = false;

        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            itemId: 'item-y',
            internalId: 'item-y',
            readFile: async () => {
                readFileCalled = true;
                return baseOptions.readFile();
            },
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => mismatchedRowMetadata(),
                claimJobForRestoration: async () => {
                    claimed = true;
                    return true;
                },
                takeOverStaleJob: async () => {
                    tookOver = true;
                    return true;
                },
            },
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async () => {
                    restored = true;
                    return { id: 'restored', outputDir: '/tmp/hls' } as TranscodeJob;
                },
            },
        });

        expect(result.response?.status).toBe(404);
        expect(claimed).toBe(false);
        expect(tookOver).toBe(false);
        expect(restored).toBe(false);
        expect(readFileCalled).toBe(false);
    });

    it('refuses (fail closed) a row whose config has no itemId at all (legacy row) — client starts a fresh session', async () => {
        let restored = false;

        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            itemId: 'item-x',
            internalId: 'item-x',
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () =>
                    metadata({
                        item_id: 'item-x',
                        config: {} as PersistedJobMetadata['config'],
                        status: 'running',
                        pod_name: 'pod-b',
                        last_accessed_at: new Date(0),
                    }),
            },
            transcodeService: {
                ...baseOptions.transcodeService,
                restoreJob: async () => {
                    restored = true;
                    return { id: 'restored', outputDir: '/tmp/hls' } as TranscodeJob;
                },
            },
        });

        expect(result.response?.status).toBe(404);
        expect(restored).toBe(false);
    });

    it('admits an UPPERCASE respelling of config.itemId against a dashed item_id (no regression of S-C1a normalization)', async () => {
        const dashed = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        const upperDashless = dashed.replace(/-/g, '').toUpperCase();

        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            itemId: dashed,
            internalId: dashed,
            readFile: readFileStampedFor(upperDashless),
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () =>
                    metadata({
                        item_id: dashed,
                        config: { itemId: upperDashless } as PersistedJobMetadata['config'],
                    }),
            },
        });

        expect(result.response?.status).toBe(200);
    });
});

// ============================================================================
// Stale-owner takeover — the disk-serve must not re-arm the 503 defer
// ============================================================================
//
// After a HARD owner death (crash/OOM, so the row stays 'running' and the
// graceful-'stopped' shortcut does not apply) with segments already on disk,
// the peer used to livelock: serving a segment calls updateLastAccessed(),
// which stamps the SAME last_accessed_at that the owner-staleness check reads,
// so the dead owner looked alive again and the very next request 503'd for
// another OWNER_SERVING_STALE_MS. Throughput collapses to ~1 segment per 15s
// against 4-6s segments, so the buffer drains and the stream stalls regardless.
// The claim further down never runs while the segments exist on disk, so
// ownership was never transferred either.
describe('restoreHlsJobIfMissing — stale owner takeover', () => {
    function staleOwnerMetadata() {
        return metadata({
            status: 'running',
            pod_name: 'pod-b', // a DIFFERENT, now-dead pod
            last_accessed_at: new Date(0), // hasn't served in ages
        });
    }

    it('takes ownership before serving from disk', async () => {
        let tookOver = false;
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => staleOwnerMetadata(),
                takeOverStaleJob: async () => {
                    tookOver = true;
                    return true;
                },
            },
        });

        expect(result.response?.status).toBe(200);
        // Without this, every served segment refreshes the dead owner's
        // liveness and the next request defers again.
        expect(tookOver).toBe(true);
    });

    it('does NOT take over while the owner is still actively serving', async () => {
        let tookOver = false;
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () =>
                    metadata({
                        status: 'running',
                        pod_name: 'pod-b',
                        last_accessed_at: new Date(), // serving right now
                    }),
                takeOverStaleJob: async () => {
                    tookOver = true;
                    return true;
                },
            },
        });

        // Sticky routing should send this to the real owner instead.
        expect(result.response?.status).toBe(503);
        expect(tookOver).toBe(false);
    });
});

// Prod 2026-11-01 (tvOS full transcode, rolling web restart): the pod that
// claimed the orphaned session served its pre-generated segments for ~35 s and
// only started FFmpeg once the first segment was missing, at the persisted
// position — a forward seek and a 12-15 s frozen frame followed. The claim now
// restores the job in the background.
describe('restoreHlsJobIfMissing — prewarm on claim', () => {
    function orphanedMetadata(overrides: Partial<PersistedJobMetadata> = {}) {
        return metadata({
            status: 'running',
            pod_name: 'pod-b',
            last_accessed_at: new Date(0),
            ...overrides,
        });
    }

    function deferred<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => {
            resolve = r;
        });
        return { promise, resolve };
    }

    it('restores the FFmpeg job in the background while the claim serves the client from disk', async () => {
        const restoreJob = vi.fn(async () => ({ id: 'r', outputDir: '/tmp/hls' }) as TranscodeJob);
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            segmentPath: 'segment_00073.m4s',
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => orphanedMetadata(),
            },
            transcodeService: { ...baseOptions.transcodeService, restoreJob },
        });
        await settlePrewarmForTests();

        // The client is served the segment it asked for...
        expect(result.response?.status).toBe(200);
        // ...and the job is already being restored, before segment 74 is asked for.
        expect(restoreJob).toHaveBeenCalledTimes(1);
        expect(restoreJob).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                prewarm: true,
                requiredSegmentIndex: 73,
                // The stale owner is a live peer: it must not share the directory.
                previousOwnerMayStillWrite: true,
            }),
        );
    });

    it('also prewarms an own row that is served from disk (pod restarted, job not in memory)', async () => {
        const restoreJob = vi.fn(async () => ({ id: 'r', outputDir: '/tmp/hls' }) as TranscodeJob);
        await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => orphanedMetadata({ pod_name: 'pod-a' }),
            },
            transcodeService: { ...baseOptions.transcodeService, restoreJob },
        });
        await settlePrewarmForTests();
        expect(restoreJob).toHaveBeenCalledTimes(1);
    });

    it('prewarms a gracefully stopped session (shutdown marks it stopped, restorable)', async () => {
        const restoreJob = vi.fn(async () => ({ id: 'r', outputDir: '/tmp/hls' }) as TranscodeJob);
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                // Stopped by the dying pod's own shutdown: not "active", so the
                // 15 s retry window never applies and the peer claims at once.
                getJob: async () =>
                    orphanedMetadata({ status: 'stopped', last_accessed_at: new Date() }),
            },
            transcodeService: { ...baseOptions.transcodeService, restoreJob },
        });
        await settlePrewarmForTests();
        expect(result.response?.status).toBe(200);
        expect(restoreJob).toHaveBeenCalledTimes(1);
    });

    it('is single-flight: concurrent segment requests start one claim and one restore', async () => {
        const gate = deferred<TranscodeJob>();
        const restoreJob = vi.fn(() => gate.promise);
        const claim = vi.fn(async () => true);
        const options = {
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => orphanedMetadata({ pod_name: 'pod-a' }),
                claimJobForRestoration: claim,
            },
            transcodeService: { ...baseOptions.transcodeService, restoreJob },
        };

        const results = await Promise.all(
            ['segment_00073.m4s', 'segment_00074.m4s', 'segment_00075.m4s'].map((segmentPath) =>
                restoreHlsJobIfMissing({ ...options, segmentPath }),
            ),
        );
        // A later request while the restore is still running joins it too.
        await restoreHlsJobIfMissing({ ...options, segmentPath: 'segment_00076.m4s' });

        gate.resolve({ id: 'r', outputDir: '/tmp/hls' } as TranscodeJob);
        await settlePrewarmForTests();

        expect(results.every((r) => r.response?.status === 200)).toBe(true);
        expect(claim).toHaveBeenCalledTimes(1);
        expect(restoreJob).toHaveBeenCalledTimes(1);
    });

    it('never restores a session this pod failed to claim (no double ownership)', async () => {
        const restoreJob = vi.fn(async () => ({ id: 'r', outputDir: '/tmp/hls' }) as TranscodeJob);
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => orphanedMetadata(),
                // A racing peer won the takeover and the claim.
                takeOverStaleJob: async () => false,
                claimJobForRestoration: async () => false,
            },
            transcodeService: { ...baseOptions.transcodeService, restoreJob },
        });
        await settlePrewarmForTests();
        expect(result.response?.status).toBe(200); // disk serve is read-only
        expect(restoreJob).not.toHaveBeenCalled();
    });

    it('backs off after a lost claim instead of repeating the claim UPDATE per segment request', async () => {
        const claim = vi.fn(async () => false);
        const options = {
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => orphanedMetadata({ pod_name: 'pod-a' }),
                claimJobForRestoration: claim,
            },
        };
        for (const segmentPath of ['segment_00073.m4s', 'segment_00074.m4s', 'segment_00075.m4s']) {
            await restoreHlsJobIfMissing({ ...options, segmentPath });
            await settlePrewarmForTests();
        }
        expect(claim).toHaveBeenCalledTimes(1);
    });

    it('a successful prewarm clears the backoff', async () => {
        const claim = vi
            .fn<() => Promise<boolean>>()
            .mockResolvedValueOnce(false)
            .mockResolvedValue(true);
        const restoreJob = vi.fn(async () => ({ id: 'r', outputDir: '/tmp/hls' }) as TranscodeJob);
        const options = {
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => orphanedMetadata({ pod_name: 'pod-a' }),
                claimJobForRestoration: claim,
            },
            transcodeService: { ...baseOptions.transcodeService, restoreJob },
        };
        vi.useFakeTimers({ toFake: ['Date'] });
        await restoreHlsJobIfMissing(options); // lost claim -> backoff
        await settlePrewarmForTests();
        vi.setSystemTime(Date.now() + 11_000);
        await restoreHlsJobIfMissing(options); // backoff elapsed -> claims, restores
        await settlePrewarmForTests();
        await restoreHlsJobIfMissing(options); // success cleared it -> may start again
        await settlePrewarmForTests();
        expect(claim).toHaveBeenCalledTimes(3);
        expect(restoreJob).toHaveBeenCalledTimes(2);
    });

    it('does not prewarm (or claim) while the owner is still serving', async () => {
        const restoreJob = vi.fn();
        const claim = vi.fn(async () => true);
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => orphanedMetadata({ last_accessed_at: new Date() }),
                claimJobForRestoration: claim,
            },
            transcodeService: { ...baseOptions.transcodeService, restoreJob },
        });
        await settlePrewarmForTests();
        expect(result.response?.status).toBe(503);
        expect(claim).not.toHaveBeenCalled();
        expect(restoreJob).not.toHaveBeenCalled();
    });

    it('does not prewarm a session that was stopped on purpose or failed', async () => {
        for (const row of [
            orphanedMetadata({ can_restore: false }),
            orphanedMetadata({ status: 'error' }),
        ]) {
            const restoreJob = vi.fn();
            await restoreHlsJobIfMissing({
                ...baseOptions,
                jobPersistence: { ...baseOptions.jobPersistence, getJob: async () => row },
                transcodeService: { ...baseOptions.transcodeService, restoreJob },
            });
            await settlePrewarmForTests();
            expect(restoreJob).not.toHaveBeenCalled();
        }
    });

    it('keeps serving from disk, and does not mark the row failed, when the prewarm fails', async () => {
        const updateStatus = vi.fn();
        const logWarn = vi.fn();
        const restoreJob = vi.fn(async () => {
            throw new Error('spawn failed');
        });
        const options = {
            ...baseOptions,
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => orphanedMetadata({ pod_name: 'pod-a' }),
                updateStatus,
            },
            transcodeService: { ...baseOptions.transcodeService, restoreJob },
            logWarn,
        };
        const first = await restoreHlsJobIfMissing(options);
        await settlePrewarmForTests();
        // Backed off: the next segment request does not retry immediately.
        const second = await restoreHlsJobIfMissing(options);
        await settlePrewarmForTests();

        expect(first.response?.status).toBe(200);
        expect(second.response?.status).toBe(200);
        expect(restoreJob).toHaveBeenCalledTimes(1);
        expect(updateStatus).not.toHaveBeenCalled();
        expect(logWarn).toHaveBeenCalledWith(
            expect.stringContaining('Prewarm restore failed'),
            expect.anything(),
        );
    });
});

// Prod 2026-11-01 20:52: a copy-mode restore resumed at segment 690 in a fresh
// generation, where that segment is file 0. The restore polled the PUBLIC name
// (segment_00690.m4s) in the new directory for 30 s and marked the row failed.
describe('restoreHlsJobIfMissing — offset-resumed copy restore', () => {
    it('hands the job to the handler instead of polling a public file name that cannot exist', async () => {
        const updateStatus = vi.fn();
        const job = {
            id: 'resumed',
            outputDir: '/tmp/hls/gen-0005',
            segmentOffset: 690,
            transcodeDecisionResult: { videoAction: 'copy' },
        } as unknown as TranscodeJob;
        const result = await restoreHlsJobIfMissing({
            ...baseOptions,
            segmentPath: 'segment_00690.m4s',
            accessFile: async () => {
                throw new Error('missing'); // segment_00690.m4s never exists: it is file 0
            },
            jobPersistence: {
                ...baseOptions.jobPersistence,
                getJob: async () => metadata({ status: 'running', pod_name: 'pod-a' }),
                updateStatus,
            },
            transcodeService: { ...baseOptions.transcodeService, restoreJob: async () => job },
        });

        expect(result.job).toBe(job);
        expect(result.response).toBeUndefined();
        expect(updateStatus).not.toHaveBeenCalled();
    });
});
