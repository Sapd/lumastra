// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test for a connector that pushed NOTHING, for anyone, silently.
 *
 * The engine populates `ResumePositionItem.username` / `WatchStateChange.username`
 * with the `users.id` UUID — the SDK field name is kept for cross-package
 * compatibility and its docstring used to say "Lumastra username". This
 * connector was written against that wording and resolved the field against a
 * map of display names, so the lookup never hit: every audiobook push was
 * dropped (position lane) or terminally drained as "no AudiobookShelf link for
 * this user" (decisive lane). Nothing errored, so it read as an idle
 * integration rather than a broken one.
 *
 * These tests feed the connector engine-shaped input — a UUID in `username` —
 * and assert the upstream call actually happens. Asserting on a UUID rather
 * than a display name is the whole point; a test written with a username in
 * that field would pass against the broken code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AudiobookMediaProgress } from '$lib/server/audiobookshelf.js';
import type {
    ResumePositionItem,
    WatchStateChange,
    PluginContext,
} from '@sapd/lumastra-plugin-sdk';

const USER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const MEDIA_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

const mockState = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/queries/user-media-state.queries.js', () => ({
    getState: { one: mockState },
}));
const mockResolveUserApiKey = vi.hoisted(() => vi.fn());
const mockForgetUserApiKey = vi.hoisted(() => vi.fn((..._a: unknown[]) => Promise.resolve()));

vi.mock('$lib/server/config.js', () => ({
    config: { AUDIOURL: 'http://abs.local', AUDIOAPIKEY: 'operator-key' },
    FEATURE_PER_TASK_QUEUES: false,
}));
vi.mock('../../index.js', () => ({ registerWatchSyncWithAutoTasks: vi.fn() }));
vi.mock('../../../secrets.js', () => ({ PluginSecrets: class {} }));
vi.mock('$lib/server/services/audiobookshelf-credentials.service.js', () => ({
    AUDIOBOOKSHELF_PLUGIN_ID: 'audiobookshelf',
    API_KEY_SECRET: 'api_key',
    PULL_DISABLED_SECRET: 'pull_disabled',
    foldUsername: (u: string) => u.toLowerCase(),
    forgetUserApiKey: (...a: unknown[]) => mockForgetUserApiKey(...a),
    matchAbsUser: vi.fn(),
    resolveUserApiKey: (...a: unknown[]) => mockResolveUserApiKey(...a),
}));

const { audiobookshelfClient } = await import('$lib/server/audiobookshelf.js');
const mockMe = vi.spyOn(audiobookshelfClient, 'getMeAs');
const { audiobookshelfWatchSync } = await import('./audiobookshelf.js');

/** `loadLinkedUsers` is a bare tagged-template read off ctx.sql. */
function makeCtx(linked: Array<{ userId: string; username: string }>): PluginContext {
    const sql = (() => Promise.resolve(linked)) as unknown as PluginContext['sql'];
    return {
        sql,
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext;
}

function item(over: Partial<ResumePositionItem> = {}): ResumePositionItem {
    return {
        providerId: 'abs-item-1',
        mediaId: MEDIA_ID,
        // The engine puts the user_id UUID here, NOT a display name.
        username: USER_ID,
        resumePositionMs: 1_400_000,
        ...over,
    };
}

function progress(overrides: Partial<AudiobookMediaProgress> = {}): AudiobookMediaProgress {
    return {
        id: 'progress',
        libraryItemId: 'abs-item-1',
        episodeId: null,
        currentTime: 0,
        duration: 3600,
        progress: 0,
        isFinished: false,
        lastUpdate: 0,
        startedAt: null,
        finishedAt: null,
        ...overrides,
    };
}

const fetchMock = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveUserApiKey.mockResolvedValue('user-key');
    mockState.mockResolvedValue({
        resume_position_ms: 1_400_000,
        last_event_at: new Date(2000).toISOString(),
    });
    mockMe.mockResolvedValue({ id: 'abs-user', username: 'denis', mediaProgress: [] });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
});

describe('audiobookshelf pushResumePosition', () => {
    it('resolves the linked user by UUID and PATCHes the position upstream', async () => {
        const ctx = makeCtx([{ userId: USER_ID, username: 'denis' }]);

        const result = await audiobookshelfWatchSync.pushResumePosition!(ctx, [item()]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://abs.local/api/me/progress/abs-item-1');
        expect(init.method).toBe('PATCH');
        // Seconds upstream, milliseconds internally.
        expect(JSON.parse(init.body)).toEqual({ currentTime: 1400 });

        expect(result).toMatchObject({ succeeded: 1, failed: 0, skipped: 0 });
        expect(result!.successful).toEqual([{ username: USER_ID, mediaId: MEDIA_ID }]);
    });

    it('keeps a newer upstream bookmark instead of overwriting it with queued progress', async () => {
        mockMe.mockResolvedValue({
            id: 'abs-user',
            username: 'denis',
            mediaProgress: [
                {
                    id: 'progress',
                    libraryItemId: 'abs-item-1',
                    episodeId: null,
                    currentTime: 5,
                    duration: 3600,
                    progress: 0,
                    isFinished: false,
                    lastUpdate: 3000,
                    startedAt: null,
                    finishedAt: null,
                },
            ],
        });
        const result = await audiobookshelfWatchSync.pushResumePosition!(
            makeCtx([{ userId: USER_ID, username: 'denis' }]),
            [item()],
        );
        expect(fetchMock).not.toHaveBeenCalled();
        expect(result!.drainedAsSkipped).toEqual([{ username: USER_ID, mediaId: MEDIA_ID }]);
    });

    it('reads current-user progress once per user within a position batch', async () => {
        await audiobookshelfWatchSync.pushResumePosition!(
            makeCtx([{ userId: USER_ID, username: 'denis' }]),
            [item(), item({ providerId: 'abs-item-2', mediaId: 'other' })],
        );
        expect(mockMe).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reads the latest local position again before pushing a previously built batch', async () => {
        mockState.mockResolvedValue({
            resume_position_ms: 45_000,
            last_event_at: new Date(2000).toISOString(),
        });
        await audiobookshelfWatchSync.pushResumePosition!(
            makeCtx([{ userId: USER_ID, username: 'denis' }]),
            [item({ resumePositionMs: 30_000 })],
        );
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ currentTime: 45 });
    });

    it('retains progress if upstream freshness cannot be checked', async () => {
        mockMe.mockRejectedValue(new Error('ABS unavailable'));
        const result = await audiobookshelfWatchSync.pushResumePosition!(
            makeCtx([{ userId: USER_ID, username: 'denis' }]),
            [item()],
        );
        expect(fetchMock).not.toHaveBeenCalled();
        expect(result).toMatchObject({ failed: 1, successful: [], drainedAsSkipped: [] });
    });

    it('reports a transient upstream failure as FAILED so the engine keeps it queued', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 503 });
        const ctx = makeCtx([{ userId: USER_ID, username: 'denis' }]);

        const result = await audiobookshelfWatchSync.pushResumePosition!(ctx, [item()]);

        expect(result).toMatchObject({ succeeded: 0, failed: 1, skipped: 0 });
        // Crucially NOT drained: draining would mark the events pushed and the
        // position — which for an audiobook lives only upstream — would be lost.
        expect(result!.drainedAsSkipped).toEqual([]);
        expect(result!.successful).toEqual([]);
    });

    it('reports a gone item (404) as terminally drained, not as a retryable failure', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 404 });
        const ctx = makeCtx([{ userId: USER_ID, username: 'denis' }]);

        const result = await audiobookshelfWatchSync.pushResumePosition!(ctx, [item()]);

        expect(result).toMatchObject({ succeeded: 0, failed: 0, skipped: 1 });
        expect(result!.drainedAsSkipped).toEqual([{ username: USER_ID, mediaId: MEDIA_ID }]);
    });

    it('terminally drains an unlinked user instead of silently skipping it', async () => {
        const ctx = makeCtx([]);

        const result = await audiobookshelfWatchSync.pushResumePosition!(ctx, [item()]);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result!.drainedAsSkipped).toEqual([{ username: USER_ID, mediaId: MEDIA_ID }]);
    });

    it('does not match a display name in the username field', async () => {
        // Guards the inverse of the original bug: keying must be by id, so an
        // item carrying an actual username must NOT resolve.
        const ctx = makeCtx([{ userId: USER_ID, username: 'denis' }]);

        const result = await audiobookshelfWatchSync.pushResumePosition!(ctx, [
            item({ username: 'denis' }),
        ]);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result!.skipped).toBe(1);
    });

    it('sends duration so a progress row this lane creates is not born with duration: 0', async () => {
        // Same failure as pushWatchState's duration bug, on the last lane that
        // still had it: a listener whose progress only ever arrives here (no
        // decisive watched-state event) got a progress row ABS could never
        // mark finished, because the row was created with `duration: 0`.
        const ctx = makeCtx([{ userId: USER_ID, username: 'denis' }]);

        await audiobookshelfWatchSync.pushResumePosition!(ctx, [item({ runtimeMs: 3_600_000 })]);

        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            currentTime: 1400,
            duration: 3600,
        });
    });

    it('omits duration when the local runtime is unknown, rather than sending zero', async () => {
        // Sending 0 would overwrite a good upstream duration on an existing
        // row exactly the way the bug above breaks a new one.
        const ctx = makeCtx([{ userId: USER_ID, username: 'denis' }]);

        await audiobookshelfWatchSync.pushResumePosition!(ctx, [item({ runtimeMs: 0 })]);

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('duration');
        expect(body).toEqual({ currentTime: 1400 });
    });
});

describe('audiobookshelf pushWatchState duration', () => {
    function change(over: Partial<WatchStateChange> = {}): WatchStateChange {
        return {
            providerId: 'abs-item-1',
            mediaId: MEDIA_ID,
            username: USER_ID,
            isWatched: true,
            resumePositionMs: 0,
            runtimeMs: 3_600_000,
            watchCount: 1,
            occurredAt: new Date(2000).toISOString(),
            ...over,
        };
    }

    it.each([true, false])(
        'drains an old decisive %s without overwriting newer ABS progress',
        async (isWatched) => {
            mockMe.mockResolvedValue({
                id: 'abs-user',
                username: 'denis',
                mediaProgress: [
                    progress({ lastUpdate: 10000, currentTime: 3600, isFinished: true }),
                ],
            });
            const result = await audiobookshelfWatchSync.pushWatchState!(
                makeCtx([{ userId: USER_ID, username: 'denis' }]),
                [change({ isWatched })],
            );
            expect(fetchMock).not.toHaveBeenCalled();
            expect(result).toMatchObject({
                succeeded: 0,
                skipped: 1,
                drainedAsSkipped: [{ username: USER_ID, mediaId: MEDIA_ID }],
            });
        },
    );

    it('allows a decisive update within the ABS clock tolerance', async () => {
        mockMe.mockResolvedValue({
            id: 'abs-user',
            username: 'denis',
            mediaProgress: [progress({ lastUpdate: 2250 })],
        });
        const result = await audiobookshelfWatchSync.pushWatchState!(
            makeCtx([{ userId: USER_ID, username: 'denis' }]),
            [change()],
        );
        expect(result).toMatchObject({ succeeded: 1, skipped: 0 });
    });

    it('keeps decisive intents queued when the freshness read fails', async () => {
        mockMe.mockRejectedValue(new Error('ABS unavailable'));
        const result = await audiobookshelfWatchSync.pushWatchState!(
            makeCtx([{ userId: USER_ID, username: 'denis' }]),
            [change()],
        );
        expect(result).toMatchObject({ failed: 1, successful: [], drainedAsSkipped: [] });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps a finish with no usable duration retryable on a fresh ABS row', async () => {
        const result = await audiobookshelfWatchSync.pushWatchState!(
            makeCtx([{ userId: USER_ID, username: 'denis' }]),
            [change({ runtimeMs: 0 })],
        );
        expect(result).toMatchObject({
            succeeded: 0,
            failed: 1,
            successful: [],
            drainedAsSkipped: [],
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reads current-user progress once per user within a decisive batch', async () => {
        await audiobookshelfWatchSync.pushWatchState!(
            makeCtx([{ userId: USER_ID, username: 'denis' }]),
            [change(), change({ providerId: 'abs-item-2', mediaId: 'other' })],
        );
        expect(mockMe).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('includes the known duration without rewinding when marking finished', async () => {
        // A generic mark-watched projects resumePositionMs=0 locally. Sending
        // that here would clear completion on an existing ABS progress row.
        const ctx = makeCtx([{ userId: USER_ID, username: 'denis' }]);

        await audiobookshelfWatchSync.pushWatchState!(ctx, [change()]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).toEqual({ duration: 3600, isFinished: true });
    });

    it('omits duration when the local runtime is unknown, rather than sending zero', async () => {
        // Sending 0 would break a healthy upstream row exactly the way the bug
        // above breaks a new one. Omitting leaves ABS's own value intact.
        const ctx = makeCtx([{ userId: USER_ID, username: 'denis' }]);

        mockMe.mockResolvedValue({
            id: 'abs-user',
            username: 'denis',
            mediaProgress: [progress()],
        });
        await audiobookshelfWatchSync.pushWatchState!(ctx, [change({ runtimeMs: 0 })]);

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('duration');
        expect(body).toEqual({ isFinished: true });
    });

    it('pushes explicit isFinished:false for an unmarked item', async () => {
        const ctx = makeCtx([{ userId: USER_ID, username: 'denis' }]);

        await audiobookshelfWatchSync.pushWatchState!(ctx, [
            change({ isWatched: false, resumePositionMs: 60_000 }),
        ]);

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).toEqual({ currentTime: 60, duration: 3600, isFinished: false });
    });
});
