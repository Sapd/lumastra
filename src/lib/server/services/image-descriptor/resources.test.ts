// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ImageSetSchema } from '$lib/schemas/api-image-descriptor.js';
import {
    personImageSet,
    channelImageSet,
    libraryImageSet,
    audiobookImageSet,
    playlistImageSet,
} from './resources.js';
import { userAvatarSet } from './resolver.js';

describe.each(['internal', 'v1'] as const)('%s resource artwork', (surface) => {
    it('advertises real person renditions and omits unknown profiles', () => {
        expect(personImageSet(surface, 7)).toEqual({});
        const images = personImageSet(surface, 7, '/profile.jpg');
        expect(ImageSetSchema.parse(images)).toEqual(images);
        expect(images.primary?.variants?.thumb).toContain('/people/7/images/profile?size=w45&v=');
        expect(images.primary?.variants?.card).toContain('size=w185&v=');
        expect(images.primary?.variants?.full).toContain('size=original&v=');
        expect(personImageSet(surface, 7, '/new.jpg').primary?.revision).not.toBe(
            images.primary?.revision,
        );
    });
    it('always provides an avatar, including generated initials and stored versions', () => {
        const generated = userAvatarSet(surface, { userId: 'user', version: '0', generated: true });
        expect(generated.primary?.source).toBe('generated');
        expect(generated.primary?.href).toContain('/users/user/images/avatar?size=card&v=0');
        expect(generated.primary?.href).toContain('&fallback=initials');
        expect(Object.keys(generated.primary?.variants ?? {}).sort()).toEqual([
            'card',
            'full',
            'thumb',
        ]);
        for (const href of Object.values(generated.primary?.variants ?? {})) {
            expect(new URL(href, 'http://localhost').searchParams.get('fallback')).toBe('initials');
        }
        expect(ImageSetSchema.parse(generated)).toEqual(generated);
        const uploaded = userAvatarSet(surface, { userId: 'user', version: '1720000000012' });
        expect(uploaded.primary?.href).not.toContain('fallback=');
        expect(uploaded.primary?.revision).toBe('1720000000012');
        expect(uploaded.primary?.source).toBe('self');
        expect(ImageSetSchema.safeParse(uploaded).success).toBe(true);
    });
    it('uses content hashes and only real library sizes', () => {
        const images = libraryImageSet(surface, 'library', 'content-hash');
        expect(Object.keys(images)).toEqual(['primary', 'backdrop']);
        for (const image of Object.values(images)) {
            expect(image?.source).toBe('generated');
            expect(image?.revision).toBe('content-hash');
            expect(Object.keys(image?.variants ?? {})).toEqual(['thumb', 'card', 'hd', 'full']);
        }
        expect(libraryImageSet(surface, 'library', null)).toEqual({});
    });
    it('serves channel logos through the channel media id and preserves provider revisions', () => {
        expect(channelImageSet(surface, 'channel')).toEqual({});
        const images = channelImageSet(surface, 'channel', 'https://logo/one');
        expect(images.primary?.href).toContain('/media/channel/images/poster?size=card&v=');
        expect(channelImageSet(surface, 'channel', 'https://logo/two').primary?.revision).not.toBe(
            images.primary?.revision,
        );
        expect(channelImageSet(surface, 'channel', images).primary?.revision).toBe(
            images.primary?.revision,
        );
    });
    it('uses the ABS artwork revision for primary audiobook covers', () => {
        expect(audiobookImageSet(surface, '', '0')).toEqual({});
        const images = audiobookImageSet(surface, 'book', '1780000000');
        expect(images.primary?.revision).toBe('1780000000');
        expect(images.primary?.href).toContain('/media/book/images/poster?size=card&v=1780000000');
        expect(ImageSetSchema.safeParse(images).success).toBe(true);
    });
    it('prefers own playlist covers and versions collages when members change artwork', () => {
        expect(playlistImageSet(surface, null, [])).toEqual({});
        const members = [
            { id: 'one', revision: '1' },
            { id: 'two', revision: '2' },
        ];
        const collage = playlistImageSet(surface, null, members).primary;
        expect(collage?.source).toBe('generated');
        expect(collage?.variants?.card).toContain('ids=one,two&size=card&v=');
        expect(
            playlistImageSet(surface, null, [{ id: 'one', revision: 'new' }, members[1]]).primary
                ?.revision,
        ).not.toBe(collage?.revision);
        expect(playlistImageSet(surface, null, [...members].reverse()).primary?.revision).not.toBe(
            collage?.revision,
        );
        const own = playlistImageSet(surface, 'https://covers/own', members).primary;
        expect(own?.source).toBe('self');
        expect(own?.href).toContain('https://covers/own?v=');
    });
});
