// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { dirname } from 'node:path';
import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { config, hasEmbeddingProvider } from '$lib/server/config.js';
import { getConfigPath } from '$lib/server/config/index.js';
import { getMasterKeySource, resolveMasterKey } from '$lib/server/crypto/master-key.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    adminExists,
    adminExistsIgnoringSetupLock,
} from '$lib/server/database/queries/users.queries.js';
import { getAllLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { getEmbeddingDimension } from '$lib/server/database/queries/onboarding.queries.js';
import { listPluginSecretKeys } from '$lib/server/database/queries/plugin-secrets.queries.js';
import {
    isForwardAuthEnabled,
    readDisabledForwardAuthHeaders,
    readRejectedForwardAuthPeer,
    readTrustedForwardAuthIdentity,
} from '$lib/server/middleware/forward-auth.js';
import { readProcNetRoute } from '$lib/server/utils/docker-gateway-trust.js';
import {
    findWideTrustedProxyRanges,
    runsOnKubernetes,
} from '$lib/server/utils/trusted-proxy-ranges.js';
import { forwardAuthRejectionView } from './forward-auth-rejection.js';
import {
    buildSetupEnvironment,
    buildSetupEnvironmentDetails,
    setupProxyState,
} from './setup-environment.js';
import { Logger } from '$lib/server/utils/logger.js';
import { forwardAuthTrustPosture } from '$lib/server/utils/client-ip.js';
import { hasForwardingHeaders, requestScheme } from '$lib/server/auth/cookie-transport.js';
import { runConfigRules } from '$lib/server/services/security-self-check/config-rules.js';
import { appPath } from '$lib/shared/api-urls.js';
import { isEnvOverridden } from '$lib/server/config/config.service.js';
import {
    SETUP_PREFERENCE_FIELDS,
    SETUP_PREFERENCE_KEYS,
    preferencesFromConfig,
    savedUseCases,
    type SetupPreferencesHydration,
} from '$lib/config/setup-preferences.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import { oidcCallbackUrl } from '$lib/server/auth/oidc-cookie.js';

/**
 * Step-3 values in force, so a resumed wizard shows (and re-saves) them rather
 * than client defaults. Env-locked fields are listed: saving them is a no-op,
 * so the wizard shows the env value and leaves them out of the request.
 */
function setupPreferencesHydration(): SetupPreferencesHydration {
    const effective = config as unknown as Record<string, unknown>;
    const snapshot = Object.fromEntries(
        Object.values(SETUP_PREFERENCE_KEYS).map((key) => [key, effective[key]]),
    );
    return {
        values: preferencesFromConfig(snapshot),
        envLocked: SETUP_PREFERENCE_FIELDS.filter((field) =>
            isEnvOverridden(SETUP_PREFERENCE_KEYS[field]),
        ),
        useCases: savedUseCases(config.INSTANCE_USE_CASES),
    };
}

/**
 * Loopback names/addresses where plain http is legitimate (local dev /
 * single-host). For a Host header this only describes how the browser reached
 * us — the client chooses it, so it must never decide what a visitor may see.
 */
function isLoopbackHost(hostname: string): boolean {
    const h = hostname.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, ''); // IPv6 brackets, v4-mapped
    return (
        h === 'localhost' ||
        h === '::1' ||
        h === '0:0:0:0:0:0:0:1' ||
        /^127(?:\.\d{1,3}){3}$/.test(h)
    );
}

/**
 * The request really comes from this machine: a loopback TCP peer with no
 * forwarding headers. (A reverse proxy on the same host is a loopback peer
 * too, but it adds X-Forwarded-For / Forwarded for the remote visitor.)
 */
function isLocalRequest(event: Parameters<PageServerLoad>[0]): boolean {
    let peer: string;
    try {
        peer = event.getClientAddress();
    } catch {
        return false;
    }
    return isLoopbackHost(peer) && !hasForwardingHeaders(event.request.headers);
}

const logger = Logger.for('SetupPage');

export const load: PageServerLoad = async (event) => {
    // The overview's Recheck button re-runs this load.
    event.depends('setup:environment');

    const sql = await aiDbService.getSql();
    // No database handle: whether setup is complete is unknown, so fail inert
    // like the read errors below — never treat it as "no admin yet" and hand
    // the wizard and its proxy diagnostics to whoever asks.
    if (!sql) throw redirect(303, appPath('/'));

    // Onboarding is first-run only. Once an admin exists the route is normally
    // inert — bounce home so it can never be used to create a rogue admin later.
    // EXCEPTION: an authenticated admin who hasn't finished onboarding (no library
    // yet) is allowed to RESUME the guided steps. This is how an OIDC sign-in — which
    // round-trips out of the SPA through the IdP and back — continues into
    // preferences → library → scan instead of being dumped on the dashboard.
    // Everyone else (anonymous, or already-onboarded) is still bounced — except
    // on a LOCKED install that has lost every admin (ruling S-C5c-2): there the
    // visitor is sent to /setup/locked, which explains the two recoveries
    // instead of silently landing on a home page nobody can administer.
    //
    // The DB reads are wrapped so a transient error fails INERT (redirect home)
    // rather than 500-ing a signed-in admin. The redirect throws below live OUTSIDE
    // the try so SvelteKit's redirect signal is never swallowed by the catch.
    let hasAdmin: boolean;
    let lockedWithoutAdmin = false;
    let hasLibrary: boolean;
    let hasDiscogsToken: boolean;
    let hasLastfmKey: boolean;
    try {
        hasAdmin = await adminExists(sql, config.ADMIN_GROUPS);
        if (hasAdmin && !localsIsAdmin(event.locals)) {
            lockedWithoutAdmin = !(await adminExistsIgnoringSetupLock(sql, config.ADMIN_GROUPS));
        }
        hasLibrary = hasAdmin ? (await getAllLibraryPaths(sql)).length > 0 : false;
        const secretKeys = await listPluginSecretKeys(sql);
        // The token now lives on the shared `discogs` integration; still
        // recognize a legacy per-task copy so upgraded installs show it set.
        hasDiscogsToken = secretKeys.some(
            (k) =>
                k.key === 'DISCOGS_TOKEN' &&
                (k.pluginId === 'discogs' ||
                    k.pluginId === 'artist-enrichment' ||
                    k.pluginId === 'album-enrichment'),
        );
        hasLastfmKey = secretKeys.some(
            (k) => k.pluginId === 'music-popularity' && k.key === 'LASTFM_API_KEY',
        );
    } catch {
        throw redirect(303, appPath('/'));
    }

    let resume = false;
    if (hasAdmin) {
        const authedAdmin = localsIsAdmin(event.locals);
        if (authedAdmin && !hasLibrary) {
            resume = true;
        } else if (lockedWithoutAdmin) {
            throw redirect(303, appPath('/setup/locked'));
        } else {
            throw redirect(303, appPath('/'));
        }
    }

    // Detect (trusted) forward-auth headers so the wizard can surface them and
    // pre-highlight the forward-auth path.
    const fa = readTrustedForwardAuthIdentity(event);

    // Identity headers that arrived from an UNTRUSTED peer were discarded above.
    // Say so — with the peer address and the TRUSTED_PROXY_IPS line to add —
    // instead of "no headers detected". Reaching this point already means a
    // pre-admin first run or an authenticated admin resuming it (everyone else
    // was redirected above); the explicit gate keeps that true if the redirect
    // logic ever changes.
    const rejectedPeer = fa === null ? readRejectedForwardAuthPeer(event) : null;
    const forwardAuthRejected = forwardAuthRejectionView({
        identityAccepted: fa !== null,
        mayShowDiagnostics: !hasAdmin || (resume && localsIsAdmin(event.locals)),
        rejectedPeer,
        procNetRoute: rejectedPeer ? readProcNetRoute() : null,
    });

    // A trusted proxy IS sending identity headers but FORWARD_AUTH_ENABLED is off,
    // so they were ignored. Same disclosure gate as the rejected-peer callout.
    const mayShowForwardAuthDiagnostics = !hasAdmin || (resume && localsIsAdmin(event.locals));
    const forwardAuthDisabledHeaders =
        fa === null && mayShowForwardAuthDiagnostics && readDisabledForwardAuthHeaders(event);

    // Transport posture for the native-login session cookie (Secure unless the
    // request shows plain HTTP, see cookie-transport.ts). Warn on plain http
    // (non-loopback), and when a proxy reports https from an address outside
    // TRUSTED_PROXY_IPS, so its forwarded headers are ignored. A GET carries no
    // Origin, so a request with no forwarding headers at all counts as plain
    // http here: adapter-node never terminates TLS itself. Loopback http
    // (local dev / single-host) is legitimate → 'ok'.
    const xfProto = (event.request.headers.get('x-forwarded-proto') ?? '')
        .split(',')[0]
        .trim()
        .toLowerCase();
    const scheme = requestScheme(event);
    const transport: 'ok' | 'proxy-https-app-http' | 'plaintext' =
        scheme === 'https' || isLoopbackHost(event.url.hostname)
            ? 'ok'
            : xfProto === 'https'
              ? 'proxy-https-app-http'
              : scheme === 'http' ||
                  (scheme === null && !hasForwardingHeaders(event.request.headers))
                ? 'plaintext'
                : 'ok';

    // The /setup page is served pre-admin (first-run only — redirects once an
    // admin exists), so anyone reaching a fresh, un-onboarded instance sees this
    // payload. Only expose the absolute server config path to a TRUSTED context:
    // a request carrying trusted forward-auth headers (the real operator behind
    // their proxy) or a loopback caller (local / single-host setup). A remote,
    // header-less drive-by gets null and the page shows generic backup guidance.
    // Loopback is judged on the TCP peer, not the client-chosen Host header.
    const trustedContext = fa !== null || isLocalRequest(event);

    // Install overview for the top of step 1: optional services, storage, live
    // nodes and how requests arrive. Purely informational, so a failure hides
    // the panel instead of breaking the wizard. Paths, URLs and node placement
    // only in the same trusted context as the config path.
    const embeddingDimension = await getEmbeddingDimension(sql).catch(() => null);
    const environment = await buildSetupEnvironment({
        proxy: setupProxyState(event),
        https: scheme === 'https',
        trustedContext,
        sql,
        embeddingDimension,
        // Recheck re-runs this load as a data request; the builder rate-limits it.
        fresh: event.isDataRequest,
    }).catch((err: unknown) => {
        logger.warn('Setup install overview failed', { error: String(err) });
        return null;
    });
    // ffmpeg's capabilities: streamed, so the first probe never holds the page.
    const environmentDetails = buildSetupEnvironmentDetails().catch(() => null);

    // OIDC onboarding: when an SSO provider is already configured, the first
    // user can onboard by signing in (they must be in an admin group).
    const oidcEnabled =
        config.AUTH_OIDC_ENABLED &&
        config.AUTH_OIDC_ISSUER.length > 0 &&
        config.AUTH_OIDC_CLIENT_ID.length > 0;

    // Surface the same OIDC config sanity checks the security self-check runs
    // (TLS-insecure, scopes missing "openid", missing client secret, unsafe
    // link-by-username) right in the wizard — parity with the forward-auth path,
    // which already warns inline about proxy-trust + transport posture. Only the
    // actionable fail/warn findings are shown; passes/skips are noise here.
    //
    // We pass the stable finding `id` + `status` so the client can render a
    // translated (paraglide) message per id; `fallback` carries the English
    // self-check text for any future OIDC finding the wizard hasn't localized yet.
    const oidcIssues = oidcEnabled
        ? runConfigRules()
              .filter((f) => f.method === 'oidc' && (f.status === 'fail' || f.status === 'warn'))
              .map((f) => ({
                  id: f.id,
                  status: f.status as 'fail' | 'warn',
                  fallback: f.remediation ? `${f.detail} ${f.remediation}` : f.detail,
              }))
        : [];

    // Resolution can back-fill process.env even for a file key. Use the cached
    // provenance, never the presence of LUMASTRA_MASTER_KEY, for backup guidance.
    resolveMasterKey();

    return {
        forwardAuth: fa ? { username: fa.username, groups: fa.groups, isAdmin: fa.isAdmin } : null,
        // Identity headers received from an untrusted peer: { peer, peerIsGateway }.
        forwardAuthRejected,
        // FORWARD_AUTH_ENABLED: the forward-auth path needs it; the wizard tells
        // the operator to set it instead of "no headers detected".
        forwardAuthEnabled: isForwardAuthEnabled(),
        forwardAuthDisabledHeaders,
        // TRUSTED_PROXY_IPS ranges wider than /24: every device in them could send
        // the identity headers. Same disclosure gate as the other proxy callouts.
        // Not on Kubernetes, where the documented pod range sits behind a
        // NetworkPolicy (the self-check still reports it there).
        wideTrustedProxyRanges:
            mayShowForwardAuthDiagnostics && !runsOnKubernetes()
                ? (findWideTrustedProxyRanges(process.env.TRUSTED_PROXY_IPS)?.wide ?? [])
                : [],
        adminGroups: config.ADMIN_GROUPS,
        environment,
        environmentDetails,
        // 'allowlist' (TRUSTED_PROXY_IPS pinned) | 'trust-any' | 'fail-closed'.
        proxyPosture: forwardAuthTrustPosture(),
        transport,
        // Config directory — the backup nudge points operators at it.
        // Gated to a trusted context so it isn't leaked to anonymous visitors.
        configDir: trustedContext ? dirname(getConfigPath()) : null,
        // Only provenance crosses the boundary, never key material.
        masterKeySource: getMasterKeySource(),
        oidcEnabled,
        oidcProviderName: config.AUTH_OIDC_PROVIDER_NAME,
        oidcCallbackUrl: oidcCallbackUrl(event.url.origin),
        // Non-secret OIDC config, so the wizard's config form can pre-fill on edit.
        // (The client secret is write-only — never sent to the client.)
        oidcConfig: {
            issuer: config.AUTH_OIDC_ISSUER,
            clientId: config.AUTH_OIDC_CLIENT_ID,
            scopes: config.AUTH_OIDC_SCOPES,
            groupsClaim: config.AUTH_OIDC_GROUPS_CLAIM,
            hasSecret: config.AUTH_OIDC_CLIENT_SECRET.length > 0,
        },
        // Actionable OIDC config warnings, shown inline when OIDC is configured.
        oidcIssues,
        // True when an already-authenticated admin is resuming onboarding (e.g. just
        // signed in via OIDC) — the wizard skips the auth steps and starts at
        // preferences.
        resume,
        // Saved step-3 preferences + use cases (see setupPreferencesHydration).
        preferences: setupPreferencesHydration(),
        // The DB's locked pgvector dimension — the embedding config form pins the
        // provider's output to it (see the endpoint). null if unreadable.
        embeddingDimension,
        // Which integrations already have a key (so the form shows a masked
        // placeholder instead of prompting from scratch). Secrets are never sent.
        integrations: {
            hasTmdb: config.TMDB_API_KEY.trim().length > 0,
            hasMdblist: config.MDBLIST_API_KEY.trim().length > 0,
            // Only consumer is the setup summary checklist (+page.svelte) — this
            // drives whether the "Embeddings" row reads as done. A bare
            // EMBEDDING_BASE_URL with no EMBEDDING_API_KEY cannot embed, so it
            // must not read as configured here.
            hasEmbedding: hasEmbeddingProvider(),
            // Discogs/Last.fm are plugin secrets (per-task settings store), not env
            // config — checked via plugin_secrets above rather than `config.*`.
            hasDiscogsToken,
            hasLastfmKey,
        },
        jellyfinCompat: config.FEATURE_JELLYFIN_COMPAT,
        subsonicCompat: config.FEATURE_SUBSONIC_COMPAT,
        // Effective value (ENV > settings.json > default), so a resumed wizard
        // shows what is in force instead of re-asserting the default.
        publicApi: config.FEATURE_DEVICE_AUTH,
        // Current metadata-language config, so a RESUMED wizard (resume: true —
        // admin exists, no library yet) hydrates from what's saved instead of
        // re-deriving a browser-locale guess that would silently overwrite a
        // previously-saved TMDB_LANGUAGE on Finish/Skip. `tmdbLanguage` is null
        // when effectively unset — i.e. equal to the schema default 'en-US':
        // saveConfig drops default-equal keys from settings.json, so
        // "explicitly set to the default" is unrepresentable in persisted state
        // and the default-compare is exactly as informative as an override
        // check. Null tells the client to fall back to its locale-based guess.
        // The additional list is the EFFECTIVE config (the getter normalizes,
        // dedupes and drops primary-equal entries) — that's what a re-save
        // would persist, so it's the right thing to display.
        metadataLanguage: {
            tmdbLanguage:
                isEnvOverridden('TMDB_LANGUAGE') || config.TMDB_LANGUAGE !== 'en-US'
                    ? config.TMDB_LANGUAGE
                    : null,
            tmdbLanguageLocked: isEnvOverridden('TMDB_LANGUAGE'),
            additionalLanguages: config.METADATA_ADDITIONAL_LANGUAGES,
        },
        // AI assistant (chat) — 'auto' has no UI representation, so it's shown as
        // 'openai' (the effective default when no provider is picked). Keys are
        // never sent, only whether one is already set (masked-placeholder hint).
        assistant: {
            enabled: config.FEATURE_AI_ASSISTANT,
            provider: config.ASSISTANT_PROVIDER === 'auto' ? 'openai' : config.ASSISTANT_PROVIDER,
            hasOpenaiKey: config.OPENAI_CHAT_API_KEY.trim().length > 0,
            hasAnthropicKey: config.ANTHROPIC_API_KEY.trim().length > 0,
            openaiModel: config.OPENAI_CHAT_MODEL,
            anthropicModel: config.ANTHROPIC_CHAT_MODEL,
        },
    };
};
