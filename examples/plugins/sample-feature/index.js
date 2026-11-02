// SPDX-License-Identifier: Apache-2.0
/**
 * Sample: defineFeature.
 *
 * A feature MUST declare at least one route — that is what identifies the
 * export as a feature, and it is how a widget's or page's `entry` file gets
 * served. A widgets-only feature is refused at load.
 *
 * @type {import('@sapd/lumastra-plugin-sdk').FeatureDefinition}
 */
export default {
    id: 'sample-feature',
    version: '1.0.0',
    capabilities: {},
    routes: [
        {
            method: 'GET',
            path: '/ping',
            handler: async () => Response.json({ ok: true, from: 'sample-feature' }),
        },
    ],
};
