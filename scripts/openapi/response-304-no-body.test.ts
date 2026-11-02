// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Finding #26: a 304 response cannot carry a body, but `convertResponse`'s
 * plain-string shorthand (`typeof def === 'string'`) always routes through
 * `apiErrorResponse`, which documents an `application/problem+json` object
 * with required `code`/`error`/`status`. Two defs used the bare-string
 * shorthand for their `304`, so the committed spec told clients a 304 carries
 * a body no server response can ever satisfy — confirmed in the generated
 * artifact at the time (`docs/api/openapi.yaml:18029` and `:36914`).
 *
 * Deliberately reads the def SOURCE TEXT rather than importing the def
 * modules: both pull in the full server module graph (config, cache, TMDB,
 * Audiobookshelf clients, …) at import time purely to read one literal
 * object, which is slow and has nothing to do with what this test checks.
 * `convertResponse` itself IS exercised, just against a literal built from
 * the same shape the fixed source declares, not the imported object.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { convertResponse } from './generate-public.js';

const ROOT = resolve(import.meta.dirname, '../..');

describe('304 responses declare no body', () => {
    it.each([
        {
            name: 'libraries/{id}/images/{role}',
            path: 'src/lib/server/api/defs/libraries/[id]/images/[role].ts',
        },
        {
            name: 'media/{id}/topshelf-preview/file/{variant}',
            path: 'src/lib/server/api/defs/media/[id]/topshelf-preview/file/[variant].ts',
        },
    ])('$name declares its 304 with the headers-only variant, not a bare string', ({ path }) => {
        const source = readFileSync(resolve(ROOT, path), 'utf-8');
        // The literal regression: `304: '...'` (a bare string) is what routes
        // through apiErrorResponse and documents a problem+json body. The fix
        // is `304: { description: '...', headers: {...} }`.
        expect(source).not.toMatch(/304:\s*'[^']*'/);
        expect(source).not.toMatch(/304:\s*"[^"]*"/);
        expect(source).toMatch(/304:\s*\{\s*\n?\s*description:/);
        expect(source).toMatch(/304:[\s\S]{0,300}headers:\s*\{[\s\S]{0,120}ETag/);
    });

    it("convertResponse emits no 'content' key for the headers-only variant", () => {
        // Same shape the fixed defs above declare, not imported from them —
        // see the file header for why.
        const converted = convertResponse(304, {
            description: 'Not Modified — client cache is current (ETag matched)',
            headers: { ETag: { description: 'Echoes the validator that matched.' } },
        });
        expect(converted).not.toHaveProperty('content');
        expect(converted).toHaveProperty('description');
        expect(converted.headers).toBeDefined();
    });

    it('still documents a problem+json body for a bare string on a body-bearing code (sanity: unaffected by the fix)', () => {
        const converted = convertResponse(404, 'Library not found');
        expect(converted).toHaveProperty('content.application/problem+json');
    });
});
