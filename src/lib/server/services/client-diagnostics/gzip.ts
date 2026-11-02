// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Streaming, bounded gunzip. A 2 MiB gzip can inflate to gigabytes; this counts
 * output bytes as they stream and destroys the inflater the moment the cap is
 * passed, so a bomb costs at most `maxBytes` of work. Never use gunzipSync here.
 */

import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';

export class InflateLimitError extends Error {}
export class InflateFormatError extends Error {}

export function inflateBounded(
    gz: Buffer,
    maxBytes: number,
    opts: { keepText?: boolean } = {},
): Promise<{ bytes: number; sha256: string; text?: string }> {
    return new Promise((resolve, reject) => {
        const gunzip = createGunzip();
        const hash = createHash('sha256');
        const chunks: Buffer[] = [];
        let bytes = 0;
        let settled = false;
        const fail = (err: Error): void => {
            if (settled) return;
            settled = true;
            gunzip.destroy();
            reject(err);
        };
        gunzip.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes)
                return fail(new InflateLimitError(`inflated size exceeds ${maxBytes} bytes`));
            hash.update(chunk);
            if (opts.keepText) chunks.push(chunk);
        });
        gunzip.on('error', (err) => fail(new InflateFormatError(err.message)));
        gunzip.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({
                bytes,
                sha256: hash.digest('hex'),
                ...(opts.keepText ? { text: Buffer.concat(chunks).toString('utf8') } : {}),
            });
        });
        gunzip.end(gz);
    });
}
