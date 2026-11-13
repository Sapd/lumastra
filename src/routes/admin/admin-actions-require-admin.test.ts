// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every form action under /admin must refuse a non-admin BEFORE doing anything.
 *
 * The /admin layout gates on `locals.user.isAdmin` in its `load` — but SvelteKit
 * runs a page's form ACTION before any load, so the layout redirect never
 * protected `POST /admin/settings?/save`. Any authenticated user could write
 * `ADMIN_GROUPS` (self-promotion) or `APPEARANCE_CUSTOM_JS` (stored XSS in every
 * admin's browser). Security review 2026-09-12, findings C4/C5.
 *
 * This test walks EVERY `+page.server.ts` under src/routes/admin that exports
 * `actions`, invokes each action as a plain user with a well-formed request, and
 * requires a 403 ActionFailure. Adding an admin page with an action and no gate
 * fails this test; so does removing the gate from a shared helper.
 */

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isActionFailure } from '@sveltejs/kit';

const saveConfig = vi.fn();
const reloadConfig = vi.fn();
vi.mock('$lib/server/config', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('$lib/server/config');
    return { ...actual, saveConfig, reloadConfig };
});

const PLAIN_USER = {
    user: { userId: 'u2', username: 'conny', isAdmin: false, userGroups: ['JellyfinEcosystem'] },
};

// Both export spellings: `export const actions = …` and a re-export of a
// factory-built pair (`export { load, actions }` — settings/playback). Matching
// only the first silently dropped the second from this sweep.
const EXPORTS_ACTIONS = /^export const actions\b|^export\s*\{[^}]*\bactions\b[^}]*\}/m;

function walk(dir: string, out: string[]): string[] {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (entry === '+page.server.ts' && EXPORTS_ACTIONS.test(readFileSync(p, 'utf8')))
            out.push(p);
    }
    return out;
}

const ADMIN_DIR = join(process.cwd(), 'src/routes/admin');
const PAGES = walk(ADMIN_DIR, []);

function requestFor(): Request {
    const form = new FormData();
    form.set('updates', JSON.stringify({ ADMIN_GROUPS: 'JellyfinEcosystem' }));
    form.set('model', 'gpt-4o');
    form.set('pricePerMillion', '1');
    return new Request('http://localhost/admin/x?/save', { method: 'POST', body: form });
}

describe('every /admin form action refuses a non-admin with 403', () => {
    it('finds the admin pages that export actions', () => {
        expect(PAGES.length).toBeGreaterThanOrEqual(15);
        expect(PAGES.some((p) => p.endsWith('settings/playback/+page.server.ts'))).toBe(true);
    });

    for (const file of PAGES) {
        const rel = relative(ADMIN_DIR, file);
        it(`${rel}: each action returns fail(403) for a plain user and never writes config`, async () => {
            const mod = (await import(/* @vite-ignore */ file)) as {
                actions: Record<string, unknown>;
            };
            const names = Object.keys(mod.actions);
            expect(names.length).toBeGreaterThan(0);
            for (const name of names) {
                saveConfig.mockClear();
                reloadConfig.mockClear();
                const action = mod.actions[name] as (ev: unknown) => Promise<unknown>;
                const result = await action({
                    request: requestFor(),
                    locals: PLAIN_USER,
                    url: new URL('http://localhost/admin/x'),
                    params: {},
                    cookies: { get: () => undefined },
                });
                expect(isActionFailure(result), `${rel} ?/${name} must be an ActionFailure`).toBe(
                    true,
                );
                expect((result as { status: number }).status, `${rel} ?/${name} status`).toBe(403);
                expect(saveConfig, `${rel} ?/${name} wrote config`).not.toHaveBeenCalled();
                expect(reloadConfig, `${rel} ?/${name} reloaded config`).not.toHaveBeenCalled();
            }
        });
    }
});
