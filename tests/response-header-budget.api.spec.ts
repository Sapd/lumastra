// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Response-header budget for SSR pages.
 *
 * Self-hosters run the app behind whatever reverse proxy they have, and each
 * one caps the upstream response-header block: stock nginx `proxy_buffer_size`
 * is 4 KB (one page), HAProxy ~15 KB (tune.bufsize minus maxrewrite). Past the
 * cap the proxy answers 502 instead of the page. On 2026-09-23 SvelteKit's
 * preload `Link` header (212 chunk entries, 15 KB) took a production install down for
 * every signed-in user, while signed-out requests (a small 302) looked fine.
 *
 * So this measures a SIGNED-IN page render on the real server, not a helper.
 * Budget = stock nginx's 4 KB, the smallest common default.
 */

import { adminTest as test, expect } from './fixtures/auth';

const HEADER_BUDGET_BYTES = 4096;

const PAGES = ['/', '/admin/settings'] as const;

test.describe('SSR response headers fit default reverse-proxy buffers', () => {
    for (const path of PAGES) {
        test(`GET ${path} (signed in) sends under ${HEADER_BUDGET_BYTES} bytes of headers`, async ({
            request,
        }) => {
            const response = await request.get(path, { maxRedirects: 0 });
            expect(response.status()).toBe(200);

            const headers = response.headersArray();
            // "Name: value\r\n" per line, plus the status line's rough upper bound.
            const bytes =
                32 +
                headers.reduce(
                    (sum, { name, value }) =>
                        sum + Buffer.byteLength(name) + 2 + Buffer.byteLength(value) + 2,
                    0,
                );
            const largest = [...headers].sort((a, b) => b.value.length - a.value.length)[0];

            expect(
                bytes,
                `largest header: ${largest?.name} (${largest?.value.length} bytes)`,
            ).toBeLessThan(HEADER_BUDGET_BYTES);
            expect(response.headers()['link']).toBeUndefined();
        });
    }
});
