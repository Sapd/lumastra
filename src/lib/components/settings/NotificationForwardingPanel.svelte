<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  "Forward my notifications" — the user's consent to have their notifications
  sent to integrations the administrator set up (admin webhooks subscribed to
  org.lumastra.user.notification, e.g. a Telegram bot).

  Renders nothing until the first read lands, and nothing at all when no
  integration exists AND forwarding is off: on an install without one there is
  nothing for the user to decide. A user who switched it on keeps seeing the
  row even after the admin removes the integration, so they can switch it off.
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { Icon, PaperAirplane } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import { toasts } from '$lib/stores/toast.store';
    import * as userApi from '$lib/api/user';
    import Toggle from '$lib/components/ui/Toggle.svelte';

    let loaded = $state(false);
    let busy = $state(false);
    let enabled = $state(false);
    let targets = $state<string[]>([]);

    const named = $derived(targets.filter((t) => t.trim().length > 0));
    const visible = $derived(loaded && (targets.length > 0 || enabled));

    onMount(async () => {
        const { data, error } = await userApi.getNotificationForwarding();
        if (!error && data) {
            enabled = data.enabled;
            targets = data.targets;
            loaded = true;
        }
    });

    async function toggle(detail: { checked: boolean }): Promise<void> {
        if (busy || !loaded) return;
        busy = true;
        try {
            const { data, error } = await userApi.setNotificationForwarding(detail.checked);
            if (error || !data) {
                toasts.error(m.settings_notification_forwarding_save_failed());
                return;
            }
            enabled = data.enabled;
            targets = data.targets;
        } finally {
            busy = false;
        }
    }
</script>

{#if visible}
    <div class="flex items-center justify-between py-3 px-4 gap-4">
        <div class="flex items-center gap-2 min-w-0">
            <Icon src={PaperAirplane} class="w-4 h-4 text-surface-400 shrink-0" />
            <div class="min-w-0">
                <span id="notification-forwarding-title" class="text-sm"
                    >{m.settings_notification_forwarding_title()}</span>
                <p id="notification-forwarding-hint" class="text-xs text-surface-500 mt-0.5">
                    {#if targets.length === 0}
                        {m.settings_notification_forwarding_none()}
                    {:else if named.length > 0}
                        {m.settings_notification_forwarding_hint({ targets: named.join(', ') })}
                    {:else}
                        {m.settings_notification_forwarding_hint_unnamed()}
                    {/if}
                </p>
            </div>
        </div>
        <div class="shrink-0">
            <Toggle
                labelledby="notification-forwarding-title"
                describedby="notification-forwarding-hint"
                checked={enabled}
                disabled={busy}
                onchange={toggle} />
        </div>
    </div>
{/if}
