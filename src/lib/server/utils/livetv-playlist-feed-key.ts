// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';

/** Identifies one playlist feed without retaining its credential-bearing tune URL. */
export function playlistFeedKey(name: string, url: string, categoryKey?: string): string {
    // Xtream URLs embed the login in the path. Its stream ID survives login
    // and server changes. For other providers the full tune URL distinguishes
    // same-name feeds, including feeds selected by a query parameter.
    const xtream = url.match(/\/live\/[^/]+\/[^/]+\/(\d+)\.(?:ts|m3u8|mpegts)(?:[?#]|$)/u);
    return createHash('sha256')
        .update(
            JSON.stringify([
                name.trim(),
                xtream ? ['xtream', xtream[1]] : ['url', url],
                categoryKey,
            ]),
        )
        .digest('hex');
}
