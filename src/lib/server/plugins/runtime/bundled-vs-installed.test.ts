// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Bundled (image) and installed (volume) plugin directories.
 *
 * These shared one path until now, which caused two problems at once: a named
 * volume mounted for persistence is seeded from the image only on FIRST use and
 * never re-seeded, freezing the first-party plugins at whatever the image held
 * that day; and bundled plugins have no registry row, so
 * PLUGINS_REQUIRE_REGISTRY=true silently disabled all of them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let bundledDir = '';
let installedDir = '';

let requireRegistry = false;
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
        rowNames.has(name) ? { name, status: 'installed', enabled: true } : null,
    ),
}));
vi.mock('../../utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { discoverExternalPlugins } from './loader.js';

const sql = {} as never;
const mk = (base: string, name: string) => {
    const d = path.join(base, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.js'), 'module.exports={};');
};
const names = (dirs: string[]) => dirs.map((d) => path.basename(d)).sort();

beforeEach(() => {
    bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-bundled-'));
    installedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-installed-'));
    process.env.PLUGINS_BUNDLED_DIR = bundledDir;
    process.env.PLUGINS_EXTERNAL_DIR = installedDir;
    process.env.PLUGINS_ENABLED = 'true';
    requireRegistry = false;
    rowNames = new Set();
});

afterEach(() => {
    fs.rmSync(bundledDir, { recursive: true, force: true });
    fs.rmSync(installedDir, { recursive: true, force: true });
    delete process.env.PLUGINS_BUNDLED_DIR;
    delete process.env.PLUGINS_EXTERNAL_DIR;
    delete process.env.PLUGINS_ENABLED;
});

describe('discovery across the two directories', () => {
    it('finds plugins in BOTH directories', async () => {
        mk(bundledDir, 'shoutbox');
        mk(installedDir, 'sample-task');
        rowNames = new Set(['sample-task']);
        expect(names(await discoverExternalPlugins(sql))).toEqual(['sample-task', 'shoutbox']);
    });

    it('the BUNDLED copy wins a name collision, and the stale volume copy is ignored', async () => {
        // The re-seed trap: an operator's volume holds a frozen copy of a
        // first-party plugin from whenever the volume was created. Preferring
        // the install dir would pin it there forever.
        mk(bundledDir, 'shoutbox');
        mk(installedDir, 'shoutbox');
        const found = await discoverExternalPlugins(sql);
        expect(found).toHaveLength(1);
        expect(found[0]).toBe(path.join(bundledDir, 'shoutbox'));
    });

    it('bundled plugins survive PLUGINS_REQUIRE_REGISTRY=true', async () => {
        // Without the exemption, strict mode disables every first-party plugin —
        // which is why enabling it could not be recommended.
        requireRegistry = true;
        mk(bundledDir, 'shoutbox');
        expect(names(await discoverExternalPlugins(sql))).toEqual(['shoutbox']);
    });

    it('strict mode still rejects a registry-LESS installed drop-in', async () => {
        // The exemption must be for the image directory only; it must not become
        // a hole that lets unverified drop-ins load in strict mode.
        requireRegistry = true;
        mk(installedDir, 'hand-placed');
        expect(await discoverExternalPlugins(sql)).toEqual([]);
    });

    it('strict mode still admits a registry-MANAGED installed plugin', async () => {
        requireRegistry = true;
        mk(installedDir, 'sample-task');
        rowNames = new Set(['sample-task']);
        expect(names(await discoverExternalPlugins(sql))).toEqual(['sample-task']);
    });

    it('works when the bundled directory does not exist at all', async () => {
        // Every deployment that predates this split.
        fs.rmSync(bundledDir, { recursive: true, force: true });
        mk(installedDir, 'sample-task');
        rowNames = new Set(['sample-task']);
        expect(names(await discoverExternalPlugins(sql))).toEqual(['sample-task']);
    });

    it('skips staging droppings in the bundled dir too', async () => {
        mk(bundledDir, '.tmp-half-written');
        mk(bundledDir, 'shoutbox');
        expect(names(await discoverExternalPlugins(sql))).toEqual(['shoutbox']);
    });
});
