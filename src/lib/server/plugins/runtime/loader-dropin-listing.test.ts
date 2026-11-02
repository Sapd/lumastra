// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `listDropInPlugins` against real directories.
 *
 * The service-level tests mock this function, so the filesystem behaviour it
 * actually depends on was unverified — and the shape production runs is the
 * bare one: a directory containing only `index.js`, with no package.json at
 * all. If that shape were skipped, the admin list would still show nothing on
 * the box this feature exists for.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let baseDir = '';
let bundledDir = '';
let requireRegistry = false;
const { logInfo, logWarn } = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
// Spread the real config so the loader's other module-eval reads (queue flags
// and friends) still resolve; only the one flag under test is overridden.
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = (await importOriginal()) as { config: Record<string, unknown> };
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get: (target, prop) =>
                prop === 'PLUGINS_REQUIRE_REGISTRY'
                    ? requireRegistry
                    : (target as Record<string | symbol, unknown>)[prop],
        }),
    };
});

let rowNames = new Set<string>();
vi.mock('../../database/queries/external-plugins.queries.js', () => ({
    getExternalPlugin: vi.fn(async (_sql: unknown, name: string) =>
        rowNames.has(name) ? { name } : null,
    ),
}));

vi.mock('../../utils/logger.js', () => ({
    Logger: { for: () => ({ info: logInfo, debug: vi.fn(), warn: logWarn, error: vi.fn() }) },
}));

import { discoverExternalPlugins, listDropInPlugins } from './loader.js';

const sql = {} as never;

function mkPlugin(
    name: string,
    opts: { pkg?: string | null; index?: boolean; bundled?: boolean } = {},
): void {
    const dir = path.join(opts.bundled ? bundledDir : baseDir, name);
    fs.mkdirSync(dir, { recursive: true });
    if (opts.index !== false) fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports={};');
    if (opts.pkg !== undefined && opts.pkg !== null) {
        fs.writeFileSync(path.join(dir, 'package.json'), opts.pkg);
    }
}

beforeEach(() => {
    logInfo.mockClear();
    logWarn.mockClear();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumastra-dropins-'));
    process.env.PLUGINS_EXTERNAL_DIR = baseDir;
    bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumastra-bundled-'));
    process.env.PLUGINS_BUNDLED_DIR = bundledDir;
    process.env.PLUGINS_ENABLED = 'true';
    requireRegistry = false;
    rowNames = new Set();
});

afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(bundledDir, { recursive: true, force: true });
    delete process.env.PLUGINS_EXTERNAL_DIR;
    delete process.env.PLUGINS_BUNDLED_DIR;
    delete process.env.PLUGINS_ENABLED;
});

describe('the shape production actually runs', () => {
    it('lists a plugin that is ONLY index.js, with no package.json', async () => {
        mkPlugin('shoutbox');
        const out = await listDropInPlugins(sql);
        expect(out).toEqual([{ name: 'shoutbox', origin: 'drop-in' }]);
    });

    it('reports no version for it, rather than inventing one', async () => {
        mkPlugin('shoutbox');
        expect((await listDropInPlugins(sql))[0].version).toBeUndefined();
    });
});

describe('TypeScript entry points', () => {
    it('resolves a plugin whose only entry is index.ts', async () => {
        // Node 24 (the runtime image) strips types on import, so a plain .ts
        // entry runs. Verified against the production container, not assumed.
        const dir = path.join(baseDir, 'ts-plugin');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.ts'), 'export default {};');
        expect((await listDropInPlugins(sql)).map((x) => x.name)).toEqual(['ts-plugin']);
    });

    it('prefers a COMPILED index.js when both are present', async () => {
        // A plugin shipping source alongside its build must run the build: that
        // is the artifact the signature and treeDigest were taken over.
        const dir = path.join(baseDir, 'both');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports={};');
        fs.writeFileSync(path.join(dir, 'index.ts'), 'export default {};');
        expect((await listDropInPlugins(sql)).map((x) => x.name)).toEqual(['both']);
    });
});

describe('version reading', () => {
    it('takes the version from package.json when there is one', async () => {
        mkPlugin('vers', { pkg: JSON.stringify({ name: 'vers', version: '3.2.1' }) });
        expect((await listDropInPlugins(sql))[0].version).toBe('3.2.1');
    });

    it('a MALFORMED package.json costs the version, not the listing', async () => {
        mkPlugin('broken-pkg', { pkg: '{ not json' });
        const out = await listDropInPlugins(sql);
        expect(out.map((p) => p.name)).toEqual(['broken-pkg']);
        expect(out[0].version).toBeUndefined();
    });
});

describe('what it excludes', () => {
    it('a directory with no entry point at all', async () => {
        mkPlugin('empty-dir', { index: false });
        expect(await listDropInPlugins(sql)).toEqual([]);
    });

    it('installer staging droppings', async () => {
        mkPlugin('.tmp-staging');
        mkPlugin('.old-backup');
        expect(await listDropInPlugins(sql)).toEqual([]);
    });

    it('anything that HAS a registry row — the row-based listing covers it', async () => {
        mkPlugin('managed');
        mkPlugin('unmanaged');
        rowNames.add('managed');
        expect((await listDropInPlugins(sql)).map((p) => p.name)).toEqual(['unmanaged']);
    });

    it('everything, under PLUGINS_REQUIRE_REGISTRY — they cannot load there', async () => {
        mkPlugin('shoutbox');
        requireRegistry = true;
        expect(await listDropInPlugins(sql)).toEqual([]);
    });

    it('everything, when the plugins directory does not exist', async () => {
        process.env.PLUGINS_EXTERNAL_DIR = path.join(baseDir, 'nope');
        expect(await listDropInPlugins(sql)).toEqual([]);
    });
});

describe('bundled plugins (the image directory)', () => {
    it('logs each shadowed installed copy once at info across discovery passes', async () => {
        const names = ['shadow-log-one', 'shadow-log-two'];
        for (const name of names) {
            // Bare production directories have no package.json version.
            mkPlugin(name, { bundled: true });
            mkPlugin(name);
        }
        const expected = names.map((name) => path.join(bundledDir, name));
        expect(await discoverExternalPlugins(sql)).toEqual(expected);
        expect(await discoverExternalPlugins(sql)).toEqual(expected);
        expect(logInfo).toHaveBeenCalledTimes(2);
        for (const name of names) {
            expect(logInfo).toHaveBeenCalledWith(
                'Ignoring installed plugin shadowed by the bundled copy',
                {
                    name,
                    ignored: path.join(baseDir, name),
                    using: path.join(bundledDir, name),
                },
            );
        }
        expect(logWarn).not.toHaveBeenCalled();
    });

    it('lists them as bundled, not as unverified drop-ins', async () => {
        mkPlugin('shoutbox', { bundled: true });
        expect(await listDropInPlugins(sql)).toEqual([{ name: 'shoutbox', origin: 'bundled' }]);
    });

    it('reports a stale same-named copy in the plugins volume on the bundled row, never as its own card', async () => {
        // The loader ignores the volume copy (bundled wins a collision); the
        // listing used to show that ignored copy as the plugin.
        mkPlugin('shoutbox', { bundled: true });
        mkPlugin('shoutbox');
        mkPlugin('my-own');
        expect(await listDropInPlugins(sql)).toEqual([
            { name: 'shoutbox', origin: 'bundled', shadowedCopy: true },
            { name: 'my-own', origin: 'drop-in' },
        ]);
    });

    it('stays listed under PLUGINS_REQUIRE_REGISTRY — bundled plugins are exempt and load', async () => {
        mkPlugin('shoutbox', { bundled: true });
        mkPlugin('hand-placed');
        requireRegistry = true;
        expect((await listDropInPlugins(sql)).map((p) => p.name)).toEqual(['shoutbox']);
    });
});

describe('the real prod inventory', () => {
    it('lists all four bare drop-ins, matching the box', async () => {
        for (const n of ['announcement', 'mal-watch-sync', 'shoutbox', 'trakt-watch-sync']) {
            mkPlugin(n);
        }
        const out = await listDropInPlugins(sql);
        expect(out.map((p) => p.name).sort()).toEqual([
            'announcement',
            'mal-watch-sync',
            'shoutbox',
            'trakt-watch-sync',
        ]);
    });
});
