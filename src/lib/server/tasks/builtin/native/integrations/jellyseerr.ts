// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyseerr integration.
 *
 * Media request management via Jellyseerr. Receives Jellyseerr webhook
 * notifications and routes them as structured events. No outbound
 * notification surface (Jellyseerr is the initiator).
 *
 * Connection: host config SEERRURL / SEERRAPIKEY (Settings → Providers).
 */

import { config } from '$lib/server/config.js';
import { defineIntegration } from '@sapd/lumastra-plugin-sdk';
import type { PluginContext, NotificationEvent } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { getBreaker, CircuitOpenError } from '../../../../utils/circuit-breaker.js';

// Distinct key from the web-tier 'jellyseerr' breaker (none currently
// declared, but reserved) so task-runner failures don't cross-trip any
// future web-tier caller of the same dependency.
const JELLYSEERR_BREAKER_KEY = 'jellyseerr-tasks';

// ---------------------------------------------------------------------------
// Webhook payload shapes (subset Jellyseerr sends)
// ---------------------------------------------------------------------------

interface JellyseerrWebhookPayload {
    notification_type?: string;
    event?: string;
    subject?: string;
    message?: string;
    image?: string;
    media?: {
        media_type?: string;
        tmdbId?: string;
        tvdbId?: string;
        status?: string;
        status4k?: string;
    };
    request?: {
        request_id?: string;
        requestedBy_email?: string;
        requestedBy_username?: string;
        requestedBy_avatar?: string;
    };
    issue?: {
        issue_id?: string;
        issue_type?: string;
        issue_status?: string;
        reportedBy_email?: string;
        reportedBy_username?: string;
        reportedBy_avatar?: string;
    };
    comment?: {
        comment_message?: string;
        commented_by_email?: string;
        commented_by_username?: string;
        commented_by_avatar?: string;
    };
    extra?: Array<{ name?: string; value?: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Integration definition
// ---------------------------------------------------------------------------

export const jellyseerrIntegration = defineIntegration({
    id: 'jellyseerr',
    capabilities: { http: true },

    // No settings of its own: the URL/API key are host settings (Settings →
    // Providers → Connections) and are read from `config` directly. A plugin
    // copy of the same keys was a second store the rest of the app never read.

    async handleWebhook(ctx: PluginContext, payload: unknown): Promise<unknown> {
        if (!isRecord(payload)) {
            ctx.logger.warn('jellyseerr: received non-object webhook payload');
            return { success: false, error: 'Invalid payload shape' };
        }

        const body = payload as JellyseerrWebhookPayload;
        const eventType = body.notification_type ?? body.event ?? 'unknown';

        ctx.logger.info('jellyseerr: webhook received', {
            eventType,
            mediaType: body.media?.media_type,
            subject: body.subject,
        });

        return {
            success: true,
            eventType,
            subject: body.subject,
            message: body.message,
            media: body.media,
            request: body.request,
        };
    },

    async sendNotification(ctx: PluginContext, event: NotificationEvent): Promise<void> {
        // Host connection settings (Settings → Providers → Media Requests).
        const rawUrl: unknown = config.SEERRURL;
        const rawKey: unknown = config.SEERRAPIKEY;
        const baseUrl = typeof rawUrl === 'string' ? rawUrl.trim() : undefined;
        const apiKey = typeof rawKey === 'string' ? rawKey.trim() : undefined;

        if (!baseUrl || !apiKey) {
            ctx.logger.warn('jellyseerr: sendNotification skipped — not configured');
            return;
        }
        if (!ctx.http) {
            throw new Error(
                'jellyseerr: http capability is required but not granted to this PluginContext',
            );
        }

        const url = `${baseUrl.replace(/\/$/, '')}/api/v1/notifications/test`;

        const http = ctx.http;

        try {
            // The non-2xx check runs INSIDE execute() so a persistent 5xx
            // (Jellyseerr up but erroring) counts as a breaker failure and
            // eventually trips it open — not just connection-level failures.
            await getBreaker(JELLYSEERR_BREAKER_KEY).execute(async () => {
                const resp = await http.post(
                    url,
                    { type: event.type, payload: event.payload },
                    {
                        headers: {
                            'X-Api-Key': apiKey,
                            'Content-Type': 'application/json',
                        },
                    },
                );
                if (!resp.ok) {
                    const body = await resp.text().catch(() => '');
                    throw new Error(`jellyseerr notification failed: ${resp.status} ${body}`);
                }
            });
        } catch (err) {
            // Circuit open — fast-fail without touching the network. Rethrow
            // as-is so callers keep the isDependencyUnavailable duck-type.
            if (err instanceof CircuitOpenError) throw err;
            // Non-2xx HTTP status thrown inside the breaker — surface as-is.
            if (err instanceof Error && err.message.startsWith('jellyseerr notification failed:')) {
                throw err;
            }
            // Network-level failure (ECONNREFUSED, DNS, timeout) — surface with
            // a stable prefix so callers can distinguish from HTTP-status errors.
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`jellyseerr notification network error: ${message}`, { cause: err });
        }

        ctx.logger.info('jellyseerr: notification sent', {
            eventType: event.type,
        });
    },
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerIntegration(jellyseerrIntegration);
