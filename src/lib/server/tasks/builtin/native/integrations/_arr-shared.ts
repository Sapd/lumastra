// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared helpers for the Servarr-family integrations (Radarr, Sonarr).
 *
 * Both apps expose the same v3 webhook envelope fields and an identical
 * `/api/v3/notification/test` connection-test endpoint authenticated with an
 * `X-Api-Key` header. This module is the single source of truth for the parts
 * that don't differ between the two integrations.
 */

import { config } from '$lib/server/config.js';
import type { PluginContext, NotificationEvent } from '@sapd/lumastra-plugin-sdk';

/** Narrow an unknown webhook body to a plain object. */
export function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Webhook payload fields common to both the Radarr and Sonarr v3 contracts.
 * Integration-specific shapes (e.g. `movie`/`series`) extend this interface.
 */
export interface ArrCommonWebhookPayload {
    eventType?: string;
    isUpgrade?: boolean;
    downloadClient?: string;
    downloadClientType?: string;
    downloadId?: string;
    release?: {
        quality?: string;
        qualityVersion?: number;
        releaseGroup?: string;
        releaseTitle?: string;
        indexer?: string;
        size?: number;
    };
    deletedFiles?: Array<{
        id?: number;
        relativePath?: string;
    }>;
    deleteReason?: string;
    instanceName?: string;
    applicationUrl?: string;
    customData?: Record<string, unknown>;
}

/**
 * Send a connection-test notification to a Servarr instance.
 *
 * Reads the instance URL and API key from the host config (the connection
 * settings on Settings → Providers), then
 * POSTs the event to `/api/v3/notification/test`. No-ops with a warning when
 * the integration is not configured. Throws on network error or non-2xx
 * response so the runner records the failure.
 */
export async function sendArrTestNotification(
    ctx: PluginContext,
    event: NotificationEvent,
    opts: { id: string; urlKey: string; apiKeyKey: string },
): Promise<void> {
    const hostConfig = config as unknown as Record<string, unknown>;
    const rawUrl = hostConfig[opts.urlKey];
    const rawKey = hostConfig[opts.apiKeyKey];
    const baseUrl = typeof rawUrl === 'string' ? rawUrl.trim() : undefined;
    const apiKey = typeof rawKey === 'string' ? rawKey.trim() : undefined;

    if (!baseUrl || !apiKey) {
        ctx.logger.warn(`${opts.id}: sendNotification skipped — not configured`);
        return;
    }
    if (!ctx.http) {
        throw new Error(
            `${opts.id}: http capability is required but not granted to this PluginContext`,
        );
    }

    const url = `${baseUrl.replace(/\/$/, '')}/api/v3/notification/test`;

    let resp;
    try {
        resp = await ctx.http.post(
            url,
            { type: event.type, payload: event.payload },
            {
                headers: {
                    'X-Api-Key': apiKey,
                    'Content-Type': 'application/json',
                },
            },
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${opts.id} notification network error: ${message}`, {
            cause: err,
        });
    }

    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`${opts.id} notification failed: ${resp.status} ${body}`);
    }

    ctx.logger.info(`${opts.id}: notification sent`, { eventType: event.type });
}
