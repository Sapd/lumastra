// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { applyPlayTokenIdentity } from './play-token-user.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import type { UserContext } from '$lib/server/types.js';

describe('applyPlayTokenIdentity', () => {
    it('sets the user and a never-admin stream-token principal', () => {
        const event = { locals: {} as App.Locals };
        const user = {
            userId: 'u1',
            username: 'admin',
            userGroups: ['admins'],
            isAdmin: true,
            mediaAccessIsAdmin: true,
        } as unknown as UserContext;
        applyPlayTokenIdentity(event, user);
        expect(event.locals.user).toBe(user);
        expect(event.locals.principal?.kind).toBe('stream_token');
        expect(event.locals.principal?.isAdmin).toBe(false);
        // The media grant stays on the user; the control-plane verdict is no.
        expect(localsIsAdmin(event.locals)).toBe(false);
    });
});
