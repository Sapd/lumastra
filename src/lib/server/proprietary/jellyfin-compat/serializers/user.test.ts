// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect } from 'vitest';
import { serializeUser } from './user';

describe('serializeUser', () => {
    it('converts UUID with dashes to 32-char hex without dashes', () => {
        const result = serializeUser({
            id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
            username: 'testuser',
            is_admin: false,
        });
        expect(result.Id).toBe('aaaabbbbccccddddeeeeffffffffffff');
        expect(result.Id).toHaveLength(32);
        expect(result.Id).not.toContain('-');
    });

    it('sets ServerId from JELLYFIN_SERVER_ID constant', () => {
        const result = serializeUser({
            id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
            username: 'testuser',
            is_admin: false,
        });
        expect(typeof result.ServerId).toBe('string');
        expect(result.ServerId).toHaveLength(32);
    });

    it('uses display_name when provided', () => {
        const result = serializeUser({
            id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
            username: 'testuser',
            is_admin: false,
            display_name: 'Test User Display',
        });
        expect(result.Name).toBe('Test User Display');
    });

    it('falls back to username when display_name is absent', () => {
        const result = serializeUser({
            id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
            username: 'testuser',
            is_admin: false,
        });
        expect(result.Name).toBe('testuser');
    });

    it('falls back to username when display_name is empty string', () => {
        const result = serializeUser({
            id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
            username: 'testuser',
            is_admin: false,
            display_name: '',
        });
        expect(result.Name).toBe('testuser');
    });

    it('sets IsAdministrator based on is_admin flag', () => {
        const admin = serializeUser({
            id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
            username: 'admin',
            is_admin: true,
        });
        expect(admin.Policy?.IsAdministrator).toBe(true);

        const user = serializeUser({
            id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
            username: 'user',
            is_admin: false,
        });
        expect(user.Policy?.IsAdministrator).toBe(false);
    });

    it('sets HasPassword and HasConfiguredPassword to true', () => {
        const result = serializeUser({
            id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
            username: 'testuser',
            is_admin: false,
        });
        expect(result.HasPassword).toBe(true);
        expect(result.HasConfiguredPassword).toBe(true);
    });
});

describe('serializeUser: age limit in the policy (brief 09)', () => {
    const base = { id: '0f8fad5b-d9cb-469f-a165-70867728950e', username: 'kid', is_admin: false };

    it('reports MaxParentalRating for an age-limited profile', () => {
        const dto = serializeUser({ ...base, maxAgeRating: 12 });
        expect(dto.Policy.MaxParentalRating).toBe(12);
    });

    it('leaves it off when there is no limit', () => {
        expect(serializeUser({ ...base, maxAgeRating: null }).Policy).not.toHaveProperty(
            'MaxParentalRating',
        );
        expect(serializeUser(base).Policy.BlockUnratedItems).toEqual([]);
    });
});
