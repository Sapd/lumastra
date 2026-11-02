// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hello World External Plugin — SDK-shape example.
 *
 * Drop this directory into $PLUGINS_EXTERNAL_DIR (default: /app/plugins) to
 * load. The host detects which SDK contract this implements from the export
 * shape (presence of `search` + `detail` → ProviderDefinition) and registers
 * it against the task registry.
 *
 * Plugin authors writing JavaScript get full IDE type-checking via the JSDoc
 * `@type` annotation below — install `@sapd/lumastra-plugin-sdk` as a dev dep to
 * pull in the types; no runtime import is needed.
 *
 * TypeScript authors: use `import type { ProviderDefinition }` (erased at
 * compile time) and compile with tsc. Do NOT runtime-import from
 * `@sapd/lumastra-plugin-sdk` — the host doesn't ship the SDK as resolvable JS to
 * plugin processes. See README.md for the full authoring guide.
 */

/** @type {import('@sapd/lumastra-plugin-sdk').ProviderDefinition} */
const helloWorldProvider = {
    id: 'hello-world-metadata-provider',
    name: 'Hello World (Test)',
    version: '1.0.0',
    capabilities: { http: false, cache: true },

    metadata: {
        priority: 1,
        fieldAuthorities: {},
    },

    settings: {
        fields: [
            {
                key: 'GREETING',
                type: 'string',
                label: 'Greeting',
                description: 'Custom greeting prefix for search results',
                default: 'Hello',
            },
        ],
    },

    async isConfigured() {
        return true;
    },

    async search(ctx, params) {
        if (params.type !== 'movie' && params.type !== 'tv') return [];
        const settings = await ctx.settings();
        const greeting = typeof settings.GREETING === 'string' ? settings.GREETING : 'Hello';
        return [
            {
                externalId: 'hello-1',
                provider: 'hello-world-metadata-provider',
                title: `${greeting}, ${params.query} (Hello World)`,
                year: params.year ?? 2026,
                mediaType: params.type === 'tv' ? 'tv' : 'movie',
                confidence: 0.1,
            },
        ];
    },

    async detail(_ctx, externalId) {
        return {
            externalId,
            provider: 'hello-world-metadata-provider',
            title: 'Hello World Item',
            mediaType: 'movie',
            confidence: 1.0,
        };
    },
};

export default helloWorldProvider;
