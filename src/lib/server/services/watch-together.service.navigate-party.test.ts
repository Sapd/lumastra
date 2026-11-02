// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `navigateParty` (security review 2026-09-12, C11).
 *
 * Mocks at the module boundaries `navigateParty` actually talks to — Valkey
 * cache, the DB handle, `checkMediaAccess`, and the user-lookup queries — not
 * the neighbouring exports of the same service module. Spying on a sibling
 * export in the same file does not intercept the SUT's internal calls to it,
 * so the fixtures below drive real code paths (getSession → isHostClient →
 * participantsBlockedBy → broadcastNavigate) through their actual boundaries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    cacheGet: vi.fn(),
    coordinationCommand: vi.fn(),
    setEx: vi.fn(),
    publishMessage: vi.fn(),
    checkMediaAccess: vi.fn(),
    getUserByUsername: vi.fn(),
    getUserById: vi.fn(),
    resolveTokenUserAccess: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        })),
    },
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    connectValkey: vi.fn(async () => {}),
    isCoordinationValkeyReady: vi.fn(() => true),
    cacheGet: mocks.cacheGet,
    cacheExists: vi.fn(async () => false),
    setEx: mocks.setEx,
    setIfNotExists: vi.fn(async () => true),
    expire: vi.fn(async () => {}),
    incr: vi.fn(async () => 1),
    lPush: vi.fn(async () => 1),
    lTrim: vi.fn(async () => {}),
    lRange: vi.fn(async () => []),
    sAdd: vi.fn(async () => 1),
    sCard: vi.fn(async () => 0),
    sRem: vi.fn(async () => 1),
    hSet: vi.fn(async () => {}),
    hGet: vi.fn(async () => null),
    hGetAll: vi.fn(async () => ({})),
    hDel: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
    getKeysByPattern: vi.fn(async () => []),
    getCoordinationClient: vi.fn(() => ({ customCommand: mocks.coordinationCommand })),
    publishMessage: mocks.publishMessage,
    subscribeToChannel: vi.fn(async () => {}),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => ({}) as unknown),
    getTaskDb: vi.fn(() => ({}) as unknown),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mocks.checkMediaAccess,
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserDisplayInfoByIds: vi.fn(async (_sql: unknown, ids: string[]) =>
        ids.map((id) => ({ id, display_name: null })),
    ),
    getUserById: mocks.getUserById,
    getUserByUsername: mocks.getUserByUsername,
}));

// Rebuild participant access from the canonical resolver, including age caps.
vi.mock('$lib/server/auth/resolve-token-user-access.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/auth/resolve-token-user-access.js')>()),
    resolveTokenUserAccess: mocks.resolveTokenUserAccess,
}));

const { navigateParty } = await import('./watch-together.service.js');

const CODE = 'ABCD';

function sessionFixture() {
    return {
        code: CODE,
        hostUserId: '6b53c5e7-2efa-5f21-a960-0ef577662a2e',
        hostDisplayName: 'Host',
        hostClientId: 'host-client',
        itemId: 'movie-1',
        mediaType: 'movie',
        title: 'Old Title',
        currentTime: 0,
        isPlaying: false,
        playbackRate: 1,
        createdAt: Date.now(),
        lastSync: Date.now(),
        visibility: 'unlisted',
        participants: [
            {
                userId: '6b53c5e7-2efa-5f21-a960-0ef577662a2e',
                displayName: 'Host',
                joinedAt: Date.now(),
                clientId: 'host-client',
            },
            {
                userId: 'ed635603-447b-5762-b2fc-029a02445668',
                displayName: 'Guest',
                joinedAt: Date.now(),
                clientId: 'guest-client',
            },
        ],
    };
}

describe('navigateParty', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cacheGet.mockImplementation(async () => JSON.stringify(sessionFixture()));
        // This authorization suite treats the atomic Redis transaction as a
        // transport boundary; the integration suite executes its Lua in Valkey.
        mocks.coordinationCommand.mockImplementation(async (command: string[]) =>
            command[1]?.includes('atomic timeline publication') ? [1, 1, '{}'] : 1,
        );
        mocks.setEx.mockImplementation(async () => {});
        mocks.publishMessage.mockImplementation(async () => true);
        mocks.getUserById.mockImplementation(async (_db: unknown, id: string) => ({
            id,
            username: 'guest-1',
            groups: [],
            is_admin: false,
            max_age_rating: 6,
        }));

        mocks.resolveTokenUserAccess.mockImplementation(async () => ({
            userGroups: [],
            permissions: {
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: true,
                hasReviewPermission: true,
                hasMediaAnnotationPermission: true,
                isAdmin: false,
                maxAgeRating: 6,
                isAgeRestricted: true,
                isModerator: false,
                liveTvPriority: 'low',
            },
            disabled: false,
            deleted: false,
        }));
    });

    it('refuses a host navigate a non-host participant cannot access, and does not broadcast', async () => {
        // guest-1 is the non-host, lower-rated participant; checkMediaAccess
        // refuses them for the over-rated item the host is trying to navigate to.
        mocks.checkMediaAccess.mockImplementation(
            async (_db: unknown, itemId: string) => itemId !== 'over-rated-item',
        );

        const result = await navigateParty(CODE, 'over-rated-item', 'New Title', {
            userId: '6b53c5e7-2efa-5f21-a960-0ef577662a2e',
            clientId: 'host-client',
            mediaType: 'movie',
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.status).toBe('forbidden');
            expect(result.message).toContain('participant(s) cannot access');
        }
        expect(mocks.setEx).not.toHaveBeenCalled();
        expect(mocks.publishMessage).not.toHaveBeenCalled();
    });

    it('refuses a non-host caller when the host-only gate is on', async () => {
        const result = await navigateParty(CODE, 'movie-2', 'New Title', {
            userId: 'ed635603-447b-5762-b2fc-029a02445668',
            clientId: 'guest-client',
            mediaType: 'movie',
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.status).toBe('forbidden');
            expect(result.message).toContain('host-only');
        }
        // Refused before the access check or any broadcast is attempted.
        expect(mocks.checkMediaAccess).not.toHaveBeenCalled();
        expect(mocks.setEx).not.toHaveBeenCalled();
        expect(mocks.publishMessage).not.toHaveBeenCalled();
    });

    it('broadcasts once when the host navigates to an item everyone can access', async () => {
        mocks.checkMediaAccess.mockResolvedValue(true);

        const result = await navigateParty(CODE, 'movie-2', 'New Title', {
            userId: '6b53c5e7-2efa-5f21-a960-0ef577662a2e',
            clientId: 'host-client',
            mediaType: 'movie',
        });

        expect(result.ok).toBe(true);
        const publications = mocks.coordinationCommand.mock.calls.filter(([command]) =>
            String(command[1]).includes('atomic timeline publication'),
        );
        expect(publications).toHaveLength(1);
        const command = publications[0][0] as string[];
        // Find the event JSON by shape, not position: the publish script's trailing
        // arguments grew with the control fencing (54cfd196fb).
        const payload = command.find((arg) => arg.startsWith('{') && arg.includes('"type"'));
        const event = JSON.parse(payload!) as { type: string; itemId: string };
        expect(event).toMatchObject({ type: 'navigate', itemId: 'movie-2' });
    });

    it('surfaces a retryable dependency error instead of claiming a participant lacks access', async () => {
        const { AuthDependencyUnavailableError } =
            await import('$lib/server/auth/dependency-unavailable.js');
        mocks.resolveTokenUserAccess.mockRejectedValueOnce(new AuthDependencyUnavailableError());
        await expect(
            navigateParty(CODE, 'movie-2', 'New Title', {
                userId: '6b53c5e7-2efa-5f21-a960-0ef577662a2e',
                clientId: 'host-client',
                mediaType: 'movie',
            }),
        ).rejects.toBeInstanceOf(AuthDependencyUnavailableError);
        expect(mocks.publishMessage).not.toHaveBeenCalled();
    });
});
