// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

/**
 * Refuse a publish that would ship a manifest pointing at TypeScript source.
 *
 * These packages keep `main`/`types`/`exports` on `./src/index.ts` at the top
 * level, because that is what makes the npm workspace resolve during local
 * development and what the app's Vite build consumes. The dist mappings live
 * under `publishConfig`, which pnpm and yarn apply when publishing — and npm
 * does NOT. npm honours only registry keys there (`access`, `tag`, …) and
 * publishes the rest of the manifest verbatim.
 *
 * Published by npm, a consumer's `import { defineTask } from
 * '@sapd/lumastra-plugin-sdk'` therefore resolves to a `.ts` file and dies with
 * ERR_UNKNOWN_FILE_EXTENSION. Type-only usage survives, which is exactly why
 * this would reach a release before anyone noticed.
 *
 * So: fail loudly at publish time rather than shipping that. This is a guard,
 * not a preference — if the layout is ever changed so npm is safe, delete it.
 */

const agent = process.env.npm_config_user_agent ?? '';
const client = agent.split(' ')[0] ?? 'unknown';

if (!/^(pnpm|yarn)\//.test(client)) {
    console.error(
        [
            '',
            `Refusing to publish with "${client}".`,
            '',
            'This package relies on publishConfig field rewriting to point main/types/',
            'exports at ./dist. Only pnpm and yarn apply that; npm publishes the',
            'src-pointing manifest verbatim, and consumers then import a .ts file that',
            'Node cannot execute.',
            '',
            'Use:  pnpm publish',
            '',
            'Or move the dist mappings to the top level of package.json and delete this',
            'guard — but note that local workspace resolution and the app build both',
            'consume ./src today.',
            '',
        ].join('\n'),
    );
    process.exit(1);
}
