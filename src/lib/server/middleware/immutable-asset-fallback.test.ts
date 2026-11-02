// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the immutable-asset-history fallback handle.
 *
 * Pins the traversal-safety of `resolveHistoryPath` (the security-critical
 * piece) and the request-level behavior of `immutableAssetFallbackHandle`
 * against a real temp directory standing in for ASSET_HISTORY_DIR.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { resolveHistoryPath, immutableAssetFallbackHandle } from './immutable-asset-fallback';

describe('resolveHistoryPath', () => {
    const dir = '/config/asset-history';

    it('resolves a valid nested suffix inside the dir', () => {
        const resolved = resolveHistoryPath(dir, 'chunks/abc123.js');
        expect(resolved).toBe(path.resolve(dir, 'chunks/abc123.js'));
    });

    it('rejects a relative traversal attempt', () => {
        expect(resolveHistoryPath(dir, '../../etc/passwd')).toBeNull();
    });

    it('rejects a URL-encoded traversal attempt', () => {
        expect(resolveHistoryPath(dir, '%2e%2e%2fetc%2fpasswd')).toBeNull();
    });

    it('rejects a suffix containing a NUL byte', () => {
        expect(resolveHistoryPath(dir, 'chunks/abc\0.js')).toBeNull();
    });

    it('rejects a malformed percent-encoded suffix', () => {
        expect(resolveHistoryPath(dir, '%')).toBeNull();
    });
});

describe('immutableAssetFallbackHandle', () => {
    let historyDir: string;
    let originalEnv: string | undefined;

    beforeEach(async () => {
        historyDir = await mkdtemp(path.join(tmpdir(), 'asset-history-'));
        originalEnv = process.env.ASSET_HISTORY_DIR;
        process.env.ASSET_HISTORY_DIR = historyDir;
    });

    afterEach(async () => {
        await rm(historyDir, { recursive: true, force: true });
        if (originalEnv === undefined) {
            delete process.env.ASSET_HISTORY_DIR;
        } else {
            process.env.ASSET_HISTORY_DIR = originalEnv;
        }
    });

    function createEvent(pathname: string, method = 'GET'): RequestEvent {
        const url = new URL(`https://app.example.com${pathname}`);
        const request = new Request(url, { method });
        return { url, request } as unknown as RequestEvent;
    }

    it('falls through for non-immutable paths', async () => {
        let resolveCalled = false;
        const resolve = async () => {
            resolveCalled = true;
            return new Response('fallthrough');
        };
        const res = await immutableAssetFallbackHandle({
            event: createEvent('/some/other/path'),
            resolve,
        } as never);
        expect(resolveCalled).toBe(true);
        expect(await res.text()).toBe('fallthrough');
    });

    it('falls through for unsafe methods (POST)', async () => {
        let resolveCalled = false;
        const resolve = async () => {
            resolveCalled = true;
            return new Response('fallthrough');
        };
        await immutableAssetFallbackHandle({
            event: createEvent('/_app/immutable/chunks/abc123.js', 'POST'),
            resolve,
        } as never);
        expect(resolveCalled).toBe(true);
    });

    it('serves content-type js correctly for a known chunk', async () => {
        await mkdir(path.join(historyDir, 'chunks'), { recursive: true });
        await writeFile(path.join(historyDir, 'chunks', 'abc123.js'), 'console.log(1);');

        let resolveCalled = false;
        const resolve = async () => {
            resolveCalled = true;
            return new Response('not found', { status: 404 });
        };
        const res = await immutableAssetFallbackHandle({
            event: createEvent('/_app/immutable/chunks/abc123.js'),
            resolve,
        } as never);

        expect(resolveCalled).toBe(false);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/javascript');
        expect(res.headers.get('x-asset-history')).toBe('1');
        expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(await res.text()).toBe('console.log(1);');
    });

    it('serves content-type css correctly', async () => {
        await mkdir(path.join(historyDir, 'assets'), { recursive: true });
        await writeFile(path.join(historyDir, 'assets', 'style.css'), 'body{}');

        const resolve = async () => new Response('not found', { status: 404 });
        const res = await immutableAssetFallbackHandle({
            event: createEvent('/_app/immutable/assets/style.css'),
            resolve,
        } as never);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/css');
    });

    it('serves content-type woff2 correctly', async () => {
        await mkdir(path.join(historyDir, 'assets'), { recursive: true });
        await writeFile(path.join(historyDir, 'assets', 'font.woff2'), 'binarydata');

        const resolve = async () => new Response('not found', { status: 404 });
        const res = await immutableAssetFallbackHandle({
            event: createEvent('/_app/immutable/assets/font.woff2'),
            resolve,
        } as never);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('font/woff2');
    });

    it('falls through to resolve() when the historical file is missing (ENOENT)', async () => {
        let resolveCalled = false;
        const resolve = async () => {
            resolveCalled = true;
            return new Response('not found', { status: 404 });
        };
        const res = await immutableAssetFallbackHandle({
            event: createEvent('/_app/immutable/chunks/missing.js'),
            resolve,
        } as never);

        expect(resolveCalled).toBe(true);
        expect(res.status).toBe(404);
    });

    it('falls through for a traversal attempt on the request path', async () => {
        let resolveCalled = false;
        const resolve = async () => {
            resolveCalled = true;
            return new Response('not found', { status: 404 });
        };
        const res = await immutableAssetFallbackHandle({
            event: createEvent('/_app/immutable/..%2f..%2fetc%2fpasswd'),
            resolve,
        } as never);

        expect(resolveCalled).toBe(true);
        expect(res.status).toBe(404);
    });

    it('returns an empty body with correct headers for HEAD requests', async () => {
        await mkdir(path.join(historyDir, 'chunks'), { recursive: true });
        await writeFile(path.join(historyDir, 'chunks', 'abc123.js'), 'console.log(1);');

        const resolve = async () => new Response('not found', { status: 404 });
        const res = await immutableAssetFallbackHandle({
            event: createEvent('/_app/immutable/chunks/abc123.js', 'HEAD'),
            resolve,
        } as never);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/javascript');
        expect(await res.text()).toBe('');
    });
});
