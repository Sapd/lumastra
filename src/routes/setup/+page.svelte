<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { scanProgressLabel } from './scan-progress-label';
    import { onDestroy, onMount, tick } from 'svelte';
    import { page } from '$app/stores';
    import { invalidate } from '$app/navigation';
    import { toasts } from '$lib/stores/toast.store';
    import { url } from '$lib/paths';
    import { estimatePasswordStrength, PASSWORD_MIN_LENGTH } from '$lib/shared/password-strength';
    import {
        AUTH_FAILURE_ERROR_PARAM,
        AUTH_FAILURE_REF_PARAM,
        formatAuthFailureBanner,
    } from '$lib/shared/auth-failure-ref';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import { normalizeLanguageTag, isPrimaryLanguageTag } from '$lib/shared/metadata-language';
    import { resolveTmdbLanguagePrefill } from './metadata-language-prefill';
    import { checkProxyBypasses as probeProxyBypasses, type BypassCheck } from './proxy-bypass';
    import { initialSetupMethod, recommendedSetupMethod } from './setup-method';
    import { libraryTypeForFolderName } from '$lib/shared/library-folder-names';
    import { z } from 'zod';
    import { apiGet, apiPost, apiPut } from '$lib/api/client.js';
    import {
        Icon,
        ShieldCheck,
        Key,
        CheckCircle,
        ExclamationTriangle,
        ArrowPath,
        ArrowLeft,
        ArrowRight,
        Film,
        Sparkles,
        BuildingLibrary,
        CircleStack,
        GlobeAlt,
        CpuChip,
        Eye,
        EyeSlash,
        Plus,
    } from 'svelte-hero-icons';
    import Toggle from '$lib/components/ui/Toggle.svelte';
    import { presetPreferenceDefaults, type UseCaseId } from '$lib/config/use-case-presets.js';
    import type {
        SetupPreferenceField,
        SetupPreferencesHydration,
    } from '$lib/config/setup-preferences.js';
    import UseCaseTiles from '$lib/components/setup/UseCaseTiles.svelte';
    import SetupEnvironment from '$lib/components/setup/SetupEnvironment.svelte';
    import AudiobookshelfSetupCard, {
        type AddedAudiobookshelfLibrary,
    } from '$lib/components/setup/AudiobookshelfSetupCard.svelte';
    import type {
        SetupEnvironment as SetupEnvironmentData,
        SetupEnvironmentDetails,
    } from '$lib/shared/setup-environment';
    import * as m from '$lib/paraglide/messages';
    import {
        dependencyCheckText,
        type DependencyFindingView,
    } from '$lib/utils/dependency-check-text.js';

    interface ForwardAuthIdentity {
        username: string;
        groups: string[];
        isAdmin: boolean;
    }

    interface PageData {
        forwardAuth: ForwardAuthIdentity | null;
        /** Identity headers that arrived from an untrusted peer (pre-admin only). */
        forwardAuthRejected: { peer: string; peerIsGateway: boolean } | null;
        forwardAuthEnabled: boolean;
        forwardAuthDisabledHeaders: boolean;
        /** TRUSTED_PROXY_IPS entries wider than /24 (pre-admin only). */
        wideTrustedProxyRanges: string[];
        adminGroups: string[];
        /** Install overview for step 1; null when it could not be built. */
        environment: SetupEnvironmentData | null;
        /** Its slower half (ffmpeg), streamed. */
        environmentDetails: Promise<SetupEnvironmentDetails | null> | null;
        proxyPosture: 'allowlist' | 'trust-any' | 'fail-closed';
        transport: 'ok' | 'proxy-https-app-http' | 'plaintext';
        configDir: string | null;
        masterKeySource: 'env' | 'file' | 'generated' | 'none';
        oidcEnabled: boolean;
        oidcProviderName: string;
        oidcCallbackUrl: string;
        oidcConfig: OidcConfig;
        oidcIssues: OidcIssue[];
        resume: boolean;
        /** Step-3 values in force (seeded on resume and for env-locked fields). */
        preferences: SetupPreferencesHydration;
        embeddingDimension: number | null;
        integrations: {
            hasTmdb: boolean;
            hasMdblist: boolean;
            hasEmbedding: boolean;
            hasDiscogsToken: boolean;
            hasLastfmKey: boolean;
        };
        jellyfinCompat: boolean;
        subsonicCompat: boolean;
        publicApi: boolean;
        metadataLanguage: {
            tmdbLanguage: string | null;
            tmdbLanguageLocked?: boolean;
            additionalLanguages: string[];
        };
        assistant: {
            enabled: boolean;
            provider: 'openai' | 'anthropic';
            hasOpenaiKey: boolean;
            hasAnthropicKey: boolean;
            openaiModel: string;
            anthropicModel: string;
        };
    }

    interface OidcConfig {
        issuer: string;
        clientId: string;
        scopes: string;
        groupsClaim: string;
        hasSecret: boolean;
    }

    interface OidcIssue {
        // Stable security-self-check finding id (e.g. 'oidc.allow-insecure'),
        // mapped to a localized message below.
        id: string;
        status: 'fail' | 'warn';
        // English self-check text, shown verbatim for any id not yet localized.
        fallback: string;
    }

    let { data }: { data: PageData } = $props();

    // First-run OIDC onboarding: signing in provisions the first admin (if the user
    // is in an admin group). The OIDC CALLBACK routes a first-run sign-in back to
    // /setup (returnTo can't carry /setup — sanitizeRedirect rejects it), where the
    // load detects the now-authenticated, library-less admin and RESUMES the wizard
    // at preferences → library → scan, instead of dropping them on the dashboard.
    const oidcSetupHref = url('/auth/oidc/login?returnTo=%2F');

    // Map a security-self-check OIDC finding id to its localized message; fall
    // back to the server's English text for any id the wizard hasn't localized.
    function oidcIssueText(issue: OidcIssue): string {
        switch (issue.id) {
            case 'oidc.allow-insecure':
                return m.setup_warn_oidc_insecure();
            case 'oidc.scopes-missing-openid':
                return m.setup_warn_oidc_scopes();
            case 'oidc.missing-client':
                return m.setup_warn_oidc_client();
            case 'oidc.link-by-username':
                return m.setup_warn_oidc_link_username();
            default:
                return issue.fallback;
        }
    }

    // ---- Step 1: OIDC discovery probe ("Test connection") ----
    interface OidcProbe {
        ok: boolean;
        error?: string;
        insecure: boolean;
        requestedScopes: string[];
        issuer?: string;
        scopesSupported?: string[];
        missingScopes?: string[];
        supportsPkceS256?: boolean;
        supportsBackchannelLogout?: boolean;
        groupsClaim?: string;
        claimsSupported?: string[];
        groupsClaimAdvertised?: boolean;
        emailAdvertised?: boolean;
        preferredUsernameAdvertised?: boolean;
        endpoints?: {
            authorization?: string;
            token?: string;
            userinfo?: string;
            jwks?: string;
            endSession?: string;
        };
    }
    let oidcTesting = $state(false);
    let oidcProbe = $state<OidcProbe | null>(null);

    const OidcProbeSchema = z
        .object({
            ok: z.boolean(),
            error: z.string().optional(),
            insecure: z.boolean(),
            requestedScopes: z.array(z.string()),
            issuer: z.string().optional(),
            scopesSupported: z.array(z.string()).optional(),
            missingScopes: z.array(z.string()).optional(),
            supportsPkceS256: z.boolean().optional(),
            supportsBackchannelLogout: z.boolean().optional(),
            groupsClaim: z.string().optional(),
            claimsSupported: z.array(z.string()).optional(),
            groupsClaimAdvertised: z.boolean().optional(),
            emailAdvertised: z.boolean().optional(),
            preferredUsernameAdvertised: z.boolean().optional(),
            endpoints: z
                .object({
                    authorization: z.string().optional(),
                    token: z.string().optional(),
                    userinfo: z.string().optional(),
                    jwks: z.string().optional(),
                    endSession: z.string().optional(),
                })
                .optional(),
        })
        .passthrough();

    async function testOidc(): Promise<void> {
        if (oidcTesting) return;
        oidcTesting = true;
        oidcProbe = null;
        const { data, error } = await apiGet('/api/setup/oidc-test', OidcProbeSchema);
        oidcTesting = false;
        oidcProbe = error
            ? { ok: false, error, insecure: false, requestedScopes: [] }
            : (data ?? { ok: false, error: '', insecure: false, requestedScopes: [] });
    }

    // Exact redirect/callback URL to register at the IdP, shown in the "enable
    // OIDC" guidance when OIDC isn't configured yet. Resolved like the login route.
    const oidcCallbackUrl = $derived(data.oidcCallbackUrl);

    // ---- Step 2c: configure OIDC (pre-filled on edit from the non-secret config) ----
    function initialOidcIssuer(): string {
        return data.oidcConfig.issuer;
    }

    function initialOidcClientId(): string {
        return data.oidcConfig.clientId;
    }

    function initialOidcProviderName(): string {
        return data.oidcEnabled ? data.oidcProviderName : '';
    }

    function initialOidcScopes(): string {
        return data.oidcConfig.scopes;
    }

    function initialOidcGroupsClaim(): string {
        return data.oidcConfig.groupsClaim;
    }

    let oidcCfgIssuer = $state(initialOidcIssuer());
    let oidcCfgClientId = $state(initialOidcClientId());
    let oidcCfgClientSecret = $state(''); // write-only; blank keeps the existing secret
    let oidcCfgProviderName = $state(initialOidcProviderName());
    let oidcCfgScopes = $state(initialOidcScopes());
    let oidcCfgGroupsClaim = $state(initialOidcGroupsClaim());
    let oidcCfgSaving = $state(false);
    let oidcCfgError = $state('');

    const oidcCfgValid = $derived(
        oidcCfgIssuer.trim().length > 0 && oidcCfgClientId.trim().length > 0,
    );

    const OidcConfigSaveSchema = z.object({ ok: z.boolean().optional() }).passthrough();

    async function saveOidcConfig(): Promise<void> {
        if (oidcCfgSaving || !oidcCfgValid) return;
        oidcCfgSaving = true;
        oidcCfgError = '';
        const { data: res, error } = await apiPost('/api/setup/oidc-config', OidcConfigSaveSchema, {
            issuer: oidcCfgIssuer.trim(),
            clientId: oidcCfgClientId.trim(),
            clientSecret: oidcCfgClientSecret,
            providerName: oidcCfgProviderName.trim(),
            scopes: oidcCfgScopes.trim(),
            groupsClaim: oidcCfgGroupsClaim.trim(),
        });
        oidcCfgSaving = false;
        if (error || !res?.ok) {
            oidcCfgError = error || m.setup_oidc_cfg_failed();
            return;
        }
        // OIDC applies live in-process; reload so the wizard re-renders with the
        // "Sign in with …" button + Test connection.
        window.location.reload();
    }

    // Re-open the config form from the already-configured state (fix a typo, etc.).
    function editOidcConfig(): void {
        oidcCfgError = '';
        oidcCfgClientSecret = '';
        step = '2c';
    }

    // Error surfaced by a server redirect back to /setup — e.g. the OIDC callback
    // bounces here with ?error=… when the first sign-in isn't in an admin group.
    // Without showing it the user lands back on step 1 with no idea why.
    // Vetted + ref-annotated by the shared formatter: the query parameters are
    // attacker-reachable, so the message is allowlisted and the correlation ref is
    // shape-checked before either is rendered. The "(reference: …)" suffix is what
    // an operator quotes in a bug report — it matches the server log line that
    // says WHY the first sign-in wasn't accepted.
    const setupError = $derived(
        formatAuthFailureBanner(
            $page.url.searchParams.get(AUTH_FAILURE_ERROR_PARAM),
            $page.url.searchParams.get(AUTH_FAILURE_REF_PARAM),
        ),
    );

    const appName = $derived($page.data?.branding?.appName ?? 'Lumastra');
    const logoFull = $derived($page.data?.branding?.logoFull as string | undefined);

    // Transport (secure-cookie) warning text, or null when fine.
    const transportWarning = $derived(
        data.transport === 'proxy-https-app-http'
            ? m.setup_warn_transport_mixed({ appName })
            : data.transport === 'plaintext'
              ? m.setup_warn_transport_plaintext({ appName })
              : null,
    );

    // Forward-auth proxy-trust warning: headers are only safe when the proxy IP
    // is pinned. 'fail-closed' (nothing set) can lock you out post-onboarding;
    // 'trust-any' is spoofable if the app is directly reachable.
    const proxyPostureWarning = $derived(
        data.proxyPosture === 'fail-closed'
            ? m.setup_warn_proxy_failclosed()
            : data.proxyPosture === 'trust-any'
              ? m.setup_warn_proxy_trustany({ appName })
              : null,
    );

    type Method = 'forward-auth' | 'native' | 'oidc';
    type Step = 'install' | 1 | '2a' | '2b' | '2c' | 3 | 4 | 5;

    // Recommendation order (setup-method.ts): OIDC configured → OIDC; a
    // forward-auth identity from a TRUSTED peer → forward auth; otherwise
    // built-in login. Pre-selecting an unconfigured OIDC card would let a plain
    // Docker install continue straight into a sign-in method that doesn't work.
    // When OIDC IS configured the recommended action is the "Sign in with …"
    // button above the cards, so NOTHING is pre-selected (null) — the two
    // fallback cards read as equal alternatives, and Continue stays disabled
    // until one is picked. Otherwise the recommended card is pre-selected and
    // carries the "Recommended" badge (see the choice cards below).
    const recommendedMethod = $derived(
        recommendedSetupMethod({
            oidcEnabled: data.oidcEnabled,
            forwardAuthDetected: data.forwardAuth !== null,
        }),
    );
    function initialMethod(): Method | null {
        return initialSetupMethod({
            oidcEnabled: data.oidcEnabled,
            forwardAuthDetected: data.forwardAuth !== null,
        });
    }

    // The install overview opens the wizard once per tab. A reload (saving the
    // OIDC config reloads) or a sign-in error coming back goes straight to the
    // sign-in step, and without an overview to show there is nothing to stop for.
    const INSTALL_SEEN_KEY = 'lumastra:setup-install-seen';

    function installStepSeen(): boolean {
        try {
            return sessionStorage.getItem(INSTALL_SEEN_KEY) === '1';
        } catch {
            return false;
        }
    }

    function initialStep(): Step {
        if (data.resume) return 3;
        if (setupError || !data.environment || installStepSeen()) return 1;
        return 'install';
    }

    function goFromInstall(): void {
        try {
            sessionStorage.setItem(INSTALL_SEEN_KEY, '1');
        } catch {
            // Private mode or blocked storage: a reload shows the overview again.
        }
        step = 1;
    }

    let method = $state<Method | null>(initialMethod());
    // Resume mode (e.g. just signed in via OIDC): auth is already done, so start at
    // preferences (step 3) rather than the sign-in chooser.
    let step = $state<Step>(initialStep());

    // Each step replaces the whole card, so the button that was used is gone and
    // focus would fall back to <body>. Move it to the new step's heading so a
    // keyboard or screen-reader user starts there and hears which step this is.
    let stepFocusArmed = false;
    $effect(() => {
        void step;
        if (!stepFocusArmed) {
            stepFocusArmed = true; // not on first render
            return;
        }
        void tick().then(() => {
            const heading = document.querySelector<HTMLElement>('.setup-title');
            if (!heading) return;
            heading.tabIndex = -1;
            heading.focus();
        });
    });

    // The visible step number: the install overview is 1, sign-in 2 (2a/2b/2c are
    // all "step 3"), preferences 4, and the library step and its scanning sub-view
    // are both 5.
    const stepNumber = $derived(
        step === 'install' ? 1 : step === 1 ? 2 : step === 3 ? 4 : step === 4 || step === 5 ? 5 : 3,
    );

    // ---- Step 2B: create admin account ----
    const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}$/;
    let newUsername = $state('');
    let newPassword = $state('');
    let confirmPassword = $state('');
    let creating = $state(false);
    let nativeError = $state('');
    let showPassword = $state(false);
    let showConfirmPassword = $state(false);

    const usernameValid = $derived(USERNAME_RE.test(newUsername));
    const showUsernameHint = $derived(newUsername.length > 0 && !usernameValid);
    const strength = $derived(estimatePasswordStrength(newPassword));
    const passwordsMismatch = $derived(
        confirmPassword.length > 0 && newPassword !== confirmPassword,
    );
    const canCreateAdmin = $derived(
        usernameValid &&
            strength.acceptable &&
            newPassword === confirmPassword &&
            confirmPassword.length > 0,
    );

    // Fill colour for the strength meter, keyed by score (0-1 red, 2 amber,
    // 3 lime, 4 green).
    const STRENGTH_COLORS: Record<number, string> = {
        0: 'meter-red',
        1: 'meter-red',
        2: 'meter-amber',
        3: 'meter-lime',
        4: 'meter-green',
    };
    const strengthColor = $derived(STRENGTH_COLORS[strength.score]);

    // ---- Step 2A: forward-auth verification ----
    let verifyingForwardAuth = $state(false);

    // ---- Step 3: finish + preferences ----
    let tmdbKey = $state('');
    let finishing = $state(false);

    // ---- Step 3: metadata language (TMDB_LANGUAGE + METADATA_ADDITIONAL_LANGUAGES) ----
    // Hydrated from the saved config when one exists (data.metadataLanguage —
    // essential on the resume path, where a second pass through step 3 must not
    // silently revert a previously-saved value to a browser-locale guess);
    // otherwise prefilled from the wizard's own UI locale via the shared
    // REGION_PREFERENCE map ('de' -> 'de-DE', 'en' -> 'en-US'). The operator can
    // clear/change both freely.
    // Deliberate one-time snapshot of the load() payload, same as the sibling
    // wizard fields (jellyfinCompatEnabled etc.).
    // svelte-ignore state_referenced_locally
    let tmdbLanguage = $state(
        resolveTmdbLanguagePrefill(data.metadataLanguage.tmdbLanguage, getLocale()),
    );
    const primaryLanguageError = $derived(
        !data.metadataLanguage.tmdbLanguageLocked &&
            tmdbLanguage.trim() !== data.metadataLanguage.tmdbLanguage?.trim() &&
            tmdbLanguage.trim() &&
            !normalizeLanguageTag(tmdbLanguage)
            ? m.setup_metadata_lang_error()
            : null,
    );
    // svelte-ignore state_referenced_locally
    let metadataAdditionalLanguages = $state(data.metadataLanguage.additionalLanguages.join(', '));

    // Mirrors the server-side rules (config.service.ts's `normalizedLanguageSet` +
    // schema.ts's `languageTags` validation): normalize each comma-separated
    // entry, drop ones equal to the primary language, dedupe, cap at 3. Empty
    // input is valid (nothing typed yet) — only malformed tags or an over-3 count
    // after normalization surface an inline error.
    const additionalLanguagesValidation = $derived.by<{
        normalized: string[];
        error: string | null;
    }>(() => {
        const rawEntries = metadataAdditionalLanguages
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        if (rawEntries.length === 0) return { normalized: [], error: null };

        const invalid: string[] = [];
        const seen: string[] = [];
        const primary = tmdbLanguage.trim() || undefined;
        for (const raw of rawEntries) {
            const normalized = normalizeLanguageTag(raw);
            if (!normalized) {
                invalid.push(raw);
                continue;
            }
            if (isPrimaryLanguageTag(normalized, primary)) continue;
            if (!seen.includes(normalized)) seen.push(normalized);
        }
        if (invalid.length > 0) {
            return {
                normalized: seen,
                error: m.setup_metadata_additional_error_invalid({ tags: invalid.join(', ') }),
            };
        }
        if (seen.length > 3) {
            return { normalized: seen, error: m.setup_metadata_additional_error_max() };
        }
        return { normalized: seen, error: null };
    });

    // ---- Step 3: optional integrations (MDBList + embeddings) ----
    let mdblistKey = $state('');
    // Discogs (artist enrichment) + Last.fm (music popularity) are plugin secrets,
    // not env config — persisted via PUT /api/v1/tasks/{id}/settings, not
    // /api/setup/integrations. See persistStep3().
    let discogsToken = $state('');
    let lastfmKey = $state('');
    let embeddingProvider = $state<'' | 'openai' | 'voyage' | 'custom'>('');
    let embeddingKey = $state('');
    let embeddingEndpoint = $state('');
    let embeddingModel = $state('');
    let embeddingTesting = $state(false);
    let embeddingTestResult = $state<{
        ok: boolean;
        error?: string;
        dimension?: number;
        expected?: number;
        matches?: boolean;
    } | null>(null);

    const EmbeddingTestSchema = z
        .object({
            ok: z.boolean(),
            error: z.string().optional(),
            dimension: z.number().optional(),
            expected: z.number().optional(),
            matches: z.boolean().optional(),
        })
        .passthrough();

    // Same as onChatProviderChange: a key typed for one provider must never be
    // tested against, or saved for, another provider's (or a custom) endpoint.
    function onEmbeddingProviderChange(): void {
        embeddingKey = '';
        embeddingEndpoint = '';
        embeddingModel = '';
        embeddingTestResult = null;
    }

    async function testEmbedding(): Promise<void> {
        if (embeddingTesting || !embeddingProvider || !embeddingKey.trim()) return;
        embeddingTesting = true;
        embeddingTestResult = null;
        const { data, error } = await apiPost('/api/setup/embedding-test', EmbeddingTestSchema, {
            provider: embeddingProvider,
            apiKey: embeddingKey,
            endpoint: embeddingEndpoint.trim() || undefined,
            model: embeddingModel.trim() || undefined,
        });
        embeddingTesting = false;
        embeddingTestResult = error
            ? { ok: false, error }
            : (data ?? { ok: false, error: m.setup_embed_test_failed() });
    }

    // ---- Step 3: inline TMDB/MDBList key tests ----
    // Same idea as the embedding/chat test buttons: verify the key against the
    // real provider BEFORE saving, instead of failing silently into "posters
    // missing later". A blank field tests the already-configured key (if any).
    let integrationTesting = $state<'' | 'tmdb' | 'mdblist'>('');
    let integrationTestResult = $state<{
        provider: 'tmdb' | 'mdblist';
        ok: boolean;
        error?: string;
    } | null>(null);

    const IntegrationTestSchema = z
        .object({ ok: z.boolean(), error: z.string().optional() })
        .passthrough();

    async function testIntegration(provider: 'tmdb' | 'mdblist'): Promise<void> {
        if (integrationTesting) return;
        const typed = provider === 'tmdb' ? tmdbKey.trim() : mdblistKey.trim();
        const hasStored =
            provider === 'tmdb' ? data.integrations.hasTmdb : data.integrations.hasMdblist;
        if (!typed && !hasStored) return;
        integrationTesting = provider;
        integrationTestResult = null;
        const { data: result, error } = await apiPost(
            '/api/setup/integration-test',
            IntegrationTestSchema,
            { provider, apiKey: typed || undefined },
        );
        integrationTesting = '';
        integrationTestResult = {
            provider,
            ok: !error && result?.ok === true,
            error: error || result?.error,
        };
    }

    // ---- Step 3: AI assistant (chat) ----
    // FEATURE_AI_ASSISTANT defaults to true globally (an install that sets a chat
    // key via env before running the wizard expects it ON out of the box) — but
    // showing that same default in the WIZARD, with no key configured yet, flips
    // the toggle on with nothing to power it. Mirror the TMDB/MDBList
    // "already configured" pattern: only default the wizard's toggle on when a
    // chat provider key already exists.
    function initialAssistantEnabled(): boolean {
        return data.assistant?.hasOpenaiKey || data.assistant?.hasAnthropicKey || false;
    }

    function initialChatProvider(): 'openai' | 'anthropic' {
        return data.assistant?.provider ?? 'openai';
    }

    const assistantEnabledDefault = initialAssistantEnabled();
    let assistantEnabled = $state(assistantEnabledDefault);
    let chatProvider = $state<'openai' | 'anthropic'>(initialChatProvider());
    let chatApiKey = $state('');
    let chatModel = $state('');
    // True once the operator explicitly picks a chat provider. Combined with the
    // other signals below into `assistantTouched` — we only persist the assistant
    // section when the operator actually engaged with it, so a wizard run (or
    // re-run) never clobbers an existing config (e.g. forcing ASSISTANT_PROVIDER
    // off its 'auto' default, which the provider <select> can't represent).
    let providerChosen = $state(false);
    const assistantTouched = $derived(
        // `initialAssistantEnabled` is a FUNCTION: comparing the boolean against
        // it (no parens) is never equal, so `assistantTouched` was always true.
        assistantEnabled !== assistantEnabledDefault ||
            providerChosen ||
            chatApiKey.trim() !== '' ||
            chatModel.trim() !== '',
    );
    // Does a chat key already exist for the currently-selected provider?
    const hasExistingChatKey = $derived(
        chatProvider === 'openai'
            ? (data.assistant?.hasOpenaiKey ?? false)
            : (data.assistant?.hasAnthropicKey ?? false),
    );
    // Live "Test chat" probe of the entered provider/key/model (mirrors the
    // embedding test) — sends one tiny message and reports the reply or error.
    let chatTesting = $state(false);
    let chatTestResult = $state<{
        ok: boolean;
        error?: string;
        model?: string;
        reply?: string;
    } | null>(null);

    const AssistantTestSchema = z
        .object({
            ok: z.boolean(),
            error: z.string().optional(),
            model: z.string().optional(),
            reply: z.string().optional(),
        })
        .passthrough();

    async function testChat(): Promise<void> {
        if (chatTesting || !chatApiKey.trim()) return;
        chatTesting = true;
        chatTestResult = null;
        // Fall back to the provider's default model (the field's placeholder) so a
        // blank model tests exactly what the saved config would use. Computed before
        // the destructure below — naming that result `data` would shadow the page
        // `data` prop referenced here (temporal-dead-zone ReferenceError).
        const model =
            chatModel.trim() ||
            (chatProvider === 'openai'
                ? data.assistant?.openaiModel
                : data.assistant?.anthropicModel) ||
            undefined;
        const { data: result, error } = await apiPost(
            '/api/setup/assistant-test',
            AssistantTestSchema,
            { provider: chatProvider, apiKey: chatApiKey, model },
        );
        chatTesting = false;
        chatTestResult = error
            ? { ok: false, error }
            : (result ?? { ok: false, error: m.setup_assistant_test_failed({ error: '' }) });
    }

    // Reset the shared key/model fields when the provider changes, so an OpenAI
    // key typed under 'openai' can't be submitted verbatim as an Anthropic key.
    function onChatProviderChange(): void {
        providerChosen = true;
        chatApiKey = '';
        chatModel = '';
        chatTestResult = null;
    }

    // ---- Step 3: use-case selection ----
    // A resumed wizard (reload, or back from an OIDC sign-in) starts from what an
    // earlier pass saved — every step-3 value below is seeded from `data.preferences`
    // then, so Save/Skip re-sends the operator's choices instead of the defaults.
    // First run keeps the defaults, except fields an env var owns (shown as set).
    function seededFromSaved(field: SetupPreferenceField): boolean {
        return data.resume || data.preferences.envLocked.includes(field);
    }
    function initialUseCases(): UseCaseId[] {
        const saved = data.preferences.useCases;
        return data.resume && saved.length > 0 ? saved : ['vod'];
    }
    let useCaseSelection = $state<string[]>(initialUseCases());
    function toggleUseCase(id: string): void {
        useCaseSelection = useCaseSelection.includes(id)
            ? useCaseSelection.filter((s) => s !== id)
            : [...useCaseSelection, id];
    }

    // Content families the picked use cases imply — these gate which step-3
    // sections render (a music-only instance shouldn't see trickplay/Jellyfin;
    // a movies-only instance shouldn't see lyrics/Discogs/Subsonic). An EMPTY
    // selection fails open: everything shows, nothing is silently hidden.
    // 'enterprise' covers home videos/training — video-family content.
    const wantsVideo = $derived(
        useCaseSelection.length === 0 ||
            useCaseSelection.includes('vod') ||
            useCaseSelection.includes('enterprise'),
    );
    const wantsMusic = $derived(
        useCaseSelection.length === 0 || useCaseSelection.includes('music'),
    );

    // Jump-nav for the (long) personalize step: one chip per section, mirroring
    // the same family gating as the sections themselves. Gives the orientation
    // benefit of a multi-step wizard without splitting the optional config into
    // more mandatory-feeling steps.
    const step3Sections = $derived.by<Array<{ id: string; label: string }>>(() => {
        const sections = [
            { id: 'setup-sec-integrations', label: m.setup_integrations_group() },
            { id: 'setup-sec-assistant', label: m.setup_assistant_group() },
            { id: 'setup-sec-apps', label: m.setup_apps_group() },
            { id: 'setup-sec-license', label: m.setup_license_group() },
        ];
        if (wantsVideo) {
            sections.push({ id: 'setup-sec-hardware', label: m.setup_group_hardware() });
        }
        sections.push(
            { id: 'setup-sec-scanning', label: m.setup_group_scanning() },
            { id: 'setup-sec-privacy', label: m.setup_group_privacy() },
        );
        if (wantsVideo) {
            sections.push({ id: 'setup-sec-jellyfin', label: m.setup_jf_group() });
        }
        sections.push({ id: 'setup-sec-extcompat', label: m.setup_jfcompat_group() });
        return sections;
    });

    function jumpToSection(id: string): void {
        const el = document.getElementById(id);
        if (!el) return;
        // Collapsed <details> sections open before scrolling, so the jump never
        // lands on a closed summary line.
        if (el instanceof HTMLDetailsElement) el.open = true;
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Optional preferences offered on the final step. Defaults mirror the config
    // schema defaults, so leaving them untouched changes nothing.
    function savedPrefs(): SetupPreferencesHydration['values'] {
        return data.preferences.values;
    }
    function initialPref<T>(field: SetupPreferenceField, value: T, fallback: T): T {
        return seededFromSaved(field) ? value : fallback;
    }
    let instanceName = $state(initialPref('appName', savedPrefs().appName, ''));
    let trickplay = $state(initialPref('trickplayEnabled', savedPrefs().trickplayEnabled, false));
    let metadataAlongside = $state(
        initialPref(
            'metadataStorageLocation',
            savedPrefs().metadataStorageLocation !== 'central',
            false,
        ),
    );
    // Audience and new-account sharing are separate choices.
    let shareActivity = $state(
        initialPref('shareActivityBetweenUsers', savedPrefs().shareActivityBetweenUsers, true),
    );
    let defaultActivitySharing = $state(
        initialPref('defaultActivitySharing', savedPrefs().defaultActivitySharing, true),
    );
    let unrated = $state(
        initialPref('unratedContentVisible', savedPrefs().unratedContentVisible, false),
    );

    // Four of the preference toggles are ALSO written by the use-case
    // projection (WIZARD_PREFERENCE_OVERLAP_KEYS). Their displayed value is the
    // value that projection would write, so the operator sees the preset's
    // intent — picking "Movies & TV" shows the intro analyser and unavailable
    // titles already ON — instead of a hardcoded default that contradicts it.
    // An explicit flip overrides the seed (`null` = untouched) and, because
    // persistStep3 sends the preferences write LAST, actually sticks.
    const presetPrefs = $derived(presetPreferenceDefaults(useCaseSelection as UseCaseId[]));
    // Seeded as an override only where the saved value deviates from what the
    // saved use cases' preset projects, so switching a use case still re-seeds
    // the toggles the operator left alone.
    function initialOverride(field: SetupPreferenceField, presetValue: boolean): boolean | null {
        const value = savedPrefs()[field];
        return seededFromSaved(field) && typeof value === 'boolean' && value !== presetValue
            ? value
            : null;
    }
    const initialPreset = presetPreferenceDefaults(initialUseCases());
    let introAnalyzerOverride = $state<boolean | null>(
        initialOverride('introAnalyzer', initialPreset.PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED),
    );
    let autoLyricsOverride = $state<boolean | null>(
        initialOverride('autoLyrics', initialPreset.FEATURE_AUTO_LYRICS),
    );
    let gravatarOverride = $state<boolean | null>(
        initialOverride('gravatar', initialPreset.FEATURE_GRAVATAR),
    );
    let showUnavailableMediaOverride = $state<boolean | null>(
        initialOverride('showUnavailableMedia', initialPreset.SHOW_UNAVAILABLE_MEDIA),
    );
    const introAnalyzer = $derived(
        introAnalyzerOverride ?? presetPrefs.PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED,
    );
    const autoLyrics = $derived(autoLyricsOverride ?? presetPrefs.FEATURE_AUTO_LYRICS);
    const gravatar = $derived(gravatarOverride ?? presetPrefs.FEATURE_GRAVATAR);
    const showUnavailableMedia = $derived(
        showUnavailableMediaOverride ?? presetPrefs.SHOW_UNAVAILABLE_MEDIA,
    );
    // Weekly licence check-in to lumastra.org (default on; renewal is unaffected).
    // Always seeded from the value in force, not only on resume: it is a
    // privacy opt-out, and a fresh pass must not write ON over an earlier OFF.
    let licenseCheckIn = $state(savedPrefs().licenseCheckIn ?? true);
    const licenseCheckInEnvLocked = $derived(data.preferences.envLocked.includes('licenseCheckIn'));
    // Every call to lumastra.org (licence, check-in, push relay token). Off runs
    // the install on the free tier at once. Seeded from the value in force, like
    // the check-in, so a fresh pass never writes ON over an earlier OFF.
    let licenseServerContact = $state(savedPrefs().licenseServerContact ?? true);
    const licenseServerContactEnvLocked = $derived(
        data.preferences.envLocked.includes('licenseServerContact'),
    );
    // OIDC back-channel logout cascade — only shown when OIDC is already enabled.
    let bclCascade = $state(
        initialPref('backchannelLogoutCascade', savedPrefs().backchannelLogoutCascade, false),
    );

    // ---- Step 3: optional Jellyfin connection ----
    let jellyfinUrl = $state('');
    let jellyfinApiKey = $state('');
    let jellyfinTesting = $state(false);
    let jellyfinResult = $state<{
        connected: boolean;
        serverName?: string;
        version?: string;
        adminUsername?: string;
        adminMatched?: boolean;
        matchedName?: string | null;
        syncStarted?: boolean;
        error?: string;
    } | null>(null);

    const canTestJellyfin = $derived(
        jellyfinUrl.trim().length > 0 && jellyfinApiKey.trim().length > 0 && !jellyfinTesting,
    );

    // Validate + save the Jellyfin connection. The endpoint probes the entered
    // creds before persisting (so bad creds are never saved) and reports whether
    // the admin's own username matches a Jellyfin user (a mismatch silently skips
    // their history import). Creds apply live — no restart.
    const JellyfinTestSchema = z
        .object({
            connected: z.boolean(),
            error: z.string().optional(),
            syncStarted: z.boolean().optional(),
        })
        .passthrough();

    async function testJellyfin(): Promise<void> {
        if (!canTestJellyfin) return;
        jellyfinTesting = true;
        jellyfinResult = null;
        const { data, error } = await apiPost('/api/setup/jellyfin', JellyfinTestSchema, {
            url: jellyfinUrl.trim(),
            apiKey: jellyfinApiKey.trim(),
        });
        jellyfinTesting = false;
        jellyfinResult = error
            ? { connected: false, error: m.setup_jf_failed() }
            : (data ?? { connected: false, error: m.setup_jf_failed() });
    }

    // ---- Step 3: external client compatibility (/j Jellyfin-compat, /subsonic) ----
    function initialJellyfinCompatEnabled(): boolean {
        return data.jellyfinCompat ?? true;
    }

    function initialSubsonicEnabled(): boolean {
        return data.subsonicCompat ?? false;
    }

    let jellyfinCompatEnabled = $state(initialJellyfinCompatEnabled());
    let subsonicEnabled = $state(initialSubsonicEnabled());

    // ---- Step 3: Public API (FEATURE_DEVICE_AUTH) — native apps + third-party
    // clients. Hydrated from the effective config (default ON), same one-time
    // snapshot as the compat toggles above.
    function initialPublicApiEnabled(): boolean {
        return data.publicApi ?? true;
    }
    let publicApiEnabled = $state(initialPublicApiEnabled());

    // GPU auto-detection (probed when we reach step 3).
    let gpuLoading = $state(true);
    let gpuSuggestionApplied = false;
    const GpuHostSchema = z.object({
        id: z.string(),
        hostname: z.string(),
        local: z.boolean(),
        transcodeEligible: z.boolean(),
        gpus: z.array(z.string()),
        recommended: z.string().nullable(),
        verified: z.boolean(),
    });
    let gpu = $state<{
        hostname: string;
        ffmpegReady: boolean;
        recommended: string | null;
        recommendedVendor: string | null;
        inContainer: boolean;
        driPresent: boolean;
        hosts: z.infer<typeof GpuHostSchema>[];
        onlyLocalHost: boolean;
        recommendedHost: string | null;
        recommendationVerified: boolean;
        modeConflict: boolean;
    } | null>(null);
    // On resume, the saved choice: detection must not re-enable hardware
    // transcoding an operator turned off (or never confirmed) on an earlier pass.
    // (A function, not `data.resume` inline: detectGpu's own `data` shadows the prop.)
    function isResumed(): boolean {
        return data.resume;
    }
    function initialUseGpu(): boolean {
        return data.resume ? savedPrefs().gpuAcceleration !== 'none' : false;
    }
    let useGpu = $state(initialUseGpu());

    // Background-worker availability — without a worker, an added library never
    // scans. Checked when we reach step 3; re-checkable after the operator fixes it.
    let workerStatus = $state<{ available: boolean; detail: string } | null>(null);
    let checkingWorker = $state(false);

    const WorkerStatusSchema = z.object({
        available: z.boolean(),
        source: z.string(),
        detail: z.string().optional(),
    });

    async function checkWorker(): Promise<void> {
        checkingWorker = true;
        const { data } = await apiGet('/api/admin/worker-status', WorkerStatusSchema);
        checkingWorker = false;
        if (data && typeof data.available === 'boolean') {
            workerStatus = { available: data.available, detail: data.detail ?? '' };
        }
    }

    // ---- Step 3: optional-dependency reachability (music embedder, Live TV proxy,
    //      *arr/download/request services) + config-volume mount. Non-blocking: a
    //      configured-but-unreachable service is a hint, not a gate. ----
    let depChecks = $state<DependencyFindingView[] | null>(null);
    let depLoading = $state(false);

    const DependencyCheckSchema = z.object({
        checks: z.array(
            z.object({
                id: z.string(),
                name: z.string(),
                status: z.enum(['pass', 'warn']),
                url: z.string().optional(),
                count: z.number().optional(),
            }),
        ),
    });

    async function checkDependencies(): Promise<void> {
        depLoading = true;
        const { data } = await apiGet('/api/setup/dependency-check', DependencyCheckSchema);
        depLoading = false;
        depChecks = data?.checks ?? [];
    }

    // Combine local encoder probes and cluster host reports, pre-arming the
    // GPU toggle once. Re-checking never replaces the operator's choice.
    const GpuDetectSchema = z.object({
        hostname: z.string(),
        hosts: z.array(GpuHostSchema).optional(),
        onlyLocalHost: z.boolean().optional(),
        recommendedHost: z.string().nullable().optional(),
        recommendationVerified: z.boolean().optional(),
        modeConflict: z.boolean().optional(),
        ffmpegReady: z.boolean().optional(),
        recommended: z.string().nullable().optional(),
        recommendedVendor: z.string().nullable().optional(),
        candidates: z
            .array(
                z.object({
                    accel: z.string(),
                    encoder: z.string(),
                    vendor: z.string(),
                    works: z.boolean(),
                }),
            )
            .optional(),
        inContainer: z.boolean().optional(),
        driPresent: z.boolean().optional(),
    });

    async function detectGpu(): Promise<void> {
        gpuLoading = true;
        const { data } = await apiGet('/api/setup/gpu-detect', GpuDetectSchema);
        gpuLoading = false;
        if (data) {
            gpu = {
                hostname: data.hostname,
                ffmpegReady: data.ffmpegReady ?? false,
                recommended: data.recommended ?? null,
                recommendedVendor: data.recommendedVendor ?? null,
                inContainer: data.inContainer ?? false,
                driPresent: data.driPresent ?? false,
                hosts: data.hosts ?? [],
                onlyLocalHost: data.onlyLocalHost ?? true,
                recommendedHost: data.recommendedHost ?? null,
                recommendationVerified: data.recommendationVerified ?? false,
                modeConflict: data.modeConflict ?? false,
            };
            if (!isResumed() && !gpuSuggestionApplied && data.recommended) {
                useGpu = data.recommendationVerified === true;
                gpuSuggestionApplied = true;
            }
        } else {
            gpu = {
                hostname: '',
                ffmpegReady: false,
                recommended: null,
                recommendedVendor: null,
                inContainer: false,
                driPresent: false,
                hosts: [],
                onlyLocalHost: true,
                recommendedHost: null,
                recommendationVerified: false,
                modeConflict: false,
            };
        }
    }

    // ---- Step 3: reverse-proxy bypass self-check (forward-auth deployments) ----
    let proxyBypassChecks = $state<BypassCheck[] | null>(null);
    const gatedSurfaces = $derived((proxyBypassChecks ?? []).filter((c) => c.gated));

    async function checkProxyBypasses(): Promise<void> {
        if (!data.forwardAuth && method !== 'forward-auth') return;
        proxyBypassChecks = await probeProxyBypasses(url);
    }

    function selectMethod(next: Method): void {
        method = next;
    }

    // From the forward-auth "no headers detected" screen: fall back to the
    // built-in login form directly, rather than just pre-selecting the method
    // on a step-1 chooser the operator isn't shown here.
    function useBuiltInLogin(): void {
        method = 'native';
        step = '2b';
    }

    function goFromStep1(): void {
        if (method === null) return; // nothing picked (OIDC-configured, no fallback chosen)
        nativeError = '';
        step = method === 'forward-auth' ? '2a' : method === 'oidc' ? '2c' : '2b';
    }

    // A setup submit in flight resolves into a step change (step 3 on success);
    // leaving its step first would let that stale response land on another one.
    const authSubmitting = $derived(creating || verifyingForwardAuth);

    function backToStep1(): void {
        if (authSubmitting) return;
        step = 1;
    }

    function reloadPage(): void {
        window.location.reload();
    }

    const SetupResponseSchema = z.object({}).passthrough();

    // Setup completed without SSO, so the server dropped OIDC settings saved while
    // no admin existed (anyone could have saved them). Say so: the operator may
    // have entered them on step 2c and expect SSO to be on.
    function warnIfOidcDiscarded(res: Record<string, unknown> | null): void {
        if (res?.oidcConfigDiscarded === true) toasts.warning(m.setup_toast_oidc_discarded());
    }

    async function confirmForwardAuth(): Promise<void> {
        if (verifyingForwardAuth) return;
        verifyingForwardAuth = true;
        const { data: res, error } = await apiPost('/api/auth/native/setup', SetupResponseSchema, {
            method: 'forward-auth',
        });
        verifyingForwardAuth = false;
        if (!error) {
            warnIfOidcDiscarded(res);
            step = 3;
            void checkWorker();
            void detectGpu();
            void checkDependencies();
            void checkProxyBypasses();
        } else {
            toasts.error(error || m.setup_toast_fwd_failed());
        }
    }

    async function createAdmin(): Promise<void> {
        if (creating || !canCreateAdmin) return;
        nativeError = '';
        creating = true;
        const {
            data: res,
            error,
            status,
        } = await apiPost('/api/auth/native/setup', SetupResponseSchema, {
            method: 'native',
            username: newUsername.trim(),
            password: newPassword,
        });
        creating = false;
        if (!error) {
            warnIfOidcDiscarded(res);
            // Session cookie is now set; finish onboarding before redirecting.
            step = 3;
            void checkWorker();
            void detectGpu();
            void checkDependencies();
            void checkProxyBypasses();
        } else if (status === 409) {
            // Setup already completed — typically our own earlier submit whose
            // response was lost (the session cookie may already be set). Reload:
            // the load resumes the wizard for that admin, or sends anyone else home.
            window.location.reload();
        } else {
            nativeError = error || m.setup_toast_admin_failed();
            toasts.error(nativeError);
        }
    }

    const TmdbKeySchema = z.object({ warning: z.string().optional() }).passthrough();
    const InstanceProfileSetupSchema = z.object({}).passthrough();
    const AssistantSetupSchema = z.object({ ok: z.boolean().optional() }).passthrough();
    const TaskSecretSchema = z.object({}).passthrough();

    // Persists everything typed on step 3 (preferences, TMDB key, MDBList/embedding
    // integrations, use-case profile, AI assistant, Discogs/Last.fm secrets).
    // Shared by finishSetup() (Save & continue → step 4) AND skipToLibrary() (Skip
    // for now → straight to /admin/library/sources) — skip must NOT silently
    // discard already-typed keys or the toggles the operator was shown, so both
    // paths save first.
    // Returns false (without persisting anything) when a required-but-missing key
    // guard fires, so the caller can keep the operator on step 3 to fix it.
    // Keep metadata-critical saves on step 3; optional failures also appear
    // in the step-4 recap so it cannot report them as set up.
    let step3SaveError = $state('');
    let failedSaves = $state<Partial<Record<SaveGroup, boolean>>>({});
    type SaveGroup = 'prefs' | 'tmdb' | 'integrations' | 'assistant' | 'discogs' | 'lastfm';

    // An env var owns these keys, so the server would skip them anyway: leave
    // them out so the request says what will actually be saved.
    function omitEnvLocked(body: Record<string, unknown>): Record<string, unknown> {
        const locked = new Set<string>(data.preferences.envLocked);
        return Object.fromEntries(Object.entries(body).filter(([field]) => !locked.has(field)));
    }

    async function persistStep3(): Promise<boolean> {
        if (finishing) return false;
        step3SaveError = '';
        if (primaryLanguageError) {
            toasts.warning(primaryLanguageError);
            return false;
        }
        // A provider is picked but the key is blank — don't silently drop it (it
        // would look like AI was configured when nothing was saved). Prompt to
        // fill it or switch back to Off.
        if (embeddingProvider && !embeddingKey.trim()) {
            toasts.warning(m.setup_embed_key_required());
            return false;
        }
        // Same trap for the assistant: enabling it without a key (typed or already
        // stored for the chosen provider) would flip FEATURE_AI_ASSISTANT on while
        // it stays dark. Only guard when the operator actually engaged with the
        // section (assistantTouched) — an untouched default isn't persisted.
        if (assistantTouched && assistantEnabled && !chatApiKey.trim() && !hasExistingChatKey) {
            toasts.warning(m.setup_assistant_key_required());
            return false;
        }
        // Don't silently drop or truncate an invalid/over-limit additional-languages
        // entry — surface it and keep the operator on step 3 to fix it, same as the
        // guards above.
        if (additionalLanguagesValidation.error) {
            toasts.warning(additionalLanguagesValidation.error);
            return false;
        }
        finishing = true;

        const key = tmdbKey.trim();
        const embedding =
            embeddingProvider && embeddingKey.trim()
                ? {
                      provider: embeddingProvider,
                      apiKey: embeddingKey,
                      endpoint: embeddingEndpoint.trim() || undefined,
                      model: embeddingModel.trim() || undefined,
                  }
                : undefined;
        const hasIntegrations = Boolean(mdblistKey.trim() || embedding);
        const discogs = discogsToken.trim();
        const lastfm = lastfmKey.trim();

        // The use-case projection goes FIRST, on its own. It is NOT independent of
        // the preferences write: it projects every managed key, four of which the
        // preferences step also owns as visible toggles
        // (WIZARD_PREFERENCE_OVERLAP_KEYS). Run concurrently, both reached the
        // same saveConfig() write lock and the later one silently won, so a VOD
        // install's SHOW_UNAVAILABLE_MEDIA / intro analyser came out preset-valued
        // or toggle-valued by timing alone — and the step-4 recap, which reads the
        // toggles, could describe a config that was never saved. Awaiting it here
        // makes the preferences write below the last writer, so the toggle the
        // operator actually saw wins. (It is seeded from the same projection, so
        // an untouched toggle still lands on the preset's value.)
        //
        // The integrations (embedding provider) go before it: the projection
        // turns embedding-backed music features on only when a provider is
        // configured, and the profile records what it projected — so projecting
        // first left a music install with an embedding key showing "re-apply
        // to turn on" notices on its first visit to Admin → Instance.
        const [integrationsSettled] = await Promise.allSettled([
            hasIntegrations
                ? apiPost('/api/setup/integrations', SetupResponseSchema, {
                      mdblistApiKey: mdblistKey.trim() || undefined,
                      embedding,
                  })
                : Promise.resolve(null),
        ]);
        const embeddingSaveFailed =
            Boolean(embedding) &&
            (integrationsSettled.status === 'rejected' ||
                Boolean(integrationsSettled.value?.error));
        const integrationWarning =
            integrationsSettled.status === 'fulfilled'
                ? integrationsSettled.value?.data?.warning
                : undefined;
        if (typeof integrationWarning === 'string') toasts.warning(integrationWarning);
        const [profileSettled] = await Promise.allSettled([
            apiPost('/api/admin/instance-profile', InstanceProfileSetupSchema, {
                useCases: useCaseSelection,
            }),
        ]);

        // The remaining writes are independent of one another, so run them
        // concurrently. Metadata-critical failures block advancing; optional
        // integrations warn. Discogs/Last.fm are plugin secrets (not env config),
        // so they go through the generic task-settings endpoint rather than
        // /api/setup/integrations.
        const [prefsSettled, tmdbSettled, assistantSettled, discogsSettled, lastfmSettled] =
            await Promise.allSettled([
                apiPost(
                    '/api/setup/preferences',
                    SetupResponseSchema,
                    omitEnvLocked({
                        appName: instanceName.trim() || undefined,
                        // Only flip GPU on when a working encoder was verified AND the
                        // operator left the toggle enabled; otherwise stay on CPU.
                        // Omitted unless detection found a working encoder (still running,
                        // or none found), so a save can't overwrite the saved choice.
                        gpuAcceleration: gpu?.recommended
                            ? useGpu
                                ? gpu.recommended
                                : 'none'
                            : undefined,
                        trickplayEnabled: trickplay,
                        introAnalyzer,
                        autoLyrics,
                        metadataStorageLocation: metadataAlongside
                            ? savedPrefs().metadataStorageLocation === 'central'
                                ? 'alongside-prefer'
                                : savedPrefs().metadataStorageLocation
                            : 'central',
                        gravatar,
                        shareActivityBetweenUsers: shareActivity,
                        defaultActivitySharing,
                        unratedContentVisible: unrated,
                        showUnavailableMedia,
                        // Only meaningful with OIDC; the toggle is only shown then.
                        backchannelLogoutCascade: data.oidcEnabled ? bclCascade : undefined,
                        jellyfinCompat: jellyfinCompatEnabled,
                        subsonicCompat: subsonicEnabled,
                        publicApi: publicApiEnabled,
                        licenseCheckIn,
                        licenseServerContact,
                        // Blank (deliberately cleared) keeps the effective TMDB_LANGUAGE
                        // instead of writing an empty value over it.
                        tmdbLanguage:
                            data.metadataLanguage.tmdbLanguageLocked ||
                            tmdbLanguage.trim() === data.metadataLanguage.tmdbLanguage?.trim()
                                ? undefined
                                : tmdbLanguage.trim() || undefined,
                        // Already normalized + deduped + primary-filtered by
                        // additionalLanguagesValidation above; send the same
                        // comma-separated shape the admin Settings ArrayInput submits.
                        // Omitted entirely when empty so an untouched field never
                        // overwrites an existing value.
                        metadataAdditionalLanguages:
                            additionalLanguagesValidation.normalized.length > 0
                                ? additionalLanguagesValidation.normalized.join(', ')
                                : undefined,
                    }),
                ),
                key
                    ? apiPost('/api/admin/tmdb-key', TmdbKeySchema, { key })
                    : Promise.resolve(null),
                // Only persist the assistant when the operator engaged with it —
                // an untouched section must not overwrite an existing config
                // (e.g. collapse ASSISTANT_PROVIDER's 'auto' to 'openai').
                assistantTouched
                    ? apiPost('/api/setup/assistant', AssistantSetupSchema, {
                          enabled: assistantEnabled,
                          provider: chatProvider,
                          apiKey: chatApiKey.trim() || undefined,
                          model: chatModel.trim() || undefined,
                      })
                    : Promise.resolve(null),
                discogs
                    ? // The Discogs token lives on the shared `discogs` integration
                      // (used by both artist- and album-enrichment), not per-task.
                      apiPut('/api/admin/plugins/discogs/settings', TaskSecretSchema, {
                          settings: { DISCOGS_TOKEN: discogs },
                      })
                    : Promise.resolve(null),
                lastfm
                    ? apiPut('/api/v1/tasks/music-popularity/settings', TaskSecretSchema, {
                          secrets: { LASTFM_API_KEY: lastfm },
                      })
                    : Promise.resolve(null),
            ]);

        const failed = (r: PromiseSettledResult<{ error: string | null } | null>): boolean =>
            r.status === 'rejected' || Boolean(r.value?.error);
        // This endpoint returns 409 only when an environment variable owns the
        // TMDB key. That effective key is already in use, so it need not block.
        const tmdbEnvLocked =
            tmdbSettled.status === 'fulfilled' && tmdbSettled.value?.status === 409;
        failedSaves = {
            prefs: failed(prefsSettled),
            tmdb: Boolean(key) && !tmdbEnvLocked && failed(tmdbSettled),
            integrations: hasIntegrations && failed(integrationsSettled),
            assistant: assistantTouched && failed(assistantSettled),
            discogs: Boolean(discogs) && failed(discogsSettled),
            lastfm: Boolean(lastfm) && failed(lastfmSettled),
        };
        if (failedSaves.prefs) toasts.warning(m.setup_toast_prefs_failed());
        const tmdbSaveError =
            tmdbSettled.status === 'fulfilled' && tmdbSettled.value?.status === 422
                ? tmdbSettled.value.error
                : null;
        const tmdbWarning =
            tmdbSettled.status === 'fulfilled' ? tmdbSettled.value?.data?.warning : undefined;
        if (tmdbWarning) toasts.warning(tmdbWarning);
        if (failedSaves.tmdb) toasts.warning(tmdbSaveError ?? m.setup_toast_tmdb_failed());
        if (tmdbEnvLocked) toasts.info(m.setup_tmdb_env_locked());
        step3SaveError = failedSaves.tmdb
            ? (tmdbSaveError ?? m.setup_toast_tmdb_failed())
            : failedSaves.prefs
              ? m.setup_toast_prefs_failed()
              : '';
        if (failedSaves.integrations) {
            toasts.warning(
                embeddingSaveFailed
                    ? integrationsSettled.status === 'fulfilled'
                        ? (integrationsSettled.value?.error ?? m.setup_embedding_save_failed())
                        : m.setup_embedding_save_failed()
                    : m.setup_toast_integrations_failed(),
            );
        }
        if (failed(profileSettled)) toasts.warning(m.setup_toast_profile_failed());
        if (failedSaves.assistant) toasts.warning(m.setup_toast_assistant_failed());
        if (failedSaves.discogs) toasts.warning(m.setup_toast_discogs_failed());
        if (failedSaves.lastfm) toasts.warning(m.setup_toast_lastfm_failed());

        finishing = false;
        return !step3SaveError && !embeddingSaveFailed;
    }

    async function finishSetup(): Promise<void> {
        if (!(await persistStep3())) return;
        // Advance to the guided "add your first library" step rather than
        // dropping the operator into the admin library page cold.
        // A music-only instance has exactly one sensible media type — preselect
        // it. Video stays an explicit choice (movie vs tv is ambiguous).
        if (!libraryMediaType && wantsMusic && !wantsVideo) libraryMediaType = 'music';
        step = 4;
        void loadMountCandidates();
    }

    async function skipToLibrary(): Promise<void> {
        // Step 3 may hold typed API keys / preferences — persist them (same as
        // Save & continue) before leaving, so "Skip for now" only skips the
        // guided library/scan steps, never the operator's already-typed input or
        // the wizard's safer defaults. Step 4's own "skip" (no library added yet)
        // has nothing left to persist here — step 3 already ran.
        if (step === 3 && !(await persistStep3())) return;
        window.location.assign(url('/admin/library/sources'));
    }

    // ---- Step 4: add media libraries (one or more) ----
    // Labels are functions so they follow the UI locale (same keys the server
    // uses for the default library group name). No Audiobooks: these are folder
    // libraries, the scanner imports audio only in music libraries, and
    // audiobooks come from AudiobookShelf (the server refuses the combination).
    const LIBRARY_MEDIA_TYPES = [
        { id: 'movie', label: () => m.setup_library_default_name_movie() },
        { id: 'tv', label: () => m.setup_library_default_name_tv() },
        { id: 'anime', label: () => m.setup_library_default_name_anime() },
        { id: 'music', label: () => m.setup_library_default_name_music() },
    ] as const;
    type LibraryMediaType = (typeof LIBRARY_MEDIA_TYPES)[number]['id'];

    interface AddedLibrary {
        /** Folder path; for an Audiobookshelf library its `abs://<id>` sentinel (list key only). */
        path: string;
        mediaType: LibraryMediaType | 'audiobook';
        label: string;
        runId: string | null;
        /** Set for an Audiobookshelf library: the upstream id and its name to show. */
        remote?: { id: string; name: string };
    }

    let libraryPath = $state('');
    // No default type — force an explicit choice so nobody scans a music/photo
    // folder as "Movies" and gets an empty library.
    let libraryMediaType = $state<LibraryMediaType | ''>('');
    let libraryCreating = $state(false);
    let libraryError = $state('');
    // Libraries added so far this wizard run. A common install needs more than
    // one (Movies + Series is the default combo) — the form stays open after each
    // add instead of jumping straight to the scan-progress step.
    let addedLibraries = $state<AddedLibrary[]>([]);
    const addedTypesLabel = $derived(
        Array.from(new Set(addedLibraries.map((l) => l.label))).join(', '),
    );

    const LibrarySetupSchema = z
        .object({
            ok: z.boolean().optional(),
            readable: z.boolean().optional(),
            runId: z.string().optional(),
            scanStarted: z.boolean().optional(),
            notDirectory: z.boolean().optional(),
            conflict: z.string().optional(),
            existingMediaType: z.string().optional(),
        })
        .passthrough();

    // Detected candidate media folders (server-side readdir of fixed roots like
    // /data, /media, /mnt) — offered as suggested libraries so the operator
    // doesn't have to type container paths blind.
    let mountCandidates = $state<Array<{ path: string; entries: number }>>([]);
    let mountsLoaded = false;
    // True while the first probe runs, so the found-folders list holds its place
    // above the manual form instead of appearing later and pushing the form down.
    let mountsLoading = $state(false);
    const MountsSchema = z.object({
        candidates: z.array(z.object({ path: z.string(), entries: z.number() })),
    });
    async function loadMountCandidates(): Promise<void> {
        if (mountsLoaded) return;
        mountsLoaded = true;
        mountsLoading = true;
        const { data } = await apiGet('/api/setup/library-mounts', MountsSchema);
        mountsLoading = false;
        // A failed probe may be retried on the next visit to the library step.
        if (!data) mountsLoaded = false;
        mountCandidates = data?.candidates ?? [];
        // Preselect what we can name and what has content; the rest waits for a
        // type (a "kids" folder can hold movies or series).
        // A reload keeps what the operator already chose for a folder.
        for (const c of mountCandidates) {
            if (c.path in suggestionTypes) continue;
            const guessed = guessLibraryType(c.path);
            suggestionTypes[c.path] = guessed ?? '';
            suggestionChecked[c.path] = guessed !== null && c.entries > 0;
        }
    }

    let suggestionTypes = $state<Record<string, LibraryMediaType | ''>>({});
    let suggestionChecked = $state<Record<string, boolean>>({});

    // Adds the checked suggestions one by one through the same path as the form
    // (probe, mismatch warning, create). Stops at the first one that needs a fix
    // and leaves it in the form, with the error, for the operator.
    // Goes through addLibrary() so a suggestion gets the same probe, mismatch
    // warning and errors as a typed path. Whatever the operator had typed into
    // the form is put back once the batch is through; on a failure the failed
    // suggestion stays in the form, next to its error.
    async function addSuggestedLibraries(): Promise<void> {
        if (libraryCreating) return;
        const typedPath = libraryPath;
        const typedType = libraryMediaType;
        for (const c of [...selectedSuggestions]) {
            const type = suggestionTypes[c.path];
            if (!type) continue;
            libraryPath = c.path;
            libraryMediaType = type;
            const before = addedLibraries.length;
            await addLibrary();
            if (addedLibraries.length === before) return;
        }
        libraryPath = typedPath;
        libraryMediaType = typedType;
    }
    // A detected folder named like a library ("movies", "Serien", "Musik")
    // preselects the type; anything else leaves the select as it is. The names
    // are shared with /api/setup/library-mounts.
    function guessLibraryType(path: string): LibraryMediaType | null {
        return libraryTypeForFolderName(path.split('/').filter(Boolean).pop() ?? '');
    }

    // Step 4 lists only the configured services that did not answer; step 1
    // already showed everything that works.
    const failingDepChecks = $derived((depChecks ?? []).filter((c) => c.status !== 'pass'));

    const unusedMountCandidates = $derived(
        mountCandidates.filter((c) => !addedLibraries.some((l) => l.path === c.path)),
    );

    const selectedSuggestions = $derived(
        unusedMountCandidates.filter(
            (c) => suggestionChecked[c.path] && suggestionTypes[c.path] !== '',
        ),
    );

    // Content-vs-type probe: before creating the library, sample the folder and
    // warn when it decisively contains the OTHER kind of media (e.g. .flac files
    // under "Movies") — currently that's only discovered via a completed-but-empty
    // scan. Warn once; a second submit with the same path+type proceeds anyway.
    const LibraryProbeSchema = z
        .object({
            ok: z.boolean().optional(),
            readable: z.boolean().optional(),
            inferredKind: z.string().optional(),
            mismatch: z.boolean().optional(),
            sampleExtensions: z.array(z.object({ ext: z.string(), count: z.number() })).optional(),
        })
        .passthrough();
    let mismatchWarned = $state<{ path: string; mediaType: string } | null>(null);

    async function addLibrary(): Promise<void> {
        if (libraryCreating || !libraryPath.trim() || !libraryMediaType) return;
        const path = libraryPath.trim();
        // The list below is keyed by path (`{#each addedLibraries as lib (lib.path)}`)
        // — a duplicate would collide on that key and silently drop a card, even
        // though both /api/setup/library calls would otherwise succeed server-side.
        if (addedLibraries.some((l) => l.path === path)) {
            libraryError = m.setup_lib_duplicate_path();
            return;
        }
        libraryCreating = true;
        libraryError = '';
        const mediaType = libraryMediaType;
        const label = LIBRARY_MEDIA_TYPES.find((t) => t.id === mediaType)?.label() ?? mediaType;

        // Probe first (best-effort — a probe failure never blocks adding).
        const alreadyWarned =
            mismatchWarned?.path === path && mismatchWarned?.mediaType === mediaType;
        if (!alreadyWarned) {
            const { data: probe } = await apiPost('/api/setup/library-probe', LibraryProbeSchema, {
                path,
                mediaType,
            });
            if (probe?.readable === false) {
                libraryCreating = false;
                libraryError = m.setup_lib_not_readable();
                return;
            }
            if (probe?.mismatch) {
                libraryCreating = false;
                const exts = (probe.sampleExtensions ?? [])
                    .slice(0, 3)
                    .map((e) => `.${e.ext}`)
                    .join(' ');
                libraryError = m.setup_lib_type_mismatch({ exts, type: label });
                mismatchWarned = { path, mediaType };
                return;
            }
        }

        const { data, error } = await apiPost('/api/setup/library', LibrarySetupSchema, {
            path,
            mediaType,
        });
        libraryCreating = false;
        if (error) {
            libraryError = error;
            return;
        }
        if (data && data.ok === false) {
            // Not usable as given — prompt a fix, don't advance.
            if (data.notDirectory) {
                libraryError = m.setup_lib_not_directory();
            } else if (data.conflict === 'media-type') {
                const existing = data.existingMediaType ?? '';
                libraryError = m.setup_lib_type_conflict({
                    type: LIBRARY_MEDIA_TYPES.find((t) => t.id === existing)?.label() ?? existing,
                });
            } else {
                libraryError = m.setup_lib_not_readable();
            }
            return;
        }
        // Library created (scan may or may not have started under backpressure).
        const runId = data?.runId ?? null;
        addedLibraries = [...addedLibraries, { path, mediaType, label, runId }];
        if (runId) scanRunIds = [...scanRunIds, runId];
        mismatchWarned = null;
        // Clear the form for an optional additional library; re-force an explicit
        // type choice rather than carrying the previous one over.
        libraryPath = '';
        libraryMediaType = '';
    }

    // Audiobookshelf libraries come from the card, which already created them
    // through /api/setup/library; they join the list and the scan screen like a
    // folder. The sentinel path keeps the list keys unique.
    let audiobookshelfOpen = $state(false);
    // The card adds its libraries one request at a time; Continue waits for them.
    let audiobookshelfAdding = $state(false);
    const addedAudiobookshelfIds = $derived(
        addedLibraries.flatMap((l) => (l.remote ? [l.remote.id] : [])),
    );
    function addAudiobookshelfLibrary(lib: AddedAudiobookshelfLibrary): void {
        if (addedAudiobookshelfIds.includes(lib.remoteLibraryId)) return;
        addedLibraries = [
            ...addedLibraries,
            {
                path: `abs://${lib.remoteLibraryId}`,
                mediaType: 'audiobook',
                label: m.setup_library_default_name_audiobook(),
                runId: lib.runId,
                remote: { id: lib.remoteLibraryId, name: lib.name },
            },
        ];
        if (lib.runId) scanRunIds = [...scanRunIds, lib.runId];
    }

    // Ticked suggestions read as chosen, so Continue adds them first instead of
    // leaving them behind (seen in a first-run test: the folders were ticked,
    // Audiobookshelf was added, Continue went on without the folders). A
    // suggestion that fails stops here, with its error in the form.
    async function addSelectedThenContinue(): Promise<void> {
        if (selectedSuggestions.length > 0) {
            await addSuggestedLibraries();
            if (selectedSuggestions.length > 0) return;
        }
        if (audiobookshelfPending > 0 && audiobookshelfCard) {
            if (!(await audiobookshelfCard.addPending())) return;
        }
        continueToScan();
    }
    let audiobookshelfPending = $state(0);
    let audiobookshelfCard = $state<{ addPending: () => Promise<boolean> } | undefined>();
    const pendingLibraryCount = $derived(selectedSuggestions.length + audiobookshelfPending);

    function continueToScan(): void {
        // Guard against a double-click firing before Svelte unmounts the step-4
        // button — without this, a second call would start a second polling
        // interval and leak the first one's handle (overwritten scanPollTimer).
        if (step === 5) return;
        step = 5;
        if (scanRunIds.length > 0) startScanPolling();
    }

    // ---- Step 5: first-scan progress (one card per added library) ----
    interface ScanStage {
        id: string;
        label?: string;
        state?: string;
        processed?: number;
        total?: number;
        currentItem?: string;
    }
    interface ScanRun {
        id: string;
        state: string;
        stages?: ScanStage[];
    }
    let scanRunIds = $state<string[]>([]);
    let scanRunsById = $state<Record<string, ScanRun>>({});
    let scanPollTimer: ReturnType<typeof setInterval> | undefined;
    // Bound the poll: stop after ~5 min (150 × 2s) so a purged/404 run or a stalled
    // worker can't leave the interval hammering /api/runs forever.
    let scanPollCount = $state(0);
    const MAX_SCAN_POLLS = 150;
    let scanGaveUp = $state(false);

    const RunPollSchema = z
        .object({
            id: z.string(),
            state: z.string(),
            stages: z
                .array(
                    z.object({
                        id: z.string(),
                        label: z.string().optional(),
                        state: z.string().optional(),
                        processed: z.number().optional(),
                        total: z.number().optional(),
                        currentItem: z.string().optional(),
                    }),
                )
                .optional(),
        })
        .passthrough();

    const TERMINAL_STATES = ['completed', 'failed', 'cancelled'];
    function isRunDone(run: ScanRun | undefined): boolean {
        return !!run && TERMINAL_STATES.includes(run.state);
    }
    function isRunFailed(run: ScanRun | undefined): boolean {
        return run?.state === 'failed' || run?.state === 'cancelled';
    }
    // The stage to show for a run: the active one, else the first with any
    // progress, else the first stage.
    function stageFor(run: ScanRun | undefined): ScanStage | null {
        const stages = run?.stages ?? [];
        return (
            stages.find((s) => s.state === 'active') ??
            stages.find((s) => (s.processed ?? 0) > 0 || (s.total ?? 0) > 0 || s.currentItem) ??
            stages[0] ??
            null
        );
    }
    // Percent for a run's bar, or null for an indeterminate (no total yet) state.
    function percentFor(run: ScanRun | undefined): number | null {
        if (isRunDone(run)) return 100;
        const s = stageFor(run);
        if (s && (s.total ?? 0) > 0) {
            return Math.min(100, Math.round(((s.processed ?? 0) / (s.total ?? 1)) * 100));
        }
        return null;
    }

    // "Done" only means something once at least one run actually started —
    // libraries still queued under backpressure (no runId yet) render their own
    // per-card notice instead and don't count toward this.
    const allScansDone = $derived(
        scanRunIds.length > 0 && scanRunIds.every((id) => isRunDone(scanRunsById[id])),
    );
    const anyScanFailed = $derived(scanRunIds.some((id) => isRunFailed(scanRunsById[id])));

    const JellyfinStatusSchema = z.object({
        configured: z.boolean(),
        paired: z.number().optional(),
        waiting: z.number().optional(),
        syncing: z.boolean().optional(),
        failed: z.boolean().optional(),
        retrying: z.boolean().optional(),
        syncStarted: z.boolean().optional(),
    });
    let jellyfinStatus = $state<z.infer<typeof JellyfinStatusSchema> | null>(null);
    let jellyfinStatusUnavailable = $state(false);
    let jellyfinPollingExpired = $state(false);

    $effect(() => {
        if (!allScansDone) return;
        jellyfinPollingExpired = false;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let delay = 2000;
        const deadline = Date.now() + 600_000;
        async function pollJellyfin(): Promise<void> {
            if (stopped) return;
            if (Date.now() >= deadline) {
                jellyfinPollingExpired = true;
                stopped = true;
                return;
            }
            let retry = true;
            try {
                const { data } = await apiGet('/api/setup/jellyfin', JellyfinStatusSchema);
                if (stopped) return;
                jellyfinStatus = data;
                jellyfinStatusUnavailable = !data;
                retry =
                    !data ||
                    (data.configured &&
                        (!!data.syncing || !!data.retrying || data.syncStarted === false));
            } catch {
                if (stopped) return;
                jellyfinStatusUnavailable = true;
            }
            if (!stopped && retry) {
                timer = setTimeout(
                    () => void pollJellyfin(),
                    Math.min(delay, Math.max(0, deadline - Date.now())),
                );
                delay = Math.min(delay * 2, 30_000);
            }
        }
        void pollJellyfin();
        return () => {
            stopped = true;
            if (timer !== undefined) clearTimeout(timer);
        };
    });

    // A run set can complete having found nothing at all — wrong folder, wrong
    // media type, or an empty mount for every added library. Checked once,
    // globally, once every run is terminal (the count endpoint is deliberately
    // global, not per-library — see /api/setup/media-count's doc comment).
    let scanItemCount = $state<number | null>(null);
    // Whether the finished scans had to add files without metadata because the
    // provider couldn't be asked (rejected key, or none configured). A scan can
    // finish with errors: 0 while every lookup failed, so "complete" alone is no
    // proof the library got titles and artwork (Windows e2e S5).
    let scanMetadataError = $state<'tmdb_auth' | 'provider_auth' | 'provider_unavailable' | null>(
        null,
    );
    const MediaCountSchema = z.object({
        count: z.number(),
        metadataUnavailable: z.number(),
        metadataProviderError: z
            .enum(['tmdb_auth', 'provider_auth', 'provider_unavailable'])
            .nullable()
            .optional(),
    });
    async function fetchMediaCount(): Promise<void> {
        const { data } = await apiGet('/api/setup/media-count', MediaCountSchema);
        scanItemCount = data?.count ?? null;
        scanMetadataError = data?.metadataProviderError ?? null;
    }
    const metadataProviderFailed = $derived(
        allScansDone && scanItemCount !== null && scanItemCount > 0 && scanMetadataError !== null,
    );
    const scanEmpty = $derived(
        allScansDone && !anyScanFailed && scanItemCount !== null && scanItemCount === 0,
    );

    // Consecutive poll failures per run id (404/network error, not a real terminal
    // state). One purged/unreachable run must not block the whole batch's "done"
    // aggregate forever while its siblings finish normally.
    let scanRunFailCounts = $state<Record<string, number>>({});
    const MAX_RUN_POLL_FAILURES = 5;

    // One poll at a time: a slow /api/runs round-trip must not overlap the next
    // interval tick, or an older response could overwrite a newer terminal state
    // after polling stopped and leave the step stuck on "scanning".
    let scanPollInFlight = false;
    async function pollScan(): Promise<void> {
        if (scanRunIds.length === 0 || scanPollInFlight) return;
        scanPollInFlight = true;
        scanPollCount += 1;
        // Retry can add a run while these requests are in flight. Pair each
        // response with the same IDs that were requested, not the live list.
        const polledRunIds = [...scanRunIds];
        let results;
        try {
            results = await Promise.all(
                polledRunIds.map((id) => apiGet(`/api/runs/${id}`, RunPollSchema)),
            );
        } finally {
            scanPollInFlight = false;
        }
        if (scanPollTimer === undefined) return; // stopped (or unmounted) meanwhile
        const next = { ...scanRunsById };
        const nextFailCounts = { ...scanRunFailCounts };
        polledRunIds.forEach((id, i) => {
            const { data } = results[i];
            if (data) {
                next[id] = data;
                nextFailCounts[id] = 0;
                return;
            }
            if (isRunDone(next[id])) return;
            const failCount = (nextFailCounts[id] ?? 0) + 1;
            nextFailCounts[id] = failCount;
            if (failCount >= MAX_RUN_POLL_FAILURES) {
                // Synthesize a terminal state so this run stops blocking the
                // aggregate — we genuinely can't tell its real status anymore.
                next[id] = { id, state: 'failed' };
            }
        });
        scanRunsById = next;
        scanRunFailCounts = nextFailCounts;
        const done = scanRunIds.every((id) => isRunDone(next[id]));
        // Stop on all-terminal, or after the cap (a purged/404 run, or a stalled
        // worker that never reaches a terminal state).
        if (done || scanPollCount >= MAX_SCAN_POLLS) {
            if (!done) scanGaveUp = true;
            stopScanPolling();
            // On a clean completion, check whether anything was actually ingested.
            if (done) void fetchMediaCount();
        }
    }
    // Finish screen: a missing or rejected TMDB key can be fixed right there.
    // Saving it re-submits every added library to /api/setup/library, which is
    // idempotent for an existing path and starts a fresh scan; the scan view then
    // tracks the new runs exactly like the first ones.
    let finishTmdbKey = $state('');
    let finishTmdbSaving = $state(false);
    let finishTmdbError = $state('');
    let rescanFailedNotice = $state('');
    const canFixTmdbHere = $derived(
        metadataProviderFailed &&
            (scanMetadataError === 'provider_unavailable' || scanMetadataError === 'tmdb_auth'),
    );
    async function saveTmdbKeyAndRescan(): Promise<void> {
        const key = finishTmdbKey.trim();
        if (!key || finishTmdbSaving) return;
        finishTmdbSaving = true;
        finishTmdbError = '';
        try {
            await saveKeyAndResubmit(key);
        } finally {
            finishTmdbSaving = false;
        }
    }
    async function saveKeyAndResubmit(key: string): Promise<void> {
        const { error } = await apiPost('/api/admin/tmdb-key', TmdbKeySchema, { key });
        if (error) {
            finishTmdbError = error;
            return;
        }
        const nextLibraries: AddedLibrary[] = [];
        const failed: string[] = [];
        let firstError = '';
        // Audiobookshelf libraries take no TMDB metadata; their sync stays as it is.
        const fileLibraries = addedLibraries.filter((l) => !l.remote);
        for (const lib of addedLibraries) {
            if (lib.remote) {
                nextLibraries.push(lib);
                continue;
            }
            const { data, error: libError } = await apiPost(
                '/api/setup/library',
                LibrarySetupSchema,
                { path: lib.path, mediaType: lib.mediaType },
            );
            // A library that could not be re-submitted keeps its finished run, so it
            // stays on screen as complete instead of silently leaving the scan view.
            // No run id (backpressure) is a scan that did not start either.
            if (libError || data?.ok === false || !data?.runId) {
                failed.push(lib.path);
                firstError ||= libError ?? '';
                nextLibraries.push(lib);
                continue;
            }
            nextLibraries.push({ ...lib, runId: data.runId });
        }
        rescanFailedNotice =
            failed.length > 0
                ? m.setup_scan_rescan_failed({ paths: failed.join(', '), error: firstError })
                : '';
        // Nothing restarted: keep the finished runs and the form, so the screen
        // does not wait on scans that never began.
        if (failed.length === fileLibraries.length) return;
        stopScanPolling();
        addedLibraries = nextLibraries;
        scanRunIds = nextLibraries.flatMap((l) => (l.runId ? [l.runId] : []));
        scanRunsById = {};
        scanRunFailCounts = {};
        scanPollCount = 0;
        scanGaveUp = false;
        scanItemCount = null;
        scanMetadataError = null;
        finishTmdbKey = '';
        startScanPolling();
    }

    let retryingScans = $state<Record<string, boolean>>({});
    let retryScanErrors = $state<Record<string, string>>({});
    async function retryQueuedScan(lib: AddedLibrary): Promise<void> {
        if (lib.runId || retryingScans[lib.path]) return;
        retryingScans = { ...retryingScans, [lib.path]: true };
        retryScanErrors = { ...retryScanErrors, [lib.path]: '' };
        try {
            const { data, error } = await apiPost(
                '/api/setup/library',
                LibrarySetupSchema,
                lib.remote
                    ? {
                          provider: 'audiobookshelf',
                          remoteLibraryId: lib.remote.id,
                          mediaType: lib.mediaType,
                      }
                    : { path: lib.path, mediaType: lib.mediaType },
            );
            if (error || data?.ok === false) {
                retryScanErrors = { ...retryScanErrors, [lib.path]: m.setup_scan_retry_failed() };
                return;
            }
            if (!data?.runId) {
                retryScanErrors = { ...retryScanErrors, [lib.path]: m.setup_scan_retry_busy() };
                return;
            }
            const runId = data.runId;
            addedLibraries = addedLibraries.map((l) => (l.path === lib.path ? { ...l, runId } : l));
            scanRunIds = [...new Set([...scanRunIds, runId])];
            scanPollCount = 0;
            scanGaveUp = false;
            scanItemCount = null;
            scanMetadataError = null;
            if (scanPollTimer === undefined) startScanPolling();
        } catch {
            retryScanErrors = { ...retryScanErrors, [lib.path]: m.setup_scan_retry_failed() };
        } finally {
            retryingScans = { ...retryingScans, [lib.path]: false };
        }
    }

    function startScanPolling(): void {
        void pollScan();
        scanPollTimer = setInterval(() => void pollScan(), 2000);
    }
    function stopScanPolling(): void {
        if (scanPollTimer !== undefined) {
            clearInterval(scanPollTimer);
            scanPollTimer = undefined;
        }
    }
    onDestroy(stopScanPolling);

    // When we start directly on step 3 (resume — e.g. after an OIDC sign-in), the
    // step-3 probes that are normally kicked off by the auth-step transitions never
    // ran, so fire them here.
    onMount(() => {
        if (data.resume) {
            void checkWorker();
            void detectGpu();
            void checkDependencies();
            void checkProxyBypasses();
        }
    });

    function goToDashboard(): void {
        window.location.assign(url('/'));
    }
</script>

<!-- Identity headers reached the app but came from a peer outside
     TRUSTED_PROXY_IPS, so they were discarded. Name the peer and the exact line
     to add; warn when that peer is the Docker gateway (trusting it trusts every
     process on the host). Only rendered when the load exposed the peer
     (pre-admin first run / resuming admin). -->
{#snippet forwardAuthRejectedCallout(rejected: { peer: string; peerIsGateway: boolean })}
    <div class="setup-callout setup-callout-warning" role="alert">
        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
        <div>
            <p class="font-semibold">{m.setup_fwd_rejected_title()}</p>
            <p class="mt-1 text-sm">
                {m.setup_fwd_rejected_hint({ peer: rejected.peer, appName })}
            </p>
            <p class="mt-2"><code class="setup-code">TRUSTED_PROXY_IPS={rejected.peer}</code></p>
        </div>
    </div>
    {#if rejected.peerIsGateway}
        <div class="setup-callout setup-callout-error" role="alert">
            <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
            <span>{m.setup_fwd_rejected_gateway({ peer: rejected.peer })}</span>
        </div>
    {/if}
{/snippet}

<!-- Forward auth is opt-in (FORWARD_AUTH_ENABLED). `detected`: a trusted proxy
     is already sending identity headers and they were ignored. -->
{#snippet forwardAuthDisabledCallout(detected: boolean)}
    <div class="setup-callout setup-callout-warning" role="alert">
        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
        <div>
            <p class="font-semibold">
                {detected ? m.setup_fwd_disabled_detected_title() : m.setup_fwd_disabled_title()}
            </p>
            <p class="mt-1 text-sm">{m.setup_fwd_disabled_hint({ appName })}</p>
            <p class="mt-2"><code class="setup-code">FORWARD_AUTH_ENABLED=true</code></p>
        </div>
    </div>
{/snippet}

<svelte:head>
    <title>{m.setup_page_title({ appName })}</title>
</svelte:head>

<div class="setup-shell">
    <div class="setup-aurora" aria-hidden="true"></div>
    <div class="setup-grain" aria-hidden="true"></div>

    <main class="setup-stage">
        <header class="setup-header">
            <div class="setup-brand">
                {#if logoFull}
                    <img src={logoFull} alt={appName} class="setup-logo" />
                {:else}
                    <span class="setup-wordmark">{appName}</span>
                {/if}
            </div>
            <p class="setup-eyebrow">{m.setup_eyebrow()}</p>
            <div class="setup-stepper" aria-label={m.setup_step_of({ step: String(stepNumber) })}>
                {#each [1, 2, 3, 4, 5] as n (n)}
                    <span
                        class="setup-dot"
                        class:is-active={n === stepNumber}
                        class:is-done={n < stepNumber}></span>
                {/each}
                <span class="setup-step-label"
                    >{m.setup_step_of({ step: String(stepNumber) })}</span>
            </div>
        </header>

        <div class="setup-card card">
            {#if step === 'install' && data.environment}
                <!-- STEP 0 — what this server found, before anything is set up. Never
                     blocks: warnings only say what will not work until fixed. -->
                <h1 class="setup-title">{m.setup_s0_title()}</h1>
                <p class="setup-lede">{m.setup_s0_lede()}</p>

                <SetupEnvironment
                    environment={data.environment}
                    details={data.environmentDetails}
                    onrecheck={() => invalidate('setup:environment')} />

                <div class="setup-actions setup-actions-end">
                    <button
                        type="button"
                        class="btn variant-filled-primary"
                        onclick={goFromInstall}>
                        <span>{m.setup_btn_continue()}</span>
                        <Icon src={ArrowRight} class="h-5 w-5" />
                    </button>
                </div>
            {:else if step === 1 || step === 'install'}
                <!-- STEP 1 — choose sign-in method -->
                <h1 class="setup-title">{m.setup_s1_title()}</h1>
                <p class="setup-lede">{m.setup_s1_lede()}</p>

                {#if setupError}
                    <div class="setup-callout setup-callout-error" role="alert">
                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                        <span>{setupError}</span>
                    </div>
                {/if}

                {#if data.forwardAuth}
                    <div class="setup-callout setup-callout-success" role="status">
                        <Icon src={CheckCircle} class="h-5 w-5 shrink-0" />
                        <span>{m.setup_s1_fwd_detected()}</span>
                    </div>
                {:else if data.forwardAuthRejected}
                    {@render forwardAuthRejectedCallout(data.forwardAuthRejected)}
                {:else if data.forwardAuthDisabledHeaders}
                    {@render forwardAuthDisabledCallout(true)}
                {/if}

                {#if transportWarning}
                    <div class="setup-callout setup-callout-warning" role="alert">
                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                        <span>{transportWarning}</span>
                    </div>
                {/if}

                {#if data.oidcEnabled}
                    <div class="setup-oidc">
                        <div class="setup-oidc-reco">
                            <span class="badge variant-filled-success"
                                >{m.setup_badge_recommended()}</span>
                        </div>
                        <a
                            class="btn variant-filled-primary setup-oidc-btn"
                            href={oidcSetupHref}
                            data-sveltekit-reload>
                            <Icon src={ShieldCheck} class="h-5 w-5" />
                            <span
                                >{m.setup_s1_oidc_signin({
                                    provider: data.oidcProviderName,
                                })}</span>
                        </a>
                        <p class="setup-choice-copy">{m.setup_s1_oidc_copy()}</p>

                        {#each data.oidcIssues as issue (issue.id)}
                            <div
                                class="setup-callout {issue.status === 'fail'
                                    ? 'setup-callout-error'
                                    : 'setup-callout-warning'}"
                                role="alert">
                                <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                <span>{oidcIssueText(issue)}</span>
                            </div>
                        {/each}

                        <!-- Live discovery probe: verify the provider is reachable and
                             its config lines up, before committing to the sign-in. -->
                        <div class="setup-oidc-actions">
                            <button
                                type="button"
                                class="btn variant-soft-surface setup-oidc-test-btn"
                                onclick={testOidc}
                                disabled={oidcTesting}>
                                {#if oidcTesting}
                                    <span class="loading-spinner"></span>
                                    <span>{m.setup_oidc_test_testing()}</span>
                                {:else}
                                    <Icon src={GlobeAlt} class="h-5 w-5" />
                                    <span>{m.setup_oidc_test_btn()}</span>
                                {/if}
                            </button>
                            <button type="button" class="setup-recheck" onclick={editOidcConfig}>
                                {m.setup_oidc_edit()}
                            </button>
                        </div>

                        {#if oidcProbe}
                            {#if oidcProbe.ok}
                                <div class="setup-callout setup-callout-success" role="status">
                                    <Icon src={CheckCircle} class="h-5 w-5 shrink-0" />
                                    <div>
                                        <p class="font-semibold">{m.setup_oidc_test_ok()}</p>
                                        {#if oidcProbe.issuer}
                                            <p class="mt-1">
                                                <code class="setup-code">{oidcProbe.issuer}</code>
                                            </p>
                                        {/if}
                                    </div>
                                </div>
                                {#if oidcProbe.insecure}
                                    <div class="setup-callout setup-callout-warning" role="alert">
                                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                        <span>{m.setup_oidc_test_insecure()}</span>
                                    </div>
                                {/if}
                                {#if oidcProbe.missingScopes && oidcProbe.missingScopes.length > 0}
                                    <div class="setup-callout setup-callout-warning" role="alert">
                                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                        <span
                                            >{m.setup_oidc_test_scopes_missing({
                                                scopes: oidcProbe.missingScopes.join(', '),
                                            })}</span>
                                    </div>
                                {/if}
                                {#if oidcProbe.supportsPkceS256 === false}
                                    <div class="setup-callout setup-callout-warning" role="alert">
                                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                        <span>{m.setup_oidc_test_pkce_warn({ appName })}</span>
                                    </div>
                                {/if}

                                <!-- Claim mapping: the first sign-in must resolve to an
                                     admin group (read from the groups claim), so state
                                     the requirement and warn when the provider's
                                     discovery doesn't advertise the claims we rely on. -->
                                <div class="setup-callout setup-backup-note" role="note">
                                    <Icon src={ShieldCheck} class="h-5 w-5 shrink-0" />
                                    <span>
                                        {m.setup_oidc_test_groups_info({
                                            claim: oidcProbe.groupsClaim ?? 'groups',
                                            groups:
                                                data.adminGroups.length > 0
                                                    ? data.adminGroups.join(', ')
                                                    : m.setup_groups_none(),
                                        })}
                                    </span>
                                </div>
                                {#if oidcProbe.groupsClaimAdvertised === false}
                                    <div class="setup-callout setup-callout-warning" role="alert">
                                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                        <span
                                            >{m.setup_oidc_test_groups_missing({
                                                claim: oidcProbe.groupsClaim ?? 'groups',
                                            })}</span>
                                    </div>
                                {/if}
                                {#if oidcProbe.emailAdvertised === false}
                                    <div class="setup-callout setup-callout-warning" role="alert">
                                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                        <span>{m.setup_oidc_test_email_missing()}</span>
                                    </div>
                                {/if}
                            {:else}
                                <div class="setup-callout setup-callout-error" role="alert">
                                    <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                    <span
                                        >{m.setup_oidc_test_failed({
                                            error: oidcProbe.error ?? '',
                                        })}</span>
                                </div>
                            {/if}
                        {/if}
                    </div>
                    <div class="setup-divider"><span>{m.setup_s1_or_other()}</span></div>
                {/if}

                <div class="setup-choices">
                    {#if !data.oidcEnabled}
                        <!-- OIDC isn't configured yet; selecting it opens its setup
                             form. Single sign-on is the recommendation: this card
                             carries the badge unless a trusted forward-auth
                             identity was detected (then forward auth does). Built-in
                             login is never badged. (When OIDC is configured, the
                             "Sign in with …" button above replaces this card.)
                             Shares row 1 with forward-auth; built-in spans row 2. -->
                        <button
                            type="button"
                            class="setup-choice"
                            class:is-selected={method === 'oidc'}
                            aria-pressed={method === 'oidc'}
                            onclick={() => selectMethod('oidc')}>
                            <div class="setup-choice-head">
                                <Icon src={GlobeAlt} class="h-6 w-6 text-primary-400" />
                                {#if recommendedMethod === 'oidc'}
                                    <span class="badge variant-filled-success"
                                        >{m.setup_badge_recommended()}</span>
                                {/if}
                            </div>
                            <h2 class="setup-choice-title">{m.setup_s1_oidc_title()}</h2>
                            <p class="setup-choice-copy">{m.setup_s1_oidc_card_copy()}</p>
                        </button>
                    {/if}

                    <button
                        type="button"
                        class="setup-choice"
                        class:is-selected={method === 'forward-auth'}
                        aria-pressed={method === 'forward-auth'}
                        onclick={() => selectMethod('forward-auth')}>
                        <div class="setup-choice-head">
                            <Icon src={ShieldCheck} class="h-6 w-6 text-primary-400" />
                            {#if recommendedMethod === 'forward-auth'}
                                <span class="badge variant-filled-success"
                                    >{m.setup_badge_recommended()}</span>
                            {/if}
                        </div>
                        <h2 class="setup-choice-title">{m.setup_s1_fwd_title()}</h2>
                        <p class="setup-choice-copy">{m.setup_s1_fwd_copy()}</p>
                    </button>

                    <button
                        type="button"
                        class="setup-choice"
                        class:setup-choice-wide={!data.oidcEnabled}
                        class:is-selected={method === 'native'}
                        aria-pressed={method === 'native'}
                        onclick={() => selectMethod('native')}>
                        <div class="setup-choice-head">
                            <Icon src={Key} class="h-6 w-6 text-primary-400" />
                        </div>
                        <h2 class="setup-choice-title">{m.setup_s1_native_title()}</h2>
                        <p class="setup-choice-copy">{m.setup_s1_native_copy({ appName })}</p>
                    </button>
                </div>

                <div class="setup-actions" class:setup-actions-end={!data.environment}>
                    {#if data.environment}
                        <button
                            type="button"
                            class="btn variant-ghost-surface"
                            onclick={() => (step = 'install')}>
                            <Icon src={ArrowLeft} class="h-5 w-5" />
                            <span>{m.setup_btn_back()}</span>
                        </button>
                        <div class="setup-actions-spacer"></div>
                    {/if}
                    <button
                        type="button"
                        class="btn variant-filled-primary"
                        onclick={goFromStep1}
                        disabled={method === null}>
                        <span>{m.setup_btn_continue()}</span>
                        <Icon src={ArrowRight} class="h-5 w-5" />
                    </button>
                </div>
            {:else if step === '2a'}
                <!-- STEP 2A — forward-auth verification -->
                <h1 class="setup-title">{m.setup_s2a_title()}</h1>

                {#if data.wideTrustedProxyRanges.length > 0}
                    <div class="setup-callout setup-callout-warning" role="alert">
                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                        <div>
                            <p class="font-semibold">{m.setup_fwd_wide_range_title()}</p>
                            <p class="mt-1 text-sm">
                                {m.setup_fwd_wide_range_hint({
                                    ranges: data.wideTrustedProxyRanges.join(', '),
                                    appName,
                                })}
                            </p>
                        </div>
                    </div>
                {/if}

                {#if !data.forwardAuth}
                    {#if !data.forwardAuthEnabled}
                        {@render forwardAuthDisabledCallout(data.forwardAuthDisabledHeaders)}
                    {/if}
                    {#if data.forwardAuthRejected}
                        {@render forwardAuthRejectedCallout(data.forwardAuthRejected)}
                    {:else if data.forwardAuthEnabled}
                        <div class="setup-callout setup-callout-warning" role="alert">
                            <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                            <div>
                                <p class="font-semibold">{m.setup_s2a_no_headers_title()}</p>
                                <p class="mt-1 text-sm">
                                    {m.setup_s2a_no_headers_hint({ appName })}
                                </p>
                            </div>
                        </div>
                    {/if}

                    <div class="setup-actions">
                        <button
                            type="button"
                            class="btn variant-ghost-surface"
                            onclick={backToStep1}
                            disabled={authSubmitting}>
                            <Icon src={ArrowLeft} class="h-5 w-5" />
                            <span>{m.setup_btn_back()}</span>
                        </button>
                        <div class="setup-actions-spacer"></div>
                        <button
                            type="button"
                            class="btn variant-soft-surface"
                            onclick={useBuiltInLogin}>
                            {m.setup_s2a_use_native()}
                        </button>
                        <button
                            type="button"
                            class="btn variant-filled-primary"
                            onclick={reloadPage}>
                            <Icon src={ArrowPath} class="h-5 w-5" />
                            <span>{m.setup_btn_reload()}</span>
                        </button>
                    </div>
                {:else}
                    <p class="setup-lede">{m.setup_s2a_lede()}</p>

                    <div class="setup-identity">
                        <p class="setup-identity-label">{m.setup_s2a_detected_user()}</p>
                        <p class="setup-identity-name">{data.forwardAuth.username}</p>

                        <p class="setup-identity-label mt-3">{m.setup_groups_label()}</p>
                        <div class="setup-chips">
                            {#if data.forwardAuth.groups.length === 0}
                                <span class="setup-chip setup-chip-muted"
                                    >{m.setup_groups_none()}</span>
                            {:else}
                                {#each data.forwardAuth.groups as group (group)}
                                    <span class="setup-chip">{group}</span>
                                {/each}
                            {/if}
                        </div>
                    </div>

                    {#if data.forwardAuth.isAdmin}
                        <div class="setup-callout setup-callout-success" role="status">
                            <Icon src={CheckCircle} class="h-5 w-5 shrink-0" />
                            <span>{m.setup_s2a_isadmin_ok()}</span>
                        </div>

                        {#if proxyPostureWarning}
                            <div class="setup-callout setup-callout-warning" role="alert">
                                <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                <span>{proxyPostureWarning}</span>
                            </div>
                        {/if}

                        <div class="setup-actions">
                            <button
                                type="button"
                                class="btn variant-ghost-surface"
                                onclick={backToStep1}
                                disabled={authSubmitting}>
                                <Icon src={ArrowLeft} class="h-5 w-5" />
                                <span>{m.setup_btn_back()}</span>
                            </button>
                            <div class="setup-actions-spacer"></div>
                            <button
                                type="button"
                                class="btn variant-filled-primary"
                                onclick={confirmForwardAuth}
                                disabled={verifyingForwardAuth}>
                                {#if verifyingForwardAuth}
                                    <span class="loading-spinner loading-spinner-white"></span>
                                    <span>{m.setup_btn_confirming()}</span>
                                {:else}
                                    <span>{m.setup_btn_continue()}</span>
                                    <Icon src={ArrowRight} class="h-5 w-5" />
                                {/if}
                            </button>
                        </div>
                    {:else}
                        <div class="setup-callout setup-callout-error" role="alert">
                            <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                            <div>
                                <p class="font-semibold">{m.setup_s2a_notadmin_title()}</p>
                                <p class="mt-1 text-sm">{m.setup_s2a_notadmin_hint()}</p>
                                <div class="setup-chips mt-2">
                                    {#each data.adminGroups as group (group)}
                                        <span class="setup-chip">{group}</span>
                                    {/each}
                                </div>
                            </div>
                        </div>

                        <div class="setup-actions">
                            <button
                                type="button"
                                class="btn variant-ghost-surface"
                                onclick={backToStep1}
                                disabled={authSubmitting}>
                                <Icon src={ArrowLeft} class="h-5 w-5" />
                                <span>{m.setup_btn_back()}</span>
                            </button>
                            <div class="setup-actions-spacer"></div>
                            <button
                                type="button"
                                class="btn variant-filled-primary"
                                onclick={reloadPage}>
                                <Icon src={ArrowPath} class="h-5 w-5" />
                                <span>{m.setup_btn_reload()}</span>
                            </button>
                        </div>
                    {/if}
                {/if}
            {:else if step === '2b'}
                <!-- STEP 2B — create admin account -->
                <h1 class="setup-title">{m.setup_s2b_title()}</h1>
                <p class="setup-lede">{m.setup_s2b_lede({ appName })}</p>

                {#if nativeError}
                    <div class="setup-callout setup-callout-error" role="alert">
                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                        <span>{nativeError}</span>
                    </div>
                {/if}

                <form
                    method="post"
                    class="setup-form"
                    onsubmit={(e) => {
                        e.preventDefault();
                        createAdmin();
                    }}>
                    <label class="setup-field" for="admin-username">
                        <span class="setup-label">{m.setup_label_username()}</span>
                        <input
                            id="admin-username"
                            class="input"
                            type="text"
                            autocomplete="username"
                            autocapitalize="none"
                            spellcheck="false"
                            bind:value={newUsername}
                            disabled={creating}
                            aria-invalid={showUsernameHint} />
                        {#if showUsernameHint}
                            <span class="setup-hint setup-hint-error"
                                >{m.setup_username_hint()}</span>
                        {/if}
                    </label>

                    <div class="setup-field">
                        <label class="setup-label" for="admin-password"
                            >{m.setup_label_password()}</label>
                        <div class="setup-input-wrap">
                            <input
                                id="admin-password"
                                aria-describedby="admin-password-hint"
                                class="input"
                                type={showPassword ? 'text' : 'password'}
                                autocomplete="new-password"
                                bind:value={newPassword}
                                disabled={creating} />
                            <button
                                type="button"
                                class="setup-input-toggle"
                                onclick={() => (showPassword = !showPassword)}
                                aria-label={showPassword
                                    ? m.setup_password_hide()
                                    : m.setup_password_show()}>
                                <Icon src={showPassword ? EyeSlash : Eye} class="h-4 w-4" />
                            </button>
                        </div>

                        <div class="setup-meter" aria-hidden="true">
                            {#each [0, 1, 2, 3] as seg (seg)}
                                {@const active = newPassword.length > 0 && seg < strength.score}
                                <span
                                    class={`setup-meter-seg${active ? ` filled ${strengthColor}` : ''}`}
                                ></span>
                            {/each}
                        </div>

                        <div class="setup-meter-row" id="admin-password-hint">
                            {#if newPassword.length > 0}
                                <span class="setup-meter-label setup-meter-label--strength"
                                    >{strength.label}</span>
                            {:else}
                                <span class="setup-meter-label setup-hint-muted"
                                    >{m.setup_password_min({
                                        min: String(PASSWORD_MIN_LENGTH),
                                    })}</span>
                            {/if}
                            {#if newPassword.length > 0 && strength.warnings.length > 0}
                                <span class="setup-hint setup-hint-muted"
                                    >{strength.warnings[0]}</span>
                            {/if}
                        </div>
                    </div>

                    <label class="setup-field" for="admin-confirm">
                        <span class="setup-label">{m.setup_label_confirm_password()}</span>
                        <div class="setup-input-wrap">
                            <input
                                id="admin-confirm"
                                class="input"
                                type={showConfirmPassword ? 'text' : 'password'}
                                autocomplete="new-password"
                                bind:value={confirmPassword}
                                disabled={creating}
                                aria-invalid={passwordsMismatch} />
                            <button
                                type="button"
                                class="setup-input-toggle"
                                onclick={() => (showConfirmPassword = !showConfirmPassword)}
                                aria-label={showConfirmPassword
                                    ? m.setup_password_hide()
                                    : m.setup_password_show()}>
                                <Icon src={showConfirmPassword ? EyeSlash : Eye} class="h-4 w-4" />
                            </button>
                        </div>
                        {#if passwordsMismatch}
                            <span class="setup-hint setup-hint-error"
                                >{m.setup_passwords_mismatch()}</span>
                        {/if}
                    </label>

                    <div class="setup-actions">
                        <button
                            type="button"
                            class="btn variant-ghost-surface"
                            onclick={backToStep1}
                            disabled={authSubmitting}>
                            <Icon src={ArrowLeft} class="h-5 w-5" />
                            <span>{m.setup_btn_back()}</span>
                        </button>
                        <div class="setup-actions-spacer"></div>
                        <button
                            type="submit"
                            class="btn variant-filled-primary"
                            disabled={creating || !canCreateAdmin}>
                            {#if creating}
                                <span class="loading-spinner loading-spinner-white"></span>
                                <span>{m.setup_btn_creating()}</span>
                            {:else}
                                <span>{m.setup_btn_create_admin()}</span>
                                <Icon src={ArrowRight} class="h-5 w-5" />
                            {/if}
                        </button>
                    </div>
                </form>
            {:else if step === '2c'}
                <!-- STEP 2C — configure OIDC SSO (form; saved live via saveConfig) -->
                <h1 class="setup-title">{m.setup_s2c_title()}</h1>
                <p class="setup-lede">{m.setup_s2c_lede({ appName })}</p>

                {#if oidcCfgError}
                    <div class="setup-callout setup-callout-error" role="alert">
                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                        <span>{oidcCfgError}</span>
                    </div>
                {/if}

                {#if oidcCallbackUrl}
                    <div class="setup-callout setup-backup-note" role="note">
                        <Icon src={GlobeAlt} class="h-5 w-5 shrink-0" />
                        <div>
                            <p class="font-semibold">{m.setup_s2c_callback_title()}</p>
                            <p class="setup-env-url">
                                <code class="setup-code">{oidcCallbackUrl}</code>
                            </p>
                            <p class="setup-env-note">{m.setup_s2c_env_admin_note()}</p>
                        </div>
                    </div>
                {/if}

                <form
                    method="post"
                    class="setup-form"
                    onsubmit={(e) => {
                        e.preventDefault();
                        saveOidcConfig();
                    }}>
                    <label class="setup-field" for="oidc-issuer">
                        <span class="setup-label">{m.setup_s2c_issuer_label()}</span>
                        <input
                            id="oidc-issuer"
                            class="input"
                            type="url"
                            autocomplete="off"
                            spellcheck="false"
                            placeholder="https://idp.example.com/application/o/lumastra/"
                            bind:value={oidcCfgIssuer}
                            disabled={oidcCfgSaving} />
                        <span class="setup-hint setup-hint-muted">{m.setup_s2c_issuer_hint()}</span>
                    </label>

                    <label class="setup-field" for="oidc-clientid">
                        <span class="setup-label">{m.setup_s2c_clientid_label()}</span>
                        <input
                            id="oidc-clientid"
                            class="input"
                            type="text"
                            autocomplete="off"
                            spellcheck="false"
                            bind:value={oidcCfgClientId}
                            disabled={oidcCfgSaving} />
                    </label>

                    <label class="setup-field" for="oidc-secret">
                        <span class="setup-label">{m.setup_s2c_secret_label()}</span>
                        <input
                            id="oidc-secret"
                            class="input"
                            type="password"
                            autocomplete="new-password"
                            placeholder={data.oidcConfig.hasSecret ? '••••••••' : ''}
                            bind:value={oidcCfgClientSecret}
                            disabled={oidcCfgSaving} />
                        <span class="setup-hint setup-hint-muted">
                            {data.oidcConfig.hasSecret
                                ? m.setup_s2c_secret_hint_keep()
                                : m.setup_s2c_secret_hint()}
                        </span>
                    </label>

                    <label class="setup-field" for="oidc-provider">
                        <span class="setup-label">{m.setup_s2c_provider_label()}</span>
                        <input
                            id="oidc-provider"
                            class="input"
                            type="text"
                            placeholder="Authentik"
                            bind:value={oidcCfgProviderName}
                            disabled={oidcCfgSaving} />
                    </label>

                    <!-- Scopes + groups claim are shown inline (not behind an
                         "advanced" toggle): the first admin sign-in must resolve to
                         an admin group read from this claim, and many IdPs need a
                         groups scope requested and/or a non-default claim, so this is
                         the #1 thing that trips people up. -->
                    <label class="setup-field" for="oidc-scopes">
                        <span class="setup-label">{m.setup_s2c_scopes_label()}</span>
                        <input
                            id="oidc-scopes"
                            class="input"
                            type="text"
                            autocomplete="off"
                            spellcheck="false"
                            bind:value={oidcCfgScopes}
                            disabled={oidcCfgSaving} />
                        <span class="setup-hint setup-hint-muted">{m.setup_s2c_scopes_hint()}</span>
                    </label>
                    <label class="setup-field" for="oidc-groups">
                        <span class="setup-label">{m.setup_s2c_groups_label()}</span>
                        <input
                            id="oidc-groups"
                            class="input"
                            type="text"
                            autocomplete="off"
                            spellcheck="false"
                            bind:value={oidcCfgGroupsClaim}
                            disabled={oidcCfgSaving} />
                        <span class="setup-hint setup-hint-muted">{m.setup_s2c_groups_hint()}</span>
                    </label>

                    <div class="setup-actions">
                        <button
                            type="button"
                            class="btn variant-ghost-surface"
                            onclick={backToStep1}
                            disabled={oidcCfgSaving}>
                            <Icon src={ArrowLeft} class="h-5 w-5" />
                            <span>{m.setup_btn_back()}</span>
                        </button>
                        <div class="setup-actions-spacer"></div>
                        <button
                            type="submit"
                            class="btn variant-filled-primary"
                            disabled={oidcCfgSaving || !oidcCfgValid}>
                            {#if oidcCfgSaving}
                                <span class="loading-spinner loading-spinner-white"></span>
                                <span>{m.setup_s2c_saving()}</span>
                            {:else}
                                <span>{m.setup_s2c_save()}</span>
                                <Icon src={ArrowRight} class="h-5 w-5" />
                            {/if}
                        </button>
                    </div>
                </form>
            {:else if step === 3}
                <!-- STEP 3 — finish -->
                <div class="setup-finish-badge">
                    <Icon src={CheckCircle} class="h-7 w-7 text-success-400" />
                </div>
                <h1 class="setup-title">{m.setup_s3_title()}</h1>
                <p class="setup-lede">{m.setup_s3_lede()}</p>

                <!-- Step 1 already showed what works; here only what does not. -->
                {#if workerStatus}
                    {#if !workerStatus.available}
                        <div class="setup-callout setup-callout-warning" role="alert">
                            <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                            <span>
                                {workerStatus.detail}
                                <button
                                    type="button"
                                    class="setup-recheck"
                                    onclick={checkWorker}
                                    disabled={checkingWorker}>
                                    {checkingWorker
                                        ? m.setup_btn_checking()
                                        : m.setup_btn_recheck()}
                                </button>
                            </span>
                        </div>
                    {/if}
                {/if}

                <!-- Optional-dependency reachability: which configured sibling
                     services/containers responded. Non-blocking — a warn just means
                     that feature won't work until the service is up. Unconfigured
                     services are omitted server-side, so this only shows what's set. -->
                {#if failingDepChecks.length > 0}
                    <div class="setup-pref-group setup-deps">
                        <div class="setup-deps-head">
                            <p class="setup-pref-group-label">{m.setup_deps_title()}</p>
                            {#if !depLoading}
                                <button
                                    type="button"
                                    class="setup-recheck"
                                    onclick={checkDependencies}>
                                    {m.setup_btn_recheck()}
                                </button>
                            {/if}
                        </div>
                        <p class="setup-pref-desc">{m.setup_deps_intro()}</p>

                        {#each failingDepChecks as c (c.id)}
                            <div class="setup-callout setup-callout-warning" role="status">
                                <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                <span>{dependencyCheckText(c)}</span>
                            </div>
                        {/each}
                    </div>
                {/if}

                <!-- Reverse-proxy bypass self-check: the proxy gating a
                     self-authenticating surface (/api/v1, /j, /subsonic) behind
                     the IdP breaks token clients and Jellyfin/Subsonic apps with
                     redirect loops. Warn only — nothing here blocks setup. -->
                {#if gatedSurfaces.length > 0}
                    <div class="setup-callout setup-callout-warning" role="alert">
                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                        <span>
                            {m.setup_proxy_gated({
                                surfaces: gatedSurfaces.map((c) => c.surface).join(', '),
                            })}
                        </span>
                    </div>
                {/if}

                <div class="setup-prefs">
                    <section class="space-y-3">
                        <h3 class="h3" id="setup-usecase-title">{m.setup_usecase_title()}</h3>
                        <p class="opacity-70">{m.setup_usecase_lede()}</p>
                        <UseCaseTiles
                            labelledby="setup-usecase-title"
                            options={[
                                { id: 'vod', label: m.setup_usecase_vod() },
                                { id: 'music', label: m.setup_usecase_music() },
                                { id: 'enterprise', label: m.setup_usecase_enterprise() },
                            ]}
                            selected={useCaseSelection}
                            ontoggle={toggleUseCase} />
                    </section>

                    <!-- Jump-nav: one chip per section below, gated the same way the
                         sections are, so the picker doubles as a table of contents. -->
                    <nav class="setup-chips" aria-label={m.setup_prefs_title()}>
                        {#each step3Sections as sec (sec.id)}
                            <button
                                type="button"
                                class="setup-chip"
                                onclick={() => jumpToSection(sec.id)}>
                                {sec.label}
                            </button>
                        {/each}
                    </nav>

                    <label class="setup-field" for="instance-name">
                        <span class="setup-label">{m.setup_instance_name()}</span>
                        <input
                            id="instance-name"
                            class="input"
                            type="text"
                            maxlength="50"
                            placeholder={appName}
                            bind:value={instanceName}
                            disabled={finishing} />
                    </label>

                    <!-- Integrations & AI — all optional, saved encrypted. TMDB is
                         first (metadata/artwork depend on it); MDBList enriches
                         ratings; embeddings power AI recommendations. -->
                    <div class="setup-pref-group" id="setup-sec-integrations">
                        <p class="setup-pref-group-label">{m.setup_integrations_group()}</p>

                        {#if wantsVideo}
                            <label class="setup-field" for="tmdb-key">
                                <span class="setup-label">
                                    {m.setup_tmdb_label()}
                                    {#if data.integrations.hasTmdb}
                                        <span class="setup-chip"
                                            >{m.setup_already_configured()}</span>
                                    {/if}
                                </span>
                                <input
                                    id="tmdb-key"
                                    class="input"
                                    type="password"
                                    autocomplete="off"
                                    placeholder={data.integrations.hasTmdb
                                        ? '••••••••'
                                        : m.setup_tmdb_placeholder()}
                                    bind:value={tmdbKey}
                                    disabled={finishing} />
                                <span class="setup-hint setup-hint-muted">
                                    {data.integrations.hasTmdb
                                        ? m.setup_key_replace_hint()
                                        : m.setup_tmdb_hint()}
                                </span>
                            </label>

                            <label class="setup-field" for="tmdb-language">
                                <span class="setup-label">{m.setup_metadata_lang_label()}</span>
                                <input
                                    id="tmdb-language"
                                    class="input"
                                    type="text"
                                    autocomplete="off"
                                    placeholder={m.setup_metadata_lang_placeholder()}
                                    bind:value={tmdbLanguage}
                                    title={data.metadataLanguage.tmdbLanguageLocked
                                        ? m.admin_settings_input_env_locked_title()
                                        : undefined}
                                    aria-invalid={primaryLanguageError ? 'true' : undefined}
                                    aria-describedby={primaryLanguageError
                                        ? 'tmdb-language-error'
                                        : undefined}
                                    disabled={finishing ||
                                        data.metadataLanguage.tmdbLanguageLocked} />
                                <span class="setup-hint setup-hint-muted"
                                    >{m.setup_metadata_lang_hint()}</span>
                                {#if primaryLanguageError}
                                    <span
                                        id="tmdb-language-error"
                                        class="setup-callout-warning"
                                        role="alert">{primaryLanguageError}</span>
                                {/if}
                            </label>

                            <label class="setup-field" for="tmdb-additional-languages">
                                <span class="setup-label"
                                    >{m.setup_metadata_additional_label()}</span>
                                <input
                                    id="tmdb-additional-languages"
                                    class="input"
                                    type="text"
                                    autocomplete="off"
                                    placeholder={m.setup_metadata_additional_placeholder()}
                                    bind:value={metadataAdditionalLanguages}
                                    disabled={finishing}
                                    aria-invalid={additionalLanguagesValidation.error !== null} />
                                {#if additionalLanguagesValidation.error}
                                    <span class="setup-hint setup-hint-error"
                                        >{additionalLanguagesValidation.error}</span>
                                {:else}
                                    <span class="setup-hint setup-hint-muted"
                                        >{m.setup_metadata_additional_hint()}</span>
                                {/if}
                            </label>

                            <button
                                type="button"
                                class="btn variant-soft-surface setup-oidc-test-btn"
                                onclick={() => testIntegration('tmdb')}
                                disabled={integrationTesting !== '' ||
                                    (!tmdbKey.trim() && !data.integrations.hasTmdb)}>
                                {#if integrationTesting === 'tmdb'}
                                    <span class="loading-spinner"></span>
                                    <span>{m.setup_key_test_testing()}</span>
                                {:else}
                                    <Icon src={Sparkles} class="h-5 w-5" />
                                    <span>{m.setup_key_test_btn()}</span>
                                {/if}
                            </button>
                            {#if integrationTestResult?.provider === 'tmdb'}
                                <div
                                    class="setup-callout {integrationTestResult.ok
                                        ? 'setup-callout-success'
                                        : 'setup-callout-error'}"
                                    role="status">
                                    <Icon
                                        src={integrationTestResult.ok
                                            ? CheckCircle
                                            : ExclamationTriangle}
                                        class="h-5 w-5 shrink-0" />
                                    <span
                                        >{integrationTestResult.ok
                                            ? m.setup_key_test_ok()
                                            : m.setup_key_test_failed({
                                                  error: integrationTestResult.error ?? '',
                                              })}</span>
                                </div>
                            {/if}

                            <label class="setup-field" for="mdblist-key">
                                <span class="setup-label">
                                    {m.setup_mdblist_label()}
                                    {#if data.integrations.hasMdblist}
                                        <span class="setup-chip"
                                            >{m.setup_already_configured()}</span>
                                    {/if}
                                </span>
                                <input
                                    id="mdblist-key"
                                    class="input"
                                    type="password"
                                    autocomplete="off"
                                    placeholder={data.integrations.hasMdblist ? '••••••••' : ''}
                                    bind:value={mdblistKey}
                                    disabled={finishing} />
                                <span class="setup-hint setup-hint-muted">
                                    {data.integrations.hasMdblist
                                        ? m.setup_key_replace_hint()
                                        : m.setup_mdblist_hint()}
                                </span>
                            </label>
                            <button
                                type="button"
                                class="btn variant-soft-surface setup-oidc-test-btn"
                                onclick={() => testIntegration('mdblist')}
                                disabled={integrationTesting !== '' ||
                                    (!mdblistKey.trim() && !data.integrations.hasMdblist)}>
                                {#if integrationTesting === 'mdblist'}
                                    <span class="loading-spinner"></span>
                                    <span>{m.setup_key_test_testing()}</span>
                                {:else}
                                    <Icon src={Sparkles} class="h-5 w-5" />
                                    <span>{m.setup_key_test_btn()}</span>
                                {/if}
                            </button>
                            {#if integrationTestResult?.provider === 'mdblist'}
                                <div
                                    class="setup-callout {integrationTestResult.ok
                                        ? 'setup-callout-success'
                                        : 'setup-callout-error'}"
                                    role="status">
                                    <Icon
                                        src={integrationTestResult.ok
                                            ? CheckCircle
                                            : ExclamationTriangle}
                                        class="h-5 w-5 shrink-0" />
                                    <span
                                        >{integrationTestResult.ok
                                            ? m.setup_key_test_ok()
                                            : m.setup_key_test_failed({
                                                  error: integrationTestResult.error ?? '',
                                              })}</span>
                                </div>
                            {/if}
                        {/if}

                        {#if wantsMusic}
                            <label class="setup-field" for="discogs-token">
                                <span class="setup-label">
                                    {m.setup_discogs_label()}
                                    {#if data.integrations.hasDiscogsToken}
                                        <span class="setup-chip"
                                            >{m.setup_already_configured()}</span>
                                    {/if}
                                </span>
                                <input
                                    id="discogs-token"
                                    class="input"
                                    type="password"
                                    autocomplete="off"
                                    placeholder={data.integrations.hasDiscogsToken
                                        ? '••••••••'
                                        : m.setup_discogs_placeholder()}
                                    bind:value={discogsToken}
                                    disabled={finishing} />
                                <span class="setup-hint setup-hint-muted">
                                    {data.integrations.hasDiscogsToken
                                        ? m.setup_key_replace_hint()
                                        : m.setup_discogs_hint()}
                                </span>
                            </label>

                            <label class="setup-field" for="lastfm-key">
                                <span class="setup-label">
                                    {m.setup_lastfm_label()}
                                    {#if data.integrations.hasLastfmKey}
                                        <span class="setup-chip"
                                            >{m.setup_already_configured()}</span>
                                    {/if}
                                </span>
                                <input
                                    id="lastfm-key"
                                    class="input"
                                    type="password"
                                    autocomplete="off"
                                    placeholder={data.integrations.hasLastfmKey
                                        ? '••••••••'
                                        : m.setup_lastfm_placeholder()}
                                    bind:value={lastfmKey}
                                    disabled={finishing} />
                                <span class="setup-hint setup-hint-muted">
                                    {data.integrations.hasLastfmKey
                                        ? m.setup_key_replace_hint()
                                        : m.setup_lastfm_hint()}
                                </span>
                            </label>
                        {/if}

                        <!-- Embeddings (AI recommendations). Provider picker; the
                             output dimension is LOCKED to the DB's vector width. -->
                        <div class="setup-field">
                            <label for="embed-provider" class="setup-label"
                                >{m.setup_embed_label()}</label>
                            <select
                                id="embed-provider"
                                class="select"
                                bind:value={embeddingProvider}
                                onchange={onEmbeddingProviderChange}
                                disabled={finishing}>
                                <option value="">{m.setup_embed_none()}</option>
                                <option value="openai">OpenAI</option>
                                <option value="voyage">Voyage AI</option>
                                <option value="custom">{m.setup_embed_custom()}</option>
                            </select>
                        </div>
                        <span class="setup-hint setup-hint-muted"
                            >{m.setup_embed_recommend_hint()}</span>

                        {#if embeddingProvider}
                            {#if embeddingProvider === 'custom'}
                                <label class="setup-field" for="embed-endpoint">
                                    <span class="setup-label"
                                        >{m.setup_embed_endpoint_label()}</span>
                                    <input
                                        id="embed-endpoint"
                                        class="input"
                                        type="url"
                                        autocomplete="off"
                                        spellcheck="false"
                                        placeholder="https://embeddings.example.com/v1"
                                        bind:value={embeddingEndpoint}
                                        disabled={finishing} />
                                </label>
                            {/if}
                            <label class="setup-field" for="embed-key">
                                <span class="setup-label">{m.setup_embed_key_label()}</span>
                                <input
                                    id="embed-key"
                                    class="input"
                                    type="password"
                                    autocomplete="new-password"
                                    bind:value={embeddingKey}
                                    disabled={finishing} />
                            </label>
                            <label class="setup-field" for="embed-model">
                                <span class="setup-label">{m.setup_embed_model_label()}</span>
                                <input
                                    id="embed-model"
                                    class="input"
                                    type="text"
                                    autocomplete="off"
                                    spellcheck="false"
                                    placeholder={embeddingProvider === 'voyage'
                                        ? 'voyage-3-lite'
                                        : 'text-embedding-3-small'}
                                    bind:value={embeddingModel}
                                    disabled={finishing} />
                            </label>
                            <span class="setup-hint setup-hint-muted">
                                {data.embeddingDimension
                                    ? m.setup_embed_dim_hint({
                                          dim: String(data.embeddingDimension),
                                      })
                                    : m.setup_embed_dim_hint_unknown()}
                            </span>

                            <!-- Embed a test string against the entered config to
                                 verify reachability/key/model + the vector width. -->
                            <button
                                type="button"
                                class="btn variant-soft-surface setup-oidc-test-btn"
                                onclick={testEmbedding}
                                disabled={embeddingTesting || !embeddingKey.trim()}>
                                {#if embeddingTesting}
                                    <span class="loading-spinner"></span>
                                    <span>{m.setup_embed_test_testing()}</span>
                                {:else}
                                    <Icon src={Sparkles} class="h-5 w-5" />
                                    <span>{m.setup_embed_test_btn()}</span>
                                {/if}
                            </button>

                            {#if embeddingTestResult}
                                {#if embeddingTestResult.ok && embeddingTestResult.matches}
                                    <div class="setup-callout setup-callout-success" role="status">
                                        <Icon src={CheckCircle} class="h-5 w-5 shrink-0" />
                                        <span
                                            >{m.setup_embed_test_ok({
                                                dim: String(embeddingTestResult.dimension ?? 0),
                                            })}</span>
                                    </div>
                                {:else if embeddingTestResult.ok}
                                    <div class="setup-callout setup-callout-warning" role="alert">
                                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                        <span
                                            >{m.setup_embed_test_mismatch({
                                                got: String(embeddingTestResult.dimension ?? 0),
                                                expected: String(embeddingTestResult.expected ?? 0),
                                            })}</span>
                                    </div>
                                {:else}
                                    <div class="setup-callout setup-callout-error" role="alert">
                                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                        <span
                                            >{m.setup_embed_test_failed_detail({
                                                error: embeddingTestResult.error ?? '',
                                            })}</span>
                                    </div>
                                {/if}
                            {/if}
                        {/if}
                    </div>

                    <!-- AI assistant (chat) — a SEPARATE feature from AI
                         recommendations (embeddings): its own provider + key, in its
                         own group so it doesn't read as a sub-option of recommendations. -->
                    <div class="setup-pref-group" id="setup-sec-assistant">
                        <p class="setup-pref-group-label">{m.setup_assistant_group()}</p>

                        <!-- AI assistant (chat) — enable/disable + provider/key/model.
                             Keys are write-only; an existing key is hinted via a
                             masked placeholder, same as the fields above. -->
                        <div class="setup-pref-row">
                            <div class="setup-pref-text">
                                <span class="setup-pref-name" id="setup-assistant-name"
                                    >{m.setup_assistant_name()}</span>
                                <span class="setup-pref-desc" id="setup-assistant-desc"
                                    >{m.setup_assistant_desc()}</span>
                            </div>
                            <Toggle
                                labelledby="setup-assistant-name"
                                describedby="setup-assistant-desc"
                                bind:checked={assistantEnabled}
                                disabled={finishing} />
                        </div>

                        {#if assistantEnabled}
                            <div class="setup-field">
                                <label for="assistant-provider" class="setup-label"
                                    >{m.setup_assistant_provider_label()}</label>
                                <select
                                    id="assistant-provider"
                                    class="select"
                                    bind:value={chatProvider}
                                    onchange={onChatProviderChange}
                                    disabled={finishing}>
                                    <option value="openai">OpenAI</option>
                                    <option value="anthropic">Anthropic</option>
                                </select>
                            </div>

                            <label class="setup-field" for="assistant-key">
                                <span class="setup-label">
                                    {m.setup_assistant_key_label()}
                                    {#if hasExistingChatKey}
                                        <span class="setup-chip"
                                            >{m.setup_already_configured()}</span>
                                    {/if}
                                </span>
                                <input
                                    id="assistant-key"
                                    class="input"
                                    type="password"
                                    autocomplete="new-password"
                                    placeholder={hasExistingChatKey ? '••••••••' : ''}
                                    bind:value={chatApiKey}
                                    disabled={finishing} />
                                {#if hasExistingChatKey}
                                    <span class="setup-hint setup-hint-muted"
                                        >{m.setup_key_replace_hint()}</span>
                                {/if}
                            </label>

                            <label class="setup-field" for="assistant-model">
                                <span class="setup-label">{m.setup_assistant_model_label()}</span>
                                <input
                                    id="assistant-model"
                                    class="input"
                                    type="text"
                                    autocomplete="off"
                                    spellcheck="false"
                                    placeholder={chatProvider === 'openai'
                                        ? data.assistant?.openaiModel
                                        : data.assistant?.anthropicModel}
                                    bind:value={chatModel}
                                    disabled={finishing} />
                            </label>

                            <!-- Send one tiny message with the entered config to
                                 verify reachability/key/model before saving. -->
                            <button
                                type="button"
                                class="btn variant-soft-surface setup-oidc-test-btn"
                                onclick={testChat}
                                disabled={chatTesting || !chatApiKey.trim()}>
                                {#if chatTesting}
                                    <span class="loading-spinner"></span>
                                    <span>{m.setup_assistant_test_testing()}</span>
                                {:else}
                                    <Icon src={Sparkles} class="h-5 w-5" />
                                    <span>{m.setup_assistant_test_btn()}</span>
                                {/if}
                            </button>

                            {#if chatTestResult}
                                {#if chatTestResult.ok}
                                    <div class="setup-callout setup-callout-success" role="status">
                                        <Icon src={CheckCircle} class="h-5 w-5 shrink-0" />
                                        <span
                                            >{m.setup_assistant_test_ok({
                                                model: chatTestResult.model ?? '',
                                            })}</span>
                                    </div>
                                {:else}
                                    <div class="setup-callout setup-callout-error" role="alert">
                                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                        <span
                                            >{m.setup_assistant_test_failed({
                                                error: chatTestResult.error ?? '',
                                            })}</span>
                                    </div>
                                {/if}
                            {/if}
                        {/if}
                    </div>

                    <!-- Apps & API — the Public API (FEATURE_DEVICE_AUTH). Visible, not
                         collapsed: it decides whether the native iPhone/iPad/Apple TV
                         apps can sign in at all, so the operator must see it. -->
                    <div class="setup-pref-group" id="setup-sec-apps">
                        <p class="setup-pref-group-label">{m.setup_apps_group()}</p>
                        <div class="setup-pref-row">
                            <div class="setup-pref-text">
                                <span class="setup-pref-name" id="setup-public-api-name"
                                    >{m.setup_public_api_name()}</span>
                                <span class="setup-pref-desc" id="setup-public-api-desc"
                                    >{m.setup_public_api_desc()}</span>
                            </div>
                            <Toggle
                                labelledby="setup-public-api-name"
                                describedby="setup-public-api-desc"
                                bind:checked={publicApiEnabled}
                                disabled={finishing} />
                        </div>
                        {#if !publicApiEnabled}
                            <div class="setup-callout setup-callout-warning" role="status">
                                <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                <span>{m.setup_public_api_off_warning()}</span>
                            </div>
                        {/if}
                    </div>

                    <!-- Lumastra licence — contact with lumastra.org at all, and the weekly
                         check-in. Visible, not collapsed: these are the default-on calls
                         to the project itself, so the operator decides them at first start. -->
                    <div class="setup-pref-group" id="setup-sec-license">
                        <p class="setup-pref-group-label">{m.setup_license_group()}</p>
                        <div class="setup-pref-row">
                            <div class="setup-pref-text">
                                <span class="setup-pref-name" id="setup-pref-license-contact-name"
                                    >{m.setup_pref_license_contact()}</span>
                                <span class="setup-pref-desc" id="setup-pref-license-contact-desc"
                                    >{m.setup_pref_license_contact_desc()}</span>
                            </div>
                            <Toggle
                                labelledby="setup-pref-license-contact-name"
                                describedby="setup-pref-license-contact-desc"
                                bind:checked={licenseServerContact}
                                onchange={({ checked }) => {
                                    // Back on: the weekly check-in is on again too (its default).
                                    if (checked && !licenseCheckInEnvLocked) licenseCheckIn = true;
                                }}
                                disabled={finishing || licenseServerContactEnvLocked} />
                        </div>
                        {#if !licenseServerContact}
                            <div
                                class="setup-callout setup-callout-warning"
                                role="status"
                                data-testid="setup-license-contact-off">
                                <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                <span>{m.setup_license_contact_off_warning()}</span>
                            </div>
                        {/if}
                        <div class="setup-pref-row">
                            <div class="setup-pref-text">
                                <span class="setup-pref-name" id="setup-pref-license-check-in-name"
                                    >{m.setup_pref_license_check_in()}</span>
                                <span class="setup-pref-desc" id="setup-pref-license-check-in-desc"
                                    >{licenseServerContact
                                        ? m.setup_pref_license_check_in_desc()
                                        : m.setup_pref_license_check_in_contact_off()}</span>
                            </div>
                            {#if licenseServerContact}
                                <Toggle
                                    labelledby="setup-pref-license-check-in-name"
                                    describedby="setup-pref-license-check-in-desc"
                                    bind:checked={licenseCheckIn}
                                    disabled={finishing || licenseCheckInEnvLocked} />
                            {:else}
                                <!-- No contact, no check-in: shown off and locked. The saved
                                     choice is kept and applies again if contact comes back. -->
                                <Toggle
                                    labelledby="setup-pref-license-check-in-name"
                                    describedby="setup-pref-license-check-in-desc"
                                    checked={false}
                                    disabled />
                            {/if}
                        </div>
                    </div>

                    <!-- Hardware transcoding — conditional/advanced; collapsed by default.
                         Video-family only: music transcoding doesn't need a GPU. -->
                    {#if wantsVideo}
                        <details class="setup-pref-details" id="setup-sec-hardware">
                            <summary class="setup-pref-summary">{m.setup_group_hardware()}</summary>
                            <div class="setup-pref-group setup-pref-group--nested">
                                {#if gpuLoading}
                                    <div class="setup-pref-row setup-pref-note">
                                        <span class="loading-spinner"></span>
                                        <span>{m.setup_gpu_checking()}</span>
                                    </div>
                                {:else if gpu?.modeConflict}
                                    <div class="setup-callout setup-callout-warning" role="alert">
                                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                        <span
                                            >{m.setup_gpu_mode_conflict({
                                                hosts: gpu.hosts
                                                    .filter((host) => host.transcodeEligible)
                                                    .map(
                                                        (host) =>
                                                            `${host.hostname}: ${host.recommended ?? 'none'}`,
                                                    )
                                                    .join('; '),
                                            })}</span>
                                    </div>
                                {:else if gpu?.recommended}
                                    <div
                                        class="setup-callout {gpu.recommendationVerified
                                            ? 'setup-callout-success'
                                            : 'setup-callout-warning'}"
                                        role="status">
                                        <Icon src={CpuChip} class="h-5 w-5 shrink-0" />
                                        <span
                                            >{gpu.recommendationVerified
                                                ? m.setup_gpu_detected({
                                                      vendor: gpu.recommendedVendor ?? '',
                                                  })
                                                : m.setup_gpu_recommended({
                                                      mode: gpu.recommended,
                                                      hostname: gpu.recommendedHost ?? gpu.hostname,
                                                  })}</span>
                                    </div>
                                    <div class="setup-pref-row">
                                        <div class="setup-pref-text">
                                            <span class="setup-pref-name" id="setup-gpu-use-name"
                                                >{m.setup_gpu_use()}</span>
                                            <span class="setup-pref-desc" id="setup-gpu-use-desc"
                                                >{m.setup_gpu_use_desc()}</span>
                                        </div>
                                        <Toggle
                                            labelledby="setup-gpu-use-name"
                                            describedby="setup-gpu-use-desc"
                                            bind:checked={useGpu}
                                            disabled={finishing} />
                                    </div>
                                {:else}
                                    <div class="setup-pref-row setup-pref-note">
                                        <Icon src={CpuChip} class="h-5 w-5 shrink-0" />
                                        <span
                                            >{gpu && !gpu.onlyLocalHost
                                                ? m.setup_gpu_cluster_none()
                                                : m.setup_gpu_none()}</span>
                                        <button
                                            type="button"
                                            class="setup-recheck"
                                            onclick={detectGpu}>
                                            {m.setup_btn_recheck()}
                                        </button>
                                    </div>
                                    {#if gpu?.inContainer && !gpu.driPresent}
                                        <!-- The most common cause of "no GPU" in Docker:
                                             /dev/dri simply isn't mounted into the container. -->
                                        <div
                                            class="setup-callout setup-callout-warning"
                                            role="note">
                                            <Icon
                                                src={ExclamationTriangle}
                                                class="h-5 w-5 shrink-0" />
                                            <span>{m.setup_gpu_docker_hint()}</span>
                                        </div>
                                    {/if}
                                    <!-- The /dev/dri hint above only covers Intel/AMD
                                         passthrough — an NVIDIA GPU needs a different
                                         Docker setup entirely, so call it out too. -->
                                    <div class="setup-callout setup-callout-warning" role="note">
                                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                        <span>{m.setup_gpu_nvidia_hint()}</span>
                                    </div>
                                {/if}
                                {#if !gpuLoading && gpu}
                                    {#each gpu.hosts as host (host.id)}
                                        <div class="setup-pref-row">
                                            <div class="setup-pref-text">
                                                <span class="setup-pref-name">{host.hostname}</span>
                                                <span class="setup-pref-desc"
                                                    >{host.gpus.length > 0
                                                        ? host.gpus.join(', ')
                                                        : m.setup_gpu_host_none()}</span>
                                                {#if !host.transcodeEligible}
                                                    <span class="setup-pref-desc"
                                                        >{m.setup_gpu_host_ineligible()}</span>
                                                {:else if host.recommended && !host.verified}
                                                    <span class="setup-pref-desc"
                                                        >{m.setup_gpu_host_untested()}</span>
                                                {:else if !host.recommended && host.gpus.length > 0}
                                                    <span class="setup-pref-desc"
                                                        >{m.setup_gpu_host_unusable()}</span>
                                                {/if}
                                            </div>
                                        </div>
                                    {/each}
                                    {#if gpu.onlyLocalHost && gpu.hostname}
                                        <div class="setup-pref-row setup-pref-note">
                                            <span
                                                >{m.setup_gpu_local_only({
                                                    hostname:
                                                        gpu.hosts[0]?.hostname ?? gpu.hostname,
                                                })}</span>
                                        </div>
                                    {/if}
                                    {#if gpu.recommended || gpu.modeConflict}
                                        <button
                                            type="button"
                                            class="setup-recheck"
                                            onclick={detectGpu}>
                                            {m.setup_btn_recheck()}
                                        </button>
                                    {/if}
                                {/if}
                            </div>
                        </details>
                    {/if}

                    <!-- Generation toggles — rows gated by content family (trickplay/
                         intro are video analysis; lyrics is music-only). Collapsed by
                         default: the step-4 recap surfaces whatever was left untouched,
                         so defaults-are-fine operators never need to open this. -->
                    <details class="setup-pref-details" id="setup-sec-scanning">
                        <summary class="setup-pref-summary">{m.setup_group_scanning()}</summary>
                        <div class="setup-pref-group setup-pref-group--nested">
                            {#if wantsVideo}
                                <div class="setup-pref-row">
                                    <div class="setup-pref-text">
                                        <span class="setup-pref-name" id="setup-pref-trickplay-name"
                                            >{m.setup_pref_trickplay()}</span>
                                        <span class="setup-pref-desc" id="setup-pref-trickplay-desc"
                                            >{m.setup_pref_trickplay_desc()}</span>
                                    </div>
                                    <Toggle
                                        labelledby="setup-pref-trickplay-name"
                                        describedby="setup-pref-trickplay-desc"
                                        bind:checked={trickplay}
                                        disabled={finishing} />
                                </div>
                                <div class="setup-pref-row">
                                    <div class="setup-pref-text">
                                        <span class="setup-pref-name" id="setup-pref-intro-name"
                                            >{m.setup_pref_intro()}</span>
                                        <span class="setup-pref-desc" id="setup-pref-intro-desc"
                                            >{m.setup_pref_intro_desc()}</span>
                                    </div>
                                    <Toggle
                                        labelledby="setup-pref-intro-name"
                                        describedby="setup-pref-intro-desc"
                                        checked={introAnalyzer}
                                        onchange={(d) => (introAnalyzerOverride = d.checked)}
                                        disabled={finishing} />
                                </div>
                            {/if}
                            {#if wantsMusic}
                                <div class="setup-pref-row">
                                    <div class="setup-pref-text">
                                        <span class="setup-pref-name" id="setup-pref-lyrics-name"
                                            >{m.setup_pref_lyrics()}</span>
                                        <span class="setup-pref-desc" id="setup-pref-lyrics-desc"
                                            >{m.setup_pref_lyrics_desc()}</span>
                                    </div>
                                    <Toggle
                                        labelledby="setup-pref-lyrics-name"
                                        describedby="setup-pref-lyrics-desc"
                                        checked={autoLyrics}
                                        onchange={(d) => (autoLyricsOverride = d.checked)}
                                        disabled={finishing} />
                                </div>
                            {/if}
                            <div class="setup-pref-row">
                                <div class="setup-pref-text">
                                    <span class="setup-pref-name" id="setup-pref-metadata-name"
                                        >{m.setup_pref_metadata()}</span>
                                    <span class="setup-pref-desc" id="setup-pref-metadata-desc"
                                        >{m.setup_pref_metadata_desc()}</span>
                                </div>
                                <Toggle
                                    labelledby="setup-pref-metadata-name"
                                    describedby="setup-pref-metadata-desc"
                                    bind:checked={metadataAlongside}
                                    disabled={finishing} />
                            </div>
                        </div>
                    </details>

                    <!-- Privacy — collapsed by default, same reasoning as Scanning. -->
                    <details class="setup-pref-details" id="setup-sec-privacy">
                        <summary class="setup-pref-summary">{m.setup_group_privacy()}</summary>
                        <div class="setup-pref-group setup-pref-group--nested">
                            <!-- First: the only preference here that decides what users
                                 can see about EACH OTHER. It is disclosed at first run
                                 because it enables the audience and there is otherwise no
                                 point at which anyone is told — a user would have to
                                 find Settings → Privacy on their own. -->
                            <div class="setup-pref-row">
                                <div class="setup-pref-text">
                                    <span
                                        class="setup-pref-name"
                                        id="setup-pref-share-activity-name"
                                        >{m.setup_pref_share_activity()}</span>
                                    <span
                                        class="setup-pref-desc"
                                        id="setup-pref-share-activity-desc"
                                        >{m.setup_pref_share_activity_desc()}</span>
                                </div>
                                <Toggle
                                    labelledby="setup-pref-share-activity-name"
                                    describedby="setup-pref-share-activity-desc"
                                    bind:checked={shareActivity}
                                    disabled={finishing} />
                            </div>
                            <div class="setup-pref-row">
                                <div class="setup-pref-text">
                                    <span class="setup-pref-name" id="setup-default-sharing-name"
                                        >{m.activity_sharing_default_label()}</span>
                                    <span class="setup-pref-desc" id="setup-default-sharing-desc"
                                        >{m.activity_sharing_default_description()}</span>
                                </div>
                                <Toggle
                                    labelledby="setup-default-sharing-name"
                                    describedby="setup-default-sharing-desc"
                                    bind:checked={defaultActivitySharing}
                                    disabled={finishing ||
                                        data.preferences.envLocked.includes(
                                            'defaultActivitySharing',
                                        )} />
                            </div>
                            <div class="setup-pref-row">
                                <div class="setup-pref-text">
                                    <span class="setup-pref-name" id="setup-pref-gravatar-name"
                                        >{m.setup_pref_gravatar()}</span>
                                    <span class="setup-pref-desc" id="setup-pref-gravatar-desc"
                                        >{m.setup_pref_gravatar_desc()}</span>
                                </div>
                                <Toggle
                                    labelledby="setup-pref-gravatar-name"
                                    describedby="setup-pref-gravatar-desc"
                                    checked={gravatar}
                                    onchange={(d) => (gravatarOverride = d.checked)}
                                    disabled={finishing} />
                            </div>
                            {#if wantsVideo}
                                <div class="setup-pref-row">
                                    <div class="setup-pref-text">
                                        <span class="setup-pref-name" id="setup-pref-unrated-name"
                                            >{m.setup_pref_unrated()}</span>
                                        <span class="setup-pref-desc" id="setup-pref-unrated-desc"
                                            >{m.setup_pref_unrated_desc()}</span>
                                    </div>
                                    <Toggle
                                        labelledby="setup-pref-unrated-name"
                                        describedby="setup-pref-unrated-desc"
                                        bind:checked={unrated}
                                        disabled={finishing} />
                                </div>
                                <div class="setup-pref-row">
                                    <div class="setup-pref-text">
                                        <span
                                            class="setup-pref-name"
                                            id="setup-pref-show-unavailable-name"
                                            >{m.setup_pref_show_unavailable()}</span>
                                        <span
                                            class="setup-pref-desc"
                                            id="setup-pref-show-unavailable-desc"
                                            >{m.setup_pref_show_unavailable_desc()}</span>
                                    </div>
                                    <Toggle
                                        labelledby="setup-pref-show-unavailable-name"
                                        describedby="setup-pref-show-unavailable-desc"
                                        checked={showUnavailableMedia}
                                        onchange={(d) => (showUnavailableMediaOverride = d.checked)}
                                        disabled={finishing} />
                                </div>
                            {/if}
                        </div>
                    </details>

                    <!-- Single sign-on (only when OIDC is already configured via env).
                         Back-channel logout is always active under OIDC; this toggle
                         just controls whether a provider logout also clears device
                         app sessions. Conditional/advanced; collapsed by default. -->
                    {#if data.oidcEnabled}
                        <details class="setup-pref-details">
                            <summary class="setup-pref-summary">{m.setup_group_sso()}</summary>
                            <div class="setup-pref-group setup-pref-group--nested">
                                <div class="setup-pref-row">
                                    <div class="setup-pref-text">
                                        <span
                                            class="setup-pref-name"
                                            id="setup-pref-bcl-cascade-name"
                                            >{m.setup_pref_bcl_cascade()}</span>
                                        <span
                                            class="setup-pref-desc"
                                            id="setup-pref-bcl-cascade-desc"
                                            >{m.setup_pref_bcl_cascade_desc()}</span>
                                    </div>
                                    <Toggle
                                        labelledby="setup-pref-bcl-cascade-name"
                                        describedby="setup-pref-bcl-cascade-desc"
                                        bind:checked={bclCascade}
                                        disabled={finishing} />
                                </div>
                            </div>
                        </details>
                    {/if}

                    <!-- Connect Jellyfin (optional). Validates + saves live (no
                         restart); warns if the admin's username has no matching
                         Jellyfin user. Import runs automatically after a library
                         is scanned, so no "import now" here. Conditional/advanced;
                         collapsed by default. Video-family only. -->
                    {#if wantsVideo}
                        <details class="setup-pref-details" id="setup-sec-jellyfin">
                            <summary class="setup-pref-summary">{m.setup_jf_group()}</summary>
                            <div class="setup-pref-group setup-pref-group--nested">
                                <p class="setup-pref-desc">{m.setup_jf_desc()}</p>
                                <p class="setup-pref-desc">{m.setup_jf_sync_interval()}</p>

                                <label class="setup-field" for="jf-url">
                                    <span class="setup-label">{m.setup_jf_url_label()}</span>
                                    <input
                                        id="jf-url"
                                        class="input"
                                        type="url"
                                        autocomplete="off"
                                        placeholder={m.setup_jf_url_placeholder()}
                                        bind:value={jellyfinUrl}
                                        disabled={jellyfinTesting || finishing} />
                                </label>

                                <label class="setup-field" for="jf-key">
                                    <span class="setup-label">{m.setup_jf_key_label()}</span>
                                    <input
                                        id="jf-key"
                                        class="input"
                                        type="password"
                                        autocomplete="off"
                                        placeholder={m.setup_jf_key_placeholder()}
                                        bind:value={jellyfinApiKey}
                                        disabled={jellyfinTesting || finishing} />
                                </label>

                                <button
                                    type="button"
                                    class="btn variant-soft-surface"
                                    onclick={testJellyfin}
                                    disabled={!canTestJellyfin}>
                                    {#if jellyfinTesting}
                                        <span class="loading-spinner"></span>
                                        <span>{m.setup_jf_btn_testing()}</span>
                                    {:else}
                                        <Icon src={GlobeAlt} class="h-5 w-5" />
                                        <span>{m.setup_jf_btn_test()}</span>
                                    {/if}
                                </button>

                                {#if jellyfinResult}
                                    {#if jellyfinResult.connected}
                                        <div
                                            class="setup-callout setup-callout-success"
                                            role="status">
                                            <Icon src={CheckCircle} class="h-5 w-5 shrink-0" />
                                            <span
                                                >{m.setup_jf_connected({
                                                    serverName:
                                                        jellyfinResult.serverName ?? 'Jellyfin',
                                                    version: jellyfinResult.version ?? '?',
                                                })}</span>
                                        </div>
                                        {#if jellyfinResult.adminMatched}
                                            <p class="setup-hint setup-hint-muted">
                                                {m.setup_jf_match_ok({
                                                    name: jellyfinResult.matchedName ?? '',
                                                })}
                                            </p>
                                        {:else}
                                            <div
                                                class="setup-callout setup-callout-warning"
                                                role="alert">
                                                <Icon
                                                    src={ExclamationTriangle}
                                                    class="h-5 w-5 shrink-0" />
                                                <span
                                                    >{m.setup_jf_match_warn({
                                                        username:
                                                            jellyfinResult.adminUsername ?? '',
                                                    })}</span>
                                            </div>
                                        {/if}
                                        {#if jellyfinResult.syncStarted === false}
                                            <p
                                                class="setup-callout setup-callout-warning"
                                                role="status">
                                                {m.setup_jellyfin_sync_start_failed()}
                                            </p>
                                        {/if}
                                    {:else}
                                        <div class="setup-callout setup-callout-error" role="alert">
                                            <Icon
                                                src={ExclamationTriangle}
                                                class="h-5 w-5 shrink-0" />
                                            <span
                                                >{jellyfinResult.error ??
                                                    m.setup_jf_failed()}</span>
                                        </div>
                                    {/if}
                                {/if}

                                <span class="setup-hint setup-hint-muted">{m.setup_jf_hint()}</span>
                            </div>
                        </details>
                    {/if}

                    <!-- External client compatibility (/j, /subsonic). Off makes the
                         respective API return 404 — for operators who don't want to
                         expose these surfaces to external clients at all.
                         Conditional/advanced; collapsed by default. Rows gated by
                         content family (/j serves video clients, Subsonic music). -->
                    <details class="setup-pref-details" id="setup-sec-extcompat">
                        <summary class="setup-pref-summary">{m.setup_jfcompat_group()}</summary>
                        <div class="setup-pref-group setup-pref-group--nested">
                            {#if wantsVideo}
                                <div class="setup-pref-row">
                                    <div class="setup-pref-text">
                                        <span class="setup-pref-name" id="setup-jfcompat-name"
                                            >{m.setup_jfcompat_name()}</span>
                                        <span class="setup-pref-desc" id="setup-jfcompat-desc"
                                            >{m.setup_jfcompat_desc()}</span>
                                    </div>
                                    <Toggle
                                        labelledby="setup-jfcompat-name"
                                        describedby="setup-jfcompat-desc"
                                        bind:checked={jellyfinCompatEnabled}
                                        disabled={finishing} />
                                </div>
                            {/if}
                            {#if wantsMusic}
                                <div class="setup-pref-row">
                                    <div class="setup-pref-text">
                                        <span class="setup-pref-name" id="setup-subsonic-name"
                                            >{m.setup_subsonic_name()}</span>
                                        <span class="setup-pref-desc" id="setup-subsonic-desc"
                                            >{m.setup_subsonic_desc()}</span>
                                    </div>
                                    <Toggle
                                        labelledby="setup-subsonic-name"
                                        describedby="setup-subsonic-desc"
                                        bind:checked={subsonicEnabled}
                                        disabled={finishing} />
                                </div>
                            {/if}
                        </div>
                    </details>
                </div>

                {#if step3SaveError}
                    <div class="setup-callout setup-callout-warning" role="alert">
                        {step3SaveError}
                    </div>
                {/if}
                <div class="setup-actions setup-actions-end">
                    <button
                        type="button"
                        class="btn variant-ghost-surface"
                        onclick={skipToLibrary}
                        disabled={finishing}>
                        {m.setup_btn_skip()}
                    </button>
                    <button
                        type="button"
                        class="btn variant-filled-primary"
                        onclick={finishSetup}
                        disabled={finishing}>
                        {#if finishing}
                            <span class="loading-spinner loading-spinner-white"></span>
                            <span>{m.setup_btn_saving()}</span>
                        {:else}
                            <span>{m.setup_btn_save_continue()}</span>
                            <Icon src={ArrowRight} class="h-5 w-5" />
                        {/if}
                    </button>
                </div>
            {:else if step === 4}
                <!-- STEP 4 — add one or more media libraries -->
                <h1 class="setup-title">
                    {addedLibraries.length === 0 ? m.setup_lib_title() : m.setup_lib_title_more()}
                </h1>
                <p class="setup-lede">
                    {addedLibraries.length === 0 ? m.setup_lib_lede() : m.setup_lib_lede_more()}
                </p>

                {#if addedLibraries.length > 0}
                    <ul class="setup-steps-list">
                        {#each addedLibraries as lib (lib.path)}
                            <li>
                                <span class="setup-steps-num">
                                    <Icon src={CheckCircle} class="h-4 w-4" />
                                </span>
                                <span>
                                    <strong>{lib.label}</strong> ·
                                    {#if lib.remote}{lib.remote.name}{:else}<code>{lib.path}</code
                                        >{/if}
                                    {#if !lib.runId}
                                        <span class="setup-hint setup-hint-muted">
                                            {m.setup_scan_queued()}
                                        </span>
                                    {/if}
                                </span>
                            </li>
                        {/each}
                    </ul>
                {/if}

                {#if libraryError}
                    <div class="setup-callout setup-callout-warning" role="alert">
                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                        <span>{libraryError}</span>
                    </div>
                {/if}

                <!-- Suggested libraries from the server-side mount scan: folders named
                     like a library come with their type and are preselected, so a
                     standard layout (movies/, series/, music/) is one click. -->
                {#if mountsLoading && unusedMountCandidates.length === 0}
                    <section class="setup-suggest" aria-busy="true">
                        <p class="setup-hint setup-hint-muted" role="status">
                            {m.setup_lib_suggest_loading()}
                        </p>
                    </section>
                {:else if unusedMountCandidates.length > 0}
                    <section class="setup-suggest" aria-labelledby="setup-suggest-title">
                        <h2 class="setup-suggest-title" id="setup-suggest-title">
                            {m.setup_lib_suggest_title()}
                        </h2>
                        <p class="setup-hint setup-hint-muted">{m.setup_lib_suggest_hint()}</p>
                        <ul class="setup-suggest-list">
                            {#each unusedMountCandidates as c (c.path)}
                                <li class="setup-suggest-row">
                                    <input
                                        type="checkbox"
                                        class="checkbox"
                                        id={`suggest-${c.path}`}
                                        bind:checked={suggestionChecked[c.path]}
                                        disabled={libraryCreating || !suggestionTypes[c.path]} />
                                    <label class="setup-suggest-path" for={`suggest-${c.path}`}>
                                        <code>{c.path}</code>
                                        {#if c.entries === 0}
                                            <span class="setup-hint setup-hint-muted"
                                                >{m.setup_lib_suggest_empty()}</span>
                                        {/if}
                                    </label>
                                    <select
                                        class="select setup-suggest-type"
                                        aria-label={`${m.setup_lib_type_label()} ${c.path}`}
                                        bind:value={suggestionTypes[c.path]}
                                        onchange={() => {
                                            suggestionChecked[c.path] =
                                                suggestionTypes[c.path] !== '';
                                        }}
                                        disabled={libraryCreating}>
                                        <option value="" disabled
                                            >{m.setup_lib_type_choose()}</option>
                                        {#each LIBRARY_MEDIA_TYPES as t (t.id)}
                                            <option value={t.id}>{t.label()}</option>
                                        {/each}
                                    </select>
                                </li>
                            {/each}
                        </ul>
                    </section>
                {/if}

                <!-- Audiobooks: never a folder, always an Audiobookshelf library.
                     Collapsed unless a stored connection already answers (no use
                     case implies audiobooks, and most installs have no ABS). -->
                <details
                    class="setup-pref-details setup-abs"
                    id="setup-sec-audiobookshelf"
                    bind:open={audiobookshelfOpen}>
                    <summary class="setup-pref-summary">{m.setup_abs_group()}</summary>
                    <div class="setup-pref-group setup-pref-group--nested">
                        <AudiobookshelfSetupCard
                            addedIds={addedAudiobookshelfIds}
                            disabled={libraryCreating}
                            onadded={addAudiobookshelfLibrary}
                            onconnected={() => (audiobookshelfOpen = true)}
                            onbusy={(busy) => (audiobookshelfAdding = busy)}
                            onpending={(count) => (audiobookshelfPending = count)}
                            bind:this={audiobookshelfCard} />
                    </div>
                </details>

                {#if unusedMountCandidates.length > 0}
                    <h2 class="setup-suggest-title setup-suggest-manual">
                        {m.setup_lib_manual_title()}
                    </h2>
                {/if}

                <form
                    method="post"
                    class="setup-form"
                    onsubmit={(e) => {
                        e.preventDefault();
                        addLibrary();
                    }}>
                    <label class="setup-field" for="lib-path">
                        <span class="setup-label">{m.setup_lib_path_label()}</span>
                        <input
                            id="lib-path"
                            class="input"
                            type="text"
                            autocomplete="off"
                            autocapitalize="none"
                            spellcheck="false"
                            placeholder={m.setup_lib_path_placeholder()}
                            bind:value={libraryPath}
                            disabled={libraryCreating} />
                        <span class="setup-hint setup-hint-muted">{m.setup_lib_path_hint()}</span>
                    </label>

                    <label class="setup-field" for="lib-type">
                        <span class="setup-label">{m.setup_lib_type_label()}</span>
                        <select
                            id="lib-type"
                            class="select"
                            bind:value={libraryMediaType}
                            disabled={libraryCreating}>
                            <option value="" disabled>{m.setup_lib_type_choose()}</option>
                            {#each LIBRARY_MEDIA_TYPES as t (t.id)}
                                <option value={t.id}>{t.label()}</option>
                            {/each}
                        </select>
                        <span class="setup-hint setup-hint-muted">{m.setup_lib_type_hint()}</span>
                        <span class="setup-hint setup-hint-muted"
                            >{m.setup_lib_audiobooks_hint()}</span>
                    </label>

                    <div class="setup-actions">
                        {#if addedLibraries.length === 0 && pendingLibraryCount === 0}
                            <button
                                type="button"
                                class="btn variant-ghost-surface"
                                onclick={skipToLibrary}
                                disabled={libraryCreating || audiobookshelfAdding}>
                                {m.setup_lib_skip()}
                            </button>
                        {/if}
                        {#if addedLibraries.length === 0 && pendingLibraryCount === 0}
                            <div class="setup-actions-spacer"></div>
                            <!-- Next to the suggested libraries, adding a typed path is the
                                 secondary action; alone, it is the step's main button. -->
                            <button
                                type="submit"
                                class="btn {unusedMountCandidates.length > 0
                                    ? 'variant-ghost-surface'
                                    : 'variant-filled-primary'}"
                                disabled={libraryCreating ||
                                    !libraryPath.trim() ||
                                    !libraryMediaType}>
                                {#if libraryCreating}
                                    <span class="loading-spinner loading-spinner-white"></span>
                                    <span>{m.setup_lib_starting()}</span>
                                {:else if unusedMountCandidates.length > 0}
                                    <Icon src={Plus} class="h-5 w-5" />
                                    <span>{m.setup_lib_add_another()}</span>
                                {:else}
                                    <Icon src={Sparkles} class="h-5 w-5" />
                                    <span>{m.setup_lib_start()}</span>
                                {/if}
                            </button>
                        {:else}
                            <!-- With libraries added or ticked, "add another" is the secondary
                                 action; the primary one adds whatever is ticked (folders and
                                 Audiobookshelf libraries) and continues. -->
                            <button
                                type="submit"
                                class="btn variant-ghost-surface"
                                disabled={libraryCreating ||
                                    !libraryPath.trim() ||
                                    !libraryMediaType}>
                                {#if libraryCreating}
                                    <span class="loading-spinner"></span>
                                    <span>{m.setup_lib_starting()}</span>
                                {:else}
                                    <Icon src={Plus} class="h-5 w-5" />
                                    <span>{m.setup_lib_add_another()}</span>
                                {/if}
                            </button>
                            <div class="setup-actions-spacer"></div>
                            <button
                                type="button"
                                class="btn variant-filled-primary"
                                onclick={() => void addSelectedThenContinue()}
                                disabled={libraryCreating || audiobookshelfAdding}>
                                <span
                                    >{pendingLibraryCount === 0
                                        ? m.setup_lib_continue()
                                        : pendingLibraryCount === 1
                                          ? m.setup_lib_add_one_and_continue()
                                          : m.setup_lib_add_and_continue({
                                                count: String(pendingLibraryCount),
                                            })}</span>
                                <Icon src={ArrowRight} class="h-5 w-5" />
                            </button>
                        {/if}
                    </div>
                </form>
            {:else}
                <!-- STEP 5 — first-scan progress, one card per added library -->
                <div
                    class="setup-finish-badge"
                    class:setup-finish-badge--warn={anyScanFailed ||
                        scanEmpty ||
                        metadataProviderFailed}
                    class:setup-finish-badge--busy={!allScansDone &&
                        !anyScanFailed &&
                        !scanEmpty &&
                        !metadataProviderFailed}>
                    <Icon
                        src={anyScanFailed || scanEmpty || metadataProviderFailed
                            ? ExclamationTriangle
                            : allScansDone
                              ? CheckCircle
                              : Sparkles}
                        class="h-7 w-7 {anyScanFailed || scanEmpty || metadataProviderFailed
                            ? 'text-warning-400'
                            : allScansDone
                              ? 'text-success-400'
                              : 'text-primary-400'}" />
                </div>
                <h1 class="setup-title">
                    {scanEmpty
                        ? m.setup_scan_empty_title()
                        : metadataProviderFailed
                          ? scanMetadataError === 'provider_unavailable'
                              ? m.setup_scan_metadata_missing_title()
                              : m.setup_scan_metadata_warn_title()
                          : allScansDone
                            ? m.setup_scan_done_title()
                            : m.setup_scan_title()}
                </h1>
                <p class="setup-lede">
                    {scanEmpty
                        ? m.setup_scan_empty_lede({ type: addedTypesLabel })
                        : metadataProviderFailed
                          ? scanMetadataError === 'provider_unavailable'
                              ? m.setup_scan_metadata_missing_lede()
                              : m.setup_scan_metadata_warn_lede()
                          : allScansDone
                            ? m.setup_scan_done_lede()
                            : m.setup_scan_lede({ appName })}
                </p>

                {#if allScansDone && (jellyfinStatus?.configured || jellyfinStatusUnavailable || jellyfinPollingExpired)}
                    <p class="setup-lede" role="status">
                        {jellyfinPollingExpired
                            ? m.setup_jellyfin_status_settings()
                            : jellyfinStatusUnavailable
                              ? m.setup_jellyfin_status_unavailable()
                              : jellyfinStatus?.syncStarted === false
                                ? m.setup_jellyfin_sync_start_failed()
                                : jellyfinStatus?.syncing
                                  ? m.setup_jellyfin_syncing()
                                  : jellyfinStatus?.retrying
                                    ? m.setup_jellyfin_retrying()
                                    : jellyfinStatus?.failed
                                      ? m.setup_jellyfin_sync_failed()
                                      : m.setup_jellyfin_paired({
                                            paired: jellyfinStatus?.paired ?? 0,
                                            waiting: jellyfinStatus?.waiting ?? 0,
                                        })}
                    </p>
                {/if}

                {#each addedLibraries as lib (lib.path)}
                    {@const run = lib.runId ? scanRunsById[lib.runId] : undefined}
                    {@const stage = stageFor(run)}
                    {@const percent = percentFor(run)}
                    {@const done = isRunDone(run)}
                    {@const failed = isRunFailed(run)}
                    <div class="setup-scan">
                        <p class="setup-scan-name">
                            {lib.label} · {lib.remote ? lib.remote.name : lib.path}
                        </p>
                        {#if !lib.runId}
                            <!-- Library created but the scan couldn't start (queue busy). -->
                            <div class="setup-callout setup-callout-warning" role="status">
                                <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                <span>{m.setup_scan_queued()}</span>
                                <button
                                    type="button"
                                    class="btn variant-soft-surface"
                                    disabled={retryingScans[lib.path]}
                                    onclick={() => void retryQueuedScan(lib)}>
                                    {retryingScans[lib.path]
                                        ? m.setup_btn_saving()
                                        : m.setup_scan_retry()}
                                </button>
                            </div>
                            {#if retryScanErrors[lib.path]}
                                <p class="setup-callout setup-callout-warning" role="alert">
                                    {retryScanErrors[lib.path]}
                                </p>
                            {/if}
                        {:else}
                            <div
                                class="setup-scan-bar"
                                class:is-indeterminate={percent === null}
                                role="progressbar"
                                aria-label={lib.label}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={percent ?? undefined}>
                                <span
                                    class="setup-scan-fill"
                                    class:is-failed={failed}
                                    style={percent !== null ? `width:${percent}%` : undefined}
                                ></span>
                            </div>
                            <div class="setup-scan-meta">
                                <span class="setup-scan-stage">
                                    {#if done}
                                        {failed ? m.setup_scan_failed() : m.setup_scan_complete()}
                                    {:else if stage}
                                        {scanProgressLabel(stage.label) ??
                                            scanProgressLabel(stage.id) ??
                                            m.setup_scan_phase_main()}{#if (stage.total ?? 0) > 0}
                                            · {stage.processed ?? 0}/{stage.total}{/if}
                                    {:else}
                                        {m.setup_scan_starting()}
                                    {/if}
                                </span>
                                {#if percent !== null && !done}
                                    <span class="setup-scan-pct">{percent}%</span>
                                {/if}
                            </div>
                            {#if stage?.currentItem && !done}
                                <p
                                    class="setup-scan-item"
                                    title={scanProgressLabel(stage.currentItem) ??
                                        stage.currentItem}>
                                    {scanProgressLabel(stage.currentItem) ?? stage.currentItem}
                                </p>
                            {/if}
                        {/if}
                    </div>
                {/each}

                {#if canFixTmdbHere}
                    <form
                        method="post"
                        class="setup-form setup-finish-tmdb"
                        onsubmit={(e) => {
                            e.preventDefault();
                            void saveTmdbKeyAndRescan();
                        }}>
                        <label class="setup-field" for="finish-tmdb-key">
                            <span class="setup-label">{m.setup_tmdb_label()}</span>
                            <input
                                id="finish-tmdb-key"
                                class="input"
                                type="password"
                                autocomplete="new-password"
                                data-1p-ignore
                                data-lpignore="true"
                                autocapitalize="none"
                                spellcheck="false"
                                placeholder={m.setup_tmdb_placeholder()}
                                bind:value={finishTmdbKey}
                                disabled={finishTmdbSaving} />
                            <span class="setup-hint setup-hint-muted"
                                >{m.setup_scan_tmdb_inline_hint()}
                                <a
                                    href="https://www.themoviedb.org/settings/api"
                                    target="_blank"
                                    rel="noopener noreferrer">{m.setup_scan_tmdb_get_key()}</a
                                ></span>
                        </label>
                        {#if finishTmdbError}
                            <div class="setup-callout setup-callout-warning" role="alert">
                                <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                                <span>{finishTmdbError}</span>
                            </div>
                        {/if}
                    </form>
                {:else if metadataProviderFailed}
                    <div class="setup-callout setup-callout-warning" role="alert">
                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                        <span>{m.setup_scan_metadata_warn_hint()}</span>
                    </div>
                {/if}

                <p>
                    <a
                        class="underline"
                        href={url('/admin/settings/playback?category=ffmpeg-hardware')}
                        >{m.admin_hardware_review_settings()}</a>
                </p>

                <div class="setup-callout setup-backup-note setup-finish-backup" role="note">
                    <Icon src={CircleStack} class="h-5 w-5 shrink-0" />
                    <span>
                        <strong>{m.setup_s3_backup_label()}</strong>
                        {m.setup_s3_backup_text_pre()}
                        <code class="setup-code">{data.configDir ?? '/config'}</code>.
                        {#if data.masterKeySource === 'env'}
                            {m.setup_s3_backup_env_key()}
                        {:else if data.masterKeySource === 'file' || data.masterKeySource === 'generated'}
                            {m.setup_s3_backup_text_post({
                                keyFile: `${data.configDir ?? '/config'}/master.key`,
                            })}
                        {:else}
                            {m.setup_s3_backup_key_unknown()}
                        {/if}
                    </span>
                </div>

                {#if rescanFailedNotice}
                    <div class="setup-callout setup-callout-warning" role="alert">
                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                        <span>{rescanFailedNotice}</span>
                    </div>
                {/if}

                {#if scanGaveUp && !allScansDone}
                    <div class="setup-callout setup-callout-warning" role="status">
                        <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                        <span>{m.setup_scan_still_running()}</span>
                    </div>
                {/if}

                <div class="setup-actions setup-actions-end">
                    {#if canFixTmdbHere}
                        <!-- With a key to fix, saving it is the main action and the
                             dashboard is the way out without one. -->
                        <button
                            type="button"
                            class="btn variant-ghost-surface"
                            onclick={goToDashboard}>
                            {m.setup_scan_skip_to_dashboard()}
                        </button>
                        <div class="setup-actions-spacer"></div>
                        <button
                            type="button"
                            class="btn variant-filled-primary"
                            onclick={() => void saveTmdbKeyAndRescan()}
                            disabled={finishTmdbSaving || !finishTmdbKey.trim()}>
                            {#if finishTmdbSaving}
                                <span class="loading-spinner loading-spinner-white"></span>
                            {:else}
                                <Icon src={ArrowPath} class="h-5 w-5" />
                            {/if}
                            <span>{m.setup_scan_tmdb_save_rescan()}</span>
                        </button>
                    {:else}
                        <button
                            type="button"
                            class="btn variant-filled-primary"
                            onclick={goToDashboard}>
                            <Icon src={Film} class="h-5 w-5" />
                            <span
                                >{allScansDone
                                    ? m.setup_scan_go_dashboard()
                                    : m.setup_scan_go_dashboard_bg()}</span>
                        </button>
                    {/if}
                </div>
            {/if}
        </div>
    </main>
</div>

<style>
    .setup-shell {
        position: relative;
        display: flex;
        flex-direction: column;
        /* height (not min-height): the app shell locks the viewport — html/body
           and the root wrapper are overflow:hidden, and /setup renders outside
           the app's .main-content scroll region. So the shell must be its OWN
           viewport-height scroll area; with min-height it just grew and got
           clipped by those ancestors. The stage uses margin-block:auto to stay
           vertically centred when a step fits and collapse to the top (scrollable)
           when it's taller than the viewport — e.g. step 3 with all its options. */
        height: 100dvh;
        align-items: center;
        justify-content: flex-start;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 1.5rem;
        background: radial-gradient(
            120% 120% at 50% -10%,
            rgb(var(--color-surface-800-rgb)) 0%,
            rgb(var(--color-surface-900-rgb)) 55%,
            rgb(0 0 0) 100%
        );
    }

    .setup-aurora {
        position: fixed;
        inset: -25%;
        z-index: 0;
        /* Decorative overlay — never capture pointer/wheel events, or scrolling
           only works while the cursor is over the card. Falls through to
           .setup-shell (the scroll container), same as .setup-grain. */
        pointer-events: none;
        background:
            radial-gradient(
                40% 36% at 18% 16%,
                rgb(var(--color-primary-500-rgb) / 0.3) 0%,
                transparent 70%
            ),
            radial-gradient(
                36% 38% at 84% 24%,
                rgb(var(--color-tertiary-500-rgb, var(--color-primary-400-rgb)) / 0.2) 0%,
                transparent 72%
            ),
            radial-gradient(
                46% 42% at 58% 94%,
                rgb(var(--color-primary-700-rgb) / 0.26) 0%,
                transparent 75%
            );
        filter: blur(30px) saturate(1.1);
        animation: setup-aurora-drift 24s ease-in-out infinite alternate;
    }

    @keyframes setup-aurora-drift {
        0% {
            transform: translate3d(-2%, -1%, 0) scale(1);
        }
        100% {
            transform: translate3d(3%, 2%, 0) scale(1.07);
        }
    }

    .setup-grain {
        position: fixed;
        inset: 0;
        z-index: 1;
        opacity: 0.05;
        pointer-events: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    }

    .setup-stage {
        position: relative;
        z-index: 2;
        width: 100%;
        max-width: 38rem;
        /* Centre vertically when it fits; collapse to the top (and let the shell
           scroll) when the step is taller than the viewport. */
        margin-block: auto;
    }

    .setup-header {
        margin-bottom: 1.25rem;
        text-align: center;
    }

    .setup-brand {
        display: flex;
        justify-content: center;
        margin-bottom: 0.85rem;
    }

    .setup-logo {
        height: 2.25rem;
        width: auto;
        object-fit: contain;
    }

    .setup-wordmark {
        font-size: 1.5rem;
        font-weight: 600;
        letter-spacing: -0.02em;
        background: linear-gradient(
            100deg,
            rgb(var(--color-primary-300-rgb)),
            rgb(var(--color-primary-500-rgb))
        );
        background-clip: text;
        -webkit-background-clip: text;
        color: transparent;
    }

    .setup-eyebrow {
        font-size: 0.72rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.18em;
        color: rgb(var(--color-primary-400-rgb));
    }

    .setup-stepper {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.4rem;
        margin-top: 0.7rem;
    }

    .setup-dot {
        height: 0.4rem;
        width: 1.5rem;
        border-radius: 999px;
        background: rgb(var(--color-surface-500-rgb) / 0.4);
        transition:
            background-color 0.3s ease,
            width 0.3s ease;
    }

    .setup-dot.is-done {
        background: rgb(var(--color-primary-600-rgb));
    }

    .setup-dot.is-active {
        width: 2.25rem;
        background: rgb(var(--color-primary-400-rgb));
    }

    .setup-step-label {
        margin-left: 0.6rem;
        font-size: 0.72rem;
        color: rgb(var(--color-surface-400-rgb));
    }

    .setup-card {
        position: relative;
        padding: 2rem;
        border-radius: 1.25rem;
        /* Near-solid panel so text sits on a calm dark surface (not the busy
           aurora) — fixes the low body-text contrast. */
        background: rgb(var(--color-surface-900-rgb) / 0.95);
        border: 1px solid rgb(var(--color-surface-500-rgb) / 0.45);
        backdrop-filter: blur(18px);
        box-shadow:
            0 1px 0 0 rgb(255 255 255 / 0.06) inset,
            0 24px 60px -20px rgb(0 0 0 / 0.75),
            0 0 0 1px rgb(var(--color-primary-500-rgb) / 0.08);
        animation: setup-card-rise 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    @keyframes setup-card-rise {
        from {
            opacity: 0;
            transform: translateY(12px) scale(0.99);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }

    .setup-title {
        font-size: 1.4rem;
        font-weight: 600;
        line-height: 1.2;
        color: rgb(var(--color-surface-50-rgb));
    }

    .setup-lede {
        margin-top: 0.5rem;
        font-size: 0.9rem;
        line-height: 1.5;
        color: rgb(var(--color-surface-300-rgb));
    }

    .setup-callout {
        display: flex;
        align-items: flex-start;
        gap: 0.6rem;
        margin-top: 1.25rem;
        border-radius: 0.75rem;
        padding: 0.8rem 0.95rem;
        font-size: 0.9rem;
        line-height: 1.45;
    }

    .setup-callout-success {
        border: 1px solid rgb(var(--color-success-500-rgb) / 0.4);
        background: rgb(var(--color-success-500-rgb) / 0.12);
        color: rgb(var(--color-success-400-rgb, var(--color-success-400-rgb)));
    }

    .setup-callout-warning {
        border: 1px solid rgb(var(--color-warning-500-rgb) / 0.4);
        background: rgb(var(--color-warning-500-rgb) / 0.12);
        color: rgb(var(--color-warning-400-rgb, var(--color-warning-400-rgb)));
    }

    .setup-callout-error {
        border: 1px solid rgb(var(--color-error-500-rgb) / 0.4);
        background: rgb(var(--color-error-500-rgb) / 0.12);
        color: rgb(var(--color-error-400-rgb, var(--color-error-400-rgb)));
    }

    .setup-backup-note {
        margin-top: 1.25rem;
        border: 1px solid rgb(var(--color-surface-500-rgb) / 0.4);
        background: rgb(var(--color-surface-700-rgb) / 0.4);
        color: rgb(var(--color-surface-200-rgb));
    }

    .setup-recheck {
        margin-left: 0.4rem;
        text-decoration: underline;
        font-weight: 600;
        color: inherit;
        cursor: pointer;
    }

    .setup-recheck:disabled {
        opacity: 0.6;
        cursor: default;
    }

    .setup-oidc {
        margin-top: 1.5rem;
    }

    .setup-oidc-reco {
        display: flex;
        justify-content: center;
        margin-bottom: 0.6rem;
    }

    /* In a form column a button stretches to the full width and reads as a
       divider with a label; keep it button-sized under its field. */
    .setup-oidc-test-btn {
        margin-top: 0;
        align-self: flex-start;
    }

    .setup-oidc-actions {
        display: flex;
        align-items: center;
        gap: 1rem;
        margin-top: 1rem;
    }

    .setup-deps {
        margin-top: 1.25rem;
    }

    .setup-deps-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.75rem;
    }

    .setup-scan {
        margin-top: 1.5rem;
    }

    .setup-scan-name {
        margin: 0 0 0.5rem;
        font-size: 0.85rem;
        font-weight: 600;
        color: rgb(var(--color-surface-100-rgb));
    }

    .setup-scan-bar {
        position: relative;
        height: 0.55rem;
        width: 100%;
        overflow: hidden;
        border-radius: 999px;
        background: rgb(var(--color-surface-600-rgb) / 0.5);
    }

    .setup-scan-fill {
        display: block;
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(
            90deg,
            rgb(var(--color-primary-500-rgb)),
            rgb(var(--color-primary-400-rgb))
        );
        transition: width 0.4s ease;
    }

    .setup-scan-fill.is-failed {
        background: rgb(var(--color-warning-500-rgb));
    }

    /* Indeterminate: no total yet — sweep a short bar to signal "working". */
    .setup-scan-bar.is-indeterminate .setup-scan-fill {
        width: 35%;
        animation: setup-scan-sweep 1.2s ease-in-out infinite;
    }

    @keyframes setup-scan-sweep {
        0% {
            transform: translateX(-120%);
        }
        100% {
            transform: translateX(320%);
        }
    }

    .setup-scan-meta {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.75rem;
        margin-top: 0.6rem;
        font-size: 0.82rem;
        color: rgb(var(--color-surface-200-rgb));
    }

    .setup-scan-pct {
        font-variant-numeric: tabular-nums;
        color: rgb(var(--color-primary-300-rgb));
    }

    .setup-scan-item {
        margin-top: 0.35rem;
        overflow: hidden;
        font-size: 0.74rem;
        color: rgb(var(--color-surface-400-rgb));
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    @media (prefers-reduced-motion: reduce) {
        .setup-scan-bar.is-indeterminate .setup-scan-fill {
            animation: none;
        }
    }

    .setup-oidc-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        width: 100%;
        margin-bottom: 0.6rem;
    }

    .setup-divider {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin: 1.1rem 0 0.25rem;
        color: rgb(var(--color-surface-400-rgb));
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
    }

    .setup-divider::before,
    .setup-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: rgb(var(--color-surface-500-rgb) / 0.4);
    }

    .setup-choices {
        display: grid;
        grid-template-columns: 1fr;
        gap: 0.85rem;
        margin-top: 1.5rem;
    }

    @media (min-width: 640px) {
        .setup-choices {
            grid-template-columns: 1fr 1fr;
        }

        /* When OIDC is unconfigured the grid holds three cards: forward-auth and
           OIDC share row 1, and built-in spans the full width of row 2. */
        .setup-choice-wide {
            grid-column: 1 / -1;
        }
    }

    .setup-env-note {
        margin-top: 0.6rem;
        font-size: 0.85rem;
    }

    .setup-env-url {
        margin-top: 0.3rem;
        word-break: break-all;
    }

    .setup-choice {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 1.1rem;
        text-align: left;
        border-radius: 1rem;
        /* Clearly visible card: lighter than the focal panel + a solid border,
           so each option reads as a selectable card rather than plain text. */
        border: 2px solid rgb(var(--color-surface-400-rgb) / 0.4);
        background: rgb(var(--color-surface-700-rgb) / 0.55);
        cursor: pointer;
        transition:
            border-color 0.2s ease,
            background-color 0.2s ease,
            transform 0.15s ease,
            box-shadow 0.2s ease;
    }

    .setup-choice:hover {
        border-color: rgb(var(--color-primary-400-rgb) / 0.7);
        background: rgb(var(--color-surface-700-rgb) / 0.75);
        transform: translateY(-2px);
    }

    .setup-choice:focus-visible {
        outline: 2px solid rgb(var(--color-primary-400-rgb));
        outline-offset: 2px;
    }

    /* Unmistakable selected state: bright primary border + glow ring + tint. */
    .setup-choice.is-selected {
        border-color: rgb(var(--color-primary-400-rgb));
        background: rgb(var(--color-primary-500-rgb) / 0.18);
        box-shadow:
            0 0 0 3px rgb(var(--color-primary-500-rgb) / 0.35),
            0 10px 30px -12px rgb(var(--color-primary-500-rgb) / 0.5);
    }

    .setup-choice-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
    }

    .setup-choice-title {
        font-size: 1rem;
        font-weight: 600;
        color: rgb(var(--color-surface-50-rgb));
    }

    .setup-choice-copy {
        font-size: 0.82rem;
        line-height: 1.45;
        color: rgb(var(--color-surface-200-rgb));
    }

    .setup-identity {
        margin-top: 1.25rem;
        border-radius: 0.85rem;
        border: 1px solid rgb(var(--color-surface-500-rgb) / 0.3);
        background: rgb(var(--color-surface-900-rgb) / 0.55);
        padding: 1rem 1.1rem;
    }

    .setup-identity-label {
        font-size: 0.72rem;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgb(var(--color-surface-400-rgb));
    }

    .setup-identity-name {
        margin-top: 0.2rem;
        font-size: 1.25rem;
        font-weight: 600;
        color: rgb(var(--color-surface-50-rgb));
    }

    .setup-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        margin-top: 0.4rem;
    }

    .setup-finish-backup {
        margin-top: 1.5rem;
    }

    .setup-finish-tmdb {
        margin-top: 1.5rem;
    }

    .setup-finish-tmdb a {
        color: rgb(var(--color-primary-300-rgb));
        text-decoration: underline;
    }

    .setup-suggest {
        margin-top: 1.5rem;
    }

    .setup-suggest-title {
        font-size: 0.95rem;
        font-weight: 600;
        color: rgb(var(--color-surface-100-rgb));
    }

    .setup-suggest-manual {
        margin-top: 2rem;
    }

    .setup-abs {
        margin-top: 1.5rem;
        margin-bottom: 1.5rem;
    }

    .setup-suggest-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-top: 0.75rem;
    }

    .setup-suggest-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0.75rem;
        border-radius: 0.75rem;
        border: 1px solid rgb(var(--color-surface-500-rgb) / 0.3);
        background: rgb(var(--color-surface-700-rgb) / 0.25);
    }

    .setup-suggest-path {
        display: flex;
        /* On a phone the path takes its own line and the type picker wraps below
           it, instead of the path breaking after every slash. */
        flex: 1 1 10rem;
        min-width: 0;
        flex-direction: column;
        cursor: pointer;
    }

    .setup-suggest-path code {
        overflow-wrap: anywhere;
    }

    .setup-suggest-type {
        flex: 0 0 9.5rem;
        width: 9.5rem;
        margin-left: auto;
    }

    .setup-chip {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        border: 1px solid rgb(var(--color-primary-500-rgb) / 0.35);
        background: rgb(var(--color-primary-500-rgb) / 0.12);
        padding: 0.15rem 0.65rem;
        font-size: 0.78rem;
        color: rgb(var(--color-primary-200-rgb, var(--color-primary-300-rgb)));
    }

    /* Chips double as buttons (jump-nav on step 3, click-to-fill on step 4). */
    button.setup-chip {
        cursor: pointer;
    }

    button.setup-chip:hover {
        background: rgb(var(--color-primary-500-rgb) / 0.25);
        border-color: rgb(var(--color-primary-500-rgb) / 0.7);
    }

    /* Jump-nav targets breathe instead of landing glued to the viewport edge. */
    .setup-pref-group[id],
    .setup-pref-details[id] {
        scroll-margin-top: 1.25rem;
    }

    .setup-chip-muted {
        border-color: rgb(var(--color-surface-500-rgb) / 0.4);
        background: rgb(var(--color-surface-700-rgb) / 0.5);
        color: rgb(var(--color-surface-400-rgb));
    }

    .setup-code {
        font-family: var(--theme-font-family-mono, monospace);
        font-size: 0.8em;
        padding: 0.05rem 0.3rem;
        border-radius: 0.3rem;
        background: rgb(var(--color-surface-900-rgb) / 0.6);
    }

    .setup-form {
        display: flex;
        flex-direction: column;
        gap: 1.1rem;
        margin-top: 1.5rem;
    }

    .setup-field {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }

    .setup-input-wrap {
        position: relative;
        display: flex;
    }

    .setup-input-wrap .input {
        flex: 1 1 auto;
        padding-right: 2.5rem;
    }

    .setup-input-toggle {
        position: absolute;
        top: 50%;
        right: 0.5rem;
        transform: translateY(-50%);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.25rem;
        border-radius: 0.4rem;
        background: transparent;
        color: rgb(var(--color-surface-400-rgb));
        cursor: pointer;
    }

    .setup-input-toggle:hover {
        color: rgb(var(--color-surface-100-rgb));
    }

    .setup-prefs {
        display: flex;
        flex-direction: column;
        gap: 1.1rem;
        margin-top: 1.5rem;
    }

    .setup-pref-group {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
    }

    .setup-pref-group-label {
        font-size: 0.72rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgb(var(--color-surface-400-rgb));
    }

    /* Conditional/advanced preference groups (hardware, Jellyfin, SSO) —
       collapsed by default so step 3 doesn't read as one giant wall of
       options; the always-relevant groups stay as plain .setup-pref-group. */
    .setup-pref-details {
        border-radius: 0.75rem;
        border: 1px solid rgb(var(--color-surface-500-rgb) / 0.3);
        background: rgb(var(--color-surface-700-rgb) / 0.25);
    }

    .setup-pref-summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.7rem 0.9rem;
        list-style: none;
        cursor: pointer;
        user-select: none;
        font-size: 0.72rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgb(var(--color-surface-400-rgb));
    }

    .setup-pref-summary::-webkit-details-marker {
        display: none;
    }

    .setup-pref-summary::after {
        content: '';
        flex-shrink: 0;
        width: 0.4rem;
        height: 0.4rem;
        border-right: 2px solid currentColor;
        border-bottom: 2px solid currentColor;
        transform: rotate(45deg);
        transition: transform 0.2s ease;
    }

    .setup-pref-details[open] .setup-pref-summary::after {
        transform: rotate(-135deg);
    }

    .setup-pref-details > .setup-pref-group--nested {
        padding: 0 0.9rem 0.9rem;
    }

    .setup-pref-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        border-radius: 0.75rem;
        border: 1px solid rgb(var(--color-surface-500-rgb) / 0.3);
        background: rgb(var(--color-surface-700-rgb) / 0.4);
        padding: 0.7rem 0.9rem;
    }

    .setup-pref-note {
        justify-content: flex-start;
        gap: 0.6rem;
        font-size: 0.85rem;
        color: rgb(var(--color-surface-300-rgb));
    }

    .setup-pref-text {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        min-width: 0;
    }

    .setup-pref-name {
        font-size: 0.88rem;
        font-weight: 500;
        color: rgb(var(--color-surface-100-rgb));
    }

    .setup-pref-desc {
        font-size: 0.76rem;
        line-height: 1.4;
        color: rgb(var(--color-surface-400-rgb));
    }

    .setup-label {
        font-size: 0.78rem;
        font-weight: 500;
        color: rgb(var(--color-surface-300-rgb));
    }

    .setup-label .setup-chip {
        margin-left: 0.5rem;
        vertical-align: middle;
    }

    .setup-hint {
        font-size: 0.74rem;
        line-height: 1.35;
    }

    .setup-hint-error {
        color: rgb(var(--color-error-400-rgb));
    }

    .setup-hint-muted {
        color: rgb(var(--color-surface-400-rgb));
    }

    .setup-meter {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 0.3rem;
        margin-top: 0.2rem;
    }

    .setup-meter-seg {
        height: 0.3rem;
        border-radius: 999px;
        background: rgb(var(--color-surface-600-rgb) / 0.6);
        transition:
            background-color 0.25s ease,
            opacity 0.25s ease;
    }

    .setup-meter-seg.filled {
        opacity: 1;
    }

    .setup-meter-seg.meter-red {
        background: rgb(var(--color-error-500-rgb));
    }

    .setup-meter-seg.meter-amber {
        background: rgb(var(--color-warning-500-rgb));
    }

    .setup-meter-seg.meter-lime {
        background: rgb(132 204 22);
    }

    .setup-meter-seg.meter-green {
        background: rgb(var(--color-success-500-rgb));
    }

    .setup-meter-row {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.4rem;
        margin-top: 0.1rem;
    }

    .setup-meter-label {
        font-size: 0.74rem;
        font-weight: 500;
        color: rgb(var(--color-surface-200-rgb));
    }

    /* Only the strength word ("weak", "very weak", …) wants title casing —
       the plain sentence-case hint text (e.g. "Use at least 10 characters.")
       shares this class and must not be re-cased by it. */
    .setup-meter-label--strength {
        text-transform: capitalize;
    }

    .setup-steps-list {
        display: flex;
        flex-direction: column;
        gap: 0.85rem;
        margin-top: 1.5rem;
    }

    .setup-steps-list li {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        font-size: 0.9rem;
        line-height: 1.45;
        color: rgb(var(--color-surface-200-rgb));
    }

    /* The badge is 1.75rem tall and a text line ~1.3rem: push the text down by
       half the difference so its first line sits centred on the badge. */
    .setup-steps-list li > .setup-steps-num + * {
        padding-top: 0.2rem;
    }

    .setup-steps-num {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        height: 1.75rem;
        width: 1.75rem;
        border-radius: 0.6rem;
        background: rgb(var(--color-primary-500-rgb) / 0.15);
        color: rgb(var(--color-primary-300-rgb));
    }

    .setup-finish-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 3rem;
        width: 3rem;
        margin-bottom: 0.85rem;
        border-radius: 999px;
        background: rgb(var(--color-success-500-rgb) / 0.12);
        border: 1px solid rgb(var(--color-success-500-rgb) / 0.35);
    }

    /* The badge ring follows the icon: amber for a warning, primary while scanning. */
    .setup-finish-badge--warn {
        background: rgb(var(--color-warning-500-rgb) / 0.12);
        border-color: rgb(var(--color-warning-500-rgb) / 0.35);
    }

    .setup-finish-badge--busy {
        background: rgb(var(--color-primary-500-rgb) / 0.12);
        border-color: rgb(var(--color-primary-500-rgb) / 0.35);
    }

    .setup-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.6rem;
        margin-top: 1.75rem;
    }

    .setup-actions-end {
        justify-content: flex-end;
    }

    .setup-actions-spacer {
        flex: 1 1 auto;
    }

    @media (prefers-reduced-motion: reduce) {
        .setup-aurora,
        .setup-card {
            animation: none;
        }

        .setup-choice:hover {
            transform: none;
        }
    }
</style>
