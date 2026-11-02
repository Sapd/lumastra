// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';

const client = vi.hoisted(() => ({
    listUsers: vi.fn(),
    getUserAsAdmin: vi.fn(),
    getMeAs: vi.fn(),
    getSessions: vi.fn(),
    createApiKey: vi.fn(),
    deactivateApiKey: vi.fn(),
    resolveKey: vi.fn(),
    forgetKey: vi.fn(),
}));

vi.mock('$lib/server/config.js', () => ({
    config: { AUDIOURL: 'http://abs.test', AUDIOAPIKEY: 'operator-key' },
    FEATURE_PER_TASK_QUEUES: false,
}));

vi.mock('$lib/server/audiobookshelf.js', () => ({
    audiobookshelfClient: client,
    AudiobookshelfUserAuthError: class AudiobookshelfUserAuthError extends Error {
        credentialRejected: boolean;
        constructor(status: number) {
            super('credential rejected');
            this.credentialRejected = status === 401 || status === 403;
        }
    },
}));

vi.mock('../../../secrets.js', () => ({
    PluginSecrets: class PluginSecrets {},
}));
vi.mock('$lib/server/services/audiobookshelf-credentials.service.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/services/audiobookshelf-credentials.service.js')
    >()),
    resolveUserApiKey: client.resolveKey,
    forgetUserApiKey: client.forgetKey,
}));

vi.mock('../../index.js', () => ({ registerWatchSyncWithAutoTasks: vi.fn() }));

import { audiobookshelfWatchSync } from './audiobookshelf.js';
import { AudiobookshelfUserAuthError } from '$lib/server/audiobookshelf.js';

function context(
    users: Array<{ userId: string; username: string; pullDisabled?: boolean }> = [
        { userId: 'lumastra-marc', username: 'Marc' },
    ],
    linkedIds: string[] = [],
): PluginContext & { queries: string[] } {
    const queries: string[] = [];
    const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join(' ');
        queries.push(`${query} ${values.map(String).join(' ')}`);
        if (query.includes('FROM users')) {
            return Promise.resolve(
                query.includes('AND NOT EXISTS')
                    ? users.filter((user) => !user.pullDisabled)
                    : users,
            );
        }
        if (query.includes('FROM plugin_user_credentials'))
            return Promise.resolve(users.filter((user) => linkedIds.includes(user.userId)));
        if (query.includes('FROM play_sessions')) return Promise.resolve([]);
        throw new Error(`Unexpected SQL: ${query}`);
    });

    return {
        sql: sql as unknown as PluginContext['sql'],
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        queries,
    } as unknown as PluginContext & { queries: string[] };
}

describe('AudiobookShelf pull audience', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        client.getSessions.mockResolvedValue([]);
        client.resolveKey.mockResolvedValue('stored-key');
        client.forgetKey.mockResolvedValue(undefined);
        client.listUsers.mockResolvedValue([{ id: 'abs-marc', username: 'marc' }]);
        client.getUserAsAdmin.mockResolvedValue({
            id: 'abs-marc',
            username: 'marc',
            mediaProgress: [
                {
                    id: 'progress-1',
                    libraryItemId: 'abs-book-1',
                    mediaItemType: 'book',
                    episodeId: null,
                    currentTime: 1_200,
                    duration: 3_600,
                    progress: 1 / 3,
                    isFinished: false,
                    lastUpdate: 1_780_000_000_000,
                    startedAt: 1_779_000_000_000,
                    finishedAt: null,
                },
            ],
        });
    });

    it('pulls both explicitly linked identities despite folded local-name collisions', async () => {
        const users = [
            { userId: 'one', username: 'Same' },
            { userId: 'two', username: 'same' },
        ];
        client.getMeAs.mockResolvedValue({
            id: 'abs-linked',
            username: 'different',
            mediaProgress: [],
        });
        await audiobookshelfWatchSync.pullWatchState!(context(users, ['one', 'two']));
        expect(client.getMeAs).toHaveBeenCalledTimes(2);
        expect(client.listUsers).not.toHaveBeenCalled();
    });

    it('applies opt-out and known-name gates before reading linked credentials', async () => {
        const users = [
            { userId: 'one', username: 'Same', pullDisabled: true },
            { userId: 'two', username: 'same' },
        ];
        await audiobookshelfWatchSync.pullWatchState!(context(users, ['one', 'two']), {
            knownUsernames: new Set(),
        });
        expect(client.resolveKey).not.toHaveBeenCalled();
        expect(client.getMeAs).not.toHaveBeenCalled();
    });

    it('rejects a stored key for this cycle and uses name fallback after clearing it', async () => {
        const linked = ['lumastra-marc'];
        client.getMeAs.mockRejectedValue(new AudiobookshelfUserAuthError(401));
        client.forgetKey.mockImplementation(async () => {
            linked.length = 0;
        });
        const ctx = context(undefined, linked);
        const rejected = await audiobookshelfWatchSync.pullWatchState!(ctx);
        expect(rejected.items).toEqual([]);
        expect(rejected.errors.join(' ')).toContain('key rejected');
        expect(client.forgetKey).toHaveBeenCalled();
        const fallback = await audiobookshelfWatchSync.pullWatchState!(ctx);
        expect(fallback.items).toHaveLength(1);
        expect(client.getUserAsAdmin).toHaveBeenCalledWith('abs-marc', undefined);
    });

    it('loads active identities and reads explicit pull opt-outs', async () => {
        const ctx = context();

        await audiobookshelfWatchSync.listPullUsers!(ctx);

        const query = ctx.queries.join('\n');
        expect(query).toContain('disabled_at IS NULL');
        expect(query).toContain('deleted_at IS NULL');
        expect(query).toContain('pull_disabled');
    });

    it('imports an exact username match without provisioning a user credential', async () => {
        const result = await audiobookshelfWatchSync.pullWatchState!(context(), {
            onlyUserIds: ['lumastra-marc'],
            knownUsernames: new Set(['marc']),
        });

        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({
            providerId: 'abs-book-1',
            providerUsername: 'Marc',
            resumePositionMs: 1_200_000,
        });
        expect(client.getUserAsAdmin).toHaveBeenCalledWith('abs-marc', undefined);
        expect(client.getMeAs).not.toHaveBeenCalled();
        expect(client.createApiKey).not.toHaveBeenCalled();
    });

    it('treats an empty engine audience as nobody, not as an unrestricted pull', async () => {
        const result = await audiobookshelfWatchSync.pullWatchState!(context(), {
            onlyUserIds: [],
            knownUsernames: new Set(['marc']),
        });

        expect(result.items).toEqual([]);
        expect(client.listUsers).not.toHaveBeenCalled();
        expect(client.getUserAsAdmin).not.toHaveBeenCalled();
    });

    it('uses the UUID-keyed engine cursor instead of replaying older progress', async () => {
        client.getUserAsAdmin.mockResolvedValueOnce({
            id: 'abs-marc',
            username: 'marc',
            mediaProgress: [
                {
                    id: 'old',
                    libraryItemId: 'old-book',
                    mediaItemType: 'book',
                    episodeId: null,
                    currentTime: 100,
                    duration: 1_000,
                    progress: 0.1,
                    isFinished: false,
                    lastUpdate: 1_700_000_000_000,
                    startedAt: null,
                    finishedAt: null,
                },
                {
                    id: 'new',
                    libraryItemId: 'new-book',
                    mediaItemType: 'book',
                    episodeId: null,
                    currentTime: 200,
                    duration: 1_000,
                    progress: 0.2,
                    isFinished: false,
                    lastUpdate: 1_800_000_000_000,
                    startedAt: null,
                    finishedAt: null,
                },
            ],
        });

        const result = await audiobookshelfWatchSync.pullWatchState!(context(), {
            onlyUserIds: ['lumastra-marc'],
            knownUsernames: new Set(['marc']),
            cursors: new Map([['lumastra-marc', new Date(1_750_000_000_000).toISOString()]]),
        });

        expect(result.items.map((item) => item.providerId)).toEqual(['new-book']);
    });

    it('caps user reads at four in flight and passes the cancellation signal', async () => {
        const users = Array.from({ length: 7 }, (_, index) => ({
            userId: `local-${index}`,
            username: `user-${index}`,
        }));
        client.listUsers.mockResolvedValue(
            users.map((user, index) => ({ id: `abs-${index}`, username: user.username })),
        );
        let active = 0;
        let maxActive = 0;
        const controller = new AbortController();
        client.getUserAsAdmin.mockImplementation(
            async (id: string, signal: AbortSignal | undefined) => {
                expect(signal).toBe(controller.signal);
                active++;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active--;
                return { id, username: id, mediaProgress: [] };
            },
        );

        await audiobookshelfWatchSync.pullWatchState!(context(users), {
            onlyUserIds: users.map((user) => user.userId),
            knownUsernames: new Set(users.map((user) => user.username)),
            signal: controller.signal,
        });

        expect(maxActive).toBe(4);
        expect(client.getUserAsAdmin).toHaveBeenCalledTimes(7);
    });

    it('aborts in-flight reads and does not start another worker batch', async () => {
        const users = Array.from({ length: 7 }, (_, index) => ({
            userId: `local-${index}`,
            username: `user-${index}`,
        }));
        client.listUsers.mockResolvedValue(
            users.map((user, index) => ({ id: `abs-${index}`, username: user.username })),
        );
        const controller = new AbortController();
        client.getUserAsAdmin.mockImplementation(
            (_id: string, signal: AbortSignal | undefined) =>
                new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                        once: true,
                    });
                }),
        );

        const pull = audiobookshelfWatchSync.pullWatchState!(context(users), {
            onlyUserIds: users.map((user) => user.userId),
            knownUsernames: new Set(users.map((user) => user.username)),
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(client.getUserAsAdmin).toHaveBeenCalledTimes(4));
        controller.abort();
        await pull;

        expect(client.getUserAsAdmin).toHaveBeenCalledTimes(4);
    });
});
