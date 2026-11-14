// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TEST-ONLY fixtures for `AssistantToolContext`.
 *
 * `AssistantToolContext.user` is a full `UserContext` — 14 required fields —
 * because the write tools hand it straight to `resolveAndGate` and
 * `watched-state-ops`. Spelling that literal out in each of the ~30 per-tool
 * test files would bury the thing each test is actually asserting, so the
 * boilerplate lives here.
 *
 * Not named `*.test.ts` on purpose: vitest's include glob is
 * `src/**\/*.{test,spec}.{js,ts}`, so this file is a helper, not a suite.
 *
 * @module server/assistant/assistant-tools/test-context
 */

import { toUserId } from '$lib/shared/user-id.js';
import type { UserContext } from '../../types.js';

/**
 * A plain, non-admin, unrestricted caller. Override individual fields for
 * tests that care (e.g. `{ hasRequestPermission: true }`).
 */
export function assistantTestUser(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: toUserId('a1ce0000-0000-4000-a000-000000000000'),
        username: 'alice',
        groups: '',
        userGroups: [],
        hasWatchPermission: false,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
        ...overrides,
    };
}
