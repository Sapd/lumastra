// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getUserAvatarVersions } from '$lib/server/database/queries/resource-images.queries.js';
import { userImageSets } from './avatars.js';

const { avatar } = vi.hoisted(() => ({ avatar: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({ config: { AUTH_OIDC_SYNC_AVATAR: true } }));
vi.mock('$lib/server/database/queries/resource-images.queries.js', () => ({
    getUserAvatarVersions: vi.fn(),
}));
vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({ getUserAvatar: avatar }),
}));
const versions = vi.mocked(getUserAvatarVersions);
const sql = {} as postgres.Sql;

beforeEach(() => {
    vi.clearAllMocks();
    versions.mockResolvedValue([]);
    avatar.mockResolvedValue(null);
});
describe('user image sets', () => {
    it('keeps the uploaded version without fetching avatar bytes', async () => {
        versions.mockResolvedValue([{ id: 'user', has_avatar: true, version: '123456' }]);
        const images = (await userImageSets(sql, 'v1', ['user'])).get('user');
        expect(images?.primary).toMatchObject({ revision: '123456', source: 'self' });
        expect(images?.primary?.href).toContain('v=123456');
        expect(avatar).not.toHaveBeenCalled();
    });
    it('always advertises generated initials when the complete fallback chain misses', async () => {
        versions.mockResolvedValue([{ id: 'user', has_avatar: false, version: null }]);
        const images = (await userImageSets(sql, 'internal', ['user'])).get('user');
        expect(images?.primary).toMatchObject({ revision: '0', source: 'generated' });
        expect(avatar).toHaveBeenCalledWith('user');
    });
    it('retains the avatar route for a Jellyfin or Gravatar fallback', async () => {
        versions.mockResolvedValue([{ id: 'user', has_avatar: false, version: null }]);
        avatar.mockResolvedValue({ buffer: new Uint8Array([1]) });
        const images = (await userImageSets(sql, 'v1', ['user'])).get('user');
        expect(images?.primary).toMatchObject({ revision: '0', source: 'self' });
    });
    it('gives users that do not exist no entry and never asks the proxy about them', async () => {
        const sets = await userImageSets(sql, 'v1', ['ghost']);
        expect(sets.has('ghost')).toBe(false);
        expect(avatar).not.toHaveBeenCalled();
    });
    it('with external:false never consults the image proxy and keeps stored/generated sources', async () => {
        versions.mockResolvedValue([
            { id: 'stored', has_avatar: true, version: '77' },
            { id: 'none', has_avatar: false, version: null },
        ]);
        // Even a resolvable Jellyfin/Gravatar avatar must not be looked up.
        avatar.mockResolvedValue({ buffer: new Uint8Array([1]) });
        const sets = await userImageSets(sql, 'v1', ['stored', 'none'], { external: false });
        expect(avatar).not.toHaveBeenCalled();
        expect(sets.get('stored')?.primary).toMatchObject({ revision: '77', source: 'self' });
        expect(sets.get('stored')?.primary?.href).not.toContain('fallback=initials');
        expect(sets.get('none')?.primary).toMatchObject({ revision: '0', source: 'generated' });
        expect(sets.get('none')?.primary?.href).toContain('fallback=initials');
    });
});
