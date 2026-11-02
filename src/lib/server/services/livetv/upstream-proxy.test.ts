// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { ProxyAgent } from 'undici';

const proxyUrl = { value: '' };
vi.mock('$lib/server/config.js', () => ({
    config: {
        get LIVETV_UPSTREAM_PROXY_URL(): string {
            return proxyUrl.value;
        },
    },
}));

import { getLiveTvUpstreamDispatcher, resetLiveTvUpstreamDispatcher } from './upstream-proxy.js';

describe('getLiveTvUpstreamDispatcher', () => {
    beforeEach(() => {
        proxyUrl.value = '';
        resetLiveTvUpstreamDispatcher();
    });

    test('returns undefined when no proxy configured', () => {
        expect(getLiveTvUpstreamDispatcher()).toBeUndefined();
    });

    test('returns a ProxyAgent when configured', () => {
        proxyUrl.value = 'http://proxy.internal:8080';
        const agent = getLiveTvUpstreamDispatcher();
        expect(agent).toBeInstanceOf(ProxyAgent);
    });

    test('caches the agent across calls for the same URL', () => {
        proxyUrl.value = 'http://proxy.internal:8080';
        expect(getLiveTvUpstreamDispatcher()).toBe(getLiveTvUpstreamDispatcher());
    });

    test('rebuilds when the URL changes', () => {
        proxyUrl.value = 'http://proxy.internal:8080';
        const first = getLiveTvUpstreamDispatcher();
        proxyUrl.value = 'http://other.internal:3128';
        expect(getLiveTvUpstreamDispatcher()).not.toBe(first);
    });

    test('accepts inline credentials without throwing', () => {
        proxyUrl.value = 'http://user:p%40ss@proxy.internal:8080';
        expect(getLiveTvUpstreamDispatcher()).toBeInstanceOf(ProxyAgent);
    });

    test('throws a descriptive error on a malformed proxy URL', () => {
        proxyUrl.value = 'not a url';
        expect(() => getLiveTvUpstreamDispatcher()).toThrow(
            /LIVETV_UPSTREAM_PROXY_URL is not a valid URL/,
        );
    });

    test('treats a whitespace-only URL as unset', () => {
        proxyUrl.value = '   ';
        expect(getLiveTvUpstreamDispatcher()).toBeUndefined();
    });

    test('throws a descriptive error for a non-http(s) (e.g. SOCKS) proxy URL', () => {
        proxyUrl.value = 'socks5://proxy.internal:1080';
        expect(() => getLiveTvUpstreamDispatcher()).toThrow(/must be an http\(s\) proxy URL/);
    });
});
