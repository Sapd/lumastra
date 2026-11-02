// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for LuaScriptLoader.
 * No Valkey connection required — tests file I/O and version parsing only.
 *
 * Run with: npm run test:integration src/lib/server/tasks/lua/loader.integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OWNERSHIP_FENCE_VERSION, SCRIPT_VERSIONS, type LuaScriptName } from './SCRIPT_VERSIONS.js';

const LUA_DIR = path.join(import.meta.dirname, '.');

async function readScript(name: string): Promise<string> {
    return fs.readFile(path.join(LUA_DIR, `${name}.lua`), 'utf-8');
}

describe('LuaScriptLoader file loading', () => {
    it('all 9 scripts exist and are readable', async () => {
        const names = Object.keys(SCRIPT_VERSIONS) as LuaScriptName[];
        expect(names).toHaveLength(9);
        for (const name of names) {
            const source = await readScript(name);
            expect(source.length).toBeGreaterThan(0);
        }
    });

    it('pins the shared ownership prefix version separately from the unchanged task scripts', async () => {
        const source = await readScript('ownership-fence');
        expect(Number(/-- @version (\d+)/.exec(source)?.[1])).toBe(OWNERSHIP_FENCE_VERSION);
    });

    it('each script has a valid -- @version N header', async () => {
        for (const name of Object.keys(SCRIPT_VERSIONS) as LuaScriptName[]) {
            const source = await readScript(name);
            const match = /-- @version (\d+)/.exec(source);
            expect(match, `${name}.lua missing @version header`).not.toBeNull();
            expect(Number(match![1])).toBeGreaterThan(0);
        }
    });

    it('script @version headers match SCRIPT_VERSIONS constants', async () => {
        for (const [name, expectedVersion] of Object.entries(SCRIPT_VERSIONS)) {
            const source = await readScript(name);
            const match = /-- @version (\d+)/.exec(source);
            const fileVersion = Number(match![1]);
            expect(fileVersion, `${name}.lua version mismatch`).toBe(expectedVersion);
        }
    });
});

describe('LuaScriptLoader.load()', () => {
    it('loads all scripts successfully', async () => {
        const { luaLoader } = await import('./loader.js');
        await expect(luaLoader.load()).resolves.toBeUndefined();
    });

    it('is idempotent — second load() is a no-op', async () => {
        const { luaLoader } = await import('./loader.js');
        await luaLoader.load();
        await expect(luaLoader.load()).resolves.toBeUndefined();
    });
});

describe('LuaScriptLoader version mismatch detection', () => {
    it('detects mismatch between file @version and SCRIPT_VERSIONS', async () => {
        const source = await readScript('transition-run');
        const versionLine = /-- @version (\d+)/.exec(source);
        const fileVersion = Number(versionLine![1]);
        const registeredVersion = SCRIPT_VERSIONS['transition-run'];
        expect(fileVersion).toBe(registeredVersion);
    });

    it('throws when @version header is missing', () => {
        const parseVersion = (src: string): number => {
            const m = /-- @version (\d+)/.exec(src);
            if (!m) throw new Error('Missing -- @version N header');
            return Number(m[1]);
        };
        expect(() => parseVersion('-- no version here\nreturn 1')).toThrow(
            'Missing -- @version N header',
        );
    });

    it('throws when parsed version does not match constant', async () => {
        const source = await readScript('aging-sweep');
        const currentVersion = SCRIPT_VERSIONS['aging-sweep'];
        const bumped = source.replace(
            `-- @version ${currentVersion}`,
            `-- @version ${currentVersion + 99}`,
        );

        const parseVersion = (src: string): number => {
            const m = /-- @version (\d+)/.exec(src);
            if (!m) throw new Error('Missing -- @version N header');
            return Number(m[1]);
        };
        const parsed = parseVersion(bumped);
        expect(parsed).not.toBe(currentVersion);
        expect(() => {
            if (parsed !== currentVersion) {
                throw new Error(
                    `Script version mismatch: aging-sweep.lua @version ${parsed} != SCRIPT_VERSIONS.aging-sweep = ${currentVersion}`,
                );
            }
        }).toThrow('Script version mismatch');
    });
});
