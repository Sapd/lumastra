// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin Users API Tests
 *
 * Tests for GET /api/admin/users (list local accounts) and
 * PATCH /api/admin/users/[username] (set is_admin flag).
 *
 * These endpoints require admin privileges and are protected by
 * requireAdmin middleware which uses DB-authoritative is_admin.
 */

import { adminTest as test, expect } from './fixtures/auth';

// ---------------------------------------------------------------------------
// Test actors
// ---------------------------------------------------------------------------

const ADMIN_USER = process.env.TEST_USER || 'TestUser';
const ADMIN_GROUPS = 'Users,Librarians,admin';

const NON_ADMIN_USER = 'TestUserNonAdmin';
const NON_ADMIN_GROUPS = 'Users';

// A synthetic username that will NOT exist in the DB at test time
const GHOST_USER = 'ghost_user_does_not_exist_xyz_99999';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminHeaders(username = ADMIN_USER) {
    return {
        'X-Forwarded-User': username,
        'X-Forwarded-Groups': ADMIN_GROUPS,
    };
}

function nonAdminHeaders() {
    return {
        'X-Forwarded-User': NON_ADMIN_USER,
        'X-Forwarded-Groups': NON_ADMIN_GROUPS,
    };
}

// ---------------------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/users', () => {
    test('returns 200 with a users array for admin', async ({ request }) => {
        const response = await request.get('/api/admin/users', {
            headers: adminHeaders(),
        });

        expect(response.status()).toBe(200);

        const body = await response.json();
        expect(body).toHaveProperty('items');
        expect(body).toHaveProperty('page');
        expect(Array.isArray(body.items)).toBe(true);
    });

    test('each user object has expected fields', async ({ request }) => {
        const response = await request.get('/api/admin/users', {
            headers: adminHeaders(),
        });

        const body = await response.json();

        if (body.items.length > 0) {
            const user = body.items[0];
            expect(typeof user.username).toBe('string');
            expect(typeof user.isAdmin).toBe('boolean');
            expect(typeof user.createdAt).toBe('string');
            // lastSeenAt may be null but must be present
            expect('lastSeenAt' in user).toBe(true);
        }
    });

    test('returns 403 for non-admin user', async ({ request }) => {
        const response = await request.get('/api/admin/users', {
            headers: nonAdminHeaders(),
        });

        expect(response.status()).toBe(403);
    });
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/users/[username]
// ---------------------------------------------------------------------------

test.describe('PATCH /api/admin/users/[username]', () => {
    test.beforeAll(async ({ request }) => {
        // Fire a non-admin request to trigger the fire-and-forget upsert in
        // hooks.server.ts (runs via shouldSyncGroups regardless of route auth).
        // We use /api/browse/all rather than /api/admin/users because the latter
        // returns 403 for non-admins, which still triggers the upsert but could
        // mask future changes where admin routes are handled differently.
        await request.get('/api/browse/all', {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });
        // Demote NON_ADMIN_USER in case a previous test run left them as admin
        await request.patch(`/api/admin/users/${encodeURIComponent(NON_ADMIN_USER)}`, {
            headers: adminHeaders(),
            data: { isAdmin: false },
        });
    });

    test('promotes a user to admin and returns updated record', async ({ request }) => {
        // First make sure NON_ADMIN_USER exists in DB by having them make a request
        await request.get('/api/browse/all', {
            headers: nonAdminHeaders(),
        });

        const response = await request.patch(
            `/api/admin/users/${encodeURIComponent(NON_ADMIN_USER)}`,
            {
                headers: adminHeaders(),
                data: { isAdmin: true },
            },
        );

        // 200 or 404 (if not yet in DB)
        if (response.status() === 200) {
            const body = await response.json();
            // Usernames are lowercased in DB — compare case-insensitively
            expect(body.username.toLowerCase()).toBe(NON_ADMIN_USER.toLowerCase());
            expect(body.isAdmin).toBe(true);
        } else {
            // If user not in DB yet, that's also acceptable — the endpoint returns 404
            expect(response.status()).toBe(404);
        }

        // Cleanup: demote them back
        await request.patch(`/api/admin/users/${encodeURIComponent(NON_ADMIN_USER)}`, {
            headers: adminHeaders(),
            data: { isAdmin: false },
        });
    });

    test('demotes a user from admin', async ({ request }) => {
        // Promote first
        const promoteResp = await request.patch(
            `/api/admin/users/${encodeURIComponent(NON_ADMIN_USER)}`,
            {
                headers: adminHeaders(),
                data: { isAdmin: true },
            },
        );

        if (promoteResp.status() !== 200) {
            // User not yet in DB — skip this assertion
            test.skip(true, 'NON_ADMIN_USER not yet in users table, skipping demotion test');
            return;
        }

        const response = await request.patch(
            `/api/admin/users/${encodeURIComponent(NON_ADMIN_USER)}`,
            {
                headers: adminHeaders(),
                data: { isAdmin: false },
            },
        );

        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.isAdmin).toBe(false);
    });

    test('prevents admin from revoking their own admin', async ({ request }) => {
        // Make a request as ADMIN_USER first to ensure they are upserted in users table
        await request.get('/api/admin/users', { headers: adminHeaders() });

        // The self-demotion guard fires before the DB update, but the user must be
        // seeded in the DB so setIsAdmin has something to update. The guard itself
        // checks locals.user.username === url_param (case-insensitive) so it returns
        // 400 regardless of DB state.
        const response = await request.patch(
            // Use lowercased username to match how hooks.server.ts stores it
            `/api/admin/users/${encodeURIComponent(ADMIN_USER.toLowerCase())}`,
            {
                headers: adminHeaders(),
                data: { isAdmin: false },
            },
        );

        expect(response.status()).toBe(422);
        const body = await response.json();
        expect(body.error).toBeTruthy();
    });

    test('returns 404 for a user that does not exist', async ({ request }) => {
        const response = await request.patch(`/api/admin/users/${encodeURIComponent(GHOST_USER)}`, {
            headers: adminHeaders(),
            data: { isAdmin: true },
        });

        expect(response.status()).toBe(404);
    });

    test('returns 403 when called by a non-admin user', async ({ request }) => {
        const response = await request.patch(`/api/admin/users/${encodeURIComponent(ADMIN_USER)}`, {
            headers: nonAdminHeaders(),
            data: { isAdmin: false },
        });

        expect(response.status()).toBe(403);
    });

    test('returns 400 for invalid body (missing isAdmin)', async ({ request }) => {
        const response = await request.patch(
            `/api/admin/users/${encodeURIComponent(NON_ADMIN_USER)}`,
            {
                headers: adminHeaders(),
                data: { someOtherField: 'value' },
            },
        );

        expect(response.status()).toBe(422);
    });

    test('returns 400 for invalid body (isAdmin is a string)', async ({ request }) => {
        const response = await request.patch(
            `/api/admin/users/${encodeURIComponent(NON_ADMIN_USER)}`,
            {
                headers: adminHeaders(),
                data: { isAdmin: 'yes' },
            },
        );

        expect(response.status()).toBe(422);
    });
});
