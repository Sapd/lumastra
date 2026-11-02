// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dummy integration.
 *
 * A minimal reference integration demonstrating webhook and notification
 * capabilities. Ported from dummy-integration.plugin.ts.
 *
 * Features:
 * - Bidirectional (webhook receiver + notification sender)
 * - Configurable simulated latency and failure modes
 * - Enable/disable via DISABLE_DUMMY_INTEGRATION / PLUGIN_DUMMY_INTEGRATION_ENABLED
 */

import { defineIntegration } from '@sapd/lumastra-plugin-sdk';
import type { PluginContext, NotificationEvent } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { config } from '$lib/server/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DummySettings {
    notificationLatencyMs: number;
    simulateNotificationFailure: boolean;
    simulateSignatureFailure: boolean;
}

// ---------------------------------------------------------------------------
// Module-level counters (per-process; reset between test runs via __testing)
// ---------------------------------------------------------------------------

let webhooksReceived = 0;
let notificationsSent = 0;

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

function isEnabled(): boolean {
    if (config.DISABLE_DUMMY_INTEGRATION) {
        return false;
    }
    return config.PLUGIN_DUMMY_INTEGRATION_ENABLED;
}

// ---------------------------------------------------------------------------
// Integration definition
// ---------------------------------------------------------------------------

export const dummyIntegration = defineIntegration({
    id: 'dummy-integration',
    capabilities: { http: true },

    settings: {
        fields: [
            {
                key: 'notificationLatencyMs',
                type: 'number',
                label: 'Notification Latency (ms)',
                description: 'Simulated notification sending latency in milliseconds',
                default: 100,
                validation: { min: 0, max: 5000 },
            },
            {
                key: 'simulateNotificationFailure',
                type: 'boolean',
                label: 'Simulate Notification Failure',
                description: 'When enabled, all notifications will fail for testing retry logic',
                default: false,
            },
            {
                key: 'simulateSignatureFailure',
                type: 'boolean',
                label: 'Simulate Signature Failure',
                description: 'When enabled, webhook signature verification will fail',
                default: false,
            },
        ],
    },

    async handleWebhook(ctx: PluginContext, payload: unknown): Promise<unknown> {
        if (!isEnabled()) {
            ctx.logger.debug('dummy-integration: disabled, ignoring webhook');
            return { success: false, error: 'Integration disabled' };
        }

        // Read settings BEFORE incrementing the counter — a settings() rejection
        // or signature-failure return shouldn't inflate the "received" tally
        // beyond actually-processed webhooks.
        const settings = (await ctx.settings()) as Partial<DummySettings>;
        const simulateSignatureFailure = settings.simulateSignatureFailure ?? false;

        if (simulateSignatureFailure) {
            return {
                success: false,
                error: 'Invalid webhook signature',
                message: 'Signature verification failed',
            };
        }

        webhooksReceived++;

        ctx.logger.info('dummy-integration: webhook received', {
            webhookNumber: webhooksReceived,
            hasPayload: payload !== null && payload !== undefined,
        });

        const body =
            typeof payload === 'object' && payload !== null
                ? (payload as Record<string, unknown>)
                : {};
        const eventType = (body['event'] ?? body['type'] ?? 'unknown') as string;

        ctx.logger.info('dummy-integration: webhook processed', { eventType });

        return {
            success: true,
            message: `Processed webhook with event type: ${eventType}`,
            events: [
                {
                    type: eventType,
                    payload: body,
                    timestamp: new Date(),
                    source: 'external-webhook',
                },
            ],
        };
    },

    async sendNotification(ctx: PluginContext, event: NotificationEvent): Promise<void> {
        if (!isEnabled()) {
            ctx.logger.debug('dummy-integration: disabled, ignoring notification');
            return;
        }

        // Same counter-before-await pattern as handleWebhook — read settings
        // first so a rejection doesn't inflate notificationsSent. Also clamp
        // latencyMs since the UI validation min/max isn't runtime-enforced.
        const settings = (await ctx.settings()) as Partial<DummySettings>;
        const rawLatency = settings.notificationLatencyMs ?? 100;
        const latencyMs = Math.max(0, Math.min(5000, rawLatency));
        const simulateFailure = settings.simulateNotificationFailure ?? false;

        notificationsSent++;

        ctx.logger.info('dummy-integration: sending notification', {
            notificationNumber: notificationsSent,
            eventType: event.type,
        });

        await new Promise<void>((resolve) => setTimeout(resolve, latencyMs));

        if (simulateFailure) {
            throw new Error('Simulated notification failure');
        }

        ctx.logger.info('dummy-integration: notification sent', {
            externalId: `dummy-${Date.now()}-${notificationsSent}`,
        });
    },
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerIntegration(dummyIntegration);

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

export const __testing = {
    getWebhooksReceived: (): number => webhooksReceived,
    getNotificationsSent: (): number => notificationsSent,
    resetState: (): void => {
        webhooksReceived = 0;
        notificationsSent = 0;
    },
    isEnabled,
};
