// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { hlsAuthQuery } from '$lib/server/utils/hls-request-utils.js';
/**
 * Shared bits of the compat variant routes (stream/v/{variant}/...).
 *
 * A variant is what an HEVC channel is served as to a player that cannot use the original:
 * `fmp4` (the same video in fMP4 segments, for Apple native HLS) or `h264` (re-encoded). The
 * `/stream` join decides and starts it; these routes only serve it.
 */
import type { LiveTvCompatVariant } from '../../../../../../../../../../shared/livetv-proxy-types.js';

export function parseVariant(value: string | undefined): LiveTvCompatVariant | null {
    return value === 'fmp4' || value === 'h264' ? value : null;
}

/** grant, propagated so header-less players stay authenticated. */
export function variantAuthQuery(url: URL): string {
    return hlsAuthQuery(url);
}

/** Rewrite the proxy's relative file names to absolute routes carrying the auth query. */
export function rewriteVariantPlaylist(body: string, routeBase: string, query: string): string {
    return body
        .replace(/^(segment-\d+\.(?:ts|m4s))$/gm, `${routeBase}/$1${query}`)
        .replace(
            /^#EXT-X-MAP:URI="(init(?:-\d+)?\.mp4)"$/gm,
            (_line, name: string) => `#EXT-X-MAP:URI="${routeBase}/${name}${query}"`,
        );
}
