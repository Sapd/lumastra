// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchMetadataUrl } from '../fetcher';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

function mockFetchOnce(body: string, init?: ResponseInit): void {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(body, init));
}

describe('fetchMetadataUrl', () => {
    it('returns { contentType, text } on success', async () => {
        mockFetchOnce('{"ok":true}', {
            headers: { 'Content-Type': 'application/json' },
        });
        const res = await fetchMetadataUrl('https://example.com/np', {});
        expect(res.contentType).toBe('application/json');
        expect(res.text).toBe('{"ok":true}');
    });

    it('rejects non-http(s) schemes', async () => {
        await expect(fetchMetadataUrl('file:///etc/passwd', {})).rejects.toThrow(/scheme/i);
    });

    it('rejects private IPs (SSRF guard)', async () => {
        await expect(fetchMetadataUrl('http://127.0.0.1/x', {})).rejects.toThrow(
            /private|disallow|ssrf|loopback/i,
        );
    });

    it('times out per opts.timeoutMs', async () => {
        globalThis.fetch = vi
            .fn()
            .mockImplementation(() => new Promise(() => {}) /* never resolves */);
        await expect(
            fetchMetadataUrl('https://example.com/slow', { timeoutMs: 50 }),
        ).rejects.toThrow(/abort|timeout/i);
    });

    it('caps response size at 1 MiB', async () => {
        const huge = 'x'.repeat(2 * 1024 * 1024);
        mockFetchOnce(huge, { headers: { 'Content-Type': 'text/plain' } });
        await expect(fetchMetadataUrl('https://example.com/big', {})).rejects.toThrow(
            /too large|size/i,
        );
    });

    it('stops downloading once the cap is passed when no Content-Length is sent', async () => {
        let pulled = 0;
        const chunk = new Uint8Array(64 * 1024).fill(0x61);
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += chunk.byteLength;
                if (pulled > 512 * 1024 * 1024) controller.close();
                else controller.enqueue(chunk);
            },
        });
        globalThis.fetch = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(stream, { headers: { 'Content-Type': 'text/plain' } }),
            );
        await expect(fetchMetadataUrl('https://example.com/endless', {})).rejects.toThrow(
            /too large|size/i,
        );
        expect(pulled).toBeLessThan(8 * 1024 * 1024);
    });

    it('forwards a user-agent when provided', async () => {
        const spy = vi.fn().mockResolvedValue(
            new Response('ok', {
                headers: { 'Content-Type': 'text/plain' },
            }),
        );
        globalThis.fetch = spy;
        await fetchMetadataUrl('https://example.com/x', {
            userAgent: 'MyBot/1.0',
        });
        const init = spy.mock.calls[0][1] as RequestInit;
        const headers = new Headers(init.headers);
        expect(headers.get('user-agent')).toBe('MyBot/1.0');
    });
});
