// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { assertNotPrivateUrl } from '$lib/server/utils/ssrf-guard';
import {
    ResponseTooLargeError,
    readBoundedResponseBytes,
} from '$lib/server/utils/bounded-response';

export interface FetchOptions {
    timeoutMs?: number;
    userAgent?: string;
}

export interface FetchResult {
    contentType: string;
    text: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB

export async function fetchMetadataUrl(url: string, opts: FetchOptions): Promise<FetchResult> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('Invalid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`URL scheme ${parsed.protocol} not allowed`);
    }
    await assertNotPrivateUrl(parsed);

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => {
            controller.abort();
            reject(new Error('Request timeout (aborted)'));
        }, timeoutMs);
    });

    const headers: Record<string, string> = {
        Accept: 'application/json, text/*;q=0.9, */*;q=0.5',
    };
    if (opts.userAgent) headers['User-Agent'] = opts.userAgent;

    try {
        const response = await Promise.race([
            // C22 fix-plan finding scope: public-only guard family
            // (`assertNotPrivateUrl` above, ssrf-guard.ts) for an
            // admin/user-supplied radio stream URL, not the same-origin-only
            // family this rule targets — and every redirect is refused
            // outright below, never followed. See
            // docs/dev/eslint-exceptions.md.
            // eslint-disable-next-line callback-safety/no-bare-fetch-in-server
            fetch(parsed.toString(), {
                method: 'GET',
                signal: controller.signal,
                headers,
                redirect: 'manual',
            }),
            timeoutPromise,
        ]);
        if (response.status >= 300 && response.status < 400) {
            throw new Error(`Redirects not followed (status ${response.status})`);
        }
        if (!response.ok) {
            throw new Error(`Upstream returned ${response.status}`);
        }
        const contentType = (
            response.headers.get('content-type') ?? 'application/octet-stream'
        ).toLowerCase();

        const cl = response.headers.get('content-length');
        if (cl && Number(cl) > MAX_RESPONSE_BYTES) {
            throw new Error('Response too large');
        }

        // Stream with a cap: a station that sends no Content-Length (or lies about
        // it) must not be buffered whole before the size check.
        let bytes: Buffer;
        try {
            bytes = await readBoundedResponseBytes(response, MAX_RESPONSE_BYTES);
        } catch (err) {
            if (err instanceof ResponseTooLargeError) {
                throw new Error('Response too large', { cause: err });
            }
            throw err;
        }
        const text = new TextDecoder('utf-8').decode(bytes);
        return { contentType, text };
    } finally {
        clearTimeout(timerId);
    }
}
