// SPDX-License-Identifier: Apache-2.0
/**
 * Sample: one plugin shipping SEVERAL contracts (definePlugin aggregate).
 *
 * Two rules, both enforced at load:
 *  - NAMESPACE — every contract id must be the plugin name or start with
 *    `<name>-`. You cannot register inside another plugin's namespace.
 *  - ANCHOR — exactly one contract must be named after the plugin itself
 *    (`sample-bundle` here). That id is how the host answers "is this loaded?",
 *    so a bundle without it is refused.
 *
 * Validation is all-or-nothing: one invalid contract registers none of them,
 * because there is no unload and a half-registered bundle is unrecoverable.
 */
export default {
    features: [
        {
            id: 'sample-bundle',
            capabilities: {},
            routes: [
                { method: 'GET', path: '/ping', handler: async () => Response.json({ ok: true }) },
            ],
        },
    ],
    tasks: [
        {
            id: 'sample-bundle-cleanup',
            name: 'Sample Bundle Cleanup',
            version: '1.0.0',
            processingVersion: 1,
            resourceClass: 'maintenance',
            capabilities: {},
            identityFor: () => 'global',
            inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) },
            async execute() {
                return { success: true, itemsProcessed: 0 };
            },
        },
    ],
};
