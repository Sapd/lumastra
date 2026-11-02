// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * FIX 6 (2026-09-22 preview-bandwidth-and-caching edge-case hunt):
 * `NoTrailerSignal` used to be declared inside MediaPreviewPlayer's INSTANCE
 * `<script>`, so every mounted instance owned a DISTINCT class object. Two
 * holders of the same preview-session-cache key (e.g. a hero slot and a
 * hover popup probing the same item's trailer) share a single-flighted
 * `create()` promise in `acquirePreviewSession` — when the server answers
 * `mode: 'none'`, BOTH holders' `await pending` rejects with the SAME
 * `NoTrailerSignal` instance, but only the CREATOR's `instanceof` check
 * (against its own instance-scoped class) could ever pass. The second
 * holder's check failed, fell through to `throw error`, and logged at error
 * level on a path specified to produce none.
 *
 * This mounts two MediaPreviewPlayer instances with identical trailer-probe
 * props (same key) close enough together to share the in-flight promise, and
 * asserts: exactly one API call (proving single-flight was actually
 * exercised), both onNoTrailer callbacks fire, and nothing is logged as an
 * error.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

const { createPreviewSession } = vi.hoisted(() => ({
    createPreviewSession: vi.fn(async (..._args: unknown[]) => ({
        data: { mode: 'none' as const },
        error: null as string | null,
        status: 200,
    })),
}));

vi.mock('$lib/api/playback', () => ({
    releasePreviewPlayback: vi.fn(),
    createPreviewSession: (...args: unknown[]) => createPreviewSession(...args),
}));
vi.mock('$app/stores', () => ({
    page: readable({ data: { hover: {} }, url: new URL('http://localhost/') }),
}));

import MediaPreviewPlayer from './MediaPreviewPlayer.svelte';
import { __resetPreviewSessionCacheForTests } from '$lib/utils/preview-session-cache';

const ITEM_ID = '22222222-3333-4444-8555-666666666666';

describe('MediaPreviewPlayer — NoTrailerSignal across a single-flighted create()', () => {
    beforeEach(() => {
        __resetPreviewSessionCacheForTests();
        createPreviewSession.mockClear();
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    test('a second holder joining the in-flight trailer probe gets onNoTrailer, not a rethrown/logged error', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const onNoTrailerA = vi.fn();
        const onNoTrailerB = vi.fn();

        // Two instances, IDENTICAL key inputs (internalId, startPositionSeconds,
        // fileId, isLiveTv, heroSafeCodec, trailerPreferred, trailerRequired) —
        // see previewSessionKey in preview-session-cache.ts. Rendered back to
        // back with no await between them so both reach acquirePreviewSession
        // before the mocked API call's promise resolves, exercising the real
        // single-flight join rather than two independent creates.
        const propsA = {
            internalId: ITEM_ID,
            startPositionSeconds: 0,
            trailerPreferred: true,
            trailerRequired: true,
            onNoTrailer: onNoTrailerA,
        };
        const propsB = { ...propsA, onNoTrailer: onNoTrailerB };

        const a = render(MediaPreviewPlayer, propsA);
        const b = render(MediaPreviewPlayer, propsB);

        await vi.waitFor(() => {
            expect(onNoTrailerA).toHaveBeenCalledTimes(1);
            expect(onNoTrailerB).toHaveBeenCalledTimes(1);
        });

        // Single-flight actually joined: one server call served both holders.
        expect(createPreviewSession).toHaveBeenCalledTimes(1);

        // The bug's signature: the second holder's `instanceof` mismatch fell
        // through to `throw error`, which is caught nowhere else in the
        // component and would have surfaced as a console.error (or an
        // unhandled rejection) here.
        expect(consoleError).not.toHaveBeenCalled();

        a.unmount();
        b.unmount();
    });
});
