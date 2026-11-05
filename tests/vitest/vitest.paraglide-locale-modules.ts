// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compile } from '@inlang/paraglide-js';
import type { Plugin } from 'vite';

/**
 * Serves `$lib/paraglide/*` to tests from a `locale-modules` compile of the
 * messages instead of the `message-modules` tree on disk.
 *
 * `npm run paraglide:compile` (what CI runs) emits one module
 * per message, ~9.5k of them behind the `messages` barrel. The vitest module
 * runner loads that barrel in ~35 s cold (a plain node import takes 1.3 s), so a
 * route test that does `await import('./+server')` inside `it()` — most routes
 * reach the barrel through `ApiResponses` — blew the 30 s test timeout whenever
 * it ran first in its worker: 31 route files when run alone (2026-10-01). The
 * `locale-modules` layout (one module per locale) loads in ~5 s with identical
 * messages, so tests keep asserting on the real English text.
 *
 * The compile lands in `.svelte-kit/paraglide-vitest/<content-hash>/`, so it runs
 * once per message/settings change and never touches `src/lib/paraglide`, which
 * the dev server, typecheck and builds own. The directory stays outside
 * node_modules on purpose: inlined modules keep honouring
 * `vi.mock('$lib/paraglide/runtime')`, because the compiled messages import
 * `../runtime.js`, which resolves to the same (mocked) file.
 *
 * Keep the strategy in sync with package.json's `paraglide:compile` script and
 * vite.config.ts.
 */
const STRATEGY = ['cookie', 'preferredLanguage', 'baseLocale'] as const;

function contentHash(root: string, project: string): string {
    const hash = createHash('sha256');
    const pkg = join(root, 'node_modules/@inlang/paraglide-js/package.json');
    hash.update(existsSync(pkg) ? readFileSync(pkg) : 'no-pkg');
    hash.update(JSON.stringify(STRATEGY));
    hash.update(readFileSync(join(project, 'settings.json')));
    const messagesDir = join(root, 'messages');
    for (const file of readdirSync(messagesDir).sort()) {
        if (!file.endsWith('.json')) continue;
        hash.update(file);
        hash.update(readFileSync(join(messagesDir, file)));
    }
    return hash.digest('hex').slice(0, 16);
}

async function ensureCompiled(root: string): Promise<string> {
    const project = join(root, 'project.inlang');
    const base = join(root, '.svelte-kit/paraglide-vitest');
    const outdir = join(base, contentHash(root, project));
    if (existsSync(join(outdir, 'messages.js'))) return outdir;

    // Compile beside the final dir and rename into place: concurrent vitest runs
    // (other sessions, other configs) must never see a half-written tree.
    await mkdir(base, { recursive: true });
    const tmp = `${outdir}.tmp-${process.pid}-${Date.now()}`;
    await compile({
        project,
        outdir: tmp,
        strategy: [...STRATEGY],
        outputStructure: 'locale-modules',
        emitGitIgnore: false,
        emitPrettierIgnore: false,
        emitReadme: false,
    });
    try {
        await rename(tmp, outdir);
    } catch {
        // Another run won the race; its tree is identical.
        await rm(tmp, { recursive: true, force: true });
    }

    // Drop compiles for older message sets. Skip anything touched in the last
    // hour so a run still using an older hash keeps its files.
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of readdirSync(base)) {
        const dir = join(base, entry);
        if (dir === outdir || statSync(dir).mtimeMs > cutoff) continue;
        await rm(dir, { recursive: true, force: true });
    }
    return outdir;
}

export function paraglideLocaleModulesForTests(): Plugin {
    let source = '';
    let target = '';
    return {
        name: 'lumastra:paraglide-locale-modules-for-tests',
        enforce: 'pre',
        async configResolved(config) {
            source = resolve(config.root, 'src/lib/paraglide') + '/';
            try {
                target = (await ensureCompiled(config.root)) + '/';
            } catch (error) {
                // Tests still run against the on-disk tree, just with the slow
                // cold load. Don't fail the whole run over it.
                config.logger.warn(
                    `[paraglide-locale-modules] compile failed, using src/lib/paraglide: ${String(error)}`,
                );
            }
        },
        resolveId(id) {
            if (!target) return null;
            // `$lib` is rewritten to an absolute path by SvelteKit's alias before
            // resolveId hooks run; accept both spellings anyway.
            let rest: string | undefined;
            if (id.startsWith(source)) rest = id.slice(source.length);
            else if (id.startsWith('$lib/paraglide/')) rest = id.slice('$lib/paraglide/'.length);
            if (rest === undefined) return null;
            // `messages` is both `messages.js` and the `messages/` directory.
            const withJs = rest.endsWith('.js') ? rest : `${rest}.js`;
            const file = join(target, withJs);
            return existsSync(file) ? file : join(target, rest);
        },
    };
}
