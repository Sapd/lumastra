// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { SCRIPT_VERSIONS, type LuaScriptName } from './SCRIPT_VERSIONS.js';
import { type ValkeyLike } from '../valkey-types.js';
import type { AuthorityToken } from '../../../../task-runtime/authority/store.js';
import { invokeFencedValkey } from './fenced.js';
export { isNoScriptError, invokeFencedValkey } from './fenced.js';

// Embed Lua sources at build time. Reading from disk fails in the production
// Vite/SvelteKit bundle because the .lua siblings aren't copied next to the
// bundled loader chunk. Inlining via ?raw resolves them at build time so the
// production container ships everything it needs in JS.
import agingSweepSource from './aging-sweep.lua?raw';
import claimRunSource from './claim-run.lua?raw';
import reseedForRetrySource from './reseed-for-retry.lua?raw';
import enqueueWithIdentitySource from './enqueue-with-identity.lua?raw';
import releaseIdentitySource from './release-identity.lua?raw';
import refreshIdentitySource from './refresh-identity.lua?raw';
import incrementStageSource from './increment-stage.lua?raw';
import transitionRunSource from './transition-run.lua?raw';
import transitionStageSource from './transition-stage.lua?raw';

const SCRIPT_SOURCES: Record<LuaScriptName, string> = {
    'aging-sweep': agingSweepSource,
    'claim-run': claimRunSource,
    'reseed-for-retry': reseedForRetrySource,
    'enqueue-with-identity': enqueueWithIdentitySource,
    'release-identity': releaseIdentitySource,
    'refresh-identity': refreshIdentitySource,
    'increment-stage': incrementStageSource,
    'transition-run': transitionRunSource,
    'transition-stage': transitionStageSource,
};

interface LoadedScript {
    name: LuaScriptName;
    source: string;
    version: number;
}

class LuaScriptLoader {
    private scripts = new Map<LuaScriptName, LoadedScript>();
    private loaded = false;

    async load(): Promise<void> {
        if (this.loaded) return;
        for (const name of Object.keys(SCRIPT_VERSIONS) as LuaScriptName[]) {
            const source = SCRIPT_SOURCES[name];
            if (!source) {
                throw new Error(`No embedded source for Lua script: ${name}`);
            }
            const version = this.parseVersion(source);
            if (version !== SCRIPT_VERSIONS[name]) {
                throw new Error(
                    `Script version mismatch: ${name}.lua @version ${version} != SCRIPT_VERSIONS.${name} = ${SCRIPT_VERSIONS[name]}`,
                );
            }
            this.scripts.set(name, { name, source, version });
        }
        this.loaded = true;
    }

    private parseVersion(source: string): number {
        const match = /-- @version (\d+)/.exec(source);
        if (!match) throw new Error('Missing -- @version N header');
        return Number(match[1]);
    }

    async invoke(
        name: LuaScriptName,
        keys: string[],
        argv: (string | number)[],
        client: ValkeyLike,
        authority?: AuthorityToken,
    ): Promise<unknown> {
        if (!this.loaded) throw new Error('LuaScriptLoader: call load() first');
        const script = this.scripts.get(name);
        if (!script) throw new Error(`Unknown script: ${name}`);

        return invokeFencedValkey(script.source, keys, argv, client, authority, {
            allowDraining: !['claim-run', 'enqueue-with-identity', 'aging-sweep'].includes(name),
        });
    }
}

export const luaLoader = new LuaScriptLoader();
