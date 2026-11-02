// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/plugin-webhooks/<integrationId> — inbound webhook for a plugin
// integration, delivered to its `handleWebhook`.
//
// Session-less by design: callers are external systems with no cookie. The
// per-integration `webhookSecret` (header `X-Plugin-Webhook-Secret`) is the
// authentication — see webhook-dispatch.ts for the two-gate rule and why an
// unconfigured integration answers 404 rather than 401.
//
// Lives at its own top-level path rather than under /api/plugins/* on purpose:
// every static segment there would shadow a feature plugin whose id happened to
// match it.

import type { RequestHandler } from './$types';
import { dispatchIntegrationWebhook } from '$lib/server/plugins/runtime/webhook-dispatch.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';

// authz: shared-secret — inbound webhooks come from external systems that hold
// no session; `dispatchIntegrationWebhook` authenticates each request against
// the integration's own `webhookSecret` in constant time and 404s unless the
// author declared `capabilities.webhook` AND an operator set that secret.
// Failed secret presentations are rate limited on the STRICT peer address —
// an X-Forwarded-For an attacker controls would let them rotate past the bucket.
export const POST: RequestHandler = async (event) =>
    dispatchIntegrationWebhook({
        integrationId: event.params.integrationId,
        request: event.request,
        clientIp: getClientIpStrict(event),
    });
