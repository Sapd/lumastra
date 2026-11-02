// SPDX-License-Identifier: Apache-2.0
/**
 * Sample: defineLyricsProvider, written in TYPESCRIPT with no build step.
 *
 * The loader resolves index.ts after index.js, and the host runs Node 24 which
 * strips types on import. Strip-only: no `enum`, no `namespace`, no decorators
 * — use const objects and union types, as below.
 */
type Lang = 'en' | 'de';
const DEFAULT_LANG: Lang = 'en';

export default {
    id: 'sample-lyrics-ts',
    name: 'Sample Lyrics (TypeScript)',
    version: '1.0.0',
    capabilities: {},
    async fetchLyrics(_ctx: unknown, query: { title: string }) {
        return { plain: `lyrics for ${query.title} (${DEFAULT_LANG})`, synced: null };
    },
};
