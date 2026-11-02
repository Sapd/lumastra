// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A page under /admin must admit exactly whom the /admin LAYOUT admits.
 *
 * The layout gates on `locals.user.isAdmin` — the authoritative verdict built by
 * buildUserPermissions, which honours the DB `admin_pinned` override and the
 * in-app `admin` capability. A page that instead gates on
 * `isUserAdmin(locals.user.userGroups)` re-derives admin from IdP groups ALONE
 * and so is blind to both. The result is a user who sees the whole admin nav and
 * is bounced to `/` by the pages that disagree with the layout.
 *
 * That is not hypothetical: prod user `windows` (is_admin=t, admin_pinned=t,
 * groups without ADMIN_GROUPS) got `/admin/library/media` 200/12002 bytes and
 * `/admin/library/sources` a 64-byte redirect payload followed by a fetch of
 * `/__data.json` — the home page. Reported as "the button does nothing".
 *
 * Both halves matter, so both are asserted: the gate must ADMIT a pinned admin
 * AND still REJECT a plain user.
 */

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRedirect } from '@sveltejs/kit';
import { load as loadSources } from './sources/+page.server.js';
import { load as loadQuarantine } from './quarantine/+page.server.js';

vi.mock('$lib/server/config', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('$lib/server/config');
    return {
        ...actual,
        config: { ...(actual.config as Record<string, unknown>), ADMIN_GROUPS: ['Librarians'] },
    };
});

/** The prod `windows` account: pinned admin, no ADMIN_GROUPS membership. */
const PINNED_ADMIN = {
    user: {
        userId: '17c7b889-32d7-49bd-a8bb-59618e003a3c',
        username: 'windows',
        isAdmin: true,
        userGroups: ['JellyfinEcosystem', 'ArrManager', 'LiveTV', 'media-admins'],
    },
    // 2026-10-13: the gate reads the principal; a pinned-admin session carries an admin one.
    principal: { isAdmin: true },
};

const PLAIN_USER = {
    user: { userId: 'u2', username: 'conny', isAdmin: false, userGroups: ['JellyfinEcosystem'] },
    principal: { isAdmin: false },
};

/** Dependency-free gate-only loads — assert the behaviour end to end. */
const GATE_ONLY_PAGES: ReadonlyArray<[name: string, load: (ev: never) => unknown]> = [
    ['sources', loadSources],
    ['quarantine', loadQuarantine],
];

/** Loads read `url` too (sources redirects the old `?tab=types` links). */
const URL_ = new URL('http://localhost/admin/library');

describe('admin library gate honours the resolved admin verdict', () => {
    for (const [name, load] of GATE_ONLY_PAGES) {
        it(`${name}: admits a pinned admin who is not in ADMIN_GROUPS`, async () => {
            await expect(load({ locals: PINNED_ADMIN, url: URL_ } as never)).resolves.toBeDefined();
        });

        it(`${name}: still rejects a non-admin`, async () => {
            const err = await Promise.resolve(
                load({ locals: PLAIN_USER, url: URL_ } as never),
            ).catch((e: unknown) => e);
            expect(isRedirect(err)).toBe(true);
        });
    }
});

/**
 * The class-wide ratchet. The behavioural cases above cover the two loads with
 * no DB dependencies; this catches every other admin surface — present and
 * future — without each one having to mock its query layer.
 */
function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\+(page\.server|server)\.ts$/.test(entry)) out.push(full);
    }
    return out;
}

describe('no admin surface re-derives admin from groups alone', () => {
    it('has no `isUserAdmin(locals…)` call under src/routes', () => {
        const offenders = walk('src/routes').filter((f) =>
            /isUserAdmin\(\s*locals\b/.test(readFileSync(f, 'utf8')),
        );
        expect(offenders).toEqual([]);
    });
});
