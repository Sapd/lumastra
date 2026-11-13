// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Node module-customization hooks that let CLI commands run server code under plain
// `tsx`, outside the SvelteKit/Vite runtime (scripts/reset-password.ts). The server
// graph reaches things only SvelteKit/Vite provide, none of which the runtime image
// ships or can resolve:
//
//   - `@sveltejs/kit`            (api/problem.ts imports `json`)      -> tiny stand-in
//   - `$app/paths`, `$app/environment`                                -> constants for a root
//     install outside the server (base '', dev false)
//   - `$env/dynamic/private|public`                                   -> process.env
//   - `import.meta.glob(...)`    (licensing/entitlements.ts loads the optional
//     proprietary init module)                                        -> a literal-path
//     lookup under the app root
//
// A command that never answers an HTTP request does not need more than that. Register
// with `register('./tsx-sveltekit-shim-loader.mjs', import.meta.url)`; it composes with
// tsx's own hooks and only claims the specifiers above.

const KIT = `export const json = (d, i) => Response.json(d, i);
export const error = (s, b) => { throw Object.assign(new Error(String(b ?? s)), { status: s }); };
export const redirect = (s, l) => { throw Object.assign(new Error('redirect'), { status: s, location: l }); };`;

const SHIMS = new Map([
    ['@sveltejs/kit', KIT],
    [
        '$app/paths',
        `export const base = ''; export const assets = '';
export const resolve = (p) => p; export const resolveRoute = (p) => p;`,
    ],
    [
        '$app/environment',
        `export const browser = false; export const building = false; export const dev = false; export const version = '';`,
    ],
    ['$env/dynamic/private', `export const env = process.env;`],
    [
        '$env/dynamic/public',
        `export const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('PUBLIC_')));`,
    ],
]);

export async function resolve(specifier, context, nextResolve) {
    const shim = SHIMS.get(specifier);
    if (shim !== undefined) {
        return {
            url: 'data:text/javascript,' + encodeURIComponent(shim),
            format: 'module',
            shortCircuit: true,
        };
    }
    return nextResolve(specifier, context);
}

// What `import.meta.glob('/abs/in/app/root/file.{a,b}')` is replaced with. Only the
// literal-path form the server uses (optional brace list for the extension), resolved
// against the app root, i.e. the directory above `src/`.
const GLOB_HELPER = `
import { existsSync as __globExists } from 'node:fs';
import { fileURLToPath as __globFileUrl, pathToFileURL as __globPathUrl } from 'node:url';
function __lumastraTsxGlob(pattern) {
    const here = __globFileUrl(import.meta.url);
    const root = here.slice(0, here.lastIndexOf('/src/'));
    const m = /^(.*)\\{([^}]*)\\}(.*)$/.exec(pattern);
    const variants = m ? m[2].split(',').map((e) => m[1] + e + m[3]) : [pattern];
    const out = {};
    for (const rel of variants) {
        if (!__globExists(root + rel)) continue;
        out[rel] = () => import(__globPathUrl(root + rel).href);
    }
    return out;
}
`;

export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    if (result.format !== 'module' || result.source == null) return result;
    const source = typeof result.source === 'string' ? result.source : result.source.toString();
    if (!source.includes('import.meta.glob(')) return result;
    return {
        ...result,
        source: GLOB_HELPER + source.replaceAll('import.meta.glob(', '__lumastraTsxGlob('),
    };
}
