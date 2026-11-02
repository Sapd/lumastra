// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/setup/oidc-config — first-run only: configure OIDC from the setup
 * wizard (issuer / client id / secret / provider name), so the operator doesn't
 * have to hand-edit env vars + restart.
 *
 * Persists via saveConfig() → settings.json (the client secret sealed AES-256-GCM)
 * AND updates the in-memory config, so OIDC goes live in THIS process immediately
 * (getConfig reads the config service before env; the OIDC service re-reads config
 * per request). No restart — the wizard reloads and shows the "Sign in with …"
 * button.
 *
 * Guard: runs BEFORE any admin exists (the enable-OIDC step is pre-admin), so it
 * can't use requireAdmin — it is first-run-only (404 once an admin exists, like
 * oidc-test). This is the same first-run posture as native admin creation: an
 * un-onboarded instance exposed to the network can be claimed by whoever reaches
 * /setup first, so onboard before exposing. The endpoint only WRITES the values the
 * caller supplies (no secret is ever read back).
 *
 * Because any visitor can write here before the first admin exists, setup that
 * completes WITHOUT OIDC resets what was saved (`discardPreAdminOidcConfig`).
 * The admin check and the write hold `FIRST_ADMIN_LOCK_KEY`, the lock every
 * admin-bootstrap path takes, so no write can land after that reset.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { adminExists, FIRST_ADMIN_LOCK_KEY } from '$lib/server/database/queries/users.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import {
    BODY_TOO_LARGE,
    isDeclaredContentLengthOverCap,
    readBoundedBodyText,
} from '$lib/server/utils/bounded-body-reader.js';
import { saveConfig } from '$lib/server/config/config.service.js';
import { config } from '$lib/server/config.js';
import { probeOidcDiscovery, resetOidcConfigCache } from '$lib/server/services/oidc.service.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';
import * as m from '$lib/paraglide/messages';

const ENDPOINT = '/api/setup/oidc-config';

// Issuer, client id/secret, name, scopes, claim: never legitimately large.
const MAX_BODY_BYTES = 16 * 1024;

export const POST: RequestHandler = withErrorHandler(async (event) => {
    const { request } = event;
    const sql = await aiDbService.getSql();
    if (!sql) {
        return ApiResponses.error('Database unavailable', undefined, 503, ENDPOINT);
    }
    // First-run only: once an admin exists, OIDC is managed in Admin → Settings.
    if (await adminExists(sql, config.ADMIN_GROUPS)) {
        return ApiResponses.notFound('setup', ENDPOINT);
    }

    // Unauthenticated surface: same per-IP cap and body bound as native setup.
    const gate = await checkRateLimit(`setup-oidc:ip:${getClientIpStrict(event)}`, 20, 15 * 60);
    if (!gate.allowed) return ApiResponses.rateLimited(gate.resetAt * 1000, ENDPOINT);
    if (isDeclaredContentLengthOverCap(request, MAX_BODY_BYTES)) {
        return ApiResponses.payloadTooLarge();
    }
    const bodyText = await readBoundedBodyText(request, MAX_BODY_BYTES);
    if (bodyText === BODY_TOO_LARGE) return ApiResponses.payloadTooLarge();

    let body: unknown;
    try {
        body = JSON.parse(bodyText);
    } catch {
        return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
    }
    if (!isRecord(body)) {
        return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
    }

    const issuer = toStringOr(body.issuer, '').trim();
    const clientId = toStringOr(body.clientId, '').trim();
    const clientSecret = toStringOr(body.clientSecret, '').trim(); // '' = public PKCE client
    const providerName = toStringOr(body.providerName, '').trim() || 'Single Sign-On';
    const scopes = toStringOr(body.scopes, '').trim() || 'openid profile email';
    const groupsClaim = toStringOr(body.groupsClaim, '').trim() || 'groups';

    if (!issuer) {
        return ApiResponses.badRequest(m.setup_oidc_issuer_invalid(), undefined, ENDPOINT);
    }
    // https-only here; a plaintext test IdP still needs AUTH_OIDC_ALLOW_INSECURE,
    // which flips a process-global TLS setting and so stays env/restart-only.
    let issuerUrl: URL;
    try {
        issuerUrl = new URL(issuer);
    } catch {
        return ApiResponses.badRequest(m.setup_oidc_issuer_invalid(), undefined, ENDPOINT);
    }
    if (issuerUrl.protocol !== 'https:') {
        return ApiResponses.badRequest(m.setup_oidc_issuer_https(), undefined, ENDPOINT);
    }
    if (issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) {
        return ApiResponses.badRequest(m.setup_oidc_issuer_invalid(), undefined, ENDPOINT);
    }
    if (!clientId) {
        return ApiResponses.badRequest(m.setup_oidc_client_required(), undefined, ENDPOINT);
    }
    // "openid" is mandatory or the IdP returns no ID token (SSO would be broken).
    if (!scopes.split(/\s+/).includes('openid')) {
        return ApiResponses.badRequest(m.setup_oidc_scopes_required(), undefined, ENDPOINT);
    }

    const probe = await probeOidcDiscovery({ issuer, clientId, clientSecret, scopes, groupsClaim });
    if (!probe.ok) {
        return ApiResponses.badRequest(
            probe.error ?? m.setup_oidc_discovery_invalid(),
            undefined,
            ENDPOINT,
        );
    }

    const updates: Record<string, unknown> = {
        AUTH_OIDC_ENABLED: true,
        AUTH_OIDC_ISSUER: issuer,
        AUTH_OIDC_CLIENT_ID: clientId,
        AUTH_OIDC_PROVIDER_NAME: providerName,
        AUTH_OIDC_SCOPES: scopes,
        AUTH_OIDC_GROUPS_CLAIM: groupsClaim,
    };
    // Only write the secret when one was entered. Empty means either "public PKCE
    // client" (initial config → stays default '') or "keep the existing secret"
    // (edit → omitting the key leaves it untouched). Either way we never clear a
    // configured secret by leaving the field blank.
    if (clientSecret) {
        updates.AUTH_OIDC_CLIENT_SECRET = clientSecret;
    }
    const saved = await withTx(sql, async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${FIRST_ADMIN_LOCK_KEY}))`;
        // An admin created since the check above closed setup: refuse.
        if (await adminExists(tx, config.ADMIN_GROUPS)) return false;
        await saveConfig(updates);
        return true;
    });
    if (!saved) return ApiResponses.notFound('setup', ENDPOINT);
    // Drop any cached discovery so the next probe/login uses the new issuer.
    resetOidcConfigCache();

    return json({ ok: true });
});
