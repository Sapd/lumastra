// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * App-side forward proxy for outbound LiveTV→provider traffic.
 *
 * Returns an undici ProxyAgent (HTTP CONNECT) to pass as `fetch`'s `dispatcher`
 * on the LiveTV fetch sites only — leaving all other outbound traffic on the
 * global dispatcher. Returns undefined when LIVETV_UPSTREAM_PROXY_URL is unset
 * (direct connections, feature off).
 *
 * Fail-closed: callers pass this dispatcher and do NOT fall back to a direct
 * connection. A dead proxy makes the fetch reject — by design.
 */
import { ProxyAgent, type Dispatcher } from 'undici';
import { config } from '$lib/server/config.js';
import { redactLiveTvUrl } from '$lib/shared/livetv-url-redaction.js';

let cached: { url: string; agent: ProxyAgent } | null = null;

function buildAgent(rawUrl: string): ProxyAgent {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(`LIVETV_UPSTREAM_PROXY_URL is not a valid URL: ${redactLiveTvUrl(rawUrl)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(
            `LIVETV_UPSTREAM_PROXY_URL must be an http(s) proxy URL (SOCKS needs a socks→http shim): ${redactLiveTvUrl(rawUrl)}`,
        );
    }
    if (parsed.username || parsed.password) {
        const user = decodeURIComponent(parsed.username);
        const pass = decodeURIComponent(parsed.password);
        const token = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
        parsed.username = '';
        parsed.password = '';
        return new ProxyAgent({ uri: parsed.toString(), token });
    }
    return new ProxyAgent(rawUrl);
}

/**
 * The cached ProxyAgent for LiveTV upstream traffic, or undefined when unset.
 */
export function getLiveTvUpstreamDispatcher(): Dispatcher | undefined {
    const url = config.LIVETV_UPSTREAM_PROXY_URL.trim();
    if (!url) return undefined;
    if (cached && cached.url === url) return cached.agent;
    if (cached && cached.url !== url) {
        void cached.agent.close().catch(() => {});
    }
    const agent = buildAgent(url);
    cached = { url, agent };
    return agent;
}

/** Test-only: drop the cached agent so the next call rebuilds. */
export function resetLiveTvUpstreamDispatcher(): void {
    cached = null;
}
