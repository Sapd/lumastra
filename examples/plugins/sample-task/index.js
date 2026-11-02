// SPDX-License-Identifier: Apache-2.0
/**
 * Sample: defineTask.
 *
 * Every field here is REQUIRED by the host's validator — `processingVersion`
 * included, which the SDK now rejects if you omit it. Plain JS with a JSDoc
 * type, so the SDK stays a dev-time dependency: importing it at runtime fails
 * with ERR_MODULE_NOT_FOUND on your first line.
 *
 * @type {import('@sapd/lumastra-plugin-sdk').TaskDefinition}
 */
export default {
    id: 'sample-task',
    name: 'Sample Task',
    version: '1.0.0',
    processingVersion: 1,
    resourceClass: 'maintenance',
    capabilities: {},
    identityFor: () => 'global',
    inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) },
    schedule: { every: '24h', runOnStartup: false },
    async execute(ctx) {
        ctx.logger.info('sample-task ran');
        return { success: true, itemsProcessed: 0 };
    },
};
