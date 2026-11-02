// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — the repository index format.
 *
 * Everything a repository says is advisory and re-verified at install, so these
 * tests are about the consumer refusing to be confused: malformed documents
 * fail closed, and version selection never offers something that cannot install.
 */

import { describe, it, expect } from 'vitest';
import {
    PluginRepositoryIndexSchema,
    pickInstallableVersion,
    compareVersions,
    type RepositoryPlugin,
} from './plugin-repository.js';

const version = (over: Partial<RepositoryPlugin['versions'][number]> = {}) => ({
    version: '1.0.0',
    manifestUrl: 'https://cdn.example.com/p/1.0.0/manifest.json',
    signature: 'sig',
    ...over,
});

const validIndex = {
    schemaVersion: 1,
    name: 'Example Repository',
    plugins: [{ name: 'trakt', versions: [version()] }],
};

describe('PluginRepositoryIndexSchema', () => {
    it('accepts a minimal valid index', () => {
        expect(PluginRepositoryIndexSchema.safeParse(validIndex).success).toBe(true);
    });

    it.each([
        ['an uppercase plugin name', { plugins: [{ name: 'Trakt', versions: [version()] }] }],
        ['a traversal plugin name', { plugins: [{ name: '../evil', versions: [version()] }] }],
        ['a plugin with no versions', { plugins: [{ name: 'trakt', versions: [] }] }],
        [
            'a file: manifest URL',
            {
                plugins: [
                    { name: 'trakt', versions: [version({ manifestUrl: 'file:///etc/passwd' })] },
                ],
            },
        ],
        [
            'a non-semver version',
            { plugins: [{ name: 'trakt', versions: [version({ version: '1.0' })] }] },
        ],
        ['a missing schemaVersion', { schemaVersion: undefined }],
    ])('rejects %s', (_label, bad) => {
        expect(PluginRepositoryIndexSchema.safeParse({ ...validIndex, ...bad }).success).toBe(
            false,
        );
    });

    it('does not throw on a malformed URL — it fails validation', () => {
        // Zod runs refinements even after `.url()` fails, so an unguarded
        // `new URL()` inside one escapes safeParse entirely. A repository is
        // attacker-influenced input; it must never be able to throw here.
        expect(() =>
            PluginRepositoryIndexSchema.safeParse({
                ...validIndex,
                plugins: [{ name: 'trakt', versions: [version({ manifestUrl: 'not-a-url' })] }],
            }),
        ).not.toThrow();
    });
});

describe('pickInstallableVersion', () => {
    const plugin = (versions: RepositoryPlugin['versions']): RepositoryPlugin => ({
        name: 'trakt',
        versions,
    });

    it('picks the newest version matching the host ABI', () => {
        const picked = pickInstallableVersion(
            plugin([
                version({ version: '1.0.0', sdkAbi: 1 }),
                version({ version: '1.2.0', sdkAbi: 1 }),
                version({ version: '1.1.0', sdkAbi: 1 }),
            ]),
            1,
        );
        expect(picked?.version).toBe('1.2.0');
    });

    it('skips a newer version built for a different ABI', () => {
        // An operator on an older host should be offered something that WILL
        // install, not the newest entry with a guaranteed ABI failure.
        const picked = pickInstallableVersion(
            plugin([
                version({ version: '2.0.0', sdkAbi: 2 }),
                version({ version: '1.5.0', sdkAbi: 1 }),
            ]),
            1,
        );
        expect(picked?.version).toBe('1.5.0');
    });

    it('treats an undeclared ABI as 1', () => {
        expect(pickInstallableVersion(plugin([version({ version: '1.0.0' })]), 1)?.version).toBe(
            '1.0.0',
        );
        expect(pickInstallableVersion(plugin([version({ version: '1.0.0' })]), 2)).toBeNull();
    });

    it('returns null when nothing is compatible', () => {
        expect(pickInstallableVersion(plugin([version({ sdkAbi: 9 })]), 1)).toBeNull();
    });
});

describe('compareVersions', () => {
    it('orders numerically, not lexically', () => {
        expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
        expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
        expect(compareVersions('0.9.0', '1.0.0')).toBeLessThan(0);
    });
});
