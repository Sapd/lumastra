// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Data assembly for the Proxy tab on Settings → Live TV (admin IA redesign,
 * spec §3.6: sources/channels/proxy/radio are tabs on ONE page). Extracted
 * from the former standalone `/admin/livetv/proxy` route's `+page.server.ts`
 * load so the merged page's server load can compose it alongside the
 * settings-framework (Sources) load without duplicating the logic.
 */
import { config } from '$lib/server/config.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import type { ProxyStatusResponse } from '$lib/schemas/livetv.js';

export interface LiveTvProxyTabData {
    liveTvSource: string;
    proxyStatus: ProxyStatusResponse | null;
    proxyError: string | null;
}

export async function loadLiveTvProxyTabData(): Promise<LiveTvProxyTabData> {
    const liveTvSource = config.LIVETV_SOURCE;

    if (liveTvSource !== 'standalone') {
        return { liveTvSource, proxyStatus: null, proxyError: null };
    }

    try {
        const proxyStatus = await getStreamProxyClient().getProxyStatus();
        return { liveTvSource, proxyStatus, proxyError: null };
    } catch {
        // best-effort: unreachable proxy surfaced to the tab via `proxyError`, not swallowed.
        return {
            liveTvSource,
            proxyStatus: null,
            proxyError: `Stream proxy unreachable at ${config.STREAM_PROXY_URL || '(not configured)'}`,
        };
    }
}
