// SPDX-License-Identifier: Apache-2.0
/**
 * Sample: defineWatchSync — two-way watch state with an external service.
 *
 * The engine drives `pushWatchState` / `pullWatchState` directly for EVERY
 * registered watch-sync, builtin or drop-in. You do not need a paired task —
 * unlike a media source, which does (see sample-media-source).
 *
 * @type {import('@sapd/lumastra-plugin-sdk').WatchSyncDefinition}
 */
export default {
    id: 'sample-watch-sync',
    name: 'Sample Watch Sync',
    version: '1.0.0',
    providerName: 'sample',
    capabilities: {},
    async isAvailable() {
        return true;
    },
    async resolveIds(_ctx, items) {
        return items.map((i) => ({ ...i, externalId: `sample-${i.mediaItemId}` }));
    },
    async pushWatchState(ctx) {
        ctx.logger.info('sample-watch-sync push');
        return { processed: 0, succeeded: 0, failed: 0 };
    },
    async pullWatchState(ctx) {
        ctx.logger.info('sample-watch-sync pull');
        return { processed: 0, updated: 0 };
    },
};
