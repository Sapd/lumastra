// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — which installed plugins get offered an update.
 *
 * The rule that matters: an update must come from the same publisher. Without
 * it, any repository could advertise "updates" for plugins it does not publish
 * — notification spam that grooms an operator into force-installing a
 * stranger's build over a trusted one.
 */

import { describe, it, expect } from 'vitest';
import { findAvailableUpdates } from './plugin-repository.service.js';
import type { RepositoryVersion } from '$lib/schemas/plugin-repository.js';

const v = (version: string, over: Partial<RepositoryVersion> = {}): RepositoryVersion => ({
    version,
    manifestUrl: `https://cdn.example.com/p/${version}/manifest.json`,
    signature: 'sig',
    sdkAbi: 1,
    ...over,
});

const installed = (
    over: Partial<{ name: string; version: string; signingKeyId: string | null }> = {},
) => ({
    name: 'trakt',
    version: '1.0.0',
    signingKeyId: 'alice-2026',
    ...over,
});

describe('findAvailableUpdates', () => {
    it('offers a newer version from the same publisher', () => {
        const out = findAvailableUpdates(
            [installed()],
            [{ name: 'trakt', advisoryKeyId: 'alice-2026', versions: [v('1.1.0')] }],
            1,
        );
        expect(out).toHaveLength(1);
        expect(out[0].toVersion).toBe('1.1.0');
    });

    it('REFUSES an update advertised under a different key', () => {
        // The takeover invitation: a second repository advertising a higher
        // version of someone else's plugin.
        const out = findAvailableUpdates(
            [installed()],
            [{ name: 'trakt', advisoryKeyId: 'mallory-2026', versions: [v('99.0.0')] }],
            1,
        );
        expect(out).toEqual([]);
    });

    it('offers nothing for a plugin whose install predates key recording', () => {
        // NULL pins nothing, so there is nothing to match against — and
        // guessing is what this rule exists to prevent.
        const out = findAvailableUpdates(
            [installed({ signingKeyId: null })],
            [{ name: 'trakt', advisoryKeyId: 'alice-2026', versions: [v('1.1.0')] }],
            1,
        );
        expect(out).toEqual([]);
    });

    it('skips a newer version built for a different ABI', () => {
        const out = findAvailableUpdates(
            [installed()],
            [
                {
                    name: 'trakt',
                    advisoryKeyId: 'alice-2026',
                    versions: [v('2.0.0', { sdkAbi: 2 }), v('1.1.0')],
                },
            ],
            1,
        );
        expect(out[0].toVersion).toBe('1.1.0');
    });

    it('offers nothing when the catalog only has what is installed', () => {
        const out = findAvailableUpdates(
            [installed({ version: '1.1.0' })],
            [{ name: 'trakt', advisoryKeyId: 'alice-2026', versions: [v('1.1.0')] }],
            1,
        );
        expect(out).toEqual([]);
    });

    it('never offers a downgrade', () => {
        const out = findAvailableUpdates(
            [installed({ version: '2.0.0' })],
            [{ name: 'trakt', advisoryKeyId: 'alice-2026', versions: [v('1.0.0')] }],
            1,
        );
        expect(out).toEqual([]);
    });

    it('flags a security release so the UI can treat it differently', () => {
        const out = findAvailableUpdates(
            [installed()],
            [
                {
                    name: 'trakt',
                    advisoryKeyId: 'alice-2026',
                    versions: [v('1.1.0', { security: true })],
                },
            ],
            1,
        );
        expect(out[0].security).toBe(true);
    });
});
