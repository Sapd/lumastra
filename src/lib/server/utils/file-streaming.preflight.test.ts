// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// HEAD and conditional GET are decided from metadata alone (real temp file).

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightFile } from './file-streaming';

let path = '';
beforeAll(() => {
    path = join(mkdtempSync(join(tmpdir(), 'preflight-')), 'movie.mkv');
    writeFileSync(path, '0123456789');
});

const run = (o: Partial<Parameters<typeof preflightFile>[1]>) =>
    preflightFile(path, { contained: false, method: 'GET', ...o });

async function validators() {
    const r = await run({ method: 'HEAD' });
    if (r.kind !== 'response') throw new Error('expected a response');
    return {
        etag: r.response.headers.get('etag')!,
        lastModified: r.response.headers.get('last-modified')!,
    };
}

describe('preflightFile', () => {
    it('HEAD answers the headers with a null body and ignores nothing it needs', async () => {
        const r = await run({ method: 'HEAD', disposition: 'attachment; filename="x.mkv"' });
        expect(r.kind).toBe('response');
        if (r.kind !== 'response') return;
        expect(r.response.status).toBe(200);
        expect(r.response.body).toBeNull();
        expect(r.response.headers.get('content-length')).toBe('10');
        expect(r.response.headers.get('content-type')).toBe('video/x-matroska');
        expect(r.response.headers.get('content-disposition')).toBe('attachment; filename="x.mkv"');
        expect(r.response.headers.get('accept-ranges')).toBe('bytes');
    });

    it('a plain GET proceeds', async () => {
        expect((await run({})).kind).toBe('proceed');
    });

    it('If-None-Match: exact, weak-prefixed and * match; another tag proceeds', async () => {
        const { etag } = await validators();
        for (const v of [etag, `W/${etag}`, '*', `"other", ${etag}`]) {
            const r = await run({ ifNoneMatch: v });
            expect(r.kind === 'response' && r.response.status).toBe(304);
        }
        expect((await run({ ifNoneMatch: '"other"' })).kind).toBe('proceed');
    });

    it('If-Modified-Since: not older than the file is 304, older proceeds', async () => {
        const { lastModified } = await validators();
        const r = await run({ ifModifiedSince: lastModified });
        expect(r.kind === 'response' && r.response.status).toBe(304);
        const old = new Date(Date.parse(lastModified) - 10_000).toUTCString();
        expect((await run({ ifModifiedSince: old })).kind).toBe('proceed');
        expect((await run({ ifModifiedSince: 'garbage' })).kind).toBe('proceed');
    });

    it('If-None-Match wins over If-Modified-Since', async () => {
        const { lastModified } = await validators();
        const r = await run({ ifNoneMatch: '"other"', ifModifiedSince: lastModified });
        expect(r.kind).toBe('proceed');
    });

    it('a matching conditional HEAD is 304 too', async () => {
        const { etag } = await validators();
        const r = await run({ method: 'HEAD', ifNoneMatch: etag });
        expect(r.kind === 'response' && r.response.status).toBe(304);
    });
});
