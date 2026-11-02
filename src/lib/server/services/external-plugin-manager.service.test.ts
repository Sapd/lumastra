// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExternalPluginRow } from '$lib/server/database/queries/external-plugins.queries.js';

const listMock = vi.fn<() => Promise<ExternalPluginRow[]>>();
const hasRegisteredMock = vi.fn<(id: string) => boolean>();
const getTaskMock = vi.fn<(id: string) => unknown>();
const buildEffectiveMock = vi.fn();
const getRowMock = vi.fn<(sql: unknown, id: string) => Promise<ExternalPluginRow | null>>();
const setEnabledMock = vi.fn();
const markUninstalledMock = vi.fn();

vi.mock('$lib/server/database/queries/external-plugins.queries.js', () => ({
    listExternalPluginsIncludingPendingRemoval: () => listMock(),
    getExternalPlugin: (sql: unknown, id: string) => getRowMock(sql, id),
    setExternalPluginEnabled: (...a: unknown[]) => setEnabledMock(...a),
    markExternalPluginUninstalled: (...a: unknown[]) => markUninstalledMock(...a),
}));
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        hasPluginRegistered: (id: string) => hasRegisteredMock(id),
        getTask: (id: string) => getTaskMock(id),
        getProvider: () => undefined,
        getTrickplay: () => undefined,
        getWatchSync: () => undefined,
        getFeature: () => undefined,
        getIntegration: () => undefined,
        getExternalService: () => undefined,
        getMediaSource: () => undefined,
        // Every family the badge can name. An incomplete mock here is what let
        // the three newest contracts ship with a blank kind.
        getSubtitleProvider: () => undefined,
        getLyricsProvider: () => undefined,
        getAuthProvider: () => undefined,
    },
    ID_PATTERN: /^[a-z][a-z0-9-]*$/,
}));
vi.mock('$lib/server/plugins/runtime/loader.js', () => ({
    listDropInPlugins: async () => [],
    lastLoadError: { get: () => undefined },
    externalPluginsDir: () => '/tmp/plugins',
    loadAndWirePlugin: vi.fn(),
}));
vi.mock('$lib/server/plugins/external-install/trust-anchors.js', () => ({
    buildEffectiveTrustedKeys: () => buildEffectiveMock(),
    classifyKeyId: (keyId: string | null, eff: Array<{ keyId: string; source: string }>) =>
        !keyId ? 'unknown' : (eff.find((k) => k.keyId === keyId)?.source ?? 'unknown'),
}));
const mockAuditLog = vi.fn();
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: (...a: unknown[]) => mockAuditLog(...a),
}));
// Override ONLY the default export's fs methods the manager uses; keep every named
// export real so the transitively-loaded config/master-key chain (named existsSync)
// still resolves.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const existsSync = vi.fn(() => true);
    const rmSync = vi.fn();
    // Provide overrides on BOTH the namespace and the default export (the manager
    // uses `import fs from 'node:fs'`), keeping every other named export real so
    // the transitively-loaded config/master-key chain still resolves.
    return { ...actual, existsSync, rmSync, default: { ...actual, existsSync, rmSync } };
});

import {
    listExternalPluginsWithState,
    enableExternalPlugin,
    disableExternalPlugin,
    reloadExternalPlugin,
    uninstallExternalPlugin,
} from './external-plugin-manager.service.js';
// Real sentinel — bundle-artifact.js is intentionally NOT mocked so the real
// isInvalidBundle runs and the fail-closed surfacing is exercised end-to-end.
import { INVALID_BUNDLE } from '$lib/server/plugins/external-install/bundle-artifact.js';

const row = (over: Partial<ExternalPluginRow>): ExternalPluginRow => ({
    name: 'p',
    version: '1.0.0',
    checksum: 'c',
    sourceManifestUrl: 'https://x/m',
    signature: 's',
    capabilities: null,
    enabled: true,
    status: 'installed',
    installedBy: null,
    installedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    sdkAbi: null,
    manifestMetadata: null,
    bundle: null,
    signingKeyId: null,
    ...over,
});
const sql = {} as never;

// A PAT-attributed actor — distinct from a bare username so an assertion on
// the object reaching auditLog() can't accidentally pass by string-matching.
const ACTOR = { username: 'admin', kind: 'pat' as const, credentialId: 'pat-7' };

beforeEach(() => {
    vi.clearAllMocks();
    buildEffectiveMock.mockReturnValue([]);
    hasRegisteredMock.mockReturnValue(false);
    getTaskMock.mockReturnValue(undefined);
});

describe('restartRequired truth table', () => {
    it.each([
        [true, true, false],
        [true, false, true],
        [false, true, true],
        [false, false, false],
    ])('enabled=%s loaded=%s → restartRequired=%s', async (enabled, loaded, expected) => {
        // status must be 'installed' for the enabled=false/loaded=false row to survive the filter
        listMock.mockResolvedValue([row({ name: 'a', enabled, status: 'installed' })]);
        hasRegisteredMock.mockReturnValue(loaded);
        const res = await listExternalPluginsWithState(sql);
        expect(res.items).toHaveLength(1);
        expect(res.items[0].restartRequired).toBe(expected);
    });
});

describe('uninstalled-row filter', () => {
    it('keeps uninstalled+loaded (pending-restart card), drops uninstalled+not-loaded, always keeps installed', async () => {
        listMock.mockResolvedValue([
            row({ name: 'still-loaded', status: 'uninstalled', enabled: false }),
            row({ name: 'gone', status: 'uninstalled', enabled: false }),
            row({ name: 'normal', status: 'installed', enabled: true }),
        ]);
        hasRegisteredMock.mockImplementation((id) => id === 'still-loaded');
        const res = await listExternalPluginsWithState(sql);
        const ids = res.items.map((i) => i.id);
        expect(ids).toContain('still-loaded');
        expect(ids).toContain('normal');
        expect(ids).not.toContain('gone');
        const pending = res.items.find((i) => i.id === 'still-loaded')!;
        expect(pending.status).toBe('uninstalled');
        expect(pending.loaded).toBe(true);
        expect(pending.restartRequired).toBe(true);
    });
});

describe('signingKeySource classification', () => {
    it('official / operator / unknown', async () => {
        buildEffectiveMock.mockReturnValue([
            { keyId: 'o1', source: 'official' },
            { keyId: 'op1', source: 'operator' },
        ]);
        listMock.mockResolvedValue([
            row({ name: 'a', signingKeyId: 'o1' }),
            row({ name: 'b', signingKeyId: 'op1' }),
            row({ name: 'c', signingKeyId: 'rotated-out' }),
            row({ name: 'd', signingKeyId: null }),
        ]);
        const res = await listExternalPluginsWithState(sql);
        const by = Object.fromEntries(res.items.map((i) => [i.id, i]));
        expect(by.a.signingKeySource).toBe('official');
        expect(by.b.signingKeySource).toBe('operator');
        expect(by.c.signingKeySource).toBe('unknown');
        expect(by.d.signingKeySource).toBe('unknown');
        expect(by.d.signingKeyId).toBeUndefined(); // never literal null
    });
});

describe('capabilities passthrough', () => {
    it('preserves a valid object and coerces garbage to undefined without throwing', async () => {
        listMock.mockResolvedValue([
            row({ name: 'a', capabilities: { allowedDomains: ['x'], database: true } }),
            row({ name: 'b', capabilities: 'not-an-object' as unknown as Record<string, unknown> }),
        ]);
        const res = await listExternalPluginsWithState(sql);
        const by = Object.fromEntries(res.items.map((i) => [i.id, i]));
        expect(by.a.capabilities).toEqual({ allowedDomains: ['x'], database: true });
        expect(by.b.capabilities).toBeUndefined();
    });
});

describe('bundle classification (fail-closed surfacing)', () => {
    it('valid bundle → isBundle:true, bundleInvalid:false', async () => {
        listMock.mockResolvedValue([
            row({
                name: 'a',
                bundle: {
                    entry: 'index.js',
                    treeDigest: 'a'.repeat(64),
                    files: [{ path: 'index.js', sha256: 'b'.repeat(64), size: 10 }],
                },
            }),
        ]);
        const res = await listExternalPluginsWithState(sql);
        expect(res.items[0].isBundle).toBe(true);
        expect(res.items[0].bundleInvalid).toBe(false);
    });
    it('null bundle (single-index.js plugin) → isBundle:false, bundleInvalid:false', async () => {
        listMock.mockResolvedValue([row({ name: 'a', bundle: null })]);
        const res = await listExternalPluginsWithState(sql);
        expect(res.items[0].isBundle).toBe(false);
        expect(res.items[0].bundleInvalid).toBe(false);
    });
    it('INVALID_BUNDLE sentinel (corrupt jsonb) → fail-closed isBundle:false, bundleInvalid:true (spec §8)', async () => {
        listMock.mockResolvedValue([row({ name: 'a', bundle: INVALID_BUNDLE })]);
        const res = await listExternalPluginsWithState(sql);
        expect(res.items[0].isBundle).toBe(false);
        expect(res.items[0].bundleInvalid).toBe(true);
    });
});

describe('effective trusted set built ONCE', () => {
    it('calls buildEffectiveTrustedKeys exactly once for an N-row list', async () => {
        listMock.mockResolvedValue([row({ name: 'a' }), row({ name: 'b' }), row({ name: 'c' })]);
        buildEffectiveMock.mockReturnValue([{ keyId: 'o1', source: 'official' }]);
        const res = await listExternalPluginsWithState(sql);
        expect(buildEffectiveMock).toHaveBeenCalledTimes(1);
        expect(res.trustedKeysConfigured).toBe(true);
    });
    it('trustedKeysConfigured is false when the effective set is empty', async () => {
        listMock.mockResolvedValue([row({ name: 'a' })]);
        buildEffectiveMock.mockReturnValue([]);
        const res = await listExternalPluginsWithState(sql);
        expect(res.trustedKeysConfigured).toBe(false);
    });
});

describe('kind derivation', () => {
    it("derives 'task' from getTask when loaded, undefined when not", async () => {
        listMock.mockResolvedValue([row({ name: 'a' })]);
        hasRegisteredMock.mockReturnValue(true);
        getTaskMock.mockImplementation((id) => (id === 'a' ? { id: 'a' } : undefined));
        const res = await listExternalPluginsWithState(sql);
        expect(res.items[0].kind).toBe('task');

        vi.clearAllMocks();
        buildEffectiveMock.mockReturnValue([]);
        getTaskMock.mockReturnValue(undefined);
        hasRegisteredMock.mockReturnValue(false);
        listMock.mockResolvedValue([row({ name: 'a' })]);
        const res2 = await listExternalPluginsWithState(sql);
        expect(res2.items[0].kind).toBeUndefined();
    });
});

describe('lifecycle wrappers (v1 parity)', () => {
    it('rejects a bad id with 404 before any lookup', async () => {
        const r = await enableExternalPlugin(sql, '../etc', null);
        expect(r.status).toBe(404);
        expect(getRowMock).not.toHaveBeenCalled();
    });
    it('404s an unknown row', async () => {
        getRowMock.mockResolvedValue(null);
        expect((await disableExternalPlugin(sql, 'ghost', null)).status).toBe(404);
    });
    it('enable of an already-registered plugin is a no-op load (loaded:true, restartRequired:false)', async () => {
        getRowMock.mockResolvedValue(row({ name: 'a' }));
        hasRegisteredMock.mockReturnValue(true);
        const r = await enableExternalPlugin(sql, 'a', ACTOR);
        expect(r).toEqual({
            status: 200,
            body: { id: 'a', enabled: true, loaded: true, restartRequired: false },
        });
    });
    it('disable always returns enabled:false, restartRequired:true', async () => {
        getRowMock.mockResolvedValue(row({ name: 'a' }));
        const r = await disableExternalPlugin(sql, 'a', ACTOR);
        expect(r).toEqual({
            status: 200,
            body: { id: 'a', enabled: false, restartRequired: true },
        });
    });
    it('reload of a registered plugin is an honest no-op (reloaded:false, restartRequired:true, no version)', async () => {
        getRowMock.mockResolvedValue(row({ name: 'a', version: '2.0.0' }));
        hasRegisteredMock.mockReturnValue(true);
        const r = await reloadExternalPlugin(sql, 'a', ACTOR);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ id: 'a', reloaded: false, restartRequired: true });
        expect((r.body as { version?: string }).version).toBeUndefined();
    });
    it('uninstall returns uninstalled:true, restartRequired:true on the happy path', async () => {
        getRowMock.mockResolvedValue(row({ name: 'a' }));
        const r = await uninstallExternalPlugin(sql, 'a', ACTOR);
        expect(r).toEqual({
            status: 200,
            body: { id: 'a', uninstalled: true, restartRequired: true },
        });
    });
});

describe('lifecycle wrappers — audit actor attribution (R5)', () => {
    // Each lifecycle wrapper must forward the FULL actor object (kind +
    // credentialId) to auditLog(), not just a bare username string — a
    // partial migration (accepting the object but only reading `.username`)
    // would compile fine and silently leave `principalKind`/`credentialId`
    // NULL on the audit row, which is exactly the R5 attribution gap.
    it('enable audits the full actor object', async () => {
        getRowMock.mockResolvedValue(row({ name: 'a' }));
        hasRegisteredMock.mockReturnValue(true);
        await enableExternalPlugin(sql, 'a', ACTOR);
        expect(mockAuditLog).toHaveBeenCalledWith('plugin.external.enable', 'a', ACTOR);
    });
    it('disable audits the full actor object', async () => {
        getRowMock.mockResolvedValue(row({ name: 'a' }));
        await disableExternalPlugin(sql, 'a', ACTOR);
        expect(mockAuditLog).toHaveBeenCalledWith('plugin.external.disable', 'a', ACTOR);
    });
    it('reload audits the full actor object', async () => {
        getRowMock.mockResolvedValue(row({ name: 'a', version: '2.0.0' }));
        hasRegisteredMock.mockReturnValue(true);
        await reloadExternalPlugin(sql, 'a', ACTOR);
        expect(mockAuditLog).toHaveBeenCalledWith('plugin.external.reload', 'a', ACTOR, {
            reloaded: false,
        });
    });
    it('uninstall audits the full actor object', async () => {
        getRowMock.mockResolvedValue(row({ name: 'a' }));
        await uninstallExternalPlugin(sql, 'a', ACTOR);
        expect(mockAuditLog).toHaveBeenCalledWith('plugin.external.uninstall', 'a', ACTOR);
    });
    it('a null actor (no request in flight) still passes through untyped', async () => {
        getRowMock.mockResolvedValue(row({ name: 'a' }));
        await disableExternalPlugin(sql, 'a', null);
        expect(mockAuditLog).toHaveBeenCalledWith('plugin.external.disable', 'a', null);
    });
});

describe('a managed plugin whose files are GONE', () => {
    // The default PLUGINS_EXTERNAL_DIR (/app/plugins) sits in the container's
    // image layer, not on a volume. A routine image update therefore deletes
    // every installed plugin while its registry row survives in Postgres — and
    // the loader never notices, because it discovers by listing directories and
    // a directory that is not there is simply not discovered (errors: 0).
    //
    // The operator was left with "installed, enabled, not loaded, no error",
    // which is indistinguishable from a pending restart. Say what happened.
    it('reports an explicit error naming the missing directory', async () => {
        const fs = await import('node:fs');
        vi.mocked(fs.existsSync).mockReturnValue(false);
        listMock.mockResolvedValue([row({ name: 'ghost', enabled: true, status: 'installed' })]);
        hasRegisteredMock.mockReturnValue(false);

        const res = await listExternalPluginsWithState(sql);

        expect(res.items).toHaveLength(1);
        expect(res.items[0].error).toMatch(/missing|not found|gone/i);
        expect(res.items[0].error).toContain('/tmp/plugins/ghost');
    });

    it('stays silent when the directory is present (no false alarm on a normal restart)', async () => {
        const fs = await import('node:fs');
        vi.mocked(fs.existsSync).mockReturnValue(true);
        listMock.mockResolvedValue([row({ name: 'fine', enabled: true, status: 'installed' })]);
        hasRegisteredMock.mockReturnValue(false);

        const res = await listExternalPluginsWithState(sql);

        expect(res.items[0].error).toBeUndefined();
        expect(res.items[0].restartRequired).toBe(true);
    });

    it('does not stat a plugin that IS loaded', async () => {
        const fs = await import('node:fs');
        vi.mocked(fs.existsSync).mockClear();
        vi.mocked(fs.existsSync).mockReturnValue(true);
        listMock.mockResolvedValue([row({ name: 'live', enabled: true, status: 'installed' })]);
        hasRegisteredMock.mockReturnValue(true);

        const res = await listExternalPluginsWithState(sql);

        expect(res.items[0].error).toBeUndefined();
        expect(vi.mocked(fs.existsSync)).not.toHaveBeenCalled();
    });
});

describe('enableExternalPlugin honours the signed bundle entry', () => {
    // The gate hardcoded index.js. A bundle's entry is whatever the SIGNED
    // manifest declared — `main.js`, `dist/index.js` — so such a plugin never
    // attempted the hot-load and always reported "restart required", even when
    // enabling would have worked. The single-file convention was being applied
    // to the bundle path, where it does not hold.
    it('probes the bundle entry, not index.js', async () => {
        const fs = await import('node:fs');
        const seen: string[] = [];
        vi.mocked(fs.existsSync).mockImplementation((p) => {
            seen.push(String(p));
            return true;
        });
        getRowMock.mockResolvedValue(
            row({
                name: 'b',
                enabled: false,
                status: 'installed',
                bundle: {
                    entry: 'dist/main.js',
                    treeDigest: 'a'.repeat(64),
                    files: [{ path: 'dist/main.js', sha256: 'b'.repeat(64), size: 1 }],
                },
            }),
        );
        hasRegisteredMock.mockReturnValue(false);
        const loader = await import('$lib/server/plugins/runtime/loader.js');
        vi.mocked(loader.loadAndWirePlugin).mockResolvedValue({ loaded: true } as never);

        await enableExternalPlugin(sql, 'b', ACTOR);

        expect(seen.some((p) => p.endsWith('dist/main.js'))).toBe(true);
        expect(seen.some((p) => p.endsWith('/b/index.js'))).toBe(false);
    });
});
