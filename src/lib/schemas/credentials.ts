// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { publicAuthorSchema } from './public-author';
import { serviceTokenMethodSchema, serviceTokenScopeSchema } from './admin';

export const PersonalAccessTokenSchema = z
    .object({
        id: z.number().int().describe('Opaque personal access token ID'),
        name: z.string(),
        description: z.string().nullable(),
        tokenPrefix: z.string(),
        scopes: z.array(z.string()),
        createdAt: z.string(),
        expiresAt: z.string().nullable(),
        lastUsedAt: z.string().nullable(),
        lastUsedIp: z.string().nullable(),
        usageCount: z.number().int(),
        isExpired: z.boolean(),
        allowedIps: z.array(z.string()).nullable(),
    })
    .meta({ id: 'PersonalAccessToken' });
export const AdminPersonalAccessTokenSchema = PersonalAccessTokenSchema.extend({
    owner: publicAuthorSchema,
}).meta({ id: 'AdminPersonalAccessToken' });
export const ServiceTokenSchema = z
    .object({
        id: z.number().int().describe('Opaque service token ID'),
        name: z.string(),
        description: z.string().nullable(),
        tokenPrefix: z.string().describe('Display prefix; never the full credential'),
        owner: publicAuthorSchema.nullable().describe('Original minting user; null after deletion'),
        actAsUserId: z.string().uuid().nullable().describe('Impersonated user UUID'),
        actAs: publicAuthorSchema.nullable(),
        scopes: z.array(serviceTokenScopeSchema),
        allowedIps: z.array(z.string()).describe('Empty means unrestricted source IPs'),
        allowedPathPrefixes: z
            .array(z.string())
            .describe('Empty means every path admitted by scopes'),
        allowedMethods: z.array(serviceTokenMethodSchema).describe('Empty means every HTTP method'),
        forceNonAdmin: z.boolean(),
        createdVia: z
            .object({ tokenId: z.number().int(), tokenName: z.string() })
            .nullable()
            .describe('Minting service token; null for a user mint'),
        createdAt: z.string(),
        expiresAt: z.string().nullable(),
        lastUsedAt: z.string().nullable(),
        usageCount: z.number().int().describe('Number of successful authentications'),
        isExpired: z.boolean().describe('Whether expiry has passed'),
    })
    .meta({ id: 'ServiceToken' });
