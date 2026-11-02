// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The listed-token shape must accept what the service actually returns.
 *
 * Prod logged "RESPONSE CONFORMANCE — body failed its declared schema" on
 * every `GET /api/admin/service-tokens`. `mount()` passes a non-conforming body
 * through unstripped, so nothing visibly broke — the server was simply failing
 * its own contract on each request, silently, for as long as the declaration
 * has been wrong.
 *
 * Five fields disagreed with `ServiceTokenService.listAll()`: `id` is the
 * table's serial (a number, declared string) and four nullable columns come
 * back as `null`, where `.optional()` accepts only `undefined`.
 *
 * The fixture below is deliberately built from `ServiceTokenListItem`'s own
 * type — the shape the service promises — rather than from what the schema
 * hopes for. That is the seam that broke.
 */

import { describe, it, expect } from 'vitest';
import { def } from './index.js';
import type { ServiceTokenListItem } from '$lib/server/oauth/service-token.service.js';

/** Exactly what `listAll()` yields for a token created with no optional fields. */
function serviceRow(): ServiceTokenListItem {
    return {
        id: 3,
        name: 'grafana',
        description: null,
        tokenPrefix: 'svc_abc123',
        owner: null,
        createdVia: null,
        actAsUserId: null,
        actAs: null,
        scopes: ['read'],
        allowedIps: [],
        allowedPathPrefixes: [],
        allowedMethods: [],
        forceNonAdmin: false,
        createdAt: new Date('2026-08-27T00:00:00.000Z'),
        expiresAt: null,
        lastUsedAt: null,
        usageCount: 0,
        isExpired: false,
    };
}

/** The handler's own mapping, verbatim. */
function toWire(t: ServiceTokenListItem) {
    return {
        ...t,
        createdAt: t.createdAt.toISOString(),
        expiresAt: t.expiresAt?.toISOString() ?? null,
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    };
}

const listSchema = def.docs?.GET?.responses?.[200];

describe('GET /service-tokens response conformance', () => {
    it('declares a 200 schema at all', () => {
        expect(listSchema).toBeDefined();
    });

    it('accepts a token with every nullable column null', () => {
        // The common case: a token created without IP/path/method restrictions.
        const schema = (
            listSchema as { schema: { safeParse: (v: unknown) => { success: boolean } } }
        ).schema;
        const body = {
            items: [toWire(serviceRow())],
            page: { limit: 1, offset: 0, hasMore: false },
        };
        const parsed = schema.safeParse(body);
        expect(parsed.success).toBe(true);
    });

    it('accepts a fully-populated token too', () => {
        const schema = (
            listSchema as { schema: { safeParse: (v: unknown) => { success: boolean } } }
        ).schema;
        const full = {
            ...serviceRow(),
            description: 'metrics scraper',
            allowedIps: ['10.0.0.1'],
            allowedPathPrefixes: ['/api/v1/'],
            allowedMethods: ['GET'] as ServiceTokenListItem['allowedMethods'],
            expiresAt: new Date('2027-01-01T00:00:00.000Z'),
            lastUsedAt: new Date('2026-08-26T00:00:00.000Z'),
        };
        const body = { items: [toWire(full)], page: { limit: 1, offset: 0, hasMore: false } };
        expect(schema.safeParse(body).success).toBe(true);
    });

    it('keeps id numeric — the column is a serial, not a string', () => {
        const schema = (
            listSchema as { schema: { safeParse: (v: unknown) => { success: boolean } } }
        ).schema;
        const body = {
            items: [{ ...toWire(serviceRow()), id: '3' }],
            page: { limit: 1, offset: 0, hasMore: false },
        };
        expect(schema.safeParse(body).success).toBe(false);
    });

    it('types scopes and allowedMethods with their enums', () => {
        const schema = (
            listSchema as { schema: { safeParse: (v: unknown) => { success: boolean } } }
        ).schema;
        const wrap = (over: Record<string, unknown>) => ({
            items: [{ ...toWire(serviceRow()), ...over }],
            page: { limit: 1, offset: 0, hasMore: false },
        });
        expect(schema.safeParse(wrap({ scopes: ['integrations:read'] })).success).toBe(true);
        expect(schema.safeParse(wrap({ scopes: ['tasks:admin'] })).success).toBe(false);
        expect(schema.safeParse(wrap({ allowedMethods: ['TRACE'] })).success).toBe(false);
    });
});
