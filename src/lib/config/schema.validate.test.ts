// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards `validateSchema()` — the structural checks that decide whether a setting
 * can render at all.
 *
 * These checks already existed and already ran, but only as `console.warn` on module
 * load in non-production. That is not a gate: a cross-section `dependsOn` was
 * introduced, printed its warning into `npm run dev` output, and reached a commit
 * anyway because every unit test, `svelte-check`, and `eslint --max-warnings=0` all
 * passed. The warning is only visible to someone reading dev-server startup logs.
 *
 * Making it an assertion turns "settings silently stop appearing in the admin UI"
 * from something you notice in the browser into something CI refuses.
 *
 * Why cross-section `dependsOn` is fatal rather than cosmetic: `isSettingEnabled`
 * evaluates `values[setting.dependsOn]`, and `values` only ever holds the settings
 * belonging to sections the current page loaded. A parent in another section is
 * therefore `undefined` → falsy → the child renders permanently disabled with no
 * way to enable it.
 */

import { describe, it, expect } from 'vitest';
import { validateSchema, configSchema, configSections, validateSettingValue } from './schema';

describe('validateSchema', () => {
    it('reports no warnings', () => {
        const { warnings } = validateSchema();
        // Asserted as the full array so a failure prints the offending keys and the
        // remedy the validator already spells out, rather than just a count.
        expect(warnings).toEqual([]);
    });
});

describe('schema/section integrity', () => {
    it('every setting names a section that exists', () => {
        const known = new Set(configSections.map((s) => s.id));
        const orphaned = [
            ...new Set(configSchema.filter((s) => !known.has(s.section)).map((s) => s.section)),
        ];
        expect(orphaned).toEqual([]);
    });

    it('every section contains at least one setting', () => {
        // An empty section renders as a heading with nothing under it — usually the
        // residue of moving the last setting out and forgetting the section itself.
        const used = new Set(configSchema.map((s) => s.section));
        const empty = configSections.filter((s) => !used.has(s.id)).map((s) => s.id);
        expect(empty).toEqual([]);
    });
});

describe('navigation settings', () => {
    const nav = configSchema.find((s) => s.type === 'navigation');

    it('rejects a list with an entry that is not a link object', () => {
        // The root layout reads .icon/.href off every entry on every request.
        expect(nav).toBeTruthy();
        expect(validateSettingValue(nav!, [{ href: '/', label: 'Home' }]).valid).toBe(true);
        expect(validateSettingValue(nav!, [{ href: '/' }, null]).valid).toBe(false);
        expect(validateSettingValue(nav!, ['oops']).valid).toBe(false);
    });
});
