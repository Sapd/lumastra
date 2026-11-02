// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { toLibraryAccessUser } from './library-group-permissions-cache.js';

describe('toLibraryAccessUser admin decision', () => {
    it('admin session: user flag and credential capability both true', () => {
        expect(toLibraryAccessUser({ ownerIsAdmin: true, mediaAccessIsAdmin: true })?.isAdmin).toBe(
            true,
        );
    });

    it('legacy context without the capability field keeps the user flag', () => {
        expect(toLibraryAccessUser({ ownerIsAdmin: true })?.isAdmin).toBe(true);
        expect(toLibraryAccessUser({ ownerIsAdmin: false })?.isAdmin).toBe(false);
    });

    it('scoped credential of an admin owner is not admin', () => {
        expect(
            toLibraryAccessUser({ ownerIsAdmin: true, mediaAccessIsAdmin: false })?.isAdmin,
        ).toBe(false);
    });

    it('a copy that lowered isAdmin stays non-admin despite a stale capability flag', () => {
        // deEscalateUser / service-token impersonation spread the user and set isAdmin false.
        expect(
            toLibraryAccessUser({ ownerIsAdmin: false, mediaAccessIsAdmin: true })?.isAdmin,
        ).toBe(false);
    });
});
