// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Schema-parity guard for GET /api/v1/people/{id}/images.
 *
 * The handler (`$lib/server/api/defs/people/[id]/images/index.js`) always
 * includes `thumb`/`card`/`full` preset-size variants alongside `href`,
 * `revision` and `source` for the `primary` role. This test drives the REAL def
 * handler and asserts the registered OpenAPI response schema
 * (`route.GET.responses[200].schema`)
 * parses that real payload without stripping any fields — a schema narrower
 * than the actual response silently drops fields from the published spec,
 * which is exactly what broke the tvOS client's strict decoder.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/people/[id]/images/index.js';

// Resolve a known profile without provider/database I/O; the real def still
// projects the service response and mount validates the listing schema.
vi.mock('$lib/server/services/person.service.js', async () => {
    const { personImageSet } = await import('$lib/server/services/image-descriptor/resources.js');
    return {
        resolvePersonAccessBoundary: vi.fn().mockResolvedValue({}),
        handlePersonGet: vi.fn(
            async (event: RequestEvent, _boundary: unknown, surface: 'internal' | 'v1') =>
                Response.json({
                    images: personImageSet(surface, event.params.personId!, '/profile.jpg'),
                }),
        ),
    };
});

// Route OpenAPI metadata migrated onto the def as `def.docs`.
const route = def.docs!;

function makeEvent(id: string): RequestEvent {
    const url = new URL(`http://localhost/api/v1/people/${id}/images`);
    return {
        url,
        request: new Request(url.toString(), { method: 'GET' }),
        params: { id },
        route: { id: '/api/v1/people/[id]/images' as const },
        locals: { user: { username: 'alice' } },
        cookies: {} as RequestEvent['cookies'],
        fetch: (() => {}) as unknown as RequestEvent['fetch'],
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => {},
    } as unknown as RequestEvent;
}

describe('/api/v1/people/{id}/images response schema', () => {
    const { GET } = mount(def, { surface: 'v1' });

    it('parses the real handler payload without stripping the size-preset fields', async () => {
        const res = await GET!(makeEvent('123'));
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;

        const responseDef = route.GET?.responses[200];
        if (!responseDef || typeof responseDef === 'string' || !('schema' in responseDef)) {
            throw new Error('Expected the 200 response to declare a schema');
        }

        const parsed = responseDef.schema.parse(body) as Record<string, unknown>;
        expect(Object.keys(parsed).sort()).toEqual(Object.keys(body).sort());

        const images = body.images as Record<string, Record<string, unknown>>;
        const parsedImages = parsed.images as Record<string, Record<string, unknown>>;
        expect(body.id).toBe('tmdb:123');
        expect(Object.keys(images)).toEqual(['primary']);
        expect(parsedImages).toEqual(images);
        expect(Object.keys(parsedImages.primary).sort()).toEqual([
            'href',
            'provider',
            'revision',
            'source',
            'variants',
        ]);
        const primary = parsedImages.primary;
        const variants = primary.variants as Record<string, string>;
        expect(Object.keys(variants).sort()).toEqual(['card', 'full', 'thumb']);
        expect(primary.href).toBe(variants.card);
        expect(primary.revision).toEqual(expect.any(String));
        expect(primary.source).toBe('self');
        expect(primary.provider).toBe('tmdb');
        for (const [name, size] of Object.entries({ thumb: 'w45', card: 'w185', full: 'original' })) {
            expect(variants[name]).toBe(
                `/api/v1/people/tmdb%3A123/images/profile?size=${size}&v=${primary.revision}`,
            );
        }
    });
});
