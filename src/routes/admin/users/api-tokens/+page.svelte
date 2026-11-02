<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteDate } from 'svelte/reactivity';
    import { onMount } from 'svelte';
    import { page } from '$app/stores';
    import type { PatInfo, ServiceTokenInfo } from '$lib/schemas/api-admin-responses';
    import * as adminApi from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import {
        Icon,
        User,
        ServerStack,
        ArrowPath,
        Plus,
        ExclamationTriangle,
        Link,
    } from 'svelte-hero-icons';
    import { AdminPageHeader } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import TokenTable from '$lib/components/admin/TokenTable.svelte';
    import ActionModal from '$lib/components/admin/ActionModal.svelte';
    import TokenSuccessModal from '$lib/components/admin/TokenSuccessModal.svelte';
    import ConnectedAppTokens from '$lib/components/jellyfin-connect/ConnectedAppTokens.svelte';
    import * as m from '$lib/paraglide/messages.js';

    let users = $state<Array<{ id: string; displayName?: string | null }>>([]);
    async function loadUsers(): Promise<void> {
        const { data } = await adminApi.getLocalUsers();
        if (data) users = data.items;
    }

    // Feature flag
    let deviceAuthEnabled = $derived($page.data?.deviceAuth !== false);

    // Personal Access Tokens state
    let patListState = $state({
        tokens: [] as PatInfo[],
        loading: false,
    });

    // Service Tokens state
    let serviceTokenListState = $state({
        tokens: [] as ServiceTokenInfo[],
        loading: false,
    });

    // PAT scopes that gate /j/* compat clients. Mutually exclusive with
    // each other and with all other scopes — enforced server-side by
    // patCreateBodySchema.superRefine and mirrored in the UI below.
    const JELLYFIN_COMPAT_SCOPES = ['jellyfin_compat', 'jellyfin_compat_read'] as const;

    type PatScope = 'read' | 'write' | 'admin' | 'jellyfin_compat' | 'jellyfin_compat_read';

    // Create PAT modal state
    let createPatFormState = $state({
        show: false,
        userId: '',
        name: '',
        description: '',
        scopes: ['read'] as PatScope[],
        expiresDays: 365 as number | null,
        creating: false,
    });

    // Service-token allowed HTTP methods. OPTIONS intentionally excluded
    // (mirrors serviceTokenMethodSchema in src/lib/schemas/admin.ts).
    const SERVICE_TOKEN_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

    type ServiceTokenMethod = (typeof SERVICE_TOKEN_METHODS)[number];

    // The only paths an integrations:read token reaches (mirrors
    // INTEGRATIONS_GRANT_PATHS in $lib/server/auth/integration-token.ts).
    const INTEGRATION_ENDPOINT_PATHS = [
        '/api/v1/integrations/watch-history',
        '/api/v1/integrations/upcoming',
        '/api/v1/integrations/homepage',
    ] as const;
    type ServiceTokenScope = 'read' | 'write' | 'admin' | 'integrations:read' | 'diagnostics:read';

    // General PAT scopes (additive). Compat scopes are surfaced separately
    // because they are mutually exclusive with these and with each other.
    const GENERAL_PAT_SCOPES = ['read', 'write', 'admin'] as const;

    // Create Service Token modal state
    let createServiceTokenFormState = $state({
        show: false,
        name: '',
        description: '',
        actAsUserId: '',
        allowedIps: '',
        allowedPathPrefixes: '',
        allowedMethods: [] as ServiceTokenMethod[],
        integrationPaths: [] as string[],
        forceNonAdmin: false,
        // Least privilege by default; admin is an explicit choice (admin/users
        // review 2026-10-07, item 8a).
        scope: 'read' as ServiceTokenScope,
        expiresDays: 90 as number | null,
        neverExpires: false,
        creating: false,
    });

    let svcIsIntegrations = $derived(createServiceTokenFormState.scope === 'integrations:read');
    // diagnostics:read (debug report): the server refuses actAsUserId,
    // forceNonAdmin, non-GET/HEAD methods, and requires an expiry of at most 90 days.
    let svcIsDiagnostics = $derived(createServiceTokenFormState.scope === 'diagnostics:read');
    let svcIsGrantOnly = $derived(svcIsIntegrations || svcIsDiagnostics);

    $effect(() => {
        if (!svcIsDiagnostics) return;
        if (createServiceTokenFormState.neverExpires)
            createServiceTokenFormState.neverExpires = false;
        if (
            createServiceTokenFormState.expiresDays == null ||
            createServiceTokenFormState.expiresDays > 90
        ) {
            createServiceTokenFormState.expiresDays = 90;
        }
    });

    // Token display modal
    let tokenDisplayState = $state({
        show: false,
        token: '',
    });

    const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null;

    onMount(() => {
        if (deviceAuthEnabled) {
            void loadUsers();
            loadPats();
            loadServiceTokens();
        }
    });

    // Refresh, create and revoke can each start a reload; only the newest
    // may write the list, or a just-revoked token reappears.
    let patLoadGeneration = 0;
    let serviceLoadGeneration = 0;

    async function loadPats() {
        const generation = ++patLoadGeneration;
        patListState.loading = true;
        try {
            const { data, error } = await adminApi.getAdminPats();
            if (generation !== patLoadGeneration) return;
            if (!error && data) {
                patListState.tokens = data.items || [];
            } else {
                // A 403/500 must not read as "no tokens yet".
                toasts.error(error || m.route_admin_api_tokens_load_pat_error());
            }
        } catch (error) {
            console.error('Failed to load PATs:', error);
            toasts.error(getErrorMessage(error, m.route_admin_api_tokens_load_pat_error()));
        } finally {
            if (generation === patLoadGeneration) patListState.loading = false;
        }
    }

    async function loadServiceTokens() {
        const generation = ++serviceLoadGeneration;
        serviceTokenListState.loading = true;
        try {
            const { data, error } = await adminApi.getServiceTokens();
            if (generation !== serviceLoadGeneration) return;
            if (!error && data) {
                serviceTokenListState.tokens = data.items || [];
            } else {
                toasts.error(error || m.route_admin_api_tokens_load_service_error());
            }
        } catch (error) {
            console.error('Failed to load service tokens:', error);
            toasts.error(getErrorMessage(error, m.route_admin_api_tokens_load_service_error()));
        } finally {
            if (generation === serviceLoadGeneration) serviceTokenListState.loading = false;
        }
    }

    async function createPat() {
        if (!createPatFormState.userId.trim()) {
            toasts.error(m.route_admin_api_tokens_username_required());
            return;
        }
        if (!createPatFormState.name.trim()) {
            toasts.error(m.route_admin_api_tokens_name_required());
            return;
        }
        if (createPatFormState.scopes.length === 0) {
            toasts.error(m.route_admin_api_tokens_scope_required());
            return;
        }

        createPatFormState.creating = true;
        try {
            const { data, error } = await adminApi.createAdminPat({
                userId: createPatFormState.userId,
                name: createPatFormState.name.trim(),
                description: createPatFormState.description.trim() || undefined,
                scopes: createPatFormState.scopes,
                expiresInDays: createPatFormState.expiresDays,
            });

            if (!error && data?.token) {
                const username =
                    users.find((u) => u.id === createPatFormState.userId)?.displayName ?? '';
                tokenDisplayState.token = data.token;
                createPatFormState.show = false;
                tokenDisplayState.show = true;
                resetPatForm();
                await loadPats();
                toasts.success(m.route_admin_api_tokens_pat_created({ username }));
            } else {
                // A 2xx without a token means the secret is lost: say so and
                // show the (now orphaned) row instead of an empty success box.
                toasts.error(error || m.route_admin_api_tokens_create_error());
                if (!error) await loadPats();
            }
        } catch (error) {
            console.error('Failed to create token:', error);
            toasts.error(getErrorMessage(error, m.route_admin_api_tokens_create_error()));
        } finally {
            createPatFormState.creating = false;
        }
    }

    async function createServiceToken() {
        if (!createServiceTokenFormState.name.trim()) {
            toasts.error(m.route_admin_api_tokens_name_required());
            return;
        }

        createServiceTokenFormState.creating = true;
        try {
            // The integrations grant takes only its own endpoint paths and is
            // GET/HEAD by nature; the server rejects anything else with it.
            const allowedPathPrefixes = svcIsIntegrations
                ? [...createServiceTokenFormState.integrationPaths]
                : svcIsDiagnostics
                  ? []
                  : createServiceTokenFormState.allowedPathPrefixes
                        .split(',')
                        .map((p) => p.trim())
                        .filter((p) => p.length > 0);
            const allowedIps = createServiceTokenFormState.allowedIps
                .split(',')
                .map((p) => p.trim())
                .filter((p) => p.length > 0);

            const { data, error } = await adminApi.createServiceToken({
                name: createServiceTokenFormState.name.trim(),
                description: createServiceTokenFormState.description.trim() || undefined,
                // The integrations grant acts as nobody and cannot be sandboxed;
                // the server rejects either field with it.
                actAsUserId: svcIsGrantOnly
                    ? undefined
                    : createServiceTokenFormState.actAsUserId.trim() || undefined,
                scopes: [createServiceTokenFormState.scope],
                allowedIps: allowedIps.length > 0 ? allowedIps : undefined,
                allowedPathPrefixes:
                    allowedPathPrefixes.length > 0 ? allowedPathPrefixes : undefined,
                allowedMethods:
                    !svcIsGrantOnly && createServiceTokenFormState.allowedMethods.length > 0
                        ? createServiceTokenFormState.allowedMethods
                        : undefined,
                forceNonAdmin: svcIsGrantOnly
                    ? undefined
                    : createServiceTokenFormState.forceNonAdmin || undefined,
                expiresInDays:
                    createServiceTokenFormState.neverExpires && !svcIsDiagnostics
                        ? null
                        : createServiceTokenFormState.expiresDays,
            });

            if (!error && data?.token) {
                tokenDisplayState.token = data.token;
                createServiceTokenFormState.show = false;
                tokenDisplayState.show = true;
                resetSvcForm();
                await loadServiceTokens();
                toasts.success(m.route_admin_api_tokens_service_created());
            } else {
                toasts.error(error || m.route_admin_api_tokens_create_error());
                if (!error) await loadServiceTokens();
            }
        } catch (error) {
            console.error('Failed to create token:', error);
            toasts.error(getErrorMessage(error, m.route_admin_api_tokens_create_error()));
        } finally {
            createServiceTokenFormState.creating = false;
        }
    }

    async function revokePat(id: number, name: string, username?: string) {
        if (
            !confirm(
                m.route_admin_api_tokens_revoke_confirm({
                    name,
                    username: username ?? '',
                }),
            )
        ) {
            return;
        }

        try {
            const { error } = await adminApi.deleteAdminPat(String(id));

            if (!error) {
                toasts.success(m.route_admin_api_tokens_revoked());
                await loadPats();
            } else {
                toasts.error(error || m.route_admin_api_tokens_revoke_error());
                // Usually "already revoked elsewhere": drop the ghost row.
                await loadPats();
            }
        } catch (error) {
            console.error('Failed to revoke token:', error);
            toasts.error(getErrorMessage(error, m.route_admin_api_tokens_revoke_error()));
        }
    }

    async function revokeServiceToken(id: number, name: string) {
        if (!confirm(m.route_admin_api_tokens_revoke_service_confirm({ name }))) {
            return;
        }

        try {
            const { error } = await adminApi.deleteServiceToken(String(id));

            if (!error) {
                toasts.success(m.route_admin_api_tokens_service_revoked());
                await loadServiceTokens();
            } else {
                toasts.error(error || m.route_admin_api_tokens_revoke_error());
                await loadServiceTokens();
            }
        } catch (error) {
            console.error('Failed to revoke token:', error);
            toasts.error(getErrorMessage(error, m.route_admin_api_tokens_revoke_error()));
        }
    }

    function resetPatForm() {
        createPatFormState.userId = '';
        createPatFormState.name = '';
        createPatFormState.description = '';
        createPatFormState.scopes = ['read'];
        createPatFormState.expiresDays = 365;
    }

    function resetSvcForm() {
        createServiceTokenFormState.name = '';
        createServiceTokenFormState.description = '';
        createServiceTokenFormState.actAsUserId = '';
        createServiceTokenFormState.allowedIps = '';
        createServiceTokenFormState.allowedPathPrefixes = '';
        createServiceTokenFormState.allowedMethods = [];
        createServiceTokenFormState.integrationPaths = [];
        createServiceTokenFormState.forceNonAdmin = false;
        createServiceTokenFormState.scope = 'read';
        createServiceTokenFormState.expiresDays = 90;
        createServiceTokenFormState.neverExpires = false;
    }

    function formatDate(dateStr: string | null): string {
        if (!dateStr) return m.route_admin_api_tokens_never();
        const date = new SvelteDate(dateStr);
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    }

    function formatRelativeDate(dateStr: string | null): string {
        if (!dateStr) return m.route_admin_api_tokens_never();
        const date = new SvelteDate(dateStr);
        const now = new SvelteDate();
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return m.route_admin_api_tokens_today();
        if (diffDays === 1) return m.route_admin_api_tokens_yesterday();
        if (diffDays < 7) return m.route_admin_api_tokens_days_ago({ count: diffDays });
        if (diffDays < 30)
            return m.route_admin_api_tokens_weeks_ago({
                count: Math.floor(diffDays / 7),
            });
        return date.toLocaleDateString();
    }

    /**
     * Toggle a PAT scope. Enforces the same exclusivity rules as
     * `patCreateBodySchema.superRefine`:
     *
     *   - `jellyfin_compat` and `jellyfin_compat_read` are exclusive — selecting
     *     one replaces all other scopes (and the other compat scope).
     *   - Selecting any general scope (`read`/`write`/`admin`) when a compat
     *     scope is active replaces the compat scope.
     *   - General scopes are otherwise additive.
     */
    function toggleScope(scope: PatScope) {
        const isCompat = (JELLYFIN_COMPAT_SCOPES as readonly string[]).includes(scope);
        const hasCompat = createPatFormState.scopes.some((s) =>
            (JELLYFIN_COMPAT_SCOPES as readonly string[]).includes(s),
        );

        if (isCompat) {
            // Selecting a compat scope: replace everything with just it
            // (or unselect if already the only scope).
            if (createPatFormState.scopes.length === 1 && createPatFormState.scopes[0] === scope) {
                createPatFormState.scopes = ['read'];
            } else {
                createPatFormState.scopes = [scope];
            }
            return;
        }

        // Selecting a general scope while a compat scope is active:
        // drop the compat scope and start fresh with this one.
        if (hasCompat) {
            createPatFormState.scopes = [scope];
            return;
        }

        if (createPatFormState.scopes.includes(scope)) {
            createPatFormState.scopes = createPatFormState.scopes.filter((s) => s !== scope);
        } else {
            createPatFormState.scopes = [...createPatFormState.scopes, scope];
        }
    }

    /** True when the active PAT scope set includes a compat scope. */
    let patCompatActive = $derived(
        createPatFormState.scopes.some((s) =>
            (JELLYFIN_COMPAT_SCOPES as readonly string[]).includes(s),
        ),
    );

    function toggleIntegrationPath(path: string) {
        const list = createServiceTokenFormState.integrationPaths;
        createServiceTokenFormState.integrationPaths = list.includes(path)
            ? list.filter((p) => p !== path)
            : [...list, path];
    }

    function toggleServiceMethod(method: ServiceTokenMethod) {
        const list = createServiceTokenFormState.allowedMethods;
        if (list.includes(method)) {
            createServiceTokenFormState.allowedMethods = list.filter((m) => m !== method);
        } else {
            createServiceTokenFormState.allowedMethods = [...list, method];
        }
    }
</script>

<svelte:head>
    <title>{m.admin_nav_page_users_api_tokens()} - Admin</title>
</svelte:head>

<div class="space-y-8">
    <AdminPageHeader
        icon={adminPageIcons['/admin/users/api-tokens']}
        title={m.route_admin_api_tokens_title()}
        description={m.route_admin_api_tokens_description()} />

    {#if !deviceAuthEnabled}
        <!-- Device auth not enabled warning -->
        <div class="bg-yellow-900/30 border border-yellow-600 rounded-lg p-6">
            <div class="flex items-start gap-4">
                <Icon src={ExclamationTriangle} class="w-8 h-8 text-yellow-500 shrink-0" />
                <div>
                    <h3 class="text-lg font-semibold text-yellow-400">
                        {m.route_admin_api_tokens_not_enabled_title()}
                    </h3>
                    <p class="text-surface-300 mt-1">
                        {m.route_admin_api_tokens_not_enabled_body()}
                    </p>
                    <pre
                        class="mt-3 bg-surface-900 rounded p-3 text-sm text-surface-300 overflow-x-auto">FEATURE_DEVICE_AUTH=true
JWT_SECRET=your-64-character-secret  # Generate with: openssl rand -hex 32</pre>
                </div>
            </div>
        </div>
    {:else}
        <!-- Personal Access Tokens Section -->
        <section>
            <div class="between mb-4">
                <div class="flex items-center gap-3">
                    <Icon src={User} class="w-6 h-6 text-blue-400" />
                    <h2 class="text-xl font-semibold">
                        {m.route_admin_api_tokens_pat_heading()}
                    </h2>
                </div>
                <div class="flex gap-2">
                    <button class="btn btn-sm btn-gray flex items-center gap-2" onclick={loadPats}>
                        <Icon src={ArrowPath} class="w-4 h-4" />
                        {m.btn_refresh()}
                    </button>
                    <button
                        class="btn btn-sm btn-blue flex items-center gap-2"
                        onclick={() => (createPatFormState.show = true)}>
                        <Icon src={Plus} class="w-4 h-4" />
                        {m.route_admin_api_tokens_create_pat()}
                    </button>
                </div>
            </div>

            <p class="text-muted mb-4">
                {m.route_admin_api_tokens_pat_description()}
            </p>

            <TokenTable
                tokens={patListState.tokens}
                type="pat"
                loading={patListState.loading}
                onRevoke={revokePat}
                {formatRelativeDate} />
        </section>

        <!-- Service Tokens Section -->
        <section>
            <div class="between mb-4">
                <div class="flex items-center gap-3">
                    <Icon src={ServerStack} class="w-6 h-6 text-purple-400" />
                    <h2 class="text-xl font-semibold">
                        {m.route_admin_api_tokens_service_heading()}
                    </h2>
                </div>
                <div class="flex gap-2">
                    <button
                        class="btn btn-sm btn-gray flex items-center gap-2"
                        onclick={loadServiceTokens}>
                        <Icon src={ArrowPath} class="w-4 h-4" />
                        {m.btn_refresh()}
                    </button>
                    <button
                        class="btn btn-sm btn-purple flex items-center gap-2"
                        onclick={() => (createServiceTokenFormState.show = true)}>
                        <Icon src={Plus} class="w-4 h-4" />
                        {m.route_admin_api_tokens_create_service()}
                    </button>
                </div>
            </div>

            <p class="text-muted mb-4">
                {m.route_admin_api_tokens_service_description()}
            </p>

            <TokenTable
                tokens={serviceTokenListState.tokens}
                type="service"
                loading={serviceTokenListState.loading}
                onRevoke={revokeServiceToken}
                {formatRelativeDate} />
        </section>

        <!-- Jellyfin Compat Tokens Section -->
        <section>
            <div class="between mb-4">
                <div class="flex items-center gap-3">
                    <Icon src={Link} class="w-6 h-6 text-green-400" />
                    <h2 class="text-xl font-semibold">
                        {m.route_admin_api_tokens_jellyfin_heading()}
                    </h2>
                </div>
            </div>

            <p class="text-muted mb-4">
                {m.route_admin_api_tokens_jellyfin_description()}
            </p>

            <ConnectedAppTokens mode="admin" />
        </section>
    {/if}
</div>

<!-- Create PAT Modal -->
{#if createPatFormState.show}
    <ActionModal
        title={m.route_admin_api_tokens_create_pat_modal_title()}
        confirmText={m.route_admin_api_tokens_create_pat_confirm()}
        confirmColor="blue"
        disabled={createPatFormState.creating ||
            !createPatFormState.userId.trim() ||
            !createPatFormState.name.trim()}
        onclose={() => (createPatFormState.show = false)}
        onconfirm={createPat}>
        <div class="space-y-4">
            <div>
                <label for="pat-username" class="block text-sm font-medium text-surface-300 mb-1"
                    >{m.route_admin_api_tokens_username()}</label>
                <select
                    id="pat-username"
                    class="w-full bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white"
                    bind:value={createPatFormState.userId}>
                    <option value="">—</option>
                    {#each users as user (user.id)}
                        <option value={user.id}>{user.displayName ?? user.id}</option>
                    {/each}
                </select>
                <p class="text-caption mt-1">
                    {m.route_admin_api_tokens_username_hint()}
                </p>
            </div>

            <div>
                <label for="pat-name" class="block text-sm font-medium text-surface-300 mb-1"
                    >{m.route_admin_api_tokens_name()}</label>
                <input
                    id="pat-name"
                    type="text"
                    class="w-full bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white"
                    placeholder={m.route_admin_api_tokens_name_placeholder()}
                    bind:value={createPatFormState.name} />
            </div>

            <div>
                <label for="pat-description" class="block text-sm font-medium text-surface-300 mb-1"
                    >{m.route_admin_api_tokens_description_label()}</label>
                <input
                    id="pat-description"
                    type="text"
                    class="w-full bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white"
                    placeholder={m.route_admin_api_tokens_description_placeholder()}
                    bind:value={createPatFormState.description} />
            </div>

            <div>
                <span class="block text-sm font-medium text-surface-300 mb-2"
                    >{m.route_admin_api_tokens_scopes()}</span>
                <div class="space-y-2">
                    <!-- General API scopes -->
                    <div class="flex gap-3 flex-wrap">
                        {#each GENERAL_PAT_SCOPES as scope (scope)}
                            <label
                                class="flex items-center gap-2 cursor-pointer"
                                class:opacity-40={patCompatActive}
                                title={patCompatActive
                                    ? m.route_admin_api_tokens_scope_disabled_compat()
                                    : ''}>
                                <input
                                    type="checkbox"
                                    checked={createPatFormState.scopes.includes(scope)}
                                    disabled={patCompatActive}
                                    onchange={() => toggleScope(scope)}
                                    class="rounded bg-surface-700 border-surface-600 text-blue-500 focus:ring-blue-500" />
                                <span class="text-sm text-surface-300 capitalize">{scope}</span>
                            </label>
                        {/each}
                    </div>

                    <!-- Jellyfin-compat scopes (mutually exclusive with general) -->
                    <div class="border-t border-surface-700 pt-2 mt-2 space-y-2">
                        <p class="text-xs text-surface-500">
                            {m.route_admin_api_tokens_compat_explanation()}
                        </p>
                        <label class="flex items-start gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={createPatFormState.scopes.includes('jellyfin_compat')}
                                onchange={() => toggleScope('jellyfin_compat')}
                                class="mt-1 rounded bg-surface-700 border-surface-600 text-blue-500 focus:ring-blue-500" />
                            <div>
                                <span class="text-sm text-surface-300"
                                    >{m.route_admin_api_tokens_compat_full()}</span>
                                <p class="text-xs text-surface-500">
                                    {m.route_admin_api_tokens_compat_full_desc()}
                                </p>
                            </div>
                        </label>
                        <label class="flex items-start gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={createPatFormState.scopes.includes('jellyfin_compat_read')}
                                onchange={() => toggleScope('jellyfin_compat_read')}
                                class="mt-1 rounded bg-surface-700 border-surface-600 text-blue-500 focus:ring-blue-500" />
                            <div>
                                <span class="text-sm text-surface-300"
                                    >{m.route_admin_api_tokens_compat_readonly()}</span>
                                <p class="text-xs text-surface-500">
                                    {m.route_admin_api_tokens_compat_readonly_desc()}
                                </p>
                            </div>
                        </label>
                    </div>
                </div>
            </div>

            <div>
                <label for="pat-expiration" class="block text-sm font-medium text-surface-300 mb-1"
                    >{m.route_admin_api_tokens_expiration()}</label>
                <select
                    id="pat-expiration"
                    class="w-full bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white"
                    bind:value={createPatFormState.expiresDays}>
                    <option value={30}>{m.route_admin_api_tokens_30_days()}</option>
                    <option value={90}>{m.route_admin_api_tokens_90_days()}</option>
                    <option value={365}>{m.route_admin_api_tokens_1_year()}</option>
                    <option value={null}>{m.route_admin_api_tokens_no_expiration()}</option>
                </select>
            </div>
        </div>
    </ActionModal>
{/if}

<!-- Create Service Token Modal -->
{#if createServiceTokenFormState.show}
    <ActionModal
        title={m.route_admin_api_tokens_create_service_modal_title()}
        confirmText={m.route_admin_api_tokens_create_service_confirm()}
        confirmColor="purple"
        disabled={createServiceTokenFormState.creating || !createServiceTokenFormState.name.trim()}
        onclose={() => (createServiceTokenFormState.show = false)}
        onconfirm={createServiceToken}>
        <div class="space-y-4">
            <div>
                <label for="svc-name" class="block text-sm font-medium text-surface-300 mb-1"
                    >{m.route_admin_api_tokens_service_name()}</label>
                <input
                    id="svc-name"
                    type="text"
                    class="w-full bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white"
                    placeholder={m.route_admin_api_tokens_service_name_placeholder()}
                    bind:value={createServiceTokenFormState.name} />
            </div>

            <div>
                <label for="svc-description" class="block text-sm font-medium text-surface-300 mb-1"
                    >{m.route_admin_api_tokens_description_label()}</label>
                <input
                    id="svc-description"
                    type="text"
                    class="w-full bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white"
                    placeholder={m.route_admin_api_tokens_description_placeholder()}
                    bind:value={createServiceTokenFormState.description} />
            </div>

            {#if !svcIsGrantOnly}
                <div>
                    <label
                        for="svc-act-as-user"
                        class="block text-sm font-medium text-surface-300 mb-1"
                        >{m.route_admin_api_tokens_act_as_user()}</label>
                    <select
                        id="svc-act-as-user"
                        class="w-full bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white"
                        bind:value={createServiceTokenFormState.actAsUserId}>
                        <option value="">—</option>
                        {#each users as user (user.id)}
                            <option value={user.id}>{user.displayName ?? user.id}</option>
                        {/each}
                    </select>
                    <p class="text-caption mt-1">
                        {m.route_admin_api_tokens_act_as_user_hint()}
                    </p>
                </div>
            {/if}

            <div>
                <span class="block text-sm font-medium text-surface-300 mb-1"
                    >{m.route_admin_api_tokens_scope_label()}</span>
                <select
                    class="w-full bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white"
                    bind:value={createServiceTokenFormState.scope}>
                    <option value="read">{m.route_admin_api_tokens_scope_read()}</option>
                    <option value="write">{m.route_admin_api_tokens_scope_write()}</option>
                    <option value="admin">{m.route_admin_api_tokens_scope_admin()}</option>
                    <option value="integrations:read"
                        >{m.route_admin_api_tokens_scope_integrations()}</option>
                    <option value="diagnostics:read"
                        >Diagnostics (debug report, 90 days max)</option>
                </select>
                <p class="text-caption mt-1">
                    {svcIsIntegrations
                        ? m.route_admin_api_tokens_scope_integrations_hint()
                        : m.route_admin_api_tokens_scope_hint()}
                </p>
            </div>

            {#if svcIsIntegrations}
                <div>
                    <span class="block text-sm font-medium text-surface-300 mb-1"
                        >{m.route_admin_api_tokens_integration_paths()}</span>
                    <div class="flex flex-col gap-1">
                        {#each INTEGRATION_ENDPOINT_PATHS as path (path)}
                            <label class="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={createServiceTokenFormState.integrationPaths.includes(
                                        path,
                                    )}
                                    onchange={() => toggleIntegrationPath(path)}
                                    class="rounded bg-surface-700 border-surface-600 text-purple-500 focus:ring-purple-500" />
                                <span class="text-sm text-surface-300 font-mono">{path}</span>
                            </label>
                        {/each}
                    </div>
                    <p class="text-caption mt-1">
                        {m.route_admin_api_tokens_integration_paths_hint()}
                    </p>
                </div>
            {:else if !svcIsDiagnostics}
                <div>
                    <label
                        for="svc-allowed-paths"
                        class="block text-sm font-medium text-surface-300 mb-1"
                        >{m.route_admin_api_tokens_allowed_paths()}</label>
                    <input
                        id="svc-allowed-paths"
                        type="text"
                        class="w-full bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white"
                        placeholder="/api/v1/health, /api/v1/stats"
                        bind:value={createServiceTokenFormState.allowedPathPrefixes} />
                    <p class="text-caption mt-1">
                        {m.route_admin_api_tokens_allowed_paths_hint()}
                    </p>
                </div>

                <div>
                    <span class="block text-sm font-medium text-surface-300 mb-1"
                        >{m.route_admin_api_tokens_allowed_methods()}</span>
                    <div class="flex gap-3 flex-wrap">
                        {#each SERVICE_TOKEN_METHODS as method (method)}
                            <label class="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={createServiceTokenFormState.allowedMethods.includes(
                                        method,
                                    )}
                                    onchange={() => toggleServiceMethod(method)}
                                    class="rounded bg-surface-700 border-surface-600 text-purple-500 focus:ring-purple-500" />
                                <span class="text-sm text-surface-300 font-mono">{method}</span>
                            </label>
                        {/each}
                    </div>
                    <p class="text-caption mt-1">
                        {m.route_admin_api_tokens_allowed_methods_hint()}
                    </p>
                </div>
            {/if}

            <div>
                <label for="svc-allowed-ips" class="block text-sm font-medium text-surface-300 mb-1"
                    >{m.route_admin_api_tokens_allowed_ips()}</label>
                <input
                    id="svc-allowed-ips"
                    type="text"
                    class="w-full bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white"
                    placeholder="192.168.1.100, 10.0.0.5"
                    bind:value={createServiceTokenFormState.allowedIps} />
                <p class="text-caption mt-1">
                    {m.route_admin_api_tokens_allowed_ips_hint()}
                </p>
                {#if createServiceTokenFormState.allowedIps.trim().length > 0}
                    <div
                        class="mt-2 rounded-lg border border-yellow-700/60 bg-yellow-900/20 p-3 text-xs text-yellow-200">
                        <p class="font-medium">
                            {m.route_admin_api_tokens_reverse_proxy_title()}
                        </p>
                        <p class="mt-1 text-yellow-200/80">
                            {m.route_admin_api_tokens_reverse_proxy_hint()}
                        </p>
                    </div>
                {/if}
            </div>

            {#if !svcIsGrantOnly}
                <div>
                    <label class="flex items-start gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            bind:checked={createServiceTokenFormState.forceNonAdmin}
                            class="mt-1 rounded bg-surface-700 border-surface-600 text-purple-500 focus:ring-purple-500" />
                        <div>
                            <span class="text-sm font-medium text-surface-300"
                                >{m.route_admin_api_tokens_force_non_admin()}</span>
                            <p class="text-xs text-surface-500 mt-0.5">
                                {m.route_admin_api_tokens_force_non_admin_desc()}
                            </p>
                        </div>
                    </label>
                </div>
            {/if}

            <div>
                <label for="svc-expiration" class="block text-sm font-medium text-surface-300 mb-1"
                    >{m.route_admin_api_tokens_expiration()}</label>
                <div class="flex items-center gap-2">
                    <select
                        id="svc-expiration"
                        class="flex-1 bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white disabled:opacity-50"
                        disabled={createServiceTokenFormState.neverExpires}
                        bind:value={createServiceTokenFormState.expiresDays}>
                        <option value={30}>{m.route_admin_api_tokens_30_days()}</option>
                        <option value={90}>{m.route_admin_api_tokens_90_days()}</option>
                        {#if !svcIsDiagnostics}
                            <option value={365}>{m.route_admin_api_tokens_1_year()}</option>
                        {/if}
                    </select>
                </div>
                {#if !svcIsDiagnostics}
                    <label class="mt-2 flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            bind:checked={createServiceTokenFormState.neverExpires}
                            class="rounded bg-surface-700 border-surface-600 text-purple-500 focus:ring-purple-500" />
                        <span class="text-sm text-surface-300"
                            >{m.route_admin_api_tokens_never_expires()}</span>
                    </label>
                {/if}
                {#if createServiceTokenFormState.neverExpires}
                    <p class="text-caption mt-1 text-yellow-300/80">
                        {m.route_admin_api_tokens_never_expires_warning()}
                    </p>
                {/if}
            </div>
        </div>
    </ActionModal>
{/if}

<!-- Token Display Modal -->
{#if tokenDisplayState.show}
    <TokenSuccessModal
        token={tokenDisplayState.token}
        onClose={() => {
            // Shown once: don't keep the secret in page state after close.
            tokenDisplayState.show = false;
            tokenDisplayState.token = '';
        }} />
{/if}
