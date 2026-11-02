// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
    ExternalPluginCapabilitiesSchema,
    ExternalPluginListItemSchema,
    ExternalPluginInstallResultSchema,
    ExternalPluginReloadResultSchema,
    ExternalPluginUninstallResultSchema,
} from './api-external-plugins.js';

describe('ExternalPluginCapabilitiesSchema', () => {
    it('accepts known keys and passes through unknown keys', () => {
        const r = ExternalPluginCapabilitiesSchema.safeParse({
            allowedDomains: ['api.example.com'],
            database: true,
            somethingNew: 42,
        });
        expect(r.success).toBe(true);
    });
    it('accepts an empty object', () => {
        expect(ExternalPluginCapabilitiesSchema.safeParse({}).success).toBe(true);
    });
});

describe('ExternalPluginListItemSchema', () => {
    const base = {
        id: 'sample-plugin',
        name: 'sample-plugin',
        version: '1.0.0',
        enabled: true,
        status: 'installed' as const,
        loaded: true,
        restartRequired: false,
        isBundle: false,
        bundleInvalid: false,
        installedAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
    };
    it('accepts a minimal item (optional fields omitted)', () => {
        expect(ExternalPluginListItemSchema.safeParse(base).success).toBe(true);
    });
    it('accepts the fully-populated item', () => {
        expect(
            ExternalPluginListItemSchema.safeParse({
                ...base,
                kind: 'task',
                error: 'boom',
                capabilities: { database: true },
                signingKeyId: 'k1',
                signingKeySource: 'official',
            }).success,
        ).toBe(true);
    });
    it('rejects a bad status enum and a bad source enum', () => {
        expect(ExternalPluginListItemSchema.safeParse({ ...base, status: 'nope' }).success).toBe(
            false,
        );
        expect(
            ExternalPluginListItemSchema.safeParse({ ...base, signingKeySource: 'nope' }).success,
        ).toBe(false);
    });
    it('never requires signingKeyId (nullable rows emit undefined)', () => {
        const { ...noKey } = base;
        expect(ExternalPluginListItemSchema.safeParse(noKey).success).toBe(true);
    });
});

describe('lifecycle result schemas', () => {
    it('reload accepts the no-op (no version) and the hot-load (version present)', () => {
        expect(
            ExternalPluginReloadResultSchema.safeParse({
                id: 'p',
                reloaded: false,
                restartRequired: true,
            }).success,
        ).toBe(true);
        expect(
            ExternalPluginReloadResultSchema.safeParse({
                id: 'p',
                reloaded: true,
                version: '1.2.3',
                restartRequired: false,
            }).success,
        ).toBe(true);
    });
    it('uninstall accepts the soft-500 warning variant', () => {
        expect(
            ExternalPluginUninstallResultSchema.safeParse({
                id: 'p',
                uninstalled: true,
                restartRequired: true,
                warning: 'dir removal failed',
            }).success,
        ).toBe(true);
    });
    it('install result accepts both a descriptor and an error body', () => {
        expect(
            ExternalPluginInstallResultSchema.safeParse({
                id: 'p',
                version: '1.0.0',
                restartRequired: false,
            }).success,
        ).toBe(true);
        expect(
            ExternalPluginInstallResultSchema.safeParse({ error: 'signature not trusted' }).success,
        ).toBe(true);
    });
});
