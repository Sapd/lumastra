// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `ctx.sql` capability gate, across every contract kind.
 *
 * The gate grants the real handle to an id it does not recognise, because
 * internal boot/admin/test contexts predate it. That default is only safe if
 * "recognise" covers ALL the kinds — a kind the lookup forgets is
 * indistinguishable from the framework's own callers, so a plugin that never
 * declared `database` gets a live handle while the admin UI tells the operator
 * it has no database access.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const defs = {
    task: new Map<string, unknown>(),
    provider: new Map<string, unknown>(),
    trickplay: new Map<string, unknown>(),
    watchSync: new Map<string, unknown>(),
    mediaSource: new Map<string, unknown>(),
    feature: new Map<string, unknown>(),
    integration: new Map<string, unknown>(),
    subtitle: new Map<string, unknown>(),
    lyrics: new Map<string, unknown>(),
    auth: new Map<string, unknown>(),
    externalService: new Map<string, unknown>(),
};

vi.mock('./registry.js', () => ({
    registry: {
        getTask: (id: string) => defs.task.get(id),
        getProvider: (id: string) => defs.provider.get(id),
        getTrickplay: (id: string) => defs.trickplay.get(id),
        getWatchSync: (id: string) => defs.watchSync.get(id),
        getMediaSource: (id: string) => defs.mediaSource.get(id),
        getFeature: (id: string) => defs.feature.get(id),
        getIntegration: (id: string) => defs.integration.get(id),
        getSubtitleProvider: (id: string) => defs.subtitle.get(id),
        getLyricsProvider: (id: string) => defs.lyrics.get(id),
        getAuthProvider: (id: string) => defs.auth.get(id),
        getExternalService: (id: string) => defs.externalService.get(id),
    },
}));

import { buildPluginContext } from './plugin-context.js';

beforeEach(() => {
    for (const m of Object.values(defs)) m.clear();
});

const KINDS = [
    'feature',
    'integration',
    'subtitle',
    'lyrics',
    'auth',
    'externalService',
    'task',
    'provider',
    'trickplay',
    'watchSync',
    'mediaSource',
] as const;

describe.each(KINDS)('a registered %s', (kind) => {
    it('is REFUSED ctx.sql when it never declared the database capability', async () => {
        defs[kind].set('p1', { id: 'p1', capabilities: {} });
        const ctx = buildPluginContext('p1');
        await expect(async () => {
            await (ctx.sql as unknown as (s: TemplateStringsArray) => Promise<unknown>)`SELECT 1`;
        }).rejects.toThrow(/add `database: true`/);
    });

    it('is granted ctx.sql when it declares it', async () => {
        defs[kind].set('p1', { id: 'p1', capabilities: { database: true } });
        const ctx = buildPluginContext('p1');
        // The stub is what throws; a granted handle either works or fails for a
        // different reason (no pool in a unit test), never with this message.
        await expect(async () => {
            await (ctx.sql as unknown as (s: TemplateStringsArray) => Promise<unknown>)`SELECT 1`;
        }).rejects.not.toThrow(/add `database: true`/);
    });
});

it('still grants an UNREGISTERED id — internal boot and admin callers predate the gate', async () => {
    const ctx = buildPluginContext('not-a-plugin');
    await expect(async () => {
        await (ctx.sql as unknown as (s: TemplateStringsArray) => Promise<unknown>)`SELECT 1`;
    }).rejects.not.toThrow(/add `database: true`/);
});
