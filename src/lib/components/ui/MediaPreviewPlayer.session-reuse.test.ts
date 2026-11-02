// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Pins the whole point of the preview-session memo (Task 8 + Task 9,
 * `.superpowers/sdd/2026-09-22-preview-bandwidth-and-caching`): revisiting a
 * hero slide must NOT re-POST `POST /playback/previews` and must NOT get a fresh
 * `PlaySessionId` — because that id is embedded in every HLS segment URL, and
 * a changing query string busts the year-long immutable browser cache on
 * those segments. Every prior round of this task shipped only static
 * evidence (types, unit tests on the memo module in isolation, a manual code
 * trace); this is the first test that mounts the real
 * `MediaPreviewPlayer.svelte` and drives it through an actual
 * unmount/remount, asserting the two claims that make the feature real:
 *
 *   1. `POST /playback/previews` fires exactly ONCE across two mounts for the
 *      same item within the memo's retention window.
 *   2. The `streamUrl` used by the second mount is byte-identical to the
 *      first, including its `PlaySessionId` query parameter.
 *
 * HONEST SCOPE NOTE: happy-dom has no `MediaSource` and hls.js's own
 * `Hls.isSupported()` therefore reports false here, so this test exercises
 * `initializePlayer`'s Safari-native-HLS branch (the `<video>` element's own
 * HLS support, gated behind a `canPlayType` stub below), not the hls.js
 * branch real Chrome/Firefox users take. The two claims under test — POST
 * count and `streamUrl` identity — are produced entirely by
 * `createPreviewSession`'s `acquirePreviewSession`/`releasePreviewSession`
 * wiring, which runs identically before either branch is chosen, so this is
 * a real (not simulated) exercise of that wiring. What it does NOT cover:
 * the hls.js-path `MANIFEST_LOADED`/`LEVEL_LOADED` readiness handlers (only
 * the Safari `HEAD`-poll readiness check runs here), and real browser HTTP
 * cache behaviour on the segment requests themselves (no network stack here
 * at all — `fetch` is stubbed).
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

interface MockPreviewSessionResult {
    data: {
        playSessionId: string;
        sessionItemId: string;
        streamUrl: string;
        playMethod: 'DirectStream';
        hlsStartPosition: number;
        reporting?: {
            kind: 'keepalive';
            method: 'POST';
            playbackSessionId: string;
            intervalMs: number;
            href: string;
        };
        mode: 'preview';
    } | null;
    error: string | null;
    status: number;
}

const { createPreviewSession } = vi.hoisted(() => ({
    createPreviewSession: vi.fn(async (..._args: unknown[]) => ({
        error: 'not configured' as string | null,
        data: null as MockPreviewSessionResult['data'],
        status: 0,
    })),
}));

// MediaPreviewPlayer's only route to POST /playback/previews.
vi.mock('$lib/api/playback', async (original) => ({
    releasePreviewPlayback: (await original<typeof import('$lib/api/playback')>())
        .releasePreviewPlayback,
    createPreviewSession: (...args: unknown[]) => createPreviewSession(...args),
}));
vi.mock('$app/stores', () => ({
    page: readable({ data: { hover: {} }, url: new URL('http://localhost/') }),
}));

import MediaPreviewPlayer from './MediaPreviewPlayer.svelte';
import { __resetPreviewSessionCacheForTests } from '$lib/utils/preview-session-cache';

const ITEM_ID = '11111111-2222-4333-8444-555555555555';

/**
 * Mints a response shaped like the real `POST /playback/previews` — critically
 * with a `playSessionId`/`streamUrl` that VARIES by call number. If the memo
 * wiring were broken and a second mount re-POSTed, it would get a
 * DIFFERENT id here, and the "byte-identical streamUrl" assertion would
 * fail honestly instead of trivially passing because the mock always
 * returns one fixed string.
 */
function mockPreviewSessionResponse(callNumber: number): MockPreviewSessionResult {
    return {
        data: {
            playSessionId: `sess-${callNumber}`,
            sessionItemId: ITEM_ID,
            streamUrl: `/api/playback/${ITEM_ID}/hls/master.m3u8?PlaySessionId=sess-${callNumber}`,
            playMethod: 'DirectStream' as const,
            hlsStartPosition: 0,
            mode: 'preview' as const,
        },
        error: null,
        status: 200,
    };
}

describe('MediaPreviewPlayer — preview-session reuse across remounts', () => {
    let postCount = 0;
    // Toggled per-test (FIX 2's "never ready" case) to control whether the
    // Safari HEAD-poll response carries the readiness header at all.
    let sendReadyHeader = true;
    let fetchMock: ReturnType<typeof vi.fn>;

    /** Number of DELETE calls `fetch` has seen so far (cleanup/release). */
    function deleteCallCount(): number {
        return fetchMock.mock.calls.filter((call: unknown[]) => {
            const init = call[1] as RequestInit | undefined;
            return init?.method === 'DELETE';
        }).length;
    }

    beforeEach(() => {
        __resetPreviewSessionCacheForTests();
        postCount = 0;
        sendReadyHeader = true;
        createPreviewSession.mockReset();
        createPreviewSession.mockImplementation(async () => {
            postCount += 1;
            return mockPreviewSessionResponse(postCount);
        });

        // MediaPreviewPlayer talks to `fetch` directly (outside the mocked
        // $lib/api/playback module) for the Safari native-HLS readiness poll,
        // the keepalive POST, and session DELETE/release. Stub it so the test
        // is hermetic, and so the HEAD poll answers with the
        // X-Lumastra-Preview-Static header the memo needs to RETAIN (not
        // immediately delete) the session on unmount -- without that header,
        // `cleanupPreviewSession` would delete the entry on unmount and the
        // second mount would re-POST for an unrelated reason (never reached
        // "ready"), which would falsely look like this test failing for the
        // thing it's supposed to prove. `fetchMock` is kept in outer scope so
        // tests can inspect exactly which requests fired (FIX 3's "no DELETE
        // between unmount and remount" assertion) and so a single test
        // (FIX 2) can flip `sendReadyHeader` to false to prove the OTHER half
        // of the gate: a session that never reaches "ready" is not retained.
        fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            if (method === 'HEAD') {
                return {
                    ok: true,
                    status: 200,
                    headers: {
                        get: (name: string) =>
                            name === 'X-Lumastra-Preview-Static' && sendReadyHeader ? '1' : null,
                    },
                };
            }
            // POST keepalive / DELETE cleanup: nothing reads the body, a
            // plain 200 keeps every branch on its non-error path.
            return { ok: true, status: 200, headers: { get: () => null } };
        });
        vi.stubGlobal('fetch', fetchMock);

        // happy-dom's <video> has no native HLS support (canPlayType returns
        // '') and no MediaSource (so hls.js's own Hls.isSupported() is also
        // false), which would otherwise send initializePlayer straight to its
        // final `throw new Error('HLS not supported')` before the readiness
        // poll -- and therefore the memo retention -- is ever reached. Route
        // it down the Safari native-HLS branch instead: see the file-level
        // comment for what this does and doesn't cover.
        HTMLVideoElement.prototype.canPlayType = () => 'probably';
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    test('native Live TV starts and releases its own playback session', async () => {
        const sessionId = '00000000-0000-4000-8000-000000000002';
        const streamUrl = '/returned/live/master.m3u8';
        fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
            if (init?.method === 'POST' && _input === '/api/livetv/playback-sessions') {
                return new Response(
                    JSON.stringify({
                        grant: {
                            id: '00000000-0000-4000-8000-000000000009',
                            ipPinned: true,
                            token: 'tok',
                            mediaId: ITEM_ID,
                            playbackSessionId: sessionId,
                            kind: 'live',
                            param: 'grant',
                            expiresAt: '2099-01-01T00:00:00.000Z',
                            renewAfter: '2098-12-31T23:55:00.000Z',
                            renewHref:
                                '/api/v1/playback/grants/00000000-0000-4000-8000-000000000009/renew',
                        },
                        playbackSessionId: sessionId,
                        kind: 'live',
                        stationId: ITEM_ID,
                        reporting: {
                            kind: 'keepalive',
                            method: 'POST',
                            playbackSessionId: sessionId,
                            intervalMs: 7_000,
                            href: `/api/livetv/playback-sessions/${sessionId}/keepalive`,
                        },
                        delivery: {
                            kind: 'live-hls',
                            url: streamUrl,
                            feedId: '00000000-0000-4000-8000-000000000003',
                            requestedQuality: 'server',
                            appliedQuality: 'original',
                            requiresProxy: true,
                            rungId: null,
                            requestedMaxBitrateBps: null,
                            appliedMaxBitrateBps: null,
                            appliedMaxHeight: null,
                            reason: null,
                        },
                    }),
                    { status: 201 },
                );
            }
            return new Response(null, { status: 204 });
        });
        const preview = render(MediaPreviewPlayer, {
            internalId: ITEM_ID,
            nativeStreamUrl: `/api/livetv/stations/${ITEM_ID}`,
            isLiveTv: true,
            startPositionSeconds: 0,
        });
        await vi.waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                `/api/livetv/playback-sessions/${sessionId}/keepalive`,
                expect.objectContaining({ method: 'POST' }),
            ),
        );
        expect(createPreviewSession).not.toHaveBeenCalled();
        preview.unmount();
        await vi.waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                `/api/livetv/playback-sessions/${sessionId}`,
                expect.objectContaining({ method: 'DELETE' }),
            ),
        );
    });

    test.each(['internal', 'v1'] as const)(
        'follows the %s preview reporting href',
        async (surface) => {
            const result = mockPreviewSessionResponse(1);
            if (!result.data) throw new Error('Expected a preview fixture');
            const href = `/api${surface === 'v1' ? '/v1' : ''}/playback/previews/sess-1/keepalive?issued=opaque`;
            result.data.reporting = {
                kind: 'keepalive',
                method: 'POST',
                playbackSessionId: 'sess-1',
                intervalMs: 7000,
                href,
            };
            createPreviewSession.mockResolvedValueOnce(result);
            const view = render(MediaPreviewPlayer, {
                internalId: ITEM_ID,
                startPositionSeconds: 120,
            });
            await vi.waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    href,
                    expect.objectContaining({ method: 'POST' }),
                ),
            );
            view.unmount();
        },
    );

    test('remounting for the same item within the retention window reuses the session', async () => {
        const first = render(MediaPreviewPlayer, {
            internalId: ITEM_ID,
            startPositionSeconds: 120,
        });

        await vi.waitFor(() => {
            const video = first.container.querySelector('video');
            expect(video?.getAttribute('src')).toBeTruthy();
        });
        expect(postCount).toBe(1);

        const firstStreamUrl = first.container.querySelector('video')?.getAttribute('src');
        expect(firstStreamUrl).toContain('PlaySessionId=sess-1');

        first.unmount();

        // FIX 3: nothing about the two claims below actually proves the
        // session was reused rather than torn down and silently re-served
        // from a cached URL a broken memo happened to still be holding --
        // that requires the absence of a DELETE in the gap, not just the
        // presence of a matching streamUrl afterwards.
        const deleteCallsAtUnmount = deleteCallCount();

        const second = render(MediaPreviewPlayer, {
            internalId: ITEM_ID,
            startPositionSeconds: 120,
        });

        await vi.waitFor(() => {
            const video = second.container.querySelector('video');
            expect(video?.getAttribute('src')).toBeTruthy();
        });

        const secondStreamUrl = second.container.querySelector('video')?.getAttribute('src');

        // CLAIM 1: exactly one POST /playback/previews across both mounts.
        expect(postCount).toBe(1);
        expect(createPreviewSession).toHaveBeenCalledTimes(1);

        // CLAIM 2: byte-identical streamUrl, including PlaySessionId.
        expect(secondStreamUrl).toBe(firstStreamUrl);

        // CLAIM 3 (FIX 3): no DELETE fired between the first unmount and the
        // second mount resolving -- the server-side session was never torn
        // down, so "reused" means what it says.
        expect(deleteCallCount()).toBe(deleteCallsAtUnmount);

        second.unmount();
    });

    test('control: a DIFFERENT item within the same window does NOT reuse the session', async () => {
        const OTHER_ITEM_ID = '99999999-8888-4777-8666-555555555555';

        const first = render(MediaPreviewPlayer, {
            internalId: ITEM_ID,
            startPositionSeconds: 120,
        });
        await vi.waitFor(() => {
            expect(first.container.querySelector('video')?.getAttribute('src')).toBeTruthy();
        });
        first.unmount();

        const second = render(MediaPreviewPlayer, {
            internalId: OTHER_ITEM_ID,
            startPositionSeconds: 120,
        });
        await vi.waitFor(() => {
            expect(second.container.querySelector('video')?.getAttribute('src')).toBeTruthy();
        });
        second.unmount();

        // Different memo key -> no hit -> a real second POST. This is the
        // control that proves the "exactly once" assertion above is actually
        // discriminating reuse from "the mock always resolves so nothing
        // could ever be called twice" -- if `postCount` were 1 here too, the
        // first test's assertion would be meaningless.
        expect(postCount).toBe(2);
    });

    test('FIX 2: a session that never reaches "ready" is NOT reused on remount', async () => {
        // The gate under test: `releasePreviewSession` only ARMS retention
        // for a `ready` entry -- one that never reached "ready" is deleted
        // immediately on unmount instead (see `preview-session-cache.ts`'s
        // `releasePreviewSession`). Withholding the readiness header from
        // every HEAD response means `markPreviewSessionReady` is never
        // called for this session, so it must NOT survive to the second
        // mount, unlike the main reuse test above.
        sendReadyHeader = false;

        const first = render(MediaPreviewPlayer, {
            internalId: ITEM_ID,
            startPositionSeconds: 120,
        });
        await vi.waitFor(() => {
            expect(first.container.querySelector('video')?.getAttribute('src')).toBeTruthy();
        });
        expect(postCount).toBe(1);

        first.unmount();

        // Contrast with FIX 3 in the main reuse test: an entry that was
        // never marked ready IS deleted on unmount (this is what makes the
        // remount below issue a real second POST instead of a memo hit).
        await vi.waitFor(() => {
            expect(deleteCallCount()).toBeGreaterThan(0);
        });

        const second = render(MediaPreviewPlayer, {
            internalId: ITEM_ID,
            startPositionSeconds: 120,
        });
        await vi.waitFor(() => {
            expect(second.container.querySelector('video')?.getAttribute('src')).toBeTruthy();
        });
        second.unmount();

        // A real second POST -- "ready-only retention" as behaviour, not
        // just a claim in a report.
        expect(postCount).toBe(2);
        expect(createPreviewSession).toHaveBeenCalledTimes(2);
    });

    test('FIX 4: an artifact that finishes warming DURING playback is still retained (Safari one-shot re-check)', async () => {
        // The initial HEAD poll in initializePlayer runs and exits BEFORE
        // playback starts. If the artifact is still warming at that instant
        // (no X-Lumastra-Preview-Static yet) the poll's single `res.ok`
        // branch marks nothing ready and never looks again -- unless
        // checkSafariReadinessOnce fires a second HEAD once real playback
        // begins (`ontimeupdate`), the session-reuse feature is a permanent
        // no-op for every such artifact on Safari/iOS.
        sendReadyHeader = false;

        const first = render(MediaPreviewPlayer, {
            internalId: ITEM_ID,
            startPositionSeconds: 120,
        });
        await vi.waitFor(() => {
            expect(first.container.querySelector('video')?.getAttribute('src')).toBeTruthy();
        });
        expect(postCount).toBe(1);

        // Artifact finishes warming now that playback is under way.
        sendReadyHeader = true;

        const video = first.container.querySelector('video') as HTMLVideoElement;
        video.dispatchEvent(new Event('timeupdate'));

        // The one-shot re-check is fire-and-forget; wait for the extra HEAD
        // it issues (beyond the one the initial poll already made), then let
        // its `.then` continuation (the actual markPreviewSessionReady call)
        // run to completion before unmounting -- the HEAD call is recorded
        // synchronously on invocation, before the mocked fetch promise (and
        // therefore the code after `await fetch(...)`) has resolved.
        await vi.waitFor(() => {
            const headCalls = fetchMock.mock.calls.filter(
                (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === 'HEAD',
            );
            expect(headCalls.length).toBeGreaterThan(1);
        });
        await new Promise((resolve) => setTimeout(resolve, 50));

        first.unmount();

        // Now marked ready, so unmount must retain (no DELETE) rather than
        // tear the session down -- the same gate FIX 2's test pins the
        // other half of.
        const second = render(MediaPreviewPlayer, {
            internalId: ITEM_ID,
            startPositionSeconds: 120,
        });
        await vi.waitFor(() => {
            expect(second.container.querySelector('video')?.getAttribute('src')).toBeTruthy();
        });
        second.unmount();

        // Reused, not re-created: still exactly one POST across both mounts.
        expect(postCount).toBe(1);
        expect(createPreviewSession).toHaveBeenCalledTimes(1);
    });

    test('FIX 4: the one-shot re-check does not fire more than once per session', async () => {
        sendReadyHeader = true;

        const first = render(MediaPreviewPlayer, {
            internalId: ITEM_ID,
            startPositionSeconds: 120,
        });
        await vi.waitFor(() => {
            expect(first.container.querySelector('video')?.getAttribute('src')).toBeTruthy();
        });

        const video = first.container.querySelector('video') as HTMLVideoElement;
        video.dispatchEvent(new Event('timeupdate'));
        video.dispatchEvent(new Event('timeupdate'));
        video.dispatchEvent(new Event('timeupdate'));

        await vi.waitFor(() => {
            const headCalls = fetchMock.mock.calls.filter(
                (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === 'HEAD',
            );
            expect(headCalls.length).toBeGreaterThan(1);
        });

        // Give any further (wrongly-fired) HEAD requests a chance to land.
        await new Promise((resolve) => setTimeout(resolve, 50));

        const headCalls = fetchMock.mock.calls.filter(
            (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === 'HEAD',
        );
        // Exactly one from the initial poll + exactly one from the one-shot
        // re-check, not one per `timeupdate`.
        expect(headCalls.length).toBe(2);

        first.unmount();
    });
});
