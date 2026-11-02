// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { runFeatureStartups } from './feature-startup.js';
import type { FeatureDefinition } from '@sapd/lumastra-plugin-sdk';

describe('runFeatureStartups', () => {
    it('calls onStartup for each feature that declares it, isolating failures', async () => {
        const calls: string[] = [];
        const features: FeatureDefinition[] = [
            {
                id: 'a',
                routes: [{ method: 'GET', path: '/x', handler: async () => new Response() }],
                onStartup: async () => {
                    calls.push('a');
                },
            },
            {
                id: 'b',
                routes: [{ method: 'GET', path: '/x', handler: async () => new Response() }],
            },
            {
                id: 'c',
                routes: [{ method: 'GET', path: '/x', handler: async () => new Response() }],
                onStartup: async () => {
                    throw new Error('boom');
                },
            },
        ];
        await runFeatureStartups(features, () => ({}) as never);
        expect(calls).toEqual(['a']); // b has none; c throws but doesn't abort
    });

    it('times out a hung onStartup and continues to later features', async () => {
        const prev = process.env.LUMASTRA_FEATURE_STARTUP_TIMEOUT_MS;
        process.env.LUMASTRA_FEATURE_STARTUP_TIMEOUT_MS = '20';
        try {
            const calls: string[] = [];
            const features: FeatureDefinition[] = [
                {
                    id: 'hang',
                    routes: [{ method: 'GET', path: '/x', handler: async () => new Response() }],
                    // never resolves
                    onStartup: () => new Promise<void>(() => {}),
                },
                {
                    id: 'after',
                    routes: [{ method: 'GET', path: '/x', handler: async () => new Response() }],
                    onStartup: async () => {
                        calls.push('after');
                    },
                },
            ];
            await runFeatureStartups(features, () => ({}) as never);
            expect(calls).toEqual(['after']); // hung plugin timed out, did not block 'after'
        } finally {
            if (prev === undefined) delete process.env.LUMASTRA_FEATURE_STARTUP_TIMEOUT_MS;
            else process.env.LUMASTRA_FEATURE_STARTUP_TIMEOUT_MS = prev;
        }
    });
});
