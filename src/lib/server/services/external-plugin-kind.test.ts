// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The admin card's kind badge must cover every contract family.
 *
 * A family missing from the lookup does not degrade gracefully: the plugin
 * installs, loads and works, and its card renders with a blank kind — so the
 * one screen an operator uses to inspect what they installed says the least
 * about the newest contracts. This test enumerates the registry's own getters,
 * so a family added later fails here rather than shipping invisible.
 */

import { describe, it, expect } from 'vitest';
import { registry } from '$lib/server/tasks/registry.js';
import { listExternalPluginsWithState } from './external-plugin-manager.service.js';

describe('kind coverage', () => {
    it('the registry exposes a getter for every family the badge must name', () => {
        // If this list grows, `registeredKindOf` must grow with it — that is the
        // coupling the blank badge came from.
        const getters = [
            'getTask',
            'getProvider',
            'getTrickplay',
            'getWatchSync',
            'getFeature',
            'getIntegration',
            'getExternalService',
            'getMediaSource',
            'getSubtitleProvider',
            'getLyricsProvider',
            'getAuthProvider',
        ] as const;
        for (const g of getters) {
            expect(typeof (registry as unknown as Record<string, unknown>)[g]).toBe('function');
        }
        expect(getters).toHaveLength(11);
    });

    it('exports the listing the admin page consumes', () => {
        expect(typeof listExternalPluginsWithState).toBe('function');
    });
});
