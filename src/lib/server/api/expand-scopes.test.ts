// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * G5 — privilege-boundary / scope-expansion invariant.
 *
 * Guards that expandScopes() upholds its documented contract:
 *   - `write` must not grant any admin-class or privileged-system scopes
 *   - `read` must not grant any write or admin scopes
 *   - Hierarchical fine-grained expansions must hold (e.g. users:admin → users:read)
 *
 * These tests lock the "write must not grant admin/tasks:run/webhooks:write" rule
 * against future edits to expandScopes().
 */

import { describe, it, expect } from 'vitest';
import { expandScopes } from './principal.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All admin-class and privileged-system scopes that write must never grant. */
const ADMIN_AND_PRIVILEGED = [
    'admin',
    'media:admin',
    'users:admin',
    'tokens:admin',
    'access:admin',
    'library:admin',
    'livetv:admin',
    'providers:admin',
    'playback:admin',
    'requests:admin',
    'tasks:admin',
    'tasks:run',
    'webhooks:write',
] as const;

/** All write-family scopes that read must never grant. */
const WRITE_SCOPES = ['write', 'media:write', 'sessions:write', 'webhooks:write'] as const;

// ---------------------------------------------------------------------------
// G5-A: write does NOT expand to any admin-class or privileged-system scope
// ---------------------------------------------------------------------------

describe('expandScopes([write]) — privilege boundary', () => {
    const expanded = expandScopes(['write']);

    it('does not contain the coarse admin scope', () => {
        expect(expanded).not.toContain('admin');
    });

    it.each(ADMIN_AND_PRIVILEGED)('does not contain privileged scope %s', (scope) => {
        expect(expanded).not.toContain(scope);
    });

    it('does contain read (write is a superset of read)', () => {
        expect(expanded).toContain('read');
    });

    it('does contain media:read (write grants media access)', () => {
        expect(expanded).toContain('media:read');
    });

    it('does contain media:write', () => {
        expect(expanded).toContain('media:write');
    });

    it('does contain sessions:read', () => {
        expect(expanded).toContain('sessions:read');
    });

    it('does contain requests:read', () => {
        expect(expanded).toContain('requests:read');
    });
});

// ---------------------------------------------------------------------------
// G5-B: read does NOT expand to any write or admin scope
// ---------------------------------------------------------------------------

describe('expandScopes([read]) — read-only boundary', () => {
    const expanded = expandScopes(['read']);

    it.each(WRITE_SCOPES)('does not contain write-family scope %s', (scope) => {
        expect(expanded).not.toContain(scope);
    });

    it.each(ADMIN_AND_PRIVILEGED)('does not contain privileged scope %s', (scope) => {
        expect(expanded).not.toContain(scope);
    });

    // `tasks:read`'s auto-grant was REMOVED (2026-09-18 fix-plan-4, Task 2,
    // Shape C ruling — see principal.ts's `if (out.has('read'))` block). It
    // used to be granted here, which is what let findings C2/C4/C5 (2026-09-17
    // security review 4) recur after 2026-09-12 C16 fixed the same shape
    // once for a different six endpoints. `tasks:read` is not a mintable
    // PAT/service-token scope, so this now requires `tasks:admin` (or the
    // coarse `admin` alias) — see `tasks/api-auth.ts`'s matching
    // `scopeGranted` split and `defs-scope-non-admin-sweep.test.ts`.
    it('does NOT contain tasks:read (auto-grant removed)', () => {
        expect(expanded).not.toContain('tasks:read');
    });

    it('does NOT contain runs:read (auto-grant removed 2026-10-07; run inputs are operator data)', () => {
        expect(expanded).not.toContain('runs:read');
    });

    it('contains media:read', () => {
        expect(expanded).toContain('media:read');
    });

    it('contains sessions:read', () => {
        expect(expanded).toContain('sessions:read');
    });

    it('contains requests:read', () => {
        expect(expanded).toContain('requests:read');
    });
});

// ---------------------------------------------------------------------------
// G5-C: hierarchical fine-grained expansions hold
// ---------------------------------------------------------------------------

describe('expandScopes — hierarchical fine-grained expansions', () => {
    it('users:admin grants users:read', () => {
        const expanded = expandScopes(['users:admin']);
        expect(expanded).toContain('users:read');
    });

    it('users:admin does not grant write (no coarse promotion)', () => {
        const expanded = expandScopes(['users:admin']);
        expect(expanded).not.toContain('write');
        expect(expanded).not.toContain('media:write');
    });

    it('media:admin grants media:read', () => {
        const expanded = expandScopes(['media:admin']);
        expect(expanded).toContain('media:read');
    });

    it('media:admin grants media:write', () => {
        const expanded = expandScopes(['media:admin']);
        expect(expanded).toContain('media:write');
    });

    it('media:admin does not grant unrelated admin scopes', () => {
        const expanded = expandScopes(['media:admin']);
        expect(expanded).not.toContain('users:admin');
        expect(expanded).not.toContain('tokens:admin');
        expect(expanded).not.toContain('tasks:run');
        expect(expanded).not.toContain('webhooks:write');
    });

    it('tasks:admin grants tasks:read', () => {
        const expanded = expandScopes(['tasks:admin']);
        expect(expanded).toContain('tasks:read');
    });

    it('tasks:admin grants runs:read', () => {
        const expanded = expandScopes(['tasks:admin']);
        expect(expanded).toContain('runs:read');
    });

    it('tasks:admin grants metrics:read', () => {
        const expanded = expandScopes(['tasks:admin']);
        expect(expanded).toContain('metrics:read');
    });

    it('tasks:admin does not grant tasks:run (explicit grant required)', () => {
        // tasks:admin is about managing tasks, not running them — tasks:run
        // requires an explicit scope grant per the documented contract.
        // NOTE: The code at line 261-266 does NOT add tasks:run for tasks:admin,
        // so this assertion matches actual behavior.
        const expanded = expandScopes(['tasks:admin']);
        expect(expanded).not.toContain('tasks:run');
    });

    it('library:admin grants library:read', () => {
        const expanded = expandScopes(['library:admin']);
        expect(expanded).toContain('library:read');
    });

    it('providers:admin grants providers:read', () => {
        const expanded = expandScopes(['providers:admin']);
        expect(expanded).toContain('providers:read');
    });

    it('playback:admin grants playback:read', () => {
        const expanded = expandScopes(['playback:admin']);
        expect(expanded).toContain('playback:read');
    });
});

// ---------------------------------------------------------------------------
// G5-D: coarse admin expands to everything (positive sanity check)
// ---------------------------------------------------------------------------

describe('expandScopes([admin]) — superset sanity', () => {
    const expanded = expandScopes(['admin']);

    it('contains tasks:run (admin grants all)', () => {
        expect(expanded).toContain('tasks:run');
    });

    it('contains webhooks:write (admin grants all)', () => {
        expect(expanded).toContain('webhooks:write');
    });

    it('contains all admin-class scopes', () => {
        for (const scope of ADMIN_AND_PRIVILEGED) {
            expect(expanded).toContain(scope);
        }
    });

    it('contains write and read', () => {
        expect(expanded).toContain('write');
        expect(expanded).toContain('read');
    });
});

// ---------------------------------------------------------------------------
// G5-E: input is preserved in output (expanded set is a superset)
// ---------------------------------------------------------------------------

describe('expandScopes — input preservation', () => {
    it('output always includes every input scope', () => {
        const inputs = ['tasks:run', 'webhooks:write', 'users:read'];
        const expanded = expandScopes(inputs);
        for (const scope of inputs) {
            expect(expanded).toContain(scope);
        }
    });

    it('empty input returns empty output', () => {
        expect(expandScopes([])).toEqual([]);
    });
});
