// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for security review 2026-09-13, C26 — the example-feature-plugin's
 * `POST /settings` mutated the process-wide demo config with no admin check
 * (its `_ctx` parameter was unused), so ANY authenticated user could flip
 * `enabled`, rewrite `widgetTitle`, or change `maxItems`/`refreshIntervalMinutes`
 * for every viewer. `dispatchFeatureRequest` only enforces "some user is
 * authenticated" (401 for none) — route-level authorization (e.g. admin-only)
 * is the plugin author's own job, unlike `FeaturePage.access`, which the host
 * enforces. This exercises the real plugin definition through the real
 * dispatcher so the fix is verified at the seam a request actually crosses.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dispatchFeatureRequest } from '../../../plugins/runtime/feature-dispatch.js';
import type { FeatureDefinition, PluginContext, PluginUser } from '@sapd/lumastra-plugin-sdk';

function deps(feature: FeatureDefinition) {
    return {
        getFeature: (id: string) => (feature.id === id ? feature : undefined),
        buildCtx: (_featureId: string, user: PluginUser) =>
            ({
                user,
                logger: { info() {}, warn() {}, error() {}, debug() {} },
            }) as unknown as PluginContext,
    };
}

function userWith(isAdmin: boolean): PluginUser {
    return { userId: 'u-1', username: 'viewer', groups: [], isAdmin };
}

async function loadFeature(): Promise<FeatureDefinition> {
    // Fresh module instance per test — the plugin keeps its demo config in a
    // module-level `let config`, so resetting the module registry before each
    // re-import stops mutations leaking across cases.
    vi.resetModules();
    const mod = await import('./index.js');
    return mod.default as FeatureDefinition;
}

describe('C26 — example-feature-plugin POST /settings requires admin', () => {
    let feature: FeatureDefinition;

    beforeEach(async () => {
        feature = await loadFeature();
    });

    it('a non-admin user gets 404 and the config is unchanged', async () => {
        const postRes = await dispatchFeatureRequest(
            {
                featureId: feature.id,
                rest: 'settings',
                method: 'POST',
                request: new Request('http://x/settings', {
                    method: 'POST',
                    body: JSON.stringify({ maxItems: 3 }),
                }),
                user: userWith(false),
            },
            deps(feature),
        );
        expect(postRes.status).toBe(404);

        const getRes = await dispatchFeatureRequest(
            {
                featureId: feature.id,
                rest: 'items',
                method: 'GET',
                request: new Request('http://x/items'),
                user: userWith(false),
            },
            deps(feature),
        );
        expect(getRes.status).toBe(200);
        const items = (await getRes.json()) as unknown[];
        // Default maxItems is 10 — the rejected POST must not have applied.
        expect(items).toHaveLength(10);
    });

    it('an admin user gets 200 and the change applies', async () => {
        const postRes = await dispatchFeatureRequest(
            {
                featureId: feature.id,
                rest: 'settings',
                method: 'POST',
                request: new Request('http://x/settings', {
                    method: 'POST',
                    body: JSON.stringify({ maxItems: 3 }),
                }),
                user: userWith(true),
            },
            deps(feature),
        );
        expect(postRes.status).toBe(200);
        expect(await postRes.json()).toMatchObject({ success: true });

        const getRes = await dispatchFeatureRequest(
            {
                featureId: feature.id,
                rest: 'items',
                method: 'GET',
                request: new Request('http://x/items'),
                user: userWith(true),
            },
            deps(feature),
        );
        expect(getRes.status).toBe(200);
        const items = (await getRes.json()) as unknown[];
        expect(items).toHaveLength(3);
    });
});
