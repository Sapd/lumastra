// SPDX-License-Identifier: Apache-2.0
/**
 * Sample: defineIntegration with an inbound webhook.
 *
 * Note it declares `capabilities.webhook` but NO `webhookSecret` settings
 * field — deliberately. The host injects that field, so an operator can set
 * the secret and reach the endpoint. Before that injection existed, this exact
 * shape produced a webhook nobody could ever turn on.
 *
 * @type {import('@sapd/lumastra-plugin-sdk').IntegrationDefinition}
 */
export default {
    id: 'sample-integration',
    name: 'Sample Integration',
    version: '1.0.0',
    capabilities: { webhook: true },
    subscribes: ['org.lumastra.playback.started'],
    async sendNotification(ctx, event) {
        ctx.logger.info('sample-integration got an event', { type: event.type });
    },
    async handleWebhook(ctx, payload) {
        ctx.logger.info('sample-integration got a webhook');
        return { ok: true, received: typeof payload };
    },
};
