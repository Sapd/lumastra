// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { defineFeature } from './define-feature.js';
import { PluginDefinitionError } from './errors.js';

const baseRoute = { method: 'GET' as const, path: '/x', handler: async () => new Response('ok') };

describe('defineFeature widgets/capabilities', () => {
    it('accepts a feature with a widget when browserUi is enabled', () => {
        const def = defineFeature({
            id: 'demo',
            capabilities: { browserUi: true },
            routes: [baseRoute],
            widgets: [{ id: 'main', title: 'Demo', entry: '/widget.js' }],
        });
        expect(def.widgets?.[0].entry).toBe('/widget.js');
    });

    it('rejects widgets without capabilities.browserUi', () => {
        expect(() =>
            defineFeature({
                id: 'demo',
                routes: [baseRoute],
                widgets: [{ id: 'main', title: 'Demo', entry: '/widget.js' }],
            }),
        ).toThrow(PluginDefinitionError);
    });

    it('rejects a widget missing entry', () => {
        expect(() =>
            defineFeature({
                id: 'demo',
                capabilities: { browserUi: true },
                routes: [baseRoute],
                // @ts-expect-error entry required
                widgets: [{ id: 'main', title: 'Demo' }],
            }),
        ).toThrow(PluginDefinitionError);
    });

    it('still accepts a routes-only feature with no widgets', () => {
        const def = defineFeature({ id: 'demo', routes: [baseRoute] });
        expect(def.widgets).toBeUndefined();
    });
});

describe('defineFeature pages', () => {
    const base = {
        id: 'dash',
        routes: [{ method: 'GET' as const, path: '/x', handler: async () => new Response() }],
    };

    it('accepts pages when browserUi is declared', () => {
        expect(() =>
            defineFeature({
                ...base,
                capabilities: { browserUi: true },
                pages: [{ id: 'index', title: 'Dashboard', entry: '/page.js' }],
            }),
        ).not.toThrow();
    });

    it('requires browserUi — a page runs plugin JS exactly as a widget does', () => {
        expect(() =>
            defineFeature({
                ...base,
                pages: [{ id: 'index', title: 'Dashboard', entry: '/page.js' }],
            }),
        ).toThrow(/browserUi/);
    });

    it('rejects a duplicate page id', () => {
        expect(() =>
            defineFeature({
                ...base,
                capabilities: { browserUi: true },
                pages: [
                    { id: 'index', title: 'A', entry: '/a.js' },
                    { id: 'index', title: 'B', entry: '/b.js' },
                ],
            }),
        ).toThrow(/duplicate page id/);
    });

    it('rejects a page id that is not a slug', () => {
        expect(() =>
            defineFeature({
                ...base,
                capabilities: { browserUi: true },
                pages: [{ id: '../escape', title: 'A', entry: '/a.js' }],
            }),
        ).toThrow(/kebab-case/);
    });
});
