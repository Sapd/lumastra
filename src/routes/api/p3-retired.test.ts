// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { fallback } from './v1/[...path]/+server.js';

// Run SvelteKit's actual endpoint method dispatch, including generated undefined exports.
const kitRoot = dirname(createRequire(import.meta.url).resolve('@sveltejs/kit/package.json'));
const runtimeUrl = pathToFileURL(resolve(kitRoot, 'src/runtime/server/endpoint.js')).href;
const { render_endpoint } = (await import(/* @vite-ignore */ runtimeUrl)) as {
    render_endpoint: (
        event: RequestEvent,
        eventState: unknown,
        endpoint: object,
        state: unknown,
    ) => Promise<Response>;
};
const mounts = [
    ['./me/playback-preferences/+server.js', '/api/me/playback-preferences'],
    ['./v1/me/playback-preferences/+server.js', '/api/v1/me/playback-preferences'],
    ['./watch-state/[id]/+server.js', '/api/watch-state/example'],
    ['./v1/watch-state/[id]/+server.js', '/api/v1/watch-state/example'],
    ['./playlists/[id]/+server.js', '/api/playlists/1'],
    ['./v1/playlists/[id]/+server.js', '/api/v1/playlists/1'],
    ['./tasks/[taskId]/state/+server.js', '/api/tasks/example/state'],
    ['./v1/tasks/[taskId]/state/+server.js', '/api/v1/tasks/example/state'],
];
function event(path: string, method: string): RequestEvent {
    const url = new URL(`http://localhost${path}`);
    return { url, request: new Request(url, { method }), route: { id: null } } as RequestEvent;
}

describe('P3 retired routes and methods', () => {
    it.each(mounts)('%s answers retired PUT with 405', async (module, path) => {
        const endpoint = await import(module);
        const response = await render_endpoint(event(path, 'PUT'), {}, endpoint, {});
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toContain('PATCH');
    });
    it.each([
        'user/profile',
        'stats/me',
        'user/playback-preferences',
        'user/pats',
        'user/links',
        'user/music/top-tracks',
        'user/series-follows',
        'user/notification-forwarding',
        'user/notification-webhook',
    ])('%s is absent and the unmatched request answers 404', async (path) => {
        expect(existsSync(resolve(__dirname, 'v1', path, '+server.ts'))).toBe(false);
        const response = await fallback(event(`/api/v1/${path}`, 'GET') as Parameters<typeof fallback>[0]);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'not_found' });
    });
});
