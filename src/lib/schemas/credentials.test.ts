// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    PersonalAccessTokenSchema,
    AdminPersonalAccessTokenSchema,
    ServiceTokenSchema,
} from './credentials';
import { DeviceSchema, DevicesListResponseSchema, RevokeAllDevicesResponseSchema } from './devices';

const pat = {
    id: 1,
    name: 'CLI',
    description: null,
    tokenPrefix: 'pat_test',
    scopes: ['read'],
    createdAt: '2026-10-17T00:00:00Z',
    expiresAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    usageCount: 0,
    isExpired: false,
    allowedIps: null,
};
const author = {
    userId: '11111111-1111-4111-8111-111111111111',
    displayName: null,
    images: { primary: { href: '/api/v1/users/avatar', revision: '0', source: 'self' } },
};
describe('credential and device wire contracts', () => {
    it('requires integer PAT ids and accepts honestly nullable metadata', () => {
        expect(PersonalAccessTokenSchema.safeParse(pat).success).toBe(true);
        expect(PersonalAccessTokenSchema.safeParse({ ...pat, id: 1.5 }).success).toBe(false);
        expect(PersonalAccessTokenSchema.safeParse({ ...pat, id: '1' }).success).toBe(false);
    });
    it('requires an author rather than a login username on admin PATs', () => {
        expect(AdminPersonalAccessTokenSchema.safeParse({ ...pat, owner: author }).success).toBe(
            true,
        );
        expect(
            AdminPersonalAccessTokenSchema.safeParse({ ...pat, username: 'login' }).success,
        ).toBe(false);
    });
    it('documents and validates complete service tokens including mint provenance', () => {
        const token = {
            id: 2,
            name: 'Monitor',
            description: null,
            tokenPrefix: 'svc_test',
            owner: author,
            actAsUserId: author.userId,
            actAs: author,
            scopes: ['read'],
            allowedIps: [],
            allowedPathPrefixes: [],
            allowedMethods: [],
            forceNonAdmin: true,
            createdVia: { tokenId: 1, tokenName: 'Minter' },
            createdAt: pat.createdAt,
            expiresAt: null,
            lastUsedAt: null,
            usageCount: 0,
            isExpired: false,
        };
        expect(ServiceTokenSchema.safeParse(token).success).toBe(true);
        expect(
            ServiceTokenSchema.safeParse({
                ...token,
                owner: null,
                actAs: null,
                actAsUserId: null,
                createdVia: null,
            }).success,
        ).toBe(true);
        expect(ServiceTokenSchema.safeParse({ ...token, allowedIps: null }).success).toBe(false);
        expect(
            ServiceTokenSchema.safeParse({
                ...token,
                createdVia: { tokenId: 1.5, tokenName: 'Minter' },
            }).success,
        ).toBe(false);
    });
    it('identifies devices by session string and uses a shared page envelope', () => {
        const device = {
            deviceSessionId: 'session',
            deviceId: 'client',
            deviceName: null,
            isCustomName: false,
            createdAt: pat.createdAt,
            lastUsedAt: null,
        };
        expect(DeviceSchema.strict().safeParse(device).success).toBe(true);
        expect(DeviceSchema.strict().safeParse({ ...device, id: 1 }).success).toBe(false);
        expect(
            DevicesListResponseSchema.safeParse({
                items: [device],
                page: { limit: 50, offset: 0, hasMore: false, total: 1 },
            }).success,
        ).toBe(true);
        expect(
            RevokeAllDevicesResponseSchema.safeParse({
                revoked: 2,
                failedStores: ['native_sessions'],
            }).success,
        ).toBe(true);
        expect(
            RevokeAllDevicesResponseSchema.safeParse({ revoked: true, failedStores: [] }).success,
        ).toBe(false);
    });
});
