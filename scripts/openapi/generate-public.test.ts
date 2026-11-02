// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { collectPublicRoutes } from './generate-public';

const { mockReadDir } = vi.hoisted(() => ({ mockReadDir: vi.fn() }));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, readdirSync: mockReadDir };
});

vi.mock('../../src/lib/server/api/defs/lists/index.ts', () => ({
    def: {
        docs: {
            GET: { tags: ['Lists'], summary: 'Read lists', responses: { 200: 'OK' } },
            POST: {
                visibility: 'internal',
                tags: ['Internal writes'],
                summary: 'Write lists',
                responses: { 200: 'OK' },
            },
        },
    },
}));

vi.mock('../../src/lib/server/api/defs/providers.ts', () => ({
    def: {
        docs: {
            visibility: 'internal',
            GET: {
                visibility: 'public',
                tags: ['Providers'],
                summary: 'Read providers',
                responses: { 200: 'OK' },
            },
            PUT: { tags: ['Internal writes'], summary: 'Replace', responses: { 200: 'OK' } },
            PATCH: { tags: ['Internal writes'], summary: 'Update', responses: { 200: 'OK' } },
        },
    },
}));

describe('per-method documentation visibility', () => {
    it('splits reads and writes between specs, inherits defaults, and collects only public tags', async () => {
        const apiDir = resolve(import.meta.dirname, '../../src/routes/api/v1');
        const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
        const entries = fs.readdirSync(apiDir, { recursive: true, withFileTypes: true });
        mockReadDir.mockReturnValue(
            entries.filter(
                (entry) =>
                    entry.name === '+server.ts' &&
                    [resolve(apiDir, 'lists'), resolve(apiDir, 'providers')].includes(
                        entry.parentPath,
                    ),
            ),
        );

        const result = await collectPublicRoutes();
        expect(result.importFailures).toEqual([]);
        expect(Object.keys(result.routes['/api/v1/lists']!)).toEqual(['get']);
        expect(Object.keys(result.internalRoutes['/api/v1/lists']!)).toEqual(['post']);
        expect(Object.keys(result.routes['/api/v1/providers']!)).toEqual(['get']);
        expect(Object.keys(result.internalRoutes['/api/v1/providers']!).sort()).toEqual([
            'patch',
            'put',
        ]);
        expect(result.tags.map((tag) => tag.name)).toEqual(['Lists', 'Providers']);
        // Public operations must state their stability; internal ones may not.
        expect(result.unlabelledPublic).toEqual(['GET /api/v1/lists', 'GET /api/v1/providers']);
    });
});
