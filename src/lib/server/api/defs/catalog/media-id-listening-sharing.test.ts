// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetDb = vi.fn();
const mockResolveCatalogInternalId = vi.fn();
const mockCheckMediaAccess = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockGetDb(),
}));
vi.mock('./resolve-id.js', () => ({
    resolveCatalogInternalId: (...args: unknown[]) => mockResolveCatalogInternalId(...args),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

const configMock = vi.hoisted(() => ({
    SOCIAL_DEFAULT_AUDIENCE: 'auto',
    SOCIAL_TRUST_GROUPS: [] as string[],
}));
vi.mock('$lib/server/config.js', () => ({ config: configMock }));
const { def } = await import('./media-id-listening-sharing.js');

const userId = '00000000-0000-4000-8000-000000000001';
const mediaId = '00000000-0000-4000-8000-000000000002';

function makeEvent(): RequestEvent {
    const url = new URL(`http://localhost/api/v1/media/${mediaId}/listening-sharing`);
    return {
        url,
        params: { id: mediaId },
        route: { id: '/api/v1/media/[id]/listening-sharing' },
        request: new Request(url),
        locals: {
            user: {
                userId,
                username: 'alice',
                userGroups: [],
                ownerIsAdmin: false,
                maxAgeRating: null,
            },
        },
        cookies: {},
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

function makeSql(
    options: {
        mediaType?: string;
        shared?: boolean;
        globallyShared?: boolean;
        hideStreams?: boolean;
        hasAudience?: boolean;
    } = {},
) {
    let shared = options.shared ?? true;
    const sql = vi.fn(async (strings: TemplateStringsArray | string) => {
        if (typeof strings === 'string') return [];
        const query = strings.join(' ');
        if (query.includes('SELECT media_type')) {
            return [{ media_type: options.mediaType ?? 'audiobook' }];
        }
        if (query.includes('AS globally_shared')) {
            return [
                {
                    shared,
                    globally_shared: options.globallyShared ?? true,
                    hide_streams: options.hideStreams ?? false,
                    has_audience: options.hasAudience ?? true,
                },
            ];
        }
        if (query.includes('INSERT INTO user_media_share_opt_out')) shared = false;
        if (query.includes('DELETE FROM user_media_share_opt_out')) shared = true;
        return [];
    });
    return sql;
}

beforeEach(() => {
    vi.clearAllMocks();
    configMock.SOCIAL_DEFAULT_AUDIENCE = 'auto';
    configMock.SOCIAL_TRUST_GROUPS = [];
    mockResolveCatalogInternalId.mockResolvedValue(mediaId);
    mockCheckMediaAccess.mockResolvedValue(true);
});

describe('media-id-listening-sharing', () => {
    it('reports the global and per-book state separately', async () => {
        mockGetDb.mockReturnValue(
            makeSql({ shared: true, globallyShared: false, hideStreams: false }),
        );

        const response = await def.handlers.GET!(makeEvent(), {
            surface: 'v1',
        } as never);

        expect(await response.json()).toEqual({
            shared: true,
            globallyShared: false,
            effectiveShared: false,
            audience: 'household',
            blockedBy: ['global_sharing_off'],
        });
    });

    it('stores and removes the restrictive per-book override', async () => {
        const sql = makeSql();
        mockGetDb.mockReturnValue(sql);

        const privateResponse = await def.handlers.PUT!(makeEvent(), {
            surface: 'v1',
            input: { body: { shared: false } },
        } as never);
        expect(await privateResponse.json()).toEqual({
            shared: false,
            globallyShared: true,
            effectiveShared: false,
            audience: 'household',
            blockedBy: ['item_opted_out'],
        });

        const sharedResponse = await def.handlers.PUT!(makeEvent(), {
            surface: 'v1',
            input: { body: { shared: true } },
        } as never);
        expect(await sharedResponse.json()).toEqual({
            shared: true,
            globallyShared: true,
            effectiveShared: true,
            audience: 'household',
            blockedBy: [],
        });
    });

    it('reports every blocker rather than just the first', async () => {
        mockGetDb.mockReturnValue(
            makeSql({
                shared: false,
                globallyShared: false,
                hideStreams: true,
                hasAudience: false,
            }),
        );
        const response = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        expect(await response.json()).toEqual({
            shared: false,
            globallyShared: false,
            effectiveShared: false,
            audience: 'household',
            blockedBy: ['global_sharing_off', 'hidden', 'item_opted_out', 'no_audience'],
        });
    });

    it.each(['household', 'groups'])('requires audience reach in %s mode', async (mode) => {
        configMock.SOCIAL_DEFAULT_AUDIENCE = mode;
        mockGetDb.mockReturnValue(makeSql({ hasAudience: false }));
        const response = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        expect(await response.json()).toMatchObject({
            effectiveShared: false,
            audience: mode,
            blockedBy: ['no_audience'],
        });
    });

    it('resolves auto to groups when designated groups exist', async () => {
        configMock.SOCIAL_TRUST_GROUPS = ['Family'];
        mockGetDb.mockReturnValue(makeSql());
        const response = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        expect(await response.json()).toMatchObject({
            effectiveShared: true,
            audience: 'groups',
            blockedBy: [],
        });
    });

    it('does not expose the preference endpoint for non-audiobook media', async () => {
        mockGetDb.mockReturnValue(makeSql({ mediaType: 'movie' }));

        const response = await def.handlers.GET!(makeEvent(), {
            surface: 'v1',
        } as never);

        expect(response.status).toBe(404);
    });
});
