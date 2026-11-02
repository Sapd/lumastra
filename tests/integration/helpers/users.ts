// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { ensureTestUser, generateTestUserId, derivedUsername } from '../fixtures/user.fixtures.js';

/**
 * Insert a throwaway user and return its id and username.
 *
 * Thin wrapper over the existing `ensureTestUser` fixture — do not
 * reimplement user insertion here. `ensureTestUser` inserts both `users` AND
 * the FK-dependent `user_profiles` row; `user_watchlist.user_id` (and other
 * user-data tables) FK to `user_profiles(user_id)`, so a helper that only
 * inserted `users` would 23503 the moment a caller seeds a row keyed on this
 * user. Each call mints a fresh UUID, so two users created in the same test
 * never collide.
 */
export async function createTestUser(sql: postgres.Sql): Promise<{ id: string; username: string }> {
    const id = generateTestUserId();
    await ensureTestUser(sql, id);
    return { id, username: derivedUsername(id) };
}
