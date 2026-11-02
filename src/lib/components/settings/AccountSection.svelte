<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { getAvatarUrl } from '$lib/utils/image-utils.js';
    import { page } from '$app/stores';
    import { env } from '$env/dynamic/public';
    import { Icon, ArrowRightOnRectangle, ArrowTopRightOnSquare, Camera } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import SettingsGroup from './SettingsGroup.svelte';
    import AvatarPanel from './AvatarPanel.svelte';
    import PasswordPanel from './PasswordPanel.svelte';
    import ApiTokensPanel from './ApiTokensPanel.svelte';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import {
        resolveLogoutMode,
        performNativeSignOut,
    } from '$lib/components/user-menu/user-menu-logout';
    import { resolve } from '$lib/paths';
    import type { UserTokenInfo } from '$lib/schemas/api-user-responses';

    /** How the user actually signs in — from the account page's server load. */
    interface SignInInfo {
        method: 'password' | 'oidc' | 'proxy' | 'idp';
        providerName: string | null;
        hasPassword: boolean;
    }

    interface Props {
        initialTokens?: UserTokenInfo[];
        patsEnabled?: boolean;
        /** Omitted/null → fall back to the request's authMethod alone. */
        signIn?: SignInInfo | null;
    }
    let { initialTokens = [], patsEnabled = false, signIn = null }: Props = $props();

    const username = $derived($page.data?.user?.username ?? '');
    // The layout ships `isAdmin` on the user object; the client PageData type
    // does not declare it (see +layout.server.ts).
    const isAdmin = $derived(
        ($page.data?.user as { isAdmin?: boolean } | undefined)?.isAdmin === true,
    );
    const canChangeAvatar = $derived($page.data?.features?.avatarUpload !== false);
    const isSession = $derived($page.data?.authMethod === 'session');
    // `authMethod === 'session'` is true for OIDC sign-ins too, so the server's
    // signIn facts win when present: an SSO user has no local password and must
    // not be told they signed in with one, nor offered "Change password".
    const signInLabel = $derived.by((): string => {
        if (!signIn) {
            return isSession
                ? m.settings_account_signed_in_password()
                : m.settings_account_signed_in_idp();
        }
        switch (signIn.method) {
            case 'password':
                return m.settings_account_signed_in_password();
            case 'oidc':
                return signIn.providerName
                    ? m.settings_account_signed_in_oidc({ provider: signIn.providerName })
                    : m.settings_account_signed_in_idp();
            case 'proxy':
                return m.settings_account_signed_in_proxy();
            default:
                return m.settings_account_signed_in_idp();
        }
    });
    const canChangePassword = $derived(isSession && (signIn ? signIn.hasPassword : true));
    const logoutMode = $derived(resolveLogoutMode($page.data?.authMethod, env.PUBLIC_LOGOUTURL));
    /** The identity provider's own account page, for SSO installs. */
    const idpUrl = $derived(!isSession ? env.PUBLIC_AUTHURL || '' : '');
    // Bumped after an avatar change so the header picture refreshes too.
    let avatarVersion = $state(Date.now());
    let editingPhoto = $state(false);
    let signingOut = $state(false);

    async function signOut(): Promise<void> {
        signingOut = true;
        await performNativeSignOut();
    }
    const avatarSrc = $derived(getAvatarUrl(username, { version: avatarVersion }));
</script>

<!--
  Who you are, first. The page used to open on a bare avatar uploader with no
  name, no sign-in method and no way to sign out.
-->
<SettingsGroup label={m.settings_account_group_profile()}>
    <div class="flex flex-wrap items-center justify-between gap-4 p-4">
        <div class="flex items-center gap-4 min-w-0">
            <Avatar src={avatarSrc} alt={m.ui_avatar_alt({ username })} {username} size="lg" />
            <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                    <span class="text-lg font-semibold truncate">{username}</span>
                    {#if isAdmin}
                        <span class="badge variant-soft-primary text-xs px-1.5 py-0.5"
                            >{m.settings_account_role_admin()}</span>
                    {/if}
                </div>
                <p class="text-xs text-surface-400 mt-0.5">{signInLabel}</p>
            </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
            {#if canChangeAvatar}
                <button
                    class="btn btn-sm variant-soft-surface inline-flex items-center gap-1.5"
                    aria-expanded={editingPhoto}
                    aria-controls="settings-account-photo"
                    onclick={() => (editingPhoto = !editingPhoto)}>
                    <Icon src={Camera} class="w-4 h-4" />
                    {m.settings_account_change_photo()}
                </button>
            {/if}
            {#if idpUrl}
                <a
                    href={idpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="btn btn-sm variant-soft-surface inline-flex items-center gap-1.5">
                    {m.settings_account_manage_at_idp()}
                    <Icon src={ArrowTopRightOnSquare} class="w-4 h-4" />
                </a>
            {/if}
            {#if logoutMode === 'session'}
                <button
                    class="btn btn-sm variant-ghost-surface inline-flex items-center gap-1.5"
                    disabled={signingOut}
                    onclick={signOut}>
                    <Icon src={ArrowRightOnRectangle} class="w-4 h-4" />
                    {m.settings_account_sign_out()}
                </button>
            {:else}
                <a
                    href={resolve('/logout')}
                    class="btn btn-sm variant-ghost-surface inline-flex items-center gap-1.5">
                    <Icon src={ArrowRightOnRectangle} class="w-4 h-4" />
                    {m.settings_account_sign_out()}
                </a>
            {/if}
        </div>
    </div>
    {#if canChangeAvatar && editingPhoto}
        <div id="settings-account-photo">
            <AvatarPanel
                {username}
                onUpdated={() => {
                    avatarVersion += 1;
                    editingPhoto = false;
                }} />
        </div>
    {/if}
</SettingsGroup>

{#if canChangePassword}
    <SettingsGroup label={m.settings_account_group_password()}>
        <PasswordPanel />
    </SettingsGroup>
{/if}

{#if patsEnabled}
    <SettingsGroup
        label={m.settings_account_group_api_tokens()}
        description={m.settings_tokens_description()}>
        <ApiTokensPanel {initialTokens} />
    </SettingsGroup>
{/if}
