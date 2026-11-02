// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ImageSetRole } from '$lib/schemas/api-image-descriptor.js';
import { chainFor } from './chains.js';

const rows: [string, ImageSetRole, string[]][] = [
    ...['movie', 'series', 'tv'].flatMap((type): [string, ImageSetRole, string[]][] =>
        ['poster', 'backdrop', 'logo', 'thumb', 'banner'].map((role) => [
            type,
            role as ImageSetRole,
            [`self:${role}`],
        ]),
    ),
    ...['poster', 'backdrop', 'logo', 'banner'].map((role): [string, ImageSetRole, string[]] => [
        'season',
        role as ImageSetRole,
        [`self:${role}`, `series:${role}`],
    ]),
    ['season', 'thumb', ['self:thumb']],
    ...['poster', 'backdrop', 'logo', 'banner'].map((role): [string, ImageSetRole, string[]] => [
        'episode',
        role as ImageSetRole,
        [`self:${role}`, `season:${role}`, `series:${role}`],
    ]),
    ['episode', 'thumb', ['self:thumb', 'self:backdrop', 'series:backdrop']],
    ['track', 'primary', ['self:poster', 'album:poster']],
    ['album', 'primary', ['self:poster', 'artist:poster']],
    ...['backdrop', 'logo', 'banner'].map((role): [string, ImageSetRole, string[]] => [
        'album',
        role as ImageSetRole,
        [`self:${role}`],
    ]),
    ['artist', 'primary', ['self:poster']],
    ['artist', 'banner', ['self:banner']],
    ['artist', 'backdrop', ['self:backdrop']],
    ['artist', 'logo', ['self:logo']],
    ['audiobook', 'primary', ['self:poster']],
    ['person', 'primary', ['self:poster']],
    [
        'user',
        'primary',
        ['uploaded:avatar', 'idp:avatar', 'jellyfin:avatar', 'gravatar:avatar', 'generated:avatar'],
    ],
    ['library', 'primary', ['generated:primary']],
    ['library', 'backdrop', ['generated:backdrop']],
    ['tvchannel', 'primary', ['self:poster']],
    ['station', 'primary', ['self:poster']],
    ['channel', 'primary', ['self:poster']],
    ['playlist', 'primary', ['self:poster', 'generated:primary']],
];
describe('documented chains', () => {
    it.each(rows)('%s %s', (type, role, expected) => {
        expect(chainFor(type, role).map((step) => `${step.owner}:${step.role}`)).toEqual(expected);
    });
    it('normalizes repository media types and rejects undocumented roles', () => {
        expect(chainFor('Episode', 'thumb')).toEqual(chainFor('episode', 'thumb'));
        expect(chainFor('album', 'thumb')).toEqual([]);
        expect(chainFor('unknown', 'primary')).toEqual([]);
        expect(chainFor('movie', 'primary')).toEqual([]);
    });
});
