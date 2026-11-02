// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Structural test — `/p/` belongs entirely to plugins.
 *
 * A static route added under `src/routes/p/` would permanently shadow any
 * plugin whose feature id matched its name, and the author would have no way
 * to discover why their page 404s. `/api/plugins/*` already has exactly this
 * problem: its static children mean no feature may ever use those ids, and
 * nothing anywhere says so.
 *
 * This is a commit-time net for a mistake that is invisible in review and
 * permanent once a plugin ships against the shadowed id.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROUTES_P = path.resolve(process.cwd(), 'src/routes/p');

describe('the /p plugin page namespace', () => {
    it('contains exactly one child, the feature-id parameter', () => {
        const children = fs
            .readdirSync(ROUTES_P, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);

        expect(children).toEqual(['[featureId]']);
    });

    it('has no route files of its own that could intercept a plugin', () => {
        const files = fs
            .readdirSync(ROUTES_P, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => e.name)
            // A +layout is fine — it wraps plugin pages rather than shadowing
            // one. A +page or +server at this level would swallow `/p` itself.
            .filter((n) => n.startsWith('+page') || n.startsWith('+server'));

        expect(files).toEqual([]);
    });
});
