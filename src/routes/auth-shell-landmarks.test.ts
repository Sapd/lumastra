// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One <main> landmark on the standalone auth pages. The root layout's auth shell
 * used to be `<main class="auth-shell">` wrapping each page's own `<main>`
 * (/setup's `setup-stage`, /login's `auth-stage`), so screen readers saw two
 * nested main landmarks. The shell is a plain wrapper now; each auth page owns
 * the single <main>. A source-level guard: rendering the root layout needs the
 * whole app shell.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const routesDir = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(routesDir, rel), 'utf8');
const countMain = (src: string): number => (src.match(/<main[\s>]/g) ?? []).length;

describe('auth pages have exactly one main landmark', () => {
    it('the layout auth shell is not a <main>', () => {
        const layout = read('+layout.svelte');
        expect(layout).toMatch(/<div class="auth-shell">/);
        expect(layout).not.toMatch(/<main[^>]*class="auth-shell"/);
    });

    // Every route isAuthRoute() sends through the auth shell.
    it.each(['login/+page.svelte', 'setup/+page.svelte', 'setup/locked/+page.svelte'])(
        '%s renders its own single <main>',
        (page) => {
            expect(countMain(read(page))).toBe(1);
        },
    );
});
