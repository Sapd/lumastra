// SPDX-License-Identifier: Apache-2.0
/**
 * Sample: defineTrickplayProvider — scrubbing thumbnails.
 *
 * `fetchParams` is the whole contract. The host asks what geometry your source
 * produces; it does not ask you to generate anything.
 *
 * @type {import('@sapd/lumastra-plugin-sdk').TrickplayProviderDefinition}
 */
export default {
    id: 'sample-trickplay',
    version: '1.0.0',
    capabilities: {},
    async fetchParams() {
        return { tileWidth: 320, tileHeight: 180, columns: 10, rows: 10, intervalMs: 10_000 };
    },
};
