// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Handle } from '@sveltejs/kit';
import { routedPathname } from '$lib/server/auth/routed-pathname';
import { config } from '$lib/server/config';

const ALLOW_HEADERS = [
    'Content-Type',
    'Authorization',
    'X-Emby-Authorization',
    'X-Emby-Token',
    'X-MediaBrowser-Token',
    'X-Emby-Client',
    'X-Emby-Client-Version',
    'X-Emby-Device-Id',
    'X-Emby-Device-Name',
    'Range',
    'If-Range',
    'If-None-Match',
    'If-Modified-Since',
    'X-Requested-With',
].join(', ');
const EXPOSE_HEADERS =
    'Content-Range, Accept-Ranges, Content-Length, ETag, Retry-After, X-Application-Error-Code';

/** Token-only /j CORS, granted only by explicit administrator opt-in. */
export const jellyfinCorsHandle: Handle = async ({ event, resolve }) => {
    const path = routedPathname(event.url);
    if (path !== '/j' && !path.startsWith('/j/')) return resolve(event);
    if (!config.FEATURE_JELLYFIN_COMPAT) return new Response('Not Found', { status: 404 });

    const origins = config.JELLYFIN_COMPAT_CORS_ORIGINS;
    const origin = event.request.headers.get('Origin');
    const allowed = !!origin && (origins.includes('*') || origins.includes(origin));
    const response =
        allowed && event.request.method === 'OPTIONS'
            ? new Response(null, {
                  status: 204,
                  headers: {
                      'Access-Control-Allow-Methods':
                          'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
                      'Access-Control-Allow-Headers': ALLOW_HEADERS,
                      'Access-Control-Max-Age': '600',
                  },
              })
            : await resolve(event);

    // Copy only the wrapper: streaming media is never buffered. Remove any
    // downstream CORS grants so this setting remains authoritative for /j.
    const result = new Response(response.body, response);
    for (const name of [...result.headers.keys()]) {
        if (
            name.toLowerCase().startsWith('access-control-') &&
            !(allowed && event.request.method === 'OPTIONS')
        )
            result.headers.delete(name);
    }
    result.headers.delete('Access-Control-Allow-Credentials');
    result.headers.append('Vary', 'Origin');
    if (allowed) {
        result.headers.set('Access-Control-Allow-Origin', origins.includes('*') ? '*' : origin!);
        result.headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS);
    }
    return result;
};
