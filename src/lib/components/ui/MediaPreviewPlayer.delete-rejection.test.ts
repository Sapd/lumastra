// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * FIX 7 (2026-09-22 preview-bandwidth-and-caching edge-case hunt):
 * `deletePreviewSessionOnServer` used to be a bare `void fetch(...)` with no
 * rejection handler, called from the preview-session memo's `onDelete` —
 * reachable both from an immediate last-release (never-ready session) and
 * from the retention timer's bare `setTimeout` callback, neither of which
 * has any surrounding try/catch. A DELETE that rejects (network loss, tab
 * unload racing the request) therefore used to surface as a genuine
 * `unhandledRejection`, which any global error reporter would pick up for a
 * failure that is, by design, harmless: the server's own 30s no-heartbeat
 * sweep reclaims the session regardless of whether this DELETE lands.
 *
 * This proves the rejection is actually observed using the same
 * `process.once('unhandledRejection', ...)` idiom as with-budget.test.ts,
 * rather than trusting a passing test suite to mean nothing escaped.
 *
 * IMPORTANT: `fetch` is stubbed with a PLAIN function here, not `vi.fn()`.
 * `vi.fn()`'s own call-result bookkeeping attaches a handler to whatever
 * promise its implementation returns (to populate `mock.results`), which
 * itself counts as "handling" the rejection from Node's point of view — a
 * `vi.fn(async () => { throw ... })` invoked and left unawaited does NOT
 * produce an `unhandledRejection` event, regardless of whether the CALLER
 * attaches a `.catch`. Verified directly (a `vi.fn()`-wrapped throwing
 * async function produced 0 `unhandledRejection` events where an otherwise
 * identical plain function produced 1). Using `vi.fn()` here would make
 * this test pass unconditionally, whether or not the production `.catch`
 * exists — call counts below are tracked with a plain array instead.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

// A literal, not a shared const: vi.hoisted's factory runs before any
// module-scope `const` below is initialized, so it cannot reference one.
const { createPreviewSession } = vi.hoisted(() => ({
    createPreviewSession: vi.fn(async (..._args: unknown[]) => ({
        data: {
            playSessionId: 'sess-1',
            sessionItemId: '33333333-4444-4555-8666-777777777777',
            streamUrl:
                '/api/playback/33333333-4444-4555-8666-777777777777/hls/master.m3u8?PlaySessionId=sess-1',
            playMethod: 'DirectStream' as const,
            hlsStartPosition: 0,
            mode: 'preview' as const,
        },
        error: null as string | null,
        status: 200,
    })),
}));

const ITEM_ID = '33333333-4444-4555-8666-777777777777';

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

describe('MediaPreviewPlayer — deletePreviewSessionOnServer rejection handling', () => {
    let calls: Array<{ method: string }>;

    beforeEach(() => {
        __resetPreviewSessionCacheForTests();
        createPreviewSession.mockClear();
        calls = [];

        // Deliberately a PLAIN function -- see the file-level comment on why
        // vi.fn() cannot be used here without invalidating the test.
        const plainFetchStub = async (_input: unknown, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            calls.push({ method });
            if (method === 'HEAD') {
                // Never carries the readiness header -- the entry is never
                // marked ready, so releasing it on unmount takes the
                // IMMEDIATE delete path (not the retention timer), which is
                // the simplest way to exercise onDelete deterministically.
                return { ok: true, status: 200, headers: { get: () => null } };
            }
            if (method === 'DELETE') {
                // The failure mode under test: network loss / unload racing
                // the request.
                throw new TypeError('network error (simulated)');
            }
            return { ok: true, status: 200, headers: { get: () => null } };
        };
        vi.stubGlobal('fetch', plainFetchStub);
        HTMLVideoElement.prototype.canPlayType = () => 'probably';
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('a rejecting DELETE from onDelete never surfaces as an unhandledRejection', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.once('unhandledRejection', onUnhandled);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const view = render(MediaPreviewPlayer, {
                internalId: ITEM_ID,
                startPositionSeconds: 120,
            });

            await vi.waitFor(() => {
                expect(view.container.querySelector('video')?.getAttribute('src')).toBeTruthy();
            });

            view.unmount();

            // Let onDelete's fetch('DELETE') reject.
            await vi.waitFor(() => {
                expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
            });
            // Give the Node process a macrotask turn to report an unhandled
            // rejection if one were going to happen.
            await new Promise((resolve) => setTimeout(resolve, 200));

            expect(unhandled).toEqual([]);
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
            consoleError.mockRestore();
        }
    });
});
