// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reconnect rebuild of a planner-driven HLS session. Runs the REAL restart
 * orchestrator and the REAL legacy URL builder, so the assertion is at the
 * seam the prod failure crossed: did the rebuild hand a URL to the engine at
 * all? Prod 2026-09-30: four rebuilds, zero `/hls` requests, terminal.
 */

import { describe, it, expect, vi } from 'vitest';
import { restartForBitrateChange } from './restart-orchestrator';
import { buildStreamUrl, type StreamUrlContext } from './stream-url-builder';
import { selectRebuildStreamSource } from './rebuild-stream-source';

type Info = { activeFileId: string };
const INFO: Info = { activeFileId: 'f1' };
const DELIVERY: Record<string, string> = {
    direct: '/issued/file?grant=opaque',
    audio_transcode: '/issued/hls?grant=opaque',
};

/** A multi-audio remux source on Firefox: the legacy builder has no URL for it. */
function legacyBuild(): string {
    const context = {
        state: {
            itemId: 'item-1',
            playSessionId: 'ps-1',
            currentMediaSource: {
                id: 'f1',
                container: 'mkv',
                bitrate: 8_000_000,
                supportsDirectPlay: false,
                videoStreams: [{ codec: 'h264' }],
                audioStreams: [{ codec: 'ac3' }, { codec: 'ac3' }],
            },
        },
        isSafari: false,
        log: () => {},
    } as unknown as StreamUrlContext;
    return buildStreamUrl(context)?.url ?? '';
}

async function rebuild(lumastra: { info: Info; method: string } | null, startedMethod?: string) {
    const initializeHls = vi.fn(async () => {});
    const initializeDirectPlay = vi.fn();
    const source = selectRebuildStreamSource({
        lumastra,
        buildLumastraUrl: (_info, method, _position) => DELIVERY[startedMethod ?? method],
        buildLegacyUrl: () => legacyBuild(),
        initializeHls,
        initializeDirectPlay,
        ...(startedMethod ? { isDirectDelivery: () => startedMethod === 'direct' } : {}),
    });
    const finishRestart = vi.fn();
    const result = await restartForBitrateChange(
        {
            videoElement: null,
            currentPosition: 714,
            log: () => {},
            setVideoTime: () => {},
            finishRestart,
        },
        { destroyPlaybackManager: () => {}, clearVideoSource: () => {} },
        {
            endCurrentSession: async () => {},
            generateNewSessionId: () => 'ps-2',
            setPlaySessionId: () => {},
            hasActiveSession: () => true,
        },
        { setLoading: () => {} },
        source.buildUrl,
        source.initialize,
        () => {},
        { autoResume: true },
    );
    return { result, initializeHls, initializeDirectPlay };
}

describe('reconnect rebuild stream source', () => {
    it('the legacy builder has no URL for an HLS source (why the old rebuild never loaded)', async () => {
        expect(legacyBuild()).toBe('');
        const { result, initializeHls } = await rebuild(null);
        expect(result).toMatchObject({ success: false, error: 'Failed to build stream URL' });
        expect(initializeHls).not.toHaveBeenCalled();
    });

    it('rebuilds a planner HLS session from the start delivery URL at the current position', async () => {
        const { result, initializeHls, initializeDirectPlay } = await rebuild({
            info: INFO,
            method: 'audio_transcode',
        });
        expect(result.success).toBe(true);
        expect(initializeHls).toHaveBeenCalledWith('/issued/hls?grant=opaque', 714);
        expect(initializeDirectPlay).not.toHaveBeenCalled();
    });

    it('rebuilds a planner direct-play session on the direct engine, not hls.js', async () => {
        const { result, initializeHls, initializeDirectPlay } = await rebuild({
            info: INFO,
            method: 'direct',
        });
        expect(result.success).toBe(true);
        expect(initializeDirectPlay).toHaveBeenCalledWith('/issued/file?grant=opaque');
        expect(initializeHls).not.toHaveBeenCalled();
    });
    it('routes the started delivery when it differs from the probed method', async () => {
        const { result, initializeHls, initializeDirectPlay } = await rebuild(
            { info: INFO, method: 'audio_transcode' },
            'direct',
        );
        expect(result.success).toBe(true);
        expect(initializeDirectPlay).toHaveBeenCalledWith('/issued/file?grant=opaque');
        expect(initializeHls).not.toHaveBeenCalled();
    });
});
