// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A failed GET logs the key. Some keys embed caller-supplied text (the /j Quick
 * Connect secret off an anonymous request), so the log line must carry a
 * truncated key, not the whole string.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const warn = vi.fn();
vi.mock('../utils/logger', () => ({
    Logger: { for: () => ({ warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const fakeClient = {
    ping: vi.fn(async () => 'PONG'),
    get: vi.fn(async () => {
        throw new Error('boom');
    }),
};
vi.mock('@valkey/valkey-glide', () => ({
    GlideClient: { createClient: vi.fn(async () => fakeClient) },
    Logger: { setLoggerConfig: vi.fn() },
    TimeUnit: { Seconds: 'Seconds', Milliseconds: 'Milliseconds' },
    GlideClientConfiguration: {},
}));

afterEach(() => {
    vi.resetModules();
});

describe('cacheGet failure log', () => {
    it('does not write a multi-megabyte key into the log', async () => {
        vi.resetModules();
        process.env.CACHE_URL = 'redis://localhost:6379/0';
        process.env.TASK_CACHE_URL = 'redis://localhost:6380/1';
        const valkey = await import('./valkey.js');
        expect(await valkey.connectValkey()).toBe(true);

        const key = 'jf:qc:secret:' + 'A'.repeat(5 * 1024 * 1024);
        await expect(valkey.cacheGet(key)).resolves.toBeNull();

        expect(warn).toHaveBeenCalledTimes(1);
        const logged = (warn.mock.calls[0][1] as { key: string }).key;
        expect(logged.length).toBeLessThan(200);
        expect(logged.startsWith('jf:qc:secret:AAAA')).toBe(true);
    });

    it('leaves a short key readable', async () => {
        const { truncateKeyForLog } = await import('./valkey.js');
        expect(truncateKeyForLog('session:abc')).toBe('session:abc');
    });
});

describe('valkey.ts logger calls', () => {
    it('never pass a raw key, lockKey or pattern (caller text can be unbounded)', () => {
        const src = readFileSync(join(__dirname, 'valkey.ts'), 'utf8');
        const offenders: string[] = [];
        for (const m of src.matchAll(/logger\.(?:warn|error|info|debug)\(/g)) {
            let depth = 0;
            let i = m.index! + m[0].length - 1;
            for (; i < src.length; i++) {
                if (src[i] === '(') depth++;
                else if (src[i] === ')' && --depth === 0) break;
            }
            const call = src.slice(m.index!, i + 1);
            if (/[{,\s](?:key|lockKey|pattern)\s*[,}\n]/.test(call.replace(/'[^']*'/g, "''"))) {
                offenders.push(call.replace(/\s+/g, ' ').slice(0, 120));
            }
        }
        expect(offenders).toEqual([]);
    });
});
