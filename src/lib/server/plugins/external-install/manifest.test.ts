// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// manifest.test.ts
import { describe, it, expect } from 'vitest';
import {
    ExternalPluginManifestSchema,
    compareSemver,
    isSafeRelativePath,
    manifestSdkAbi,
    capabilitySubsetViolation,
} from './manifest.js';
import { PLUGIN_SDK_ABI } from '@sapd/lumastra-plugin-sdk';

const valid = {
    name: 'sample-plugin',
    version: '1.2.0',
    kind: 'task',
    bundleUrl: 'https://cdn.example.com/sample/1.2.0/index.js',
    checksum: 'a'.repeat(64),
};

describe('ExternalPluginManifestSchema', () => {
    it('accepts a valid manifest', () => {
        expect(ExternalPluginManifestSchema.safeParse(valid).success).toBe(true);
    });
    it.each([
        ['Uppercase name', { ...valid, name: 'Sample' }],
        ['dot-dot name', { ...valid, name: '../evil' }],
        ['unicode name', { ...valid, name: 'sämple' }],
        ['non-semver version', { ...valid, version: '1.2' }],
        ['prerelease version', { ...valid, version: '1.2.0-rc1' }],
        ['non-hex checksum', { ...valid, checksum: 'zz' + 'a'.repeat(62) }],
        ['file: bundleUrl', { ...valid, bundleUrl: 'file:///etc/passwd' }],
        ['ftp: bundleUrl', { ...valid, bundleUrl: 'ftp://host/x' }],
        ['bad kind', { ...valid, kind: 'wormhole' }],
    ])('rejects %s', (_label, bad) => {
        expect(ExternalPluginManifestSchema.safeParse(bad).success).toBe(false);
    });
});

describe('ExternalPluginManifestSchema multi-contract kinds', () => {
    const { kind: _dropped, ...noKind } = valid;

    it('accepts a kinds list in place of kind', () => {
        const parsed = ExternalPluginManifestSchema.safeParse({
            ...noKind,
            kinds: ['watch-sync', 'task'],
        });
        expect(parsed.success).toBe(true);
    });

    it('rejects a manifest declaring both kind and kinds', () => {
        expect(ExternalPluginManifestSchema.safeParse({ ...valid, kinds: ['task'] }).success).toBe(
            false,
        );
    });

    it('rejects a manifest declaring neither kind nor kinds', () => {
        expect(ExternalPluginManifestSchema.safeParse(noKind).success).toBe(false);
    });

    it('rejects an empty kinds list', () => {
        expect(ExternalPluginManifestSchema.safeParse({ ...noKind, kinds: [] }).success).toBe(
            false,
        );
    });

    it('rejects a duplicate entry in kinds', () => {
        expect(
            ExternalPluginManifestSchema.safeParse({ ...noKind, kinds: ['task', 'task'] }).success,
        ).toBe(false);
    });

    it('rejects an unknown kind inside kinds', () => {
        expect(
            ExternalPluginManifestSchema.safeParse({ ...noKind, kinds: ['task', 'wormhole'] })
                .success,
        ).toBe(false);
    });
});

describe('ExternalPluginManifestSchema sdkAbi', () => {
    it('accepts a manifest declaring the current ABI', () => {
        expect(
            ExternalPluginManifestSchema.safeParse({ ...valid, sdkAbi: PLUGIN_SDK_ABI }).success,
        ).toBe(true);
    });

    it.each([
        ['zero', 0],
        ['negative', -1],
        ['fractional', 1.5],
        ['a string', '1'],
    ])('rejects %s sdkAbi', (_label, sdkAbi) => {
        expect(ExternalPluginManifestSchema.safeParse({ ...valid, sdkAbi }).success).toBe(false);
    });

    it('treats an absent sdkAbi as ABI 1', () => {
        // Manifests signed before the field existed carry no sdkAbi and were
        // authored against ABI 1. They must keep installing on an ABI-1 host —
        // and must start failing the moment the host moves past it.
        const parsed = ExternalPluginManifestSchema.parse(valid);
        expect(manifestSdkAbi(parsed)).toBe(1);
    });

    it('reports the declared sdkAbi when present', () => {
        const parsed = ExternalPluginManifestSchema.parse({ ...valid, sdkAbi: 3 });
        expect(manifestSdkAbi(parsed)).toBe(3);
    });
});

describe('ExternalPluginManifestSchema catalog metadata', () => {
    it('accepts the signed metadata fields', () => {
        const parsed = ExternalPluginManifestSchema.safeParse({
            ...valid,
            publisher: 'Trakt Team',
            description: 'Two-way watch-state sync with trakt.tv',
            license: 'MIT',
            sourceUrl: 'https://github.com/example/trakt-plugin',
            capabilities: { http: true, database: true, allowedDomains: ['api.trakt.tv'] },
            minAppVersion: '1.4.0',
            releasedAt: '2026-08-26T00:00:00.000Z',
        });
        expect(parsed.success).toBe(true);
    });

    it('still accepts a manifest carrying none of them', () => {
        expect(ExternalPluginManifestSchema.safeParse(valid).success).toBe(true);
    });

    it.each([
        ['a non-URL sourceUrl', { sourceUrl: 'not-a-url' }],
        ['a file: sourceUrl', { sourceUrl: 'file:///etc/passwd' }],
        ['a non-semver minAppVersion', { minAppVersion: '1.4' }],
        ['a non-datetime releasedAt', { releasedAt: 'yesterday' }],
        ['an over-long description', { description: 'x'.repeat(501) }],
    ])('rejects %s', (_label, bad) => {
        expect(ExternalPluginManifestSchema.safeParse({ ...valid, ...bad }).success).toBe(false);
    });

    it('STRIPS unknown fields rather than rejecting them', () => {
        // Forward compatibility, and it is load-bearing: a manifest signed with
        // metadata a future host understands must still install on THIS host.
        // The signature covers the raw bytes and is verified before parsing, so
        // stripping is safe — but someone "hardening" this schema with
        // .strict() would silently break every newer manifest. Hence the pin.
        const parsed = ExternalPluginManifestSchema.safeParse({
            ...valid,
            somethingFromTheFuture: { nested: true },
        });
        expect(parsed.success).toBe(true);
        expect(parsed.success && 'somethingFromTheFuture' in parsed.data).toBe(false);
    });
});

describe('capabilitySubsetViolation', () => {
    it('accepts a plugin that uses no more than it declared', () => {
        expect(
            capabilitySubsetViolation({ http: true, database: true }, { http: true }),
        ).toBeNull();
    });

    it('accepts when the manifest declared nothing (back-compat)', () => {
        expect(capabilitySubsetViolation(undefined, { http: true })).toBeNull();
    });

    it('REFUSES a boolean capability the manifest never declared', () => {
        // The install-confirm dialog is the trust decision, and it can only
        // show what was SIGNED. A bundle that declares "http only" and then
        // registers database access made that dialog a lie.
        const msg = capabilitySubsetViolation({ http: true }, { http: true, database: true });
        expect(msg).toContain('database');
    });

    it('REFUSES an outbound domain the manifest never declared', () => {
        const msg = capabilitySubsetViolation(
            { http: true, allowedDomains: ['api.trakt.tv'] },
            { http: true, allowedDomains: ['api.trakt.tv', 'evil.example'] },
        );
        expect(msg).toContain('evil.example');
    });

    it('treats an absent declared domain list as declaring none', () => {
        expect(
            capabilitySubsetViolation({ http: true }, { http: true, allowedDomains: ['x.test'] }),
        ).not.toBeNull();
    });
});

describe('compareSemver', () => {
    it('orders correctly', () => {
        expect(compareSemver('1.0.0', '0.9.0')).toBeGreaterThan(0);
        expect(compareSemver('0.9.0', '1.0.0')).toBeLessThan(0);
        expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
        expect(compareSemver('1.2.10', '1.2.9')).toBeGreaterThan(0);
    });
    it('throws on non-strict input', () => {
        expect(() => compareSemver('1.2', '1.0.0')).toThrow();
    });
});

describe('isSafeRelativePath', () => {
    it('accepts plain relative POSIX paths', () => {
        expect(isSafeRelativePath('index.js')).toBe(true);
        expect(isSafeRelativePath('lib/util.js')).toBe(true);
        expect(isSafeRelativePath('a/b/c.mjs')).toBe(true);
    });
    it('rejects traversal, absolute, dot and empty segments', () => {
        expect(isSafeRelativePath('../evil')).toBe(false);
        expect(isSafeRelativePath('a/../../b')).toBe(false);
        expect(isSafeRelativePath('/etc/passwd')).toBe(false);
        expect(isSafeRelativePath('a/./b')).toBe(false);
        expect(isSafeRelativePath('a//b')).toBe(false);
        expect(isSafeRelativePath('dir/')).toBe(false); // trailing-slash → empty last seg
        expect(isSafeRelativePath('')).toBe(false);
    });
    it('rejects windows drive + backslash', () => {
        expect(isSafeRelativePath('C:/x')).toBe(false);
        expect(isSafeRelativePath('a\\b')).toBe(false);
    });
    it('rejects control bytes (NUL, newline, CR, DEL)', () => {
        expect(isSafeRelativePath('a\x00b')).toBe(false);
        expect(isSafeRelativePath('a\nb')).toBe(false);
        expect(isSafeRelativePath('a\rb')).toBe(false);
        expect(isSafeRelativePath('a\x7fb')).toBe(false);
    });
    it('rejects over-length (>256)', () => {
        expect(isSafeRelativePath('a'.repeat(257))).toBe(false);
        expect(isSafeRelativePath('a'.repeat(256))).toBe(true);
    });
});

describe('ExternalPluginManifestSchema bundle fields', () => {
    const base = {
        name: 'sample-plugin',
        version: '1.0.0',
        kind: 'task' as const,
        bundleUrl: 'https://example.com/b',
        checksum: 'a'.repeat(64),
    };
    it("format:'bundle' requires entry", () => {
        expect(ExternalPluginManifestSchema.safeParse({ ...base, format: 'bundle' }).success).toBe(
            false,
        );
        expect(
            ExternalPluginManifestSchema.safeParse({ ...base, format: 'bundle', entry: 'index.js' })
                .success,
        ).toBe(true);
    });
    it('entry without bundle is rejected', () => {
        expect(ExternalPluginManifestSchema.safeParse({ ...base, entry: 'index.js' }).success).toBe(
            false,
        );
        expect(
            ExternalPluginManifestSchema.safeParse({ ...base, format: 'single', entry: 'index.js' })
                .success,
        ).toBe(false);
    });
    it('bundle entry must be a safe relative path', () => {
        expect(
            ExternalPluginManifestSchema.safeParse({ ...base, format: 'bundle', entry: '../x' })
                .success,
        ).toBe(false);
    });
    it('absent format still parses (back-compat single)', () => {
        expect(ExternalPluginManifestSchema.safeParse(base).success).toBe(true);
    });
});
