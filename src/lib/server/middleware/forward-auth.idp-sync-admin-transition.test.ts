// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `computeIdpSyncAdminTransition()` — the pure X3/MINOR-4-fix
 * core of `syncAdminCredentialsAfterUpsert()` (security review 2026-09-23,
 * final fix wave). Before the X3 fix, the IdP-group periodic sync
 * narrowed/restored purely from `upsertUser()`'s column-only
 * `{demoted,promoted}` flags, which over-narrowed a dual-membership admin
 * (IdP admin group AND in-app admin) the moment they left the IdP group, and
 * never restored them. Fix round 2 (MINOR 4) additionally found the in-app
 * check itself was incomplete: it only looked at the `admin` CAPABILITY,
 * missing an in-app group whose NAME matches `config.ADMIN_GROUPS` (which
 * `syncAdminCredentialsAfterUpsert()` now also checks via
 * `hasGroupPermission()` before calling this function — see its own doc
 * comment). This file tests only the pure `{wasAdmin,isAdminNow}` OR-merge
 * this function does with an already-resolved `inAppIsAdminNow` boolean; the
 * capability-vs-name-match resolution itself is exercised at the call site,
 * not here (it needs the DB round trip this function deliberately avoids).
 */

import { describe, it, expect } from 'vitest';
import { computeIdpSyncAdminTransition } from './forward-auth.js';

describe('computeIdpSyncAdminTransition', () => {
    it('dual-membership: column demoted but in-app still admin -> no transition (true, true), not narrowed', () => {
        const result = computeIdpSyncAdminTransition(
            { isAdmin: false, demoted: true, promoted: false },
            true, // in-app admin now (and, since unaffected by this write, also before)
        );
        expect(result).toEqual({ wasAdmin: true, isAdminNow: true });
    });

    it('column demoted, no in-app admin -> real demotion (true, false)', () => {
        const result = computeIdpSyncAdminTransition(
            { isAdmin: false, demoted: true, promoted: false },
            false,
        );
        expect(result).toEqual({ wasAdmin: true, isAdminNow: false });
    });

    it('column promoted, already in-app admin -> no transition (true, true), not a spurious restore', () => {
        const result = computeIdpSyncAdminTransition(
            { isAdmin: true, demoted: false, promoted: true },
            true,
        );
        expect(result).toEqual({ wasAdmin: true, isAdminNow: true });
    });

    it('column promoted, no in-app admin -> real promotion (false, true)', () => {
        const result = computeIdpSyncAdminTransition(
            { isAdmin: true, demoted: false, promoted: true },
            false,
        );
        expect(result).toEqual({ wasAdmin: false, isAdminNow: true });
    });

    it('no column transition, no in-app admin -> stable non-admin (false, false)', () => {
        const result = computeIdpSyncAdminTransition(
            { isAdmin: false, demoted: false, promoted: false },
            false,
        );
        expect(result).toEqual({ wasAdmin: false, isAdminNow: false });
    });

    it('no column transition, in-app admin throughout (capability OR name-match, resolved by the caller) -> stable admin (true, true)', () => {
        // fix round 2, MINOR 4: this boolean is now `extraCapabilities.isAdmin
        // === true || hasGroupPermission(effectiveGroups, ADMIN_GROUPS)` at
        // the call site — this pure function only sees the resolved boolean,
        // so a name-conferred in-app admin (no `admin` capability row at
        // all) exercises the EXACT SAME branch here as a capability-conferred
        // one. The call-site OR is what fix round 2 added; this test pins
        // that this function's own merge doesn't care which path produced
        // `true`.
        const result = computeIdpSyncAdminTransition(
            { isAdmin: false, demoted: false, promoted: false },
            true,
        );
        expect(result).toEqual({ wasAdmin: true, isAdminNow: true });
    });
});
