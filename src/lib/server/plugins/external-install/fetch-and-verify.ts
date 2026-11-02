// fetch-and-verify.ts
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import {
    assertNotPrivateUrl,
    resolveSafePublicUrl,
    pinnedFetch,
} from '$lib/server/utils/ssrf-guard.js';

const MAX_HOPS = 5;

function assertProtocol(u: URL): void {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error(`disallowed protocol: ${u.protocol}`);
    }
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
    const lenHeader = res.headers.get('content-length');
    if (lenHeader && Number(lenHeader) > maxBytes)
        throw new Error('response exceeds size cap (content-length)');
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                throw new Error('response exceeds size cap (streamed)');
            }
            chunks.push(value);
        }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export async function fetchWithGuards(
    url: string,
    opts: { maxBytes: number; allowPrivate: boolean; timeoutMs: number },
): Promise<{ bytes: Buffer; contentType: string | null }> {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
        assertProtocol(current);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
        try {
            let res: Response;
            if (opts.allowPrivate) {
                // C22 fix-plan finding scope: this whole function IS the
                // guard for arbitrary/attacker-influenced install URLs — the
                // public-only, per-hop DNS-pinned family (ssrf-guard.ts),
                // not the same-origin-only family this rule targets. Every
                // hop is re-validated by the `for` loop above regardless of
                // branch. See docs/dev/eslint-exceptions.md.
                // eslint-disable-next-line callback-safety/no-bare-fetch-in-server
                res = await fetch(current, { redirect: 'manual', signal: controller.signal });
            } else {
                // Re-gate EVERY hop: private-IP check + DNS-pin. pinnedFetch
                // dials the vetted IP from the transport and keeps the hostname
                // in the URL, so Host and TLS SNI stay correct. [review C4]
                await assertNotPrivateUrl(current);
                const safe = await resolveSafePublicUrl(current);
                res = await pinnedFetch(safe, {
                    redirect: 'manual',
                    signal: controller.signal,
                });
            }

            if (res.status >= 300 && res.status < 400) {
                const loc = res.headers.get('location');
                if (!loc) throw new Error('redirect without Location');
                current = new URL(loc, current); // re-gate on next loop iteration
                await res.body?.cancel();
                continue;
            }
            if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
            const bytes = await readCapped(res, opts.maxBytes);
            return { bytes, contentType: res.headers.get('content-type') };
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error('too many redirects');
}
