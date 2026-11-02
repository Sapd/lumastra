// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Node module-customization hooks that make `import x from './foo.lua?raw'`
// (and bare `./foo.lua`) resolve to the file's TEXT when running TS source under
// tsx (scripts/startup-migration.ts, migrate-schema, the openapi generator, …).
//
// Why this exists: the Lua loader (src/lib/server/tasks/lua/loader.ts) uses
// Vite's `?raw` import to inline the .lua sources into the SvelteKit production
// bundle. But the container runs the migration ENTRYPOINT via `tsx` over raw TS
// source (start.sh) — and tsx/Node don't understand Vite's `?raw`, so the first
// import chain that reaches loader.ts crashed startup with
// `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".lua"`.
// (connection.ts → services → cache/tasks → loader.ts pulls it in on every
// migration run.) Registering this hook gives tsx the same `?raw` semantics
// Vite provides at build time. See scripts/register-lua.mjs for the wiring and
// start.sh for where it is applied.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const LUA_SPECIFIER = /^(.*\.lua)(\?raw)?$/;

export async function resolve(specifier, context, nextResolve) {
    const match = LUA_SPECIFIER.exec(specifier);
    if (match) {
        // Strip the `?raw` query so Node's resolver can locate the real file,
        // then tag the result so load() below knows to inline it as text.
        const resolved = await nextResolve(match[1], context);
        return { ...resolved, format: 'lua-raw', shortCircuit: true };
    }
    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    const isLua = context.format === 'lua-raw' || url.replace(/\?.*$/, '').endsWith('.lua');
    if (isLua) {
        const text = await readFile(fileURLToPath(url.replace(/\?.*$/, '')), 'utf8');
        // Export the raw source as the default binding, matching `import x from '…?raw'`.
        return {
            format: 'module',
            source: `export default ${JSON.stringify(text)};`,
            shortCircuit: true,
        };
    }
    return nextLoad(url, context);
}
