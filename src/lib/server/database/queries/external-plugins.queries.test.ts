// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listExternalPluginsIncludingPendingRemoval } from './external-plugins.queries.js';

describe('listExternalPluginsIncludingPendingRemoval', () => {
    it('is exported as a function', () => {
        expect(typeof listExternalPluginsIncludingPendingRemoval).toBe('function');
    });
    it('selects installed AND uninstalled rows, ordered by name', () => {
        const src = fs.readFileSync(path.join(__dirname, 'external-plugins.queries.ts'), 'utf8');
        // The sibling must widen the status predicate (NOT status='installed')
        // and keep the deterministic ORDER BY name.
        const fn = src.slice(src.indexOf('listExternalPluginsIncludingPendingRemoval'));
        expect(fn).toMatch(/status IN \('installed', 'uninstalled'\)/);
        expect(fn).toMatch(/ORDER BY name/);
    });
});
