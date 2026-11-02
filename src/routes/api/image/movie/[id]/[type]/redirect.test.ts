// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { GET as movieGet } from './+server';

async function location(get: (e: never) => unknown, id: string): Promise<string> {
    try {
        await get({
            params: { id, type: 'poster' },
            url: new URL('http://localhost/api/image/movie/x/poster?w=1'),
        } as never);
    } catch (e) {
        return (e as { location: string }).location;
    }
    throw new Error('no redirect');
}

describe('image redirect routes', () => {
    it('encode the decoded id so it stays one path segment', async () => {
        const loc = await location(movieGet as never, 'a/../b\r\nX: y');
        expect(loc).not.toMatch(/[\r\n]/);
        expect(new URL(loc, 'http://localhost').pathname.split('/')).toHaveLength(6);
    });

    it('keeps a numeric id', async () => {
        expect(await location(movieGet as never, '42')).toBe('/api/image/sonarr/42/poster?w=1');
    });
});
