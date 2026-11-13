<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Jellyfin-compatible clients (Swiftfin, Findroid, Streamyfin, …) signed in via
  the /j compat layer.

  These are a THIRD kind of session, distinct from both the web logins and the
  device/OAuth tokens listed elsewhere on this page: each client login mints its
  own 30-day compat session. They used to be invisible here, with no lever short
  of deleting the whole client password (which signs out every client at once).

  Loaded client-side on purpose. The page loader does not import the /j tree;
  going over HTTP keeps that separation. It also keeps the section entirely self-contained: nothing to
  add to the loader, and a Valkey hiccup degrades to an empty list instead of
  failing the whole page.
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { SvelteDate } from 'svelte/reactivity';
    import { Icon, ServerStack } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import { getJellyfinClientSessions, revokeJellyfinClientSession } from '$lib/api/user';
    import { toasts } from '$lib/stores/toast.store';
    import InlineConfirm from './InlineConfirm.svelte';
    import SettingsGroup from './SettingsGroup.svelte';
    import { formatRelativeTime } from '$lib/utils/time-formatting';
    import type { JellyfinClientSession } from '$lib/schemas/api-user-responses';
    import { resolve } from '$lib/paths';

    let sessions = $state<JellyfinClientSession[]>([]);
    let loading = $state(true);
    let revoking = $state<string | null>(null);
    let liveMessage = $state('');

    onMount(() => {
        void load();
    });

    async function load(): Promise<void> {
        loading = true;
        try {
            const { data } = await getJellyfinClientSessions();
            if (data) sessions = data.items;
        } catch {
            // Leave the list empty — the section hides itself below.
        } finally {
            loading = false;
        }
    }

    function formatDate(dateStr: string): string {
        const parsed = new SvelteDate(dateStr);
        return Number.isNaN(parsed.getTime())
            ? m.settings_devices_never()
            : parsed.toLocaleDateString();
    }

    /** "Swiftfin 1.2 · iPhone" — omitting whichever parts the client didn't send. */
    function clientLabel(s: JellyfinClientSession): string {
        const parts = [s.clientName, s.clientVersion].filter(Boolean).join(' ');
        const device = s.deviceName?.trim();
        if (parts && device) return `${parts} · ${device}`;
        return parts || device || m.settings_jellyfin_clients_unknown();
    }

    async function revoke(session: JellyfinClientSession): Promise<void> {
        revoking = session.id;
        const label = clientLabel(session);
        try {
            const { error, status } = await revokeJellyfinClientSession(session.id);
            // 404 means the session is already gone — revoked from another tab
            // or device, or expired since this list was loaded. The user asked
            // for it to be signed out and it is, so report success rather than
            // an alarming failure over a race they can do nothing about.
            if (!error || status === 404) {
                sessions = sessions.filter((s) => s.id !== session.id);
                liveMessage = m.settings_jellyfin_clients_signed_out({ name: label });
                toasts.success(m.settings_jellyfin_clients_signed_out({ name: label }));
            } else {
                toasts.error(error || m.settings_jellyfin_clients_revoke_error());
            }
        } catch {
            toasts.error(m.settings_jellyfin_clients_revoke_error());
        } finally {
            revoking = null;
        }
    }
</script>

<!--
  Data-driven: with no connected clients there is nothing useful to say, and an
  empty card on a page that already has three lists is just noise. Also stays
  invisible when the compat layer is disabled, since the endpoint 404s then.
-->
{#if !loading && sessions.length > 0}
    <div class="sr-only" aria-live="polite">{liveMessage}</div>

    <SettingsGroup
        label={m.settings_jellyfin_clients_heading()}
        description={m.settings_jellyfin_clients_description()}>
        {#each sessions as session (session.id)}
            {@const label = clientLabel(session)}
            <div class="flex flex-wrap items-center justify-between py-3 px-4 gap-x-4 gap-y-2">
                <div class="flex items-center gap-3 min-w-0 flex-1 basis-56">
                    <Icon src={ServerStack} class="w-6 h-6 text-surface-400 shrink-0" />
                    <div class="min-w-0">
                        <div class="text-sm font-medium truncate">{label}</div>
                        <p
                            class="text-xs text-surface-400 mt-0.5"
                            title={formatDate(session.createdAt)}>
                            {m.settings_jellyfin_clients_connected_since({
                                date: formatRelativeTime(session.createdAt),
                            })}
                        </p>
                    </div>
                </div>
                <InlineConfirm
                    triggerLabel={m.settings_jellyfin_clients_sign_out()}
                    ariaLabel={m.settings_devices_log_out_label({ name: label })}
                    confirmLabel={m.settings_devices_confirm()}
                    busy={revoking === session.id}
                    onConfirm={() => revoke(session)} />
            </div>
        {/each}
        {#snippet footer()}
            <!--
              Points back to where access is set up. This page reviews and revokes;
              pairing a NEW client needs the server URL and password, which live in
              the connect dialog on Connections.
            -->
            <a
                href={resolve('/settings/connections') + '?connect=jellyfin'}
                class="text-sm text-primary-400 hover:text-primary-300">
                {m.settings_jellyfin_clients_connect_new()}
            </a>
        {/snippet}
    </SettingsGroup>
{/if}
