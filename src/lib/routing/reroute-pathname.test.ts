// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJellyfinPath, reroutePathname } from './reroute-pathname';
import { JELLYFIN_ROUTE_PATTERNS } from './jellyfin-route-patterns';

const re = (pathname: string): string => reroutePathname(new URL(`http://localhost${pathname}`));
const ID = 'd8900695-2ee1-4430-ac3b-b71dd9defce3';

describe('jellyfin-route-patterns table', () => {
    it('lists exactly the /j route directories (run node scripts/gen-jellyfin-route-patterns.mjs)', () => {
        const dir = join(process.cwd(), 'src/routes/(proprietary)/j');
        // An AGPL-only tree has no /j routes; the table is then irrelevant.
        if (!existsSync(dir)) return;
        const found: string[] = [];
        (function walk(d: string): void {
            for (const e of readdirSync(d)) {
                const p = join(d, e);
                if (statSync(p).isDirectory()) walk(p);
                else if (e === '+server.ts') found.push(d.slice(dir.length) || '/');
            }
        })(dir);
        expect([...JELLYFIN_ROUTE_PATTERNS]).toEqual(
            found.filter((p) => p !== '/[...path]').sort(),
        );
    });
});

describe('case-insensitive /j routing', () => {
    it.each([
        // Finamp transcoded downloads (capital U)
        [`/j/Audio/${ID}/Universal`, `/j/Audio/${ID}/universal`],
        // Findroid TV profile avatars (lowercase users), index stripped as before
        [`/j/users/${ID}/Images/Primary`, `/j/Users/${ID}/Images/Primary`],
        [`/j/users/${ID}/images/primary/0`, `/j/Users/${ID}/Images/primary`],
        // jellyfin-apiclient lowercase paths
        ['/j/users/public', '/j/Users/Public'],
        ['/j/Users/authenticatebyname', '/j/Users/AuthenticateByName'],
        ['/j/Localization/cultures', '/j/Localization/Cultures'],
        // jellyfin_apiclient_python and findroid images (previously special-cased)
        ['/j/system/info/public', '/j/System/Info/Public'],
        [`/j/items/${ID}/Images/Primary`, `/j/Items/${ID}/Images/Primary`],
        ['/j/ITEMS/LATEST', '/j/Items/Latest'],
        ['/j/sessions/playing/progress', '/j/Sessions/Playing/Progress'],
        ['/j/syncplay/list', '/j/SyncPlay/List'],
        [`/j/users/${ID}/playeditems/${ID}`, `/j/Users/${ID}/PlayedItems/${ID}`],
        [`/j/users/${ID}/items/${ID}/userdata`, `/j/Users/${ID}/Items/${ID}/UserData`],
    ])('%s -> %s', (input, expected) => {
        expect(re(input)).toBe(expected);
    });

    it('keeps param values as sent (ids, image types, names)', () => {
        expect(re(`/j/Items/${ID.toUpperCase()}/PlaybackInfo`)).toBe(
            `/j/Items/${ID.toUpperCase()}/PlaybackInfo`,
        );
        expect(re(`/j/shows/${ID}/episodes`)).toBe(`/j/Shows/${ID}/Episodes`);
    });

    it('prefers a static segment over a param, like SvelteKit, and falls back to the param', () => {
        const patterns = ['/Items/[itemId]', '/Items/Latest', '/Items/[itemId]/Similar'];
        expect(canonicalJellyfinPath('/j/items/latest', patterns)).toBe('/j/Items/Latest');
        // "latest" here is an item id: only the param branch reaches a route
        expect(canonicalJellyfinPath('/j/items/latest/similar', patterns)).toBe(
            '/j/Items/latest/Similar',
        );
    });

    it('fixes the literal part of mixed segments and keeps the param part', () => {
        const patterns = ['/Audio/[itemId]/stream', '/Audio/[itemId]/stream.[container]'];
        expect(canonicalJellyfinPath(`/j/audio/${ID}/STREAM.flac`, patterns)).toBe(
            `/j/Audio/${ID}/stream.flac`,
        );
        expect(canonicalJellyfinPath(`/j/audio/${ID}/Stream`, patterns)).toBe(
            `/j/Audio/${ID}/stream`,
        );
    });

    it('keeps everything after a rest param as sent', () => {
        const patterns = ['/web/[...path]', '/web'];
        expect(canonicalJellyfinPath('/j/WEB/Index.HTML', patterns)).toBe('/j/web/Index.HTML');
        expect(canonicalJellyfinPath('/j/Web', patterns)).toBe('/j/web');
    });

    it('leaves a path no route matches unchanged', () => {
        expect(re('/j/NoSuch/Route')).toBe('/j/NoSuch/Route');
        expect(canonicalJellyfinPath('/j/items/x/y/z', ['/Items/[itemId]'])).toBe('/j/items/x/y/z');
    });

    it('does not touch percent-encoded segments (SvelteKit decodes after reroute)', () => {
        expect(re('/j/%49tems/Latest')).toBe('/j/%49tems/Latest');
    });

    it('strips the image index only at real Images/[imageType] positions', () => {
        expect(re('/j/web/images/a/1')).toBe('/j/web/images/a/1');
        expect(re('/j/web/Images/a/1')).toBe('/j/web/Images/a/1');
        expect(re(`/j/Items/${ID}/Images/Primary/0`)).toBe(`/j/Items/${ID}/Images/Primary`);
    });

    it('keeps Images/Chapter/{n} on its own authenticated route (index is not stripped)', () => {
        expect(re(`/j/Items/${ID}/Images/Chapter/3`)).toBe(`/j/Items/${ID}/Images/Chapter/3`);
        expect(re(`/j/items/${ID}/images/chapter/3`)).toBe(`/j/Items/${ID}/Images/Chapter/3`);
    });

    it('canonicalises a lowercase path with a trailing slash', () => {
        expect(re('/j/users/public/')).toBe('/j/Users/Public/');
    });

    it('does not apply to non-/j paths', () => {
        expect(re('/api/v1/MEDIA')).toBe('/api/v1/MEDIA');
    });
});
