// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Discogs integration.
 *
 * Holds the single shared Discogs personal access token used by the music
 * enrichment tasks (artist-enrichment, album-enrichment) to fetch artist/album
 * metadata from Discogs. Registering it as an integration surfaces the token on
 * the /admin/settings/plugins page (integrations section) and makes it editable
 * through the generic PluginSettingsPanel + /api/admin/plugins/discogs/settings
 * API — the same way Sonarr/Radarr credentials are managed.
 *
 * The token is stored as `plugin_secrets (plugin_id='discogs',
 * key='DISCOGS_TOKEN')`; readers use `readDiscogsToken()` in
 * `$lib/server/services/discogs-token`.
 *
 * This integration has no webhook or outbound-notification behaviour — it exists
 * purely as the credential owner. `defineIntegration` requires at least one of
 * `handleWebhook` / `sendNotification`, so a no-op `sendNotification` is
 * provided.
 */

import { defineIntegration } from '@sapd/lumastra-plugin-sdk';
import type { PluginContext, NotificationEvent } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { DISCOGS_TOKEN_KEY } from '../../../../services/discogs-token.js';

export const discogsIntegration = defineIntegration({
    id: 'discogs',
    capabilities: { http: true, allowedDomains: ['api.discogs.com'] },

    settings: {
        fields: [
            {
                key: DISCOGS_TOKEN_KEY,
                type: 'secret',
                label: 'Discogs Token',
                description:
                    'Personal access token from discogs.com/settings/developers. ' +
                    'Enables Discogs as a music artist/album enrichment source.',
                default: '',
            },
        ],
    },

    // No-op: Discogs is a credential-only integration (no webhook / notifications).
    // defineIntegration requires at least one hook, so this satisfies the contract.
    async sendNotification(ctx: PluginContext, _event: NotificationEvent): Promise<void> {
        ctx.logger.debug('discogs: sendNotification is a no-op (credential-only integration)');
    },
});

// Self-register so the loadBuiltins() import is sufficient.
registry.registerIntegration(discogsIntegration);
