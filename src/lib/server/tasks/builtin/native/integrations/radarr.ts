// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Radarr integration.
 *
 * Movie management via Radarr. Receives Radarr webhook notifications and
 * routes them as structured events. Outbound notification sends a test ping
 * to Radarr's connection test endpoint.
 *
 * Connection: host config RADARRURL / RADARRAPIKEY (Settings → Providers).
 */

import { defineIntegration } from '@sapd/lumastra-plugin-sdk';
import type { PluginContext, NotificationEvent } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { isRecord, sendArrTestNotification, type ArrCommonWebhookPayload } from './_arr-shared.js';

// ---------------------------------------------------------------------------
// Webhook payload shapes (Radarr v3 webhook contract)
// ---------------------------------------------------------------------------

interface RadarrWebhookPayload extends ArrCommonWebhookPayload {
    movie?: {
        id?: number;
        title?: string;
        year?: number;
        folderPath?: string;
        tmdbId?: number;
        imdbId?: string;
    };
    remoteMovie?: {
        tmdbId?: number;
        imdbId?: string;
        title?: string;
        year?: number;
    };
    movieFile?: {
        id?: number;
        relativePath?: string;
        path?: string;
        quality?: string;
        qualityVersion?: number;
        releaseGroup?: string;
        sceneName?: string;
        indexerFlags?: number;
        size?: number;
    };
}

// ---------------------------------------------------------------------------
// Integration definition
// ---------------------------------------------------------------------------

export const radarrIntegration = defineIntegration({
    id: 'radarr',
    capabilities: { http: true },

    // No settings of its own: the URL/API key are host settings (Settings →
    // Providers → Connections) and are read from `config` directly. A plugin
    // copy of the same keys was a second store the rest of the app never read.

    async handleWebhook(ctx: PluginContext, payload: unknown): Promise<unknown> {
        if (!isRecord(payload)) {
            ctx.logger.warn('radarr: received non-object webhook payload');
            return { success: false, error: 'Invalid payload shape' };
        }

        const body = payload as RadarrWebhookPayload;
        const eventType = body.eventType ?? 'unknown';

        ctx.logger.info('radarr: webhook received', {
            eventType,
            movieTitle: body.movie?.title,
            tmdbId: body.movie?.tmdbId ?? body.remoteMovie?.tmdbId,
        });

        return {
            success: true,
            eventType,
            movie: body.movie,
            remoteMovie: body.remoteMovie,
            isUpgrade: body.isUpgrade,
            downloadClient: body.downloadClient,
        };
    },

    async sendNotification(ctx: PluginContext, event: NotificationEvent): Promise<void> {
        await sendArrTestNotification(ctx, event, {
            id: 'radarr',
            urlKey: 'RADARRURL',
            apiKeyKey: 'RADARRAPIKEY',
        });
    },
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerIntegration(radarrIntegration);
