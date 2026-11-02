// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetch, readKey, config } = vi.hoisted(() => ({
    fetch: vi.fn(),
    readKey: vi.fn(),
    config: { AUDIOBOOK_AUTO_CREATE_USERS: true },
}));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({ fetchWithTimeout: fetch }));
vi.mock('$lib/server/config.js', () => ({ config }));
vi.mock('../tasks/secrets.js', () => ({
    PluginSecrets: class {
        getUserRaw = readKey;
    },
}));

import { checkAudiobookshelfUserMatches } from './audiobookshelf-user-matches.js';
import { selectAudiobookshelfSyncUsers } from './audiobookshelf-sync-users.js';

describe('Audiobookshelf user-check failures', () => {
    beforeEach(() => {
        fetch.mockReset();
        readKey.mockReset().mockResolvedValue('stored-key');
        config.AUDIOBOOK_AUTO_CREATE_USERS = true;
    });

    it.each(['network', 'json'])(
        'never exposes credentials through a %s failure',
        async (failure) => {
            const error = new Error('https://user:password@abs.example/?key=secret-token');
            if (failure === 'network') fetch.mockRejectedValue(error);
            else
                fetch.mockResolvedValue({
                    ok: true,
                    json: async () => {
                        throw error;
                    },
                });
            await expect(
                checkAudiobookshelfUserMatches(
                    vi.fn() as never,
                    'https://abs.example',
                    'secret-token',
                ),
            ).rejects.toThrow(/^Audiobookshelf user check unavailable$/);
        },
    );

    it.each([{}, { users: null }, { users: [{ id: 'one' }] }])(
        'does not treat a malformed user list as zero matches (%j)',
        async (body) => {
            fetch.mockResolvedValue(new Response(JSON.stringify(body)));
            await expect(
                checkAudiobookshelfUserMatches(
                    vi.fn() as never,
                    'https://abs.example',
                    'secret-token',
                ),
            ).rejects.toThrow('Audiobookshelf user check unavailable');
        },
    );
});

interface Listener {
    userId: string;
    username: string;
    linked?: boolean;
    pullDisabled?: boolean;
}

function database(users: Listener[]) {
    return vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join(' ');
        if (query.includes('SELECT puc.user_id')) return users.filter((user) => user.linked);
        return query.includes('AND NOT EXISTS')
            ? users.filter((user) => !user.pullDisabled)
            : users;
    });
}

describe('Audiobookshelf sync diagnostic audience', () => {
    beforeEach(() => {
        config.AUDIOBOOK_AUTO_CREATE_USERS = true;
        readKey.mockReset().mockResolvedValue('stored-key');
        fetch
            .mockReset()
            .mockImplementation(
                async (url: string) =>
                    new Response(
                        JSON.stringify(
                            url.includes('/api/me')
                                ? { id: 'abs-linked', username: 'different-name' }
                                : { users: [] },
                        ),
                    ),
            );
    });

    it('does not warn about accounts provisioned lazily on first playback', async () => {
        const result = await checkAudiobookshelfUserMatches(
            database([{ userId: 'new', username: 'new' }]) as never,
            'http://abs.test',
            'operator',
        );
        expect(result.unmatchedUsernames).toEqual([]);
        expect(result.matchedUsernames).toEqual([]);
        expect(result.pendingUsernames).toEqual(['new']);
        expect(readKey).not.toHaveBeenCalled();
    });

    it('lists ABS-only accounts without warning about pending local listeners', async () => {
        fetch.mockResolvedValue(
            new Response(JSON.stringify({ users: [{ id: 'orphan', username: 'absorphan' }] })),
        );
        const result = await checkAudiobookshelfUserMatches(
            database([{ userId: 'kid', username: 'kidviewer' }]) as never,
            'http://abs.test',
            'operator',
        );
        expect(result.unmatchedUsernames).toEqual(['absorphan']);
        expect(result.pendingUsernames).toEqual(['kidviewer']);
    });

    it('recognizes a renamed upstream account by its stored link', async () => {
        fetch.mockImplementation(
            async (url: string) =>
                new Response(
                    JSON.stringify(
                        url.includes('/api/me')
                            ? { id: 'linked', username: 'renamed' }
                            : {
                                  users: [
                                      { id: 'linked', username: 'renamed' },
                                      { id: 'orphan', username: 'absorphan' },
                                  ],
                              },
                    ),
                ),
        );
        const result = await checkAudiobookshelfUserMatches(
            database([{ userId: 'local', username: 'original', linked: true }]) as never,
            'http://abs.test',
            'operator',
        );
        expect(result.unmatchedUsernames).toEqual(['absorphan']);
        expect(result.matchedUsernames).toEqual(['original']);
    });

    it('warns about a missing account when automatic creation is disabled', async () => {
        config.AUDIOBOOK_AUTO_CREATE_USERS = false;
        const result = await checkAudiobookshelfUserMatches(
            database([{ userId: 'new', username: 'new' }]) as never,
            'http://abs.test',
            'operator',
        );
        expect(result.unmatchedUsernames).toEqual(['new']);
    });

    it('honors stored credentials despite folded local-name collisions', async () => {
        const result = await checkAudiobookshelfUserMatches(
            database([
                { userId: 'one', username: 'Same', linked: true },
                { userId: 'two', username: 'same', linked: true },
            ]) as never,
            'http://abs.test',
            'operator',
            ' SAME ',
        );
        expect(result.unmatchedUsernames).toEqual([]);
        expect(result.matchedUsernames).toEqual(['Same', 'same']);
        expect(result.adminMatched).toBe(true);
        expect(readKey).toHaveBeenCalledTimes(2);
    });

    it('does not bless a rejected stored key even if name fallback can find the user', async () => {
        fetch.mockImplementation(async (url: string) =>
            url.includes('/api/me')
                ? new Response('{}', { status: 401 })
                : new Response(JSON.stringify({ users: [{ id: 'abs', username: 'Admin' }] })),
        );
        const result = await checkAudiobookshelfUserMatches(
            database([{ userId: 'admin', username: 'Admin', linked: true }]) as never,
            'http://abs.test',
            'operator',
            'admin',
        );
        expect(result.adminMatched).toBe(false);
        expect(result.matchedUsernames).toEqual([]);
        expect(result.unmatchedUsernames).toEqual(['Admin']);
    });

    it('never matches an opted-out admin, even when the ABS name exists', async () => {
        fetch.mockResolvedValue(
            new Response(JSON.stringify({ users: [{ id: 'abs', username: 'Admin' }] })),
        );
        const result = await checkAudiobookshelfUserMatches(
            database([{ userId: 'admin', username: 'Admin', pullDisabled: true }]) as never,
            'http://abs.test',
            'operator',
            ' ADMIN ',
        );
        expect(result.adminMatched).toBe(false);
        expect(result.unmatchedUsernames).toEqual([]);
    });

    it('does not let another folded-name link hide an opted-out admin', async () => {
        const result = await checkAudiobookshelfUserMatches(
            database([
                { userId: 'admin', username: 'Admin', linked: true, pullDisabled: true },
                { userId: 'other', username: 'admin', linked: true },
            ]) as never,
            'http://abs.test',
            'operator',
            ' ADMIN ',
        );
        expect(result.adminMatched).toBe(false);
        expect(result.unmatchedUsernames).toEqual([]);
    });

    it('applies the same knownUsernames pre-filter as the engine', async () => {
        fetch.mockResolvedValue(
            new Response(JSON.stringify({ users: [{ id: 'abs', username: 'Admin' }] })),
        );
        const result = await checkAudiobookshelfUserMatches(
            database([{ userId: 'admin', username: 'Admin', linked: true }]) as never,
            'http://abs.test',
            'operator',
            'admin',
            { knownUsernames: new Set() },
        );
        expect(result.adminMatched).toBe(false);
        expect(result.matchedUsernames).toEqual([]);
        expect(readKey).not.toHaveBeenCalled();
    });

    it('folds the admin name using the same NFC, whitespace and case normalization', async () => {
        fetch.mockResolvedValue(
            new Response(JSON.stringify({ users: [{ id: 'abs', username: 'CAFÉ' }] })),
        );
        const result = await checkAudiobookshelfUserMatches(
            database([{ userId: 'admin', username: 'cafe\u0301' }]) as never,
            'http://abs.test',
            'operator',
            ' CAFÉ ',
        );
        expect(result.adminMatched).toBe(true);
    });

    it('still warns about ambiguous upstream names with automatic creation enabled', async () => {
        fetch.mockResolvedValue(
            new Response(
                JSON.stringify({
                    users: [
                        { id: 'one', username: 'Same' },
                        { id: 'two', username: 'same' },
                    ],
                }),
            ),
        );
        const result = await checkAudiobookshelfUserMatches(
            database([{ userId: 'local', username: 'Same' }]) as never,
            'http://abs.test',
            'operator',
        );
        expect(result.unmatchedUsernames).toEqual(['Same']);
    });

    it('keeps pull-disabled users eligible for credential-gated push only', async () => {
        const sql = database([
            { userId: 'one', username: 'Same', linked: true, pullDisabled: true },
            { userId: 'two', username: 'unlinked' },
        ]);
        expect(
            (await selectAudiobookshelfSyncUsers(sql as never, { direction: 'push' })).users.map(
                (user) => user.userId,
            ),
        ).toEqual(['one']);
        expect(
            (await selectAudiobookshelfSyncUsers(sql as never)).users.map((user) => user.userId),
        ).toEqual(['two']);
    });

    it.each(['network', 'json'])(
        'never echoes a stored credential when its %s probe fails',
        async (failure) => {
            fetch.mockImplementation(async (url: string) => {
                if (!url.includes('/api/me')) return new Response(JSON.stringify({ users: [] }));
                if (failure === 'network')
                    throw new Error('http://user:secret@abs.test stored-key');
                return new Response('invalid secret-key JSON');
            });
            await expect(
                checkAudiobookshelfUserMatches(
                    database([{ userId: 'one', username: 'linked', linked: true }]) as never,
                    'http://abs.test',
                    'operator',
                ),
            ).rejects.toThrow(/^Audiobookshelf user check unavailable$/);
        },
    );
});
