// SPDX-License-Identifier: Apache-2.0
/**
 * Sample: defineSubtitleProvider.
 *
 * Ranking is the HOST's job and it puts the viewer's language preference
 * FIRST, hash match second — so return title-search results in preferred
 * languages too, and set `hashMatch` only when you matched the actual file.
 *
 * @type {import('@sapd/lumastra-plugin-sdk').SubtitleProviderDefinition}
 */
export default {
    id: 'sample-subtitle-provider',
    name: 'Sample Subtitles',
    version: '1.0.0',
    capabilities: {},
    async isConfigured() {
        return true;
    },
    async search(_ctx, query) {
        return query.languages.map((language, i) => ({
            id: `sample-${language}-${i}`,
            language,
            format: 'srt',
            releaseName: 'Sample.Release',
            hashMatch: false,
        }));
    },
    async download(_ctx, candidateId) {
        return { content: `1\n00:00:01,000 --> 00:00:02,000\n${candidateId}\n`, format: 'srt' };
    },
};
