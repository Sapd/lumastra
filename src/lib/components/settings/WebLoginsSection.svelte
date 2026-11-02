<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import { SvelteDate } from 'svelte/reactivity';
    import { Icon, GlobeAlt, ArrowTopRightOnSquare } from 'svelte-hero-icons';
    import { env } from '$env/dynamic/public';
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages';
    import { toasts } from '$lib/stores/toast.store';
    import InlineConfirm from './InlineConfirm.svelte';
    import SettingsGroup from './SettingsGroup.svelte';
    import { formatRelativeTime } from '$lib/utils/time-formatting';
    import { parseUserAgent } from '$lib/utils/user-agent';

    /**
     * Shape mirrors `WebLoginView` from `$lib/server/utils/web-logins-util` —
     * duplicated (not imported) so this client component never statically
     * imports a `$lib/server/*` module.
     */
    interface WebLoginView {
        id: string;
        createdAt: string;
        lastUsedAt: string | null;
        userAgent: string | null;
        ip: string | null;
        current: boolean;
    }

    interface Props {
        webLogins: WebLoginView[];
    }
    let { webLogins: initialWebLogins }: Props = $props();

    let webLogins = $state<WebLoginView[]>(untrack(() => initialWebLogins.slice()));
    let revokingId = $state<string | null>(null);
    let revokingOthers = $state(false);

    const otherLogins = $derived(webLogins.filter((l) => !l.current));
    /**
     * The identity provider's own account page — only for people who actually
     * sign in through it. A built-in-login user on an install that also sets
     * PUBLIC_AUTHURL would otherwise be sent to an IdP they have no account at.
     */
    const idpUrl = $derived($page.data?.authMethod !== 'session' ? env.PUBLIC_AUTHURL || '' : '');

    function formatDate(dateStr: string | null): string {
        if (!dateStr) return m.settings_devices_never();
        return new SvelteDate(dateStr).toLocaleString();
    }

    /** "Chrome 147 on macOS" — the raw user agent stays in the title. */
    function browserLabel(login: WebLoginView): string {
        return login.userAgent
            ? parseUserAgent(login.userAgent) || login.userAgent
            : m.settings_devices_unknown_device();
    }

    function lastActive(dateStr: string | null): string {
        return dateStr ? formatRelativeTime(dateStr) : m.settings_devices_never();
    }

    async function signOut(login: WebLoginView): Promise<void> {
        revokingId = login.id;
        try {
            const res = await fetch(`/api/user/sessions/${encodeURIComponent(login.id)}`, {
                method: 'DELETE',
            });
            if (!res.ok) throw new Error(String(res.status));
            webLogins = webLogins.filter((l) => l.id !== login.id);
            toasts.success(m.settings_weblogins_signout_toast());
        } catch {
            toasts.error(m.settings_weblogins_signout_error());
        } finally {
            revokingId = null;
        }
    }

    async function signOutOthers(): Promise<void> {
        if (otherLogins.length === 0) return;
        revokingOthers = true;
        try {
            const res = await fetch('/api/user/sessions', { method: 'POST' });
            if (!res.ok) throw new Error(String(res.status));
            webLogins = webLogins.filter((l) => l.current);
            toasts.success(m.settings_weblogins_signout_others_toast());
        } catch {
            toasts.error(m.settings_weblogins_signout_others_error());
        } finally {
            revokingOthers = false;
        }
    }
</script>

{#snippet othersFooter()}
    {#if otherLogins.length > 1}
        <InlineConfirm
            triggerLabel={m.settings_weblogins_signout_others()}
            confirmLabel={m.settings_devices_confirm()}
            variant="error"
            busy={revokingOthers}
            onConfirm={signOutOthers} />
        <span class="text-xs text-surface-500">{m.settings_devices_current_session_stays()}</span>
    {/if}
{/snippet}

<SettingsGroup
    label={m.settings_weblogins_heading()}
    footer={otherLogins.length > 1 ? othersFooter : undefined}>
    {#if webLogins.length === 0}
        <div class="flex flex-wrap items-center justify-between gap-3 py-3 px-4">
            <div class="flex items-center gap-3 min-w-0">
                <Icon src={GlobeAlt} class="w-6 h-6 text-surface-400 shrink-0" />
                <p class="text-sm text-surface-300">{m.settings_weblogins_none_note()}</p>
            </div>
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
        </div>
    {:else}
        {#each webLogins as login (login.id)}
            <div class="flex flex-wrap items-center justify-between py-3 px-4 gap-x-4 gap-y-2">
                <div class="flex items-center gap-3 min-w-0 flex-1 basis-56">
                    <Icon src={GlobeAlt} class="w-6 h-6 text-surface-400 shrink-0" />
                    <div class="min-w-0">
                        <div class="text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span class="truncate font-medium" title={login.userAgent ?? undefined}
                                >{browserLabel(login)}</span>
                            {#if login.current}
                                <span class="badge variant-soft-primary text-xs px-1.5 py-0.5"
                                    >{m.settings_weblogins_this_device()}</span>
                            {/if}
                        </div>
                        <p
                            class="text-xs text-surface-400 mt-0.5"
                            title={formatDate(login.lastUsedAt)}>
                            {[
                                login.ip,
                                m.settings_devices_last_active({
                                    date: lastActive(login.lastUsedAt),
                                }),
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        </p>
                    </div>
                </div>
                {#if login.current}
                    <span class="text-xs text-surface-500">{m.settings_devices_current()}</span>
                {:else}
                    <InlineConfirm
                        triggerLabel={m.settings_weblogins_signout()}
                        ariaLabel={m.settings_devices_log_out_label({ name: browserLabel(login) })}
                        confirmLabel={m.settings_devices_confirm()}
                        busy={revokingId === login.id}
                        onConfirm={() => signOut(login)} />
                {/if}
            </div>
        {/each}
    {/if}
</SettingsGroup>
