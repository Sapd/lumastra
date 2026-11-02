// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonarr integration.
 *
 * TV series management via Sonarr. Receives Sonarr webhook notifications and
 * routes them as structured events. Outbound notification sends a test ping
 * to Sonarr's connection test endpoint.
 *
 * Connection: host config SONARRURL / SONARRAPIKEY (Settings → Providers).
 */

import { defineIntegration } from '@sapd/lumastra-plugin-sdk';
import type { PluginContext, NotificationEvent } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { isRecord, sendArrTestNotification, type ArrCommonWebhookPayload } from './_arr-shared.js';

// ---------------------------------------------------------------------------
// Webhook payload shapes (Sonarr v3 webhook contract)
// ---------------------------------------------------------------------------

interface SonarrWebhookPayload extends ArrCommonWebhookPayload {
    series?: {
        id?: number;
        title?: string;
        titleSlug?: string;
        tvdbId?: number;
        tvMazeId?: number;
        imdbId?: string;
        type?: string;
    };
    episodes?: Array<{
        id?: number;
        episodeNumber?: number;
        seasonNumber?: number;
        title?: string;
        airDate?: string;
        airDateUtc?: string;
        quality?: string;
        qualityVersion?: number;
        releaseGroup?: string;
        sceneName?: string;
        hasFile?: boolean;
    }>;
    episodeFile?: {
        id?: number;
        relativePath?: string;
        path?: string;
        quality?: string;
        qualityVersion?: number;
        releaseGroup?: string;
        sceneName?: string;
        size?: number;
    };
}

// ---------------------------------------------------------------------------
// Integration definition
// ---------------------------------------------------------------------------

export const sonarrIntegration = defineIntegration({
    id: 'sonarr',
    capabilities: { http: true },

    // No settings of its own: the URL/API key are host settings (Settings →
    // Providers → Connections) and are read from `config` directly. A plugin
    // copy of the same keys was a second store the rest of the app never read.

    async handleWebhook(ctx: PluginContext, payload: unknown): Promise<unknown> {
        if (!isRecord(payload)) {
            ctx.logger.warn('sonarr: received non-object webhook payload');
            return { success: false, error: 'Invalid payload shape' };
        }

        const body = payload as SonarrWebhookPayload;
        const eventType = body.eventType ?? 'unknown';

        ctx.logger.info('sonarr: webhook received', {
            eventType,
            seriesTitle: body.series?.title,
            episodeCount: body.episodes?.length,
        });

        return {
            success: true,
            eventType,
            series: body.series,
            episodes: body.episodes,
            isUpgrade: body.isUpgrade,
            downloadClient: body.downloadClient,
        };
    },

    async sendNotification(ctx: PluginContext, event: NotificationEvent): Promise<void> {
        await sendArrTestNotification(ctx, event, {
            id: 'sonarr',
            urlKey: 'SONARRURL',
            apiKeyKey: 'SONARRAPIKEY',
        });
    },
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerIntegration(sonarrIntegration);
