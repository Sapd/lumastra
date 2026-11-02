// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * readAvatarUpload() against the REAL adapter seam: each body goes through
 * `getRequest()` from `@sveltejs/kit/node` — the function adapter-node calls
 * with its BODY_SIZE_LIMIT — so an over-limit body fails inside
 * `request.formData()` exactly as it does in production. Before the fix that
 * failure (a SvelteKitError carrying `status`, not `statusCode`) escaped as a
 * 500 for every avatar over adapter-node's 512K default.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { getRequest } from '@sveltejs/kit/node';
import { AVATAR_MAX_UPLOAD_BYTES, readAvatarUpload } from './avatar-upload';
import { isPayloadTooLargeError } from './bounded-body-reader';
import { makeImageOfSize, type TestImageFormat } from '../../../../tests/helpers/sized-test-image';

const KiB = 1024;
const MiB = 1024 * 1024;

async function multipartBody(file: Buffer, mime: string): Promise<{ body: Buffer; type: string }> {
    const form = new FormData();
    form.append('avatar', new Blob([new Uint8Array(file)], { type: mime }), 'avatar');
    const encoded = new Response(form);
    return {
        body: Buffer.from(await encoded.arrayBuffer()),
        type: encoded.headers.get('content-type') ?? '',
    };
}

/** A Request built the way adapter-node builds it, with the given body cap. */
async function adapterRequest(
    body: Buffer,
    contentType: string,
    bodySizeLimit: number,
    { declareLength = true } = {},
): Promise<Request> {
    const stream = new PassThrough();
    const req = Object.assign(stream, {
        method: 'PUT',
        url: '/api/image/user/alice/avatar',
        httpVersionMajor: 1,
        headers: {
            host: 'localhost',
            'content-type': contentType,
            ...(declareLength
                ? { 'content-length': String(body.length) }
                : { 'transfer-encoding': 'chunked' }),
        },
    }) as unknown as IncomingMessage;
    const request = await getRequest({ request: req, base: 'http://localhost', bodySizeLimit });
    // Feed in chunks so the streamed-size check runs, not only the header check.
    for (let i = 0; i < body.length; i += 64 * KiB) stream.write(body.subarray(i, i + 64 * KiB));
    stream.end();
    return request;
}

const ADAPTER_DEFAULT_LIMIT = 512 * KiB; // adapter-node's BODY_SIZE_LIMIT default
const SHIPPED_LIMIT = 50 * MiB; // compose, chart and image default

describe('readAvatarUpload', () => {
    it('reports too_large (not a throw) when the adapter body cap rejects the declared length', async () => {
        const image = await makeImageOfSize('jpeg', 1 * MiB);
        const { body, type } = await multipartBody(image, 'image/jpeg');
        const request = await adapterRequest(body, type, ADAPTER_DEFAULT_LIMIT);

        await expect(readAvatarUpload(request)).resolves.toEqual({ kind: 'too_large' });
    });

    it('reports too_large when a chunked body overruns the adapter cap mid-stream', async () => {
        const image = await makeImageOfSize('png', 1 * MiB);
        const { body, type } = await multipartBody(image, 'image/png');
        const request = await adapterRequest(body, type, ADAPTER_DEFAULT_LIMIT, {
            declareLength: false,
        });

        await expect(readAvatarUpload(request)).resolves.toEqual({ kind: 'too_large' });
    });

    const formats: Array<[TestImageFormat, string]> = [
        ['jpeg', 'image/jpeg'],
        ['png', 'image/png'],
        ['webp', 'image/webp'],
    ];
    const accepted = [400 * KiB, 1 * MiB, 1.9 * MiB];

    for (const [format, mime] of formats) {
        for (const size of accepted) {
            it(`accepts a ${Math.round(size / KiB)} KiB ${format} under the shipped body limit`, async () => {
                const image = await makeImageOfSize(format, size);
                const { body, type } = await multipartBody(image, mime);
                const result = await readAvatarUpload(
                    await adapterRequest(body, type, SHIPPED_LIMIT),
                );

                expect(result.kind).toBe('file');
                if (result.kind === 'file') expect(result.file.size).toBe(image.length);
            });
        }

        it(`rejects a 2.5 MiB ${format} as too_large before buffering it`, async () => {
            const image = await makeImageOfSize(format, 2.5 * MiB);
            const { body, type } = await multipartBody(image, mime);
            const result = await readAvatarUpload(await adapterRequest(body, type, SHIPPED_LIMIT));

            expect(result).toEqual({ kind: 'too_large' });
        });
    }

    it('rejects an over-cap file even when the request declares no length', async () => {
        const image = await makeImageOfSize('jpeg', 2.5 * MiB);
        const { body, type } = await multipartBody(image, 'image/jpeg');
        const request = await adapterRequest(body, type, SHIPPED_LIMIT, { declareLength: false });

        await expect(readAvatarUpload(request)).resolves.toEqual({ kind: 'too_large' });
    });

    it('reports missing for a body without an avatar field', async () => {
        const form = new FormData();
        form.append('other', 'x');
        const request = new Request('http://localhost/', { method: 'PUT', body: form });

        await expect(readAvatarUpload(request)).resolves.toEqual({ kind: 'missing' });
    });

    it('reports missing for a body that is not multipart at all', async () => {
        const request = new Request('http://localhost/', {
            method: 'PUT',
            body: 'not a form',
            headers: { 'content-type': 'text/plain' },
        });

        await expect(readAvatarUpload(request)).resolves.toEqual({ kind: 'missing' });
    });

    it('caps at 2 MiB, the limit the UI states', () => {
        expect(AVATAR_MAX_UPLOAD_BYTES).toBe(2 * MiB);
    });
});

describe('isPayloadTooLargeError', () => {
    it('recognises the adapter error (status 413) and service errors (statusCode 413)', async () => {
        const { body, type } = await multipartBody(
            await makeImageOfSize('jpeg', 1 * MiB),
            'image/jpeg',
        );
        const request = await adapterRequest(body, type, ADAPTER_DEFAULT_LIMIT);
        const adapterError = await request.formData().then(
            () => null,
            (err: unknown) => err,
        );

        expect(isPayloadTooLargeError(adapterError)).toBe(true);
        expect(isPayloadTooLargeError(Object.assign(new Error('x'), { statusCode: 413 }))).toBe(
            true,
        );
    });

    it('ignores other errors', () => {
        expect(isPayloadTooLargeError(new Error('Content-length exceeds nothing'))).toBe(false);
        expect(isPayloadTooLargeError(Object.assign(new Error('x'), { status: 404 }))).toBe(false);
        expect(isPayloadTooLargeError(null)).toBe(false);
        expect(isPayloadTooLargeError('413')).toBe(false);
    });
});
