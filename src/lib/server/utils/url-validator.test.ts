// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:dns', () => ({
    promises: {
        lookup: vi.fn(),
    },
}));

import { promises as dns } from 'node:dns';
import { validateUrl } from './url-validator.js';

const mockLookup = vi.mocked(dns.lookup);

/** Helper: mock dns.lookup to return a single address (array form, matching real API) */
function mockDns(address: string, family: 4 | 6 = 4): void {
    mockLookup.mockResolvedValue([{ address, family }] as unknown as {
        address: string;
        family: number;
    });
}

beforeEach(() => {
    mockLookup.mockReset();
});

describe('validateUrl', () => {
    describe('scheme rejection (AC #1)', () => {
        it('rejects file:// scheme', async () => {
            const result = await validateUrl('file:///etc/passwd');
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.reason).toContain('scheme');
        });

        it('rejects ftp:// scheme', async () => {
            const result = await validateUrl('ftp://evil.com/file');
            expect(result.valid).toBe(false);
        });

        it('rejects data: scheme', async () => {
            const result = await validateUrl('data:text/html,<script>');
            expect(result.valid).toBe(false);
        });

        it('rejects javascript: scheme', async () => {
            const result = await validateUrl('javascript:alert(1)');
            expect(result.valid).toBe(false);
        });

        it('accepts http:// scheme', async () => {
            mockDns('93.184.216.34');
            const result = await validateUrl('http://valid.com/file.m3u');
            expect(result.valid).toBe(true);
        });

        it('accepts https:// scheme', async () => {
            mockDns('93.184.216.34');
            const result = await validateUrl('https://valid.com/file.m3u');
            expect(result.valid).toBe(true);
        });
    });

    describe('private IP blocking (AC #2)', () => {
        it('blocks 10.0.0.1 (10/8 start)', async () => {
            const result = await validateUrl('http://10.0.0.1/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks 10.255.255.255 (10/8 end)', async () => {
            const result = await validateUrl('http://10.255.255.255/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks 192.168.1.1', async () => {
            const result = await validateUrl('http://192.168.1.1/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks 172.16.0.1 (172.16/12 start)', async () => {
            const result = await validateUrl('http://172.16.0.1/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks 172.31.255.255 (172.16/12 end)', async () => {
            const result = await validateUrl('http://172.31.255.255/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('does NOT block 172.15.0.1 (outside 172.16/12)', async () => {
            const result = await validateUrl('http://172.15.0.1/file.m3u');
            expect(result.valid).toBe(true);
            if (result.valid) expect(result.resolvedIp).toBe('172.15.0.1');
        });

        it('blocks 127.0.0.1 (loopback)', async () => {
            const result = await validateUrl('http://127.0.0.1/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks 127.255.255.255 (loopback end)', async () => {
            const result = await validateUrl('http://127.255.255.255/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks 169.254.1.1 (link-local)', async () => {
            const result = await validateUrl('http://169.254.1.1/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks 0.0.0.0', async () => {
            const result = await validateUrl('http://0.0.0.0/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks 100.64.0.1 (CGNAT / RFC 6598)', async () => {
            const result = await validateUrl('http://100.64.0.1/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('does NOT block 100.63.255.255 (below CGNAT range)', async () => {
            const result = await validateUrl('http://100.63.255.255/file.m3u');
            expect(result.valid).toBe(true);
        });

        it('blocks ::1 (IPv6 loopback)', async () => {
            const result = await validateUrl('http://[::1]/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks fc00::1 (IPv6 unique local)', async () => {
            const result = await validateUrl('http://[fc00::1]/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks fe80::1 (IPv6 link-local)', async () => {
            const result = await validateUrl('http://[fe80::1]/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('does NOT block 8.8.8.8 (public IP)', async () => {
            const result = await validateUrl('http://8.8.8.8/file.m3u');
            expect(result.valid).toBe(true);
            if (result.valid) expect(result.resolvedIp).toBe('8.8.8.8');
        });
    });

    describe('IPv4-mapped IPv6 bypass protection', () => {
        it('blocks ::ffff:127.0.0.1 (mapped loopback)', async () => {
            const result = await validateUrl('http://[::ffff:127.0.0.1]/file.m3u');
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.reason).toContain('private');
        });

        it('blocks ::ffff:10.0.0.1 (mapped RFC 1918)', async () => {
            const result = await validateUrl('http://[::ffff:10.0.0.1]/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks ::ffff:192.168.1.1 (mapped RFC 1918)', async () => {
            const result = await validateUrl('http://[::ffff:192.168.1.1]/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('allows ::ffff:8.8.8.8 (mapped public IP)', async () => {
            const result = await validateUrl('http://[::ffff:8.8.8.8]/file.m3u');
            expect(result.valid).toBe(true);
        });

        it('blocks DNS-resolved IPv4-mapped private address', async () => {
            mockDns('::ffff:10.0.0.1', 6);
            const result = await validateUrl('http://sneaky-rebind.com/file.m3u');
            expect(result.valid).toBe(false);
        });
    });

    describe('DNS rebinding protection (AC #3)', () => {
        it('blocks hostname resolving to private IP', async () => {
            mockDns('10.0.0.1');
            const result = await validateUrl('http://evil-rebind.com/file.m3u');
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.reason).toContain('private');
        });

        it('allows hostname resolving to public IP', async () => {
            mockDns('93.184.216.34');
            const result = await validateUrl('http://example.com/file.m3u');
            expect(result.valid).toBe(true);
            if (result.valid) expect(result.resolvedIp).toBe('93.184.216.34');
        });

        it('prefers an IPv4 address when DNS lists an AAAA record first', async () => {
            // Callers pin the connection to resolvedIp; a dead AAAA record on a
            // host with no IPv6 route must not become the only address dialed.
            mockLookup.mockResolvedValue([
                { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
                { address: '93.184.216.34', family: 4 },
            ] as unknown as { address: string; family: number });
            const result = await validateUrl('http://example.com/file.m3u');
            expect(result.valid).toBe(true);
            if (result.valid) expect(result.resolvedIp).toBe('93.184.216.34');
        });

        it('falls back to the IPv6 address on an AAAA-only host', async () => {
            mockDns('2606:2800:220:1:248:1893:25c8:1946', 6);
            const result = await validateUrl('http://example.com/file.m3u');
            expect(result.valid).toBe(true);
            if (result.valid) expect(result.resolvedIp).toBe('2606:2800:220:1:248:1893:25c8:1946');
        });

        it('rejects when DNS lookup fails', async () => {
            mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
            const result = await validateUrl('http://nonexistent.invalid/file.m3u');
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.reason).toContain('DNS');
        });
    });

    describe('allowPrivateIps toggle (AC #4)', () => {
        it('allows private IP when toggle is true', async () => {
            const result = await validateUrl('http://192.168.1.1/file.m3u', {
                allowPrivateIps: true,
            });
            expect(result.valid).toBe(true);
            if (result.valid) expect(result.resolvedIp).toBe('192.168.1.1');
        });

        it('allows 10.x when toggle is true', async () => {
            const result = await validateUrl('http://10.0.0.1/file.m3u', {
                allowPrivateIps: true,
            });
            expect(result.valid).toBe(true);
        });

        it('still rejects file:// even when toggle is true', async () => {
            const result = await validateUrl('file:///etc/passwd', {
                allowPrivateIps: true,
            });
            expect(result.valid).toBe(false);
        });

        it('allows DNS-resolved private IP when toggle is true', async () => {
            mockDns('192.168.1.100');
            const result = await validateUrl('http://my-local-proxy.lan/file.m3u', {
                allowPrivateIps: true,
            });
            expect(result.valid).toBe(true);
            if (result.valid) expect(result.resolvedIp).toBe('192.168.1.100');
        });
    });

    describe('edge cases', () => {
        it('rejects empty string', async () => {
            const result = await validateUrl('');
            expect(result.valid).toBe(false);
        });

        it('rejects invalid URL format', async () => {
            const result = await validateUrl('not-a-url');
            expect(result.valid).toBe(false);
        });

        it('accepts URL with port', async () => {
            mockDns('93.184.216.34');
            const result = await validateUrl('http://example.com:8080/file.m3u');
            expect(result.valid).toBe(true);
        });

        it('accepts URL with auth', async () => {
            mockDns('93.184.216.34');
            const result = await validateUrl('http://user:pass@example.com/');
            expect(result.valid).toBe(true);
        });

        it('accepts very long URL', async () => {
            mockDns('93.184.216.34');
            const longPath = 'a'.repeat(2000);
            const result = await validateUrl(`http://example.com/${longPath}`);
            expect(result.valid).toBe(true);
        });

        it('blocks IPv6 unspecified address', async () => {
            const result = await validateUrl('http://[::]/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks when ANY resolved IP is private (all private)', async () => {
            mockLookup.mockResolvedValue([
                { address: '10.0.0.1', family: 4 },
                { address: '10.0.0.2', family: 4 },
            ] as unknown as { address: string; family: number });
            const result = await validateUrl('http://multi-private.com/file.m3u');
            expect(result.valid).toBe(false);
        });

        it('blocks when ANY resolved IP is private (mixed public+private)', async () => {
            mockLookup.mockResolvedValue([
                { address: '93.184.216.34', family: 4 },
                { address: '10.0.0.1', family: 4 },
            ] as unknown as { address: string; family: number });
            const result = await validateUrl('http://mixed-ips.com/file.m3u');
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.reason).toContain('private');
        });
    });
});

it('names the admin opt-in when a LAN source is blocked, without echoing credentials', async () => {
    const result = await validateUrl('http://user:secret@192.168.1.10/lineup.m3u');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('LIVETV_ALLOW_PRIVATE_URLS');
    expect(JSON.stringify(result)).not.toContain('secret');
});

it.each(['http://[64:ff9b::a9fe:a9fe]/', 'http://[2002:7f00:1::]/', 'http://192.0.0.192/'])(
    'D-L1: rejects translated/private target %s unless explicitly allowed',
    async (url) => {
        expect((await validateUrl(url)).valid).toBe(false);
        expect((await validateUrl(url, { allowPrivateIps: true })).valid).toBe(true);
    },
);

it.each(['http://[64:ff9b::808:808]/', 'http://[2002:808:808::]/'])(
    'D-L1: keeps a translated public destination %s usable',
    async (url) => {
        expect((await validateUrl(url)).valid).toBe(true);
    },
);
