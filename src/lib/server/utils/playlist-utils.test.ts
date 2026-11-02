// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the pure playlist permission helpers.
 *
 * `getUserRole` / `getPlaylistContext` hit the database and are covered by
 * playlist-utils.integration.test.ts; these tests cover the pure role gates.
 */

import { describe, it, expect } from 'vitest';
import { canEdit, canManageMembers, type PlaylistRole } from './playlist-utils';

describe('canEdit', () => {
    it.each([
        ['owner', true],
        ['editor', true],
        ['readonly', false],
        [null, false],
    ] as Array<[PlaylistRole, boolean]>)('role %s → %s', (role, expected) => {
        expect(canEdit(role)).toBe(expected);
    });
});

describe('canManageMembers', () => {
    it.each([
        ['owner', true],
        ['editor', false],
        ['readonly', false],
        [null, false],
    ] as Array<[PlaylistRole, boolean]>)('role %s → %s', (role, expected) => {
        // Only the owner may manage members — editors can edit content but not
        // invite/remove members or change roles.
        expect(canManageMembers(role)).toBe(expected);
    });
});
