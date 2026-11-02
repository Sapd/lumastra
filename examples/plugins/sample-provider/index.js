// SPDX-License-Identifier: Apache-2.0
/**
 * Sample: defineProvider — metadata and artwork from an external source.
 *
 * `detail` is what distinguishes a metadata provider from a subtitle provider
 * at detection time: both declare `search`, so the loader looks for `detail`
 * (and `download` for subtitles) to tell them apart. Omit it and your plugin is
 * classified as something else and rejected with an error naming a contract you
 * never wrote.
 *
 * @type {import('@sapd/lumastra-plugin-sdk').ProviderDefinition}
 */
export default {
    id: 'sample-provider',
    name: 'Sample Provider',
    version: '1.0.0',
    capabilities: {},
    async isConfigured() {
        return true;
    },
    async search(_ctx, query) {
        return [{ providerId: 'sample-1', title: String(query.title ?? 'Sample'), year: 2026 }];
    },
    async detail(_ctx, providerId) {
        return { providerId, title: 'Sample Title', year: 2026, overview: 'From a sample plugin.' };
    },
};
