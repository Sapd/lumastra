<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteDate } from 'svelte/reactivity';

    import { goto, replaceState } from '$app/navigation';
    import { page } from '$app/stores';
    import { url, resolve } from '$lib/paths';
    import type { PageData } from './$types';
    import * as m from '$lib/paraglide/messages';
    import * as adminApi from '$lib/api/admin';

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null;

    let userCodeInput = $state('');
    let loading = $state(false);
    let errorState = $state('');
    let success = $state('');
    let showTechnicalScopes = $state(false);

    // Plain-language rendering of the granted scope set. Driven off the scopes
    // the server actually issues (data.deviceCode.capabilities.granted) rather
    // than a hardcoded list, so a change to the grant shows up here.
    let capabilities = $derived(data.deviceCode?.capabilities ?? null);

    // Keyed by a stable slug, never by the translated text: two capability
    // strings colliding in some locale would be a duplicate-key crash that
    // takes down the whole consent page.
    let plainCapabilities = $derived.by(() => {
        const granted = capabilities?.granted ?? [];
        const lines: { key: string; label: string }[] = [];
        if (granted.includes('media:read'))
            lines.push({ key: 'browse', label: m.device_cap_browse() });
        if (granted.includes('media:write'))
            lines.push({ key: 'play', label: m.device_cap_play() });
        if (granted.includes('requests:read'))
            lines.push({ key: 'requests', label: m.device_cap_requests() });
        return lines;
    });

    // Sync error from server data reactively
    let error = $derived.by(() => data.error || errorState);

    // Format user code as user types (XXXX-XXXX)
    function formatUserCode(value: string): string {
        // Remove all non-alphanumeric characters
        const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        // Insert dash after 4 characters
        if (clean.length > 4) {
            return clean.slice(0, 4) + '-' + clean.slice(4, 8);
        }
        return clean;
    }

    function handleInput(event: Event) {
        const input = event.target as HTMLInputElement;
        userCodeInput = formatUserCode(input.value);
        input.value = userCodeInput;
    }

    async function lookupCode() {
        if (loading) return; // Prevent double-click
        if (userCodeInput.length < 9) {
            errorState = m.device_enter_complete_code();
            return;
        }

        loading = true; // Disable button during navigation
        errorState = '';
        try {
            // Navigate to same page with code parameter, invalidateAll ensures server load runs
            await goto(resolve(`/device?code=${encodeURIComponent(userCodeInput)}`), {
                invalidateAll: true,
            });
        } catch {
            errorState = m.device_network_error();
        } finally {
            loading = false;
        }
    }

    async function authorize() {
        if (!data.deviceCode) return;
        if (loading) return; // Prevent double-click
        if (success) return; // Already authorized

        loading = true;
        errorState = '';
        success = '';

        try {
            const { data: authData, error: authErr } = await adminApi.authorizeOAuth({
                user_code: data.deviceCode.userCode,
            });

            if (!authErr) {
                success = m.device_authorized_success();
                // Clear the code from URL to prevent "already used" error on refresh/back
                replaceState(resolve('/device'), {});
            } else {
                errorState = authErr || m.device_authorize_failed();
            }
        } catch (e) {
            errorState = m.device_network_error();
        } finally {
            loading = false;
        }
    }

    async function deny() {
        if (!data.deviceCode) return;
        if (loading) return; // Prevent double-click
        if (success) return; // Already completed

        loading = true;
        errorState = '';
        success = '';

        try {
            const { data: denyData, error: denyErr } = await adminApi.revokeOAuth({
                user_code: data.deviceCode.userCode,
            });

            if (!denyErr) {
                success = m.device_denied_success();
                // Clear the code from URL to prevent stale state on refresh/back
                replaceState(resolve('/device'), {});
            } else {
                errorState = denyErr || m.device_deny_failed();
            }
        } catch (e) {
            errorState = m.device_network_error();
        } finally {
            loading = false;
        }
    }

    // Some clients (see device-client-redirects.ts) are known first-party apps
    // whose approving browser and polling app are the SAME device (e.g. the
    // iOS app opens Safari to verification_uri_complete; once approved there's
    // nothing left to do there — the app already gets its token from its own
    // polling, never from this redirect). The server resolves that target by
    // client_id at code-creation time — this page never decides it itself (no
    // user-agent sniffing, no platform guessing): it just redirects if
    // `data.deviceCode.redirectUri` is set, and does nothing otherwise.
    $effect(() => {
        if (success === m.device_authorized_success() && data.deviceCode?.redirectUri) {
            window.location.href = data.deviceCode.redirectUri;
        }
    });

    // Calculate time remaining
    function getTimeRemaining(expiresAt: string): string {
        const now = new SvelteDate();
        const expires = new SvelteDate(expiresAt);
        const diff = expires.getTime() - now.getTime();

        if (diff <= 0) return m.device_expired();

        const minutes = Math.floor(diff / 60000);
        const seconds = Math.floor((diff % 60000) / 1000);

        if (minutes > 0) {
            return m.device_time_remaining_minutes({
                minutes: minutes.toString(),
                seconds: seconds.toString(),
            });
        }
        return m.device_time_remaining_seconds({ seconds: seconds.toString() });
    }
</script>

<svelte:head>
    <title>{m.device_authorize_title()}</title>
</svelte:head>

<div class="min-h-screen center p-4">
    <div class="card p-8 max-w-md w-full">
        <div class="text-center mb-6">
            <h1 class="h1 mb-2">{m.device_authorize_title()}</h1>
            {#if data.username}
                <p class="text-surface-500">
                    {m.device_logged_in_as({ username: data.username })}
                </p>
            {/if}
        </div>

        {#if !data.enabled}
            <div class="alert variant-filled-error">
                <p>{m.device_not_enabled()}</p>
            </div>
        {:else if !data.username}
            <div class="alert variant-filled-warning">
                <p>{m.device_please_login()}</p>
            </div>
        {:else if success}
            <div class="alert variant-filled-success mb-4">
                <p>{success}</p>
            </div>
            <div class="text-center space-y-2">
                {#if success === m.device_authorized_success() && data.deviceCode?.redirectUri}
                    <!-- Fallback for when the automatic redirect above is blocked or
                         dismissed — same destination, user-initiated. -->
                    <a href={data.deviceCode.redirectUri} class="btn variant-filled-primary block"
                        >{m.device_return_app()}</a>
                {/if}
                <a href={resolve('/')} class="btn variant-filled-primary"
                    >{m.device_return_dashboard()}</a>
            </div>
        {:else if data.deviceCode}
            <!-- Device code found - show authorize/deny -->
            <div class="space-y-6">
                <div class="card variant-soft p-4">
                    <div class="text-center">
                        <p class="text-sm text-surface-500 mb-1">
                            {m.device_code_label()}
                        </p>
                        <p class="text-2xl font-mono font-bold tracking-wider">
                            {data.deviceCode.userCode}
                        </p>
                        {#if data.deviceCode.deviceName}
                            <!-- break-all: device_name is client-supplied text
                                 (bounded server-side), so it must not overflow. -->
                            <p class="text-sm mt-2 break-all">
                                {data.deviceCode.deviceName}
                            </p>
                        {/if}
                        <p class="text-xs text-surface-400 mt-2">
                            {m.device_client()}: {data.deviceCode.clientId}
                        </p>
                        <p class="text-xs text-warning-500 mt-1">
                            {getTimeRemaining(data.deviceCode.expiresAt)}
                        </p>
                    </div>
                </div>

                {#if capabilities}
                    <div class="card variant-soft p-4 space-y-3">
                        <!-- What the device asked for. Shown separately from what it
                             gets: a recognized scope (e.g. media:read) genuinely
                             narrows the grant below, but the request can never
                             WIDEN it — the server always picks between its own
                             fixed grant tiers, never the device's raw string. -->
                        <div>
                            <p class="text-xs uppercase tracking-wide text-surface-500">
                                {m.device_scope_requested()}
                            </p>
                            {#if capabilities.requested && capabilities.requestedIsKnown}
                                <!-- Echoed verbatim only for scopes this server
                                     recognizes. break-all: the scope column is
                                     unbounded client-supplied text; without it a
                                     long unbroken value overflows the card. -->
                                <p class="text-sm font-mono break-all">
                                    {capabilities.requested}
                                </p>
                                {#if capabilities.requestedIsIgnored}
                                    <p class="text-xs text-surface-400">
                                        {m.device_scope_requested_ignored()}
                                    </p>
                                {:else}
                                    <!-- A recognized request that actually narrows
                                         the grant below (e.g. media:read) — say so,
                                         instead of the (now false) "ignored" claim. -->
                                    <p class="text-xs text-surface-400">
                                        {m.device_scope_requested_honored()}
                                    </p>
                                {/if}
                            {:else if capabilities.requested}
                                <!-- Unrecognized: describe it instead of echoing
                                     arbitrary text from an unauthenticated
                                     endpoint back at the approving user. -->
                                <p class="text-sm">
                                    {m.device_scope_unrecognized()}
                                </p>
                                <p class="text-xs text-surface-400">
                                    {m.device_scope_requested_ignored()}
                                </p>
                            {:else}
                                <p class="text-xs text-surface-400">
                                    {m.device_scope_none_requested()}
                                </p>
                            {/if}
                        </div>

                        <div>
                            <p class="text-xs uppercase tracking-wide text-surface-500 mb-1">
                                {m.device_scope_granted()}
                            </p>
                            <ul class="text-sm space-y-1">
                                {#each plainCapabilities as capability (capability.key)}
                                    <li class="flex gap-2">
                                        <span aria-hidden="true" class="text-success-500">✓</span>
                                        <span>{capability.label}</span>
                                    </li>
                                {:else}
                                    <!-- The grant is server-fixed and currently always
                                         includes media:read, so this is unreachable today.
                                         It exists so a future change to the granted set
                                         degrades to a visible statement rather than an
                                         empty list under a "will be granted" heading. -->
                                    <li>{m.device_cap_unknown()}</li>
                                {/each}
                            </ul>
                        </div>

                        {#if capabilities.grantsAdmin}
                            <!-- Unreachable while the bearer path pins tokenScopes: [].
                                 Present so that if that ever regresses, the approving
                                 user is warned instead of silently handing a TV admin
                                 rights — the failure this screen exists to prevent.
                                 Shown to EVERY user: it is an alarm, not reassurance,
                                 and a non-admin approver is equally worth warning. -->
                            <div class="admin-warning-note">
                                <p class="text-sm font-semibold">
                                    {m.device_admin_warning_title()}
                                </p>
                                <p class="text-xs">
                                    {m.device_admin_warning_body()}
                                </p>
                            </div>
                        {:else if data.isAdmin}
                            <!-- Admins only. The guarantee holds for everyone, but
                                 "this device gets no admin rights" only answers a
                                 question an admin has; for a regular user it names a
                                 privilege they never had and reads as noise. -->
                            <div class="no-admin-note">
                                <p class="text-sm font-semibold">
                                    {m.device_no_admin_title()}
                                </p>
                                <p class="text-xs text-surface-300">
                                    {m.device_no_admin_body()}
                                </p>
                            </div>
                        {/if}

                        <div>
                            <button
                                type="button"
                                class="text-xs underline text-surface-400"
                                aria-expanded={showTechnicalScopes}
                                onclick={() => (showTechnicalScopes = !showTechnicalScopes)}>
                                {showTechnicalScopes
                                    ? m.device_scope_hide_technical()
                                    : m.device_scope_show_technical()}
                            </button>
                            {#if showTechnicalScopes}
                                <ul class="flex flex-wrap gap-1 mt-2">
                                    {#each capabilities.granted as scope (scope)}
                                        <li
                                            class="text-xs font-mono px-2 py-0.5 rounded bg-surface-700/60">
                                            {scope}
                                        </li>
                                    {:else}
                                        <li class="text-xs text-surface-400">
                                            {m.device_scope_none_granted()}
                                        </li>
                                    {/each}
                                </ul>
                            {/if}
                        </div>
                    </div>
                {/if}

                <div class="text-center">
                    <p class="mb-4">
                        {m.device_allow_access()}
                    </p>
                </div>

                {#if error}
                    <div class="alert variant-filled-error">
                        <p>{error}</p>
                    </div>
                {/if}

                <div class="grid grid-cols-2 gap-4">
                    <button class="btn variant-filled-error" onclick={deny} disabled={loading}>
                        {#if loading}
                            <span class="animate-spin mr-2">...</span>
                        {/if}
                        {m.device_deny()}
                    </button>
                    <button
                        class="btn variant-filled-primary"
                        onclick={authorize}
                        disabled={loading}>
                        {#if loading}
                            <span class="animate-spin mr-2">...</span>
                        {/if}
                        {m.device_authorize()}
                    </button>
                </div>

                <p class="text-xs text-center text-surface-400">
                    {m.device_trust_warning()}
                </p>
            </div>
        {:else}
            <!-- No code or invalid code - show input form -->
            <div class="space-y-6">
                <p class="text-center text-surface-300">
                    {m.device_enter_code_prompt()}
                </p>

                {#if error}
                    <div class="alert variant-filled-error">
                        <p>{error}</p>
                    </div>
                {/if}

                <div>
                    <label for="user-code" class="label mb-2">{m.device_code_label()}</label>
                    <input
                        id="user-code"
                        type="text"
                        class="input text-center text-2xl font-mono tracking-widest"
                        placeholder="XXXX-XXXX"
                        maxlength="9"
                        bind:value={userCodeInput}
                        oninput={handleInput}
                        autocomplete="off"
                        autocapitalize="characters" />
                </div>

                <button
                    class="btn variant-filled-primary w-full"
                    onclick={lookupCode}
                    disabled={loading || userCodeInput.length < 9}>
                    {m.device_continue()}
                </button>
            </div>
        {/if}
    </div>
</div>

<style>
    .alert {
        padding: 1rem;
        border-radius: 0.5rem;
    }

    .alert.variant-filled-error {
        background-color: rgba(239, 68, 68, 0.2);
        border: 1px solid rgba(239, 68, 68, 0.5);
        color: #fecaca;
    }

    .alert.variant-filled-success {
        background-color: rgba(34, 197, 94, 0.2);
        border: 1px solid rgba(34, 197, 94, 0.5);
        color: #bbf7d0;
    }

    .alert.variant-filled-warning {
        background-color: rgba(234, 179, 8, 0.2);
        border: 1px solid rgba(234, 179, 8, 0.5);
        color: #fef08a;
    }

    /* The "no admin" guarantee is the property the user is being asked to
       trust, so it gets its own affordance rather than blending into the list. */
    .no-admin-note {
        padding: 0.625rem 0.75rem;
        border-radius: 0.375rem;
        background-color: rgba(34, 197, 94, 0.12);
        border: 1px solid rgba(34, 197, 94, 0.35);
    }

    /* Inverse of .no-admin-note: shown only if the grant ever regresses to
       include admin, so it must read as an alarm, not an affordance. */
    .admin-warning-note {
        padding: 0.625rem 0.75rem;
        border-radius: 0.375rem;
        background-color: rgba(239, 68, 68, 0.15);
        border: 1px solid rgba(239, 68, 68, 0.5);
        color: #fecaca;
    }
</style>
