// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Residual fix-plan finding (2026-09-13, item 3): the SSE 503 on
 * `defs/events/index.ts`, `defs/runs/stream.ts`, and
 * `defs/admin/ingest/stream/index.ts` is a `stream_limit` problem+json error
 * at runtime (`sse-replay-hub.ts` calls `problem('stream_limit', ...)`), but
 * their `docs.responses[503]` used the bare-string shorthand, which
 * `convertResponse` always routes through `apiErrorResponse(desc, 503)` with
 * NO code override — so the generated spec documented the status-default
 * code (`dependency_unavailable`) instead of the code the server actually
 * sends, misleading any client that switches on `code`.
 *
 * The fix threads an explicit `code` through a new `ResponseDef` variant
 * (`{ description, code }`) so a def can override the status-default
 * problem code, and sets it on the three SSE defs.
 *
 * Deliberately reads the def SOURCE TEXT for the "defs declare it" checks
 * rather than importing the def modules — see response-304-no-body.test.ts's
 * header for why (importing pulls in the full server module graph).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { convertResponse } from './generate-public.js';

const ROOT = resolve(import.meta.dirname, '../..');

describe('convertResponse — explicit problem code override', () => {
    it('an explicit `code` on a description-only response overrides the status default', () => {
        // Status 503 defaults to `dependency_unavailable` (DEFAULT_CODE_FOR_STATUS
        // in helpers.ts) — the override must win.
        const converted = convertResponse(503, {
            description: 'Process-wide SSE connection capacity reached',
            code: 'stream_limit',
        });
        const schema = (
            converted as { content: { ['application/problem+json']: { schema: { shape: any } } } }
        ).content['application/problem+json'].schema;
        expect(schema.shape.code.meta()?.example).toBe('stream_limit');
    });

    it('a bare string on the same status still gets the status-default code (sanity: unaffected by the fix)', () => {
        const converted = convertResponse(503, 'Some other 503');
        const schema = (
            converted as { content: { ['application/problem+json']: { schema: { shape: any } } } }
        ).content['application/problem+json'].schema;
        expect(schema.shape.code.meta()?.example).toBe('dependency_unavailable');
    });
});

describe('SSE 503 defs declare the stream_limit problem code', () => {
    it.each([
        {
            name: 'events/index',
            path: 'src/lib/server/api/defs/events/index.ts',
        },
        {
            name: 'runs/stream',
            path: 'src/lib/server/api/defs/runs/stream.ts',
        },
        {
            name: 'admin/ingest/stream/index',
            path: 'src/lib/server/api/defs/admin/ingest/stream/index.ts',
        },
    ])('$name declares 503 with an explicit code: stream_limit, not a bare string', ({ path }) => {
        const source = readFileSync(resolve(ROOT, path), 'utf-8');
        expect(source).not.toMatch(/503:\s*'[^']*'/);
        expect(source).not.toMatch(/503:\s*"[^"]*"/);
        expect(source).toMatch(/503:[\s\S]{0,300}code:\s*'stream_limit'/);
    });
});
