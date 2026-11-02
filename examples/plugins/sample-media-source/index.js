// SPDX-License-Identifier: Apache-2.0
/**
 * Sample: defineMediaSource — ingest an external library.
 *
 * ⚠️ THE HOST DOES NOT CALL scan() FOR YOU. Registering a media source makes it
 * configurable; it does not put it on a schedule. This sample therefore ships a
 * PAIRED TASK that drives its own scan — which is what every builtin media
 * source does, and what your plugin must do. Ship only the media source and
 * nothing will ever run.
 */
const mediaSource = {
    id: 'sample-media-source',
    name: 'Sample Media Source',
    version: '1.0.0',
    capabilities: {},
    sourceConfig: { supportsIncrementalScan: true, defaultScanIntervalHours: 6 },
    async scan(ctx) {
        ctx.logger.info('sample-media-source scan');
        return { imported: 0, updated: 0, removed: 0 };
    },
    async fullSync(ctx) {
        return mediaSource.scan(ctx);
    },
    async getStatus() {
        return { configured: true, lastScanAt: null };
    },
};

export default {
    mediaSources: [mediaSource],
    tasks: [
        {
            id: 'sample-media-source-scan',
            name: 'Sample Media Source Scan',
            version: '1.0.0',
            processingVersion: 1,
            resourceClass: 'maintenance',
            capabilities: {},
            identityFor: () => 'global',
            inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) },
            schedule: { every: '6h', runOnStartup: false },
            async execute(ctx) {
                const r = await mediaSource.scan(ctx);
                return { success: true, itemsProcessed: r.imported };
            },
        },
    ],
};
