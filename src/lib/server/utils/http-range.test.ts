// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the HTTP Range helper (§9.1): parseRange cases plus
 * serveFileWithRange status/header behavior against a real temp file.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { parseRange, serveFileWithRange } from './http-range';

describe('parseRange', () => {
    const fileSize = 1000;

    it('returns full-body 200 when no Range header is present', () => {
        const result = parseRange(null, fileSize);
        expect(result).toEqual({ status: 200, start: 0, end: 999 });
    });

    it('parses bytes=0-99', () => {
        const result = parseRange('bytes=0-99', fileSize);
        expect(result).toEqual({ status: 206, start: 0, end: 99 });
    });

    it('parses a suffix range bytes=-100 (last 100 bytes)', () => {
        const result = parseRange('bytes=-100', fileSize);
        expect(result).toEqual({ status: 206, start: 900, end: 999 });
    });

    it('parses an open-ended range bytes=100-', () => {
        const result = parseRange('bytes=100-', fileSize);
        expect(result).toEqual({ status: 206, start: 100, end: 999 });
    });

    it('returns 416 for an unsatisfiable range (start beyond file size)', () => {
        const result = parseRange('bytes=2000-3000', fileSize);
        expect(result).toEqual({ status: 416 });
    });

    it('returns 416 for a reversed range (start > end)', () => {
        const result = parseRange('bytes=500-100', fileSize);
        expect(result).toEqual({ status: 416 });
    });

    it('falls back to full body for a malformed Range header', () => {
        const result = parseRange('not-a-range', fileSize);
        expect(result).toEqual({ status: 200, start: 0, end: 999 });
    });

    it('clamps an end beyond the file size to the last byte', () => {
        const result = parseRange('bytes=900-5000', fileSize);
        expect(result).toEqual({ status: 206, start: 900, end: 999 });
    });
});

describe('serveFileWithRange', () => {
    let dir: string;
    let filePath: string;
    const content = Buffer.from('0123456789'.repeat(10)); // 100 bytes

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    });

    async function setup(): Promise<void> {
        dir = mkdtempSync(join(tmpdir(), 'http-range-test-'));
        filePath = join(dir, 'artifact.mp4');
        await fs.writeFile(filePath, content);
    }

    it('serves the full body with 200 and Accept-Ranges when no Range header', async () => {
        await setup();
        const request = new Request('http://localhost/file');
        const res = await serveFileWithRange(filePath, request, { contentType: 'video/mp4' });
        expect(res.status).toBe(200);
        expect(res.headers.get('accept-ranges')).toBe('bytes');
        expect(res.headers.get('content-length')).toBe('100');
        expect(res.headers.get('content-type')).toBe('video/mp4');
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.equals(content)).toBe(true);
    });

    it('serves a 206 partial response with Content-Range for a satisfiable range', async () => {
        await setup();
        const request = new Request('http://localhost/file', { headers: { Range: 'bytes=0-9' } });
        const res = await serveFileWithRange(filePath, request);
        expect(res.status).toBe(206);
        expect(res.headers.get('content-range')).toBe('bytes 0-9/100');
        expect(res.headers.get('content-length')).toBe('10');
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.equals(content.subarray(0, 10))).toBe(true);
    });

    it('serves a 416 with Content-Range */size for an unsatisfiable range', async () => {
        await setup();
        const request = new Request('http://localhost/file', {
            headers: { Range: 'bytes=9999-10000' },
        });
        const res = await serveFileWithRange(filePath, request);
        expect(res.status).toBe(416);
        expect(res.headers.get('content-range')).toBe('bytes */100');
    });

    it('returns headers only (no body) for HEAD', async () => {
        await setup();
        const request = new Request('http://localhost/file', { method: 'HEAD' });
        const res = await serveFileWithRange(filePath, request, { contentType: 'video/mp4' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBe('100');
        expect(res.body).toBeNull();
    });

    it('merges caller-supplied extra headers', async () => {
        await setup();
        const request = new Request('http://localhost/file');
        const res = await serveFileWithRange(filePath, request, {
            contentType: 'video/mp4',
            headers: { 'Cache-Control': 'public, max-age=3600', ETag: '"abc123"' },
        });
        expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
        expect(res.headers.get('etag')).toBe('"abc123"');
    });
});
