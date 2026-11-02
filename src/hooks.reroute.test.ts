// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { reroute } from './hooks';

/** Invoke the reroute hook with just a pathname. */
async function re(pathname: string): Promise<string | void> {
    return reroute({ url: new URL(`http://localhost${pathname}`) } as Parameters<
        typeof reroute
    >[0]);
}

describe('reroute /j compat normalization', () => {
    it('uppercases lowercase /j/system paths (jellyfin_apiclient_python)', async () => {
        expect(await re('/j/system/info/public')).toBe('/j/System/Info/Public');
    });

    it('uppercases the lowercase Items segment in findroid image URLs', async () => {
        // findroid (jellyfin-sdk-kotlin) lowercases the Items segment in image URLs.
        expect(await re('/j/items/abc/Images/Primary')).toBe('/j/Items/abc/Images/Primary');
    });

    it('strips the trailing Jellyfin image index from backdrop URLs', async () => {
        // Jellyfin image URLs carry an optional trailing image index (/Images/Backdrop/0).
        expect(await re('/j/items/abc/Images/Backdrop/0')).toBe('/j/Items/abc/Images/Backdrop');
        expect(await re('/j/Items/abc/Images/Backdrop/0')).toBe('/j/Items/abc/Images/Backdrop');
    });

    it('strips the trailing image index from user image (avatar) URLs', async () => {
        const id = 'caaf0693-bbfd-4444-bde3-c429bfb4dc86';
        expect(await re(`/j/Users/${id}/Images/Primary/0`)).toBe(`/j/Users/${id}/Images/Primary`);
    });

    it('leaves a correctly-cased, index-less image URL unchanged', async () => {
        expect(await re('/j/Items/abc/Images/Primary')).toBe('/j/Items/abc/Images/Primary');
    });

    it('preserves the lowercase-hex item UUID when uppercasing the Items segment', async () => {
        const id = 'd8900695-2ee1-4430-ac3b-b71dd9defce3';
        expect(await re(`/j/items/${id}/Images/Primary`)).toBe(`/j/Items/${id}/Images/Primary`);
    });
});
