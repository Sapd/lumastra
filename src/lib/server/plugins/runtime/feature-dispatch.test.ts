// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { matchFeatureRoute } from './feature-dispatch.js';
import type { FeatureDefinition } from '@sapd/lumastra-plugin-sdk';

const feature: FeatureDefinition = {
    id: 'demo',
    capabilities: { browserUi: true },
    routes: [
        { method: 'GET', path: '/messages', handler: async () => new Response('list') },
        { method: 'GET', path: '/messages/:id', handler: async () => new Response('one') },
        { method: 'POST', path: '/messages', handler: async () => new Response('made') },
    ],
};

describe('matchFeatureRoute', () => {
    it('matches an exact static path + method', () => {
        const m = matchFeatureRoute(feature, 'POST', '/messages');
        expect(m?.route.path).toBe('/messages');
        expect(m?.params).toEqual({});
    });

    it('matches a param path and extracts params', () => {
        const m = matchFeatureRoute(feature, 'GET', '/messages/abc-123');
        expect(m?.route.path).toBe('/messages/:id');
        expect(m?.params).toEqual({ id: 'abc-123' });
    });

    it('prefers a static segment over a param segment', () => {
        // both '/messages' (static) and '/messages/:id' exist; '/messages' wins exactly
        const m = matchFeatureRoute(feature, 'GET', '/messages');
        expect(m?.route.path).toBe('/messages');
    });

    it('returns null for an unknown path or method', () => {
        expect(matchFeatureRoute(feature, 'GET', '/nope')).toBeNull();
        expect(matchFeatureRoute(feature, 'DELETE', '/messages')).toBeNull();
    });

    it('normalizes a leading-slash-less rest path', () => {
        expect(matchFeatureRoute(feature, 'GET', 'messages')?.route.path).toBe('/messages');
    });

    it('returns null (does not throw) for a malformed percent-escape in a param segment', () => {
        for (const bad of ['/messages/%', '/messages/%zz', '/messages/%E0%A4%A']) {
            expect(() => matchFeatureRoute(feature, 'GET', bad)).not.toThrow();
            expect(matchFeatureRoute(feature, 'GET', bad)).toBeNull();
        }
    });

    it('decodes a well-formed percent-escape in a param segment', () => {
        const m = matchFeatureRoute(feature, 'GET', '/messages/a%20b');
        expect(m?.route.path).toBe('/messages/:id');
        expect(m?.params).toEqual({ id: 'a b' });
    });
});
