<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  /admin/notifications — "Message users": the one place an operator tells
  people something. Three genuinely different kinds, picked at the top
  (`?kind=`), each keeping its own mechanics:

   - announcement — a durable inbox row for every user (or chosen users),
     optionally pinned; survives the recipient being offline. The compose
     form and "Recent" list below.
   - maintenance — a banner with a live countdown on every open app until it
     expires or is ended (MaintenanceNoticeCard).
   - live — a one-off pop-up on screens playing right now; perishable, gone in
     seconds (LiveMessageCard; formerly "Broadcast to all" on Active sessions).

  They used to live on three surfaces (this page, a collapsible card and a
  button on Active sessions); an operator had to know which was which before
  finding it. Active sessions keeps only the per-session message button and a
  link here. See `admin-broadcast.service.ts` for the announcement side.

  Two things a reader should not go looking for:

   - There is no EDIT action. A sent announcement's text is immutable, like
     every other notification kind's: it has already been copied into every
     recipient's inbox and mirrored into however many push banners, so an edit
     would leave those disagreeing forever. Retraction is Delete, which cascades
     to every copy.
   - There is no in-app (media) destination. The optional Link field takes an
     ordinary web address and nothing else — an announcement is not about a
     media item, and pointing one at a catalogue entry was a separate product
     decision that has not been made. The address is scheme-checked server-side
     (`http`/`https` only) and recipients open it in a new tab.
-->

<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';
    import { untrack } from 'svelte';
    import {
        Icon,
        MapPin,
        Trash,
        ArrowPath,
        Megaphone,
        WrenchScrewdriver,
        ChatBubbleOvalLeft,
        type IconSource,
    } from 'svelte-hero-icons';
    import { page } from '$app/state';
    import { goto } from '$app/navigation';
    import MaintenanceNoticeCard from '$lib/components/admin/MaintenanceNoticeCard.svelte';
    import LiveMessageCard from '$lib/components/admin/LiveMessageCard.svelte';
    import { AdminPageHeader } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import UserMultiSelect from '$lib/components/admin/UserMultiSelect.svelte';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import { modals } from '$lib/stores/modal.store';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import * as m from '$lib/paraglide/messages.js';
    import {
        broadcastNotification,
        listBroadcasts,
        setBroadcastPin,
        deleteBroadcast,
    } from '$lib/api/admin';
    import type { AdminBroadcast } from '$lib/schemas/admin-broadcasts';
    import type { PageData } from './$types';

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    // ---- Message kind ------------------------------------------------------
    type Kind = 'announcement' | 'maintenance' | 'live';
    const KINDS: { id: Kind; icon: IconSource; title: () => string; hint: () => string }[] = [
        {
            id: 'announcement',
            icon: Megaphone,
            title: m.admin_messages_kind_announcement,
            hint: m.admin_messages_kind_announcement_hint,
        },
        {
            id: 'maintenance',
            icon: WrenchScrewdriver,
            title: m.admin_messages_kind_maintenance,
            hint: m.admin_messages_kind_maintenance_hint,
        },
        {
            id: 'live',
            icon: ChatBubbleOvalLeft,
            title: m.admin_messages_kind_live,
            hint: m.admin_messages_kind_live_hint,
        },
    ];
    const kind = $derived.by((): Kind => {
        const k = page.url.searchParams.get('kind');
        return k === 'maintenance' || k === 'live' ? k : 'announcement';
    });
    function selectKind(next: Kind): void {
        const url = new URL(page.url);
        if (next === 'announcement') url.searchParams.delete('kind');
        else url.searchParams.set('kind', next);
        void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
    }

    // Seeded once from the server load, then owned by the client — the refresh
    // button and post-mutation reloads write here, so it must not be re-derived
    // from `data` or every mutation would be reverted on the next invalidation.
    // Same `untrack` idiom as /admin/users.
    let broadcasts = $state<AdminBroadcast[]>(untrack(() => data.initialBroadcasts) ?? []);
    const users = $derived(data.initialUsers ?? []);

    let refreshing = $state(false);
    let sending = $state(false);
    /** Broadcast ids with a pin/delete in flight, so their row buttons disable. */
    const busyIds = new SvelteSet<string>();

    // ---- Compose form ----------------------------------------------------
    let title = $state('');
    let body = $state('');
    /**
     * Optional external address the announcement links to.
     *
     * Not validated here beyond the browser's own `type="url"` affordance: the
     * server owns the rule (absolute, `http`/`https` only) and answers 422 with
     * a field message, which `send()` surfaces through the same toast path as
     * every other send failure. A second implementation of the rule on this
     * page would only be able to disagree with the first.
     */
    let linkUrl = $state('');
    let audience = $state<'all' | 'users'>('all');
    let pinned = $state(false);
    /** Hours to keep the pin, or 0 for "until I unpin". */
    let pinDurationHours = $state(0);
    // Default ON, matching the product decision: a broadcast is an interruption
    // by nature, and the admin unticks when it is not urgent enough for one.
    let pushEnabled = $state(true);
    const selectedUserIds = new SvelteSet<string>();

    const canSend = $derived(
        title.trim().length > 0 && !sending && (audience === 'all' || selectedUserIds.size > 0),
    );

    /**
     * Turn the duration picker into the absolute instant the API wants.
     *
     * Computed at SEND time rather than when the admin picks it, so a form left
     * open for an hour still pins for the full period they chose. The server
     * stores the absolute deadline and compares it live, so this is the only
     * place a relative duration exists.
     */
    function pinExpiresAt(): string | undefined {
        if (!pinned || pinDurationHours <= 0) return undefined;
        return new Date(Date.now() + pinDurationHours * 60 * 60 * 1000).toISOString();
    }

    function resetForm(): void {
        title = '';
        body = '';
        linkUrl = '';
        audience = 'all';
        pinned = false;
        pinDurationHours = 0;
        pushEnabled = true;
        selectedUserIds.clear();
    }

    async function refresh(): Promise<void> {
        refreshing = true;
        const { data: listed, error } = await listBroadcasts();
        refreshing = false;
        if (error || !listed) {
            toasts.error(getErrorMessage(error, m.admin_broadcast_load_failed()));
            return;
        }
        broadcasts = listed.items;
    }

    async function send(): Promise<void> {
        if (!canSend) return;
        sending = true;
        const trimmedBody = body.trim();
        const trimmedLinkUrl = linkUrl.trim();
        const { data: sent, error } = await broadcastNotification({
            title: title.trim(),
            ...(trimmedBody ? { body: trimmedBody } : {}),
            ...(trimmedLinkUrl ? { linkUrl: trimmedLinkUrl } : {}),
            audience,
            ...(audience === 'users' ? { userIds: [...selectedUserIds] } : {}),
            pinned,
            ...(pinExpiresAt() ? { pinExpiresAt: pinExpiresAt()! } : {}),
            pushEnabled,
        });
        sending = false;

        if (error || !sent) {
            toasts.error(getErrorMessage(error, m.admin_broadcast_send_failed()));
            return;
        }
        if (sent.failedCount > 0) {
            toasts.warning(
                m.admin_broadcast_sent_partial({
                    count: sent.recipientCount,
                    delivered: sent.deliveredCount,
                    failed: sent.failedCount,
                }),
            );
        } else {
            toasts.success(m.admin_broadcast_sent({ count: sent.recipientCount }));
        }
        resetForm();
        await refresh();
    }

    async function togglePin(broadcast: AdminBroadcast): Promise<void> {
        busyIds.add(broadcast.id);
        // Unpin sends no expiry — the server clears the whole pin block anyway,
        // and re-pinning is what refreshes `pinnedAt` and moves an announcement
        // back to the top of every recipient's pinned block.
        const { data: updated, error } = await setBroadcastPin(broadcast.id, {
            pinned: !broadcast.isPinned,
        });
        busyIds.delete(broadcast.id);

        if (error || !updated) {
            toasts.error(getErrorMessage(error, m.admin_broadcast_pin_failed()));
            return;
        }
        // Replace the one row in place rather than refetching the list: the
        // PATCH response is the updated row, so a second round trip would only
        // re-derive what we already hold.
        broadcasts = broadcasts.map((b) => (b.id === updated.id ? updated : b));
    }

    function requestDelete(broadcast: AdminBroadcast): void {
        modals.open(ConfirmModal, {
            title: m.admin_broadcast_delete_confirm_title(),
            body: m.admin_broadcast_delete_confirm_body({
                title: broadcast.title,
                count: broadcast.recipientCount,
            }),
            confirmText: m.admin_broadcast_delete_action(),
            confirmVariant: 'danger' as const,
            onConfirm: () => executeDelete(broadcast),
        });
    }

    async function executeDelete(broadcast: AdminBroadcast): Promise<void> {
        busyIds.add(broadcast.id);
        const { error } = await deleteBroadcast(broadcast.id);
        busyIds.delete(broadcast.id);

        if (error) {
            toasts.error(getErrorMessage(error, m.admin_broadcast_delete_failed()));
            return;
        }
        toasts.success(m.admin_broadcast_deleted());
        broadcasts = broadcasts.filter((b) => b.id !== broadcast.id);
    }

    function formatDate(iso: string): string {
        return new Date(iso).toLocaleString();
    }
</script>

<svelte:head>
    <title>{m.admin_broadcast_title()}</title>
</svelte:head>

<AdminPageHeader
    icon={adminPageIcons['/admin/notifications']}
    title={m.admin_broadcast_title()}
    description={m.admin_broadcast_description()} />

<div class="space-y-6">
    <div
        class="grid gap-2 sm:grid-cols-3"
        role="radiogroup"
        aria-label={m.admin_messages_kind_label()}>
        {#each KINDS as k (k.id)}
            <button
                type="button"
                role="radio"
                aria-checked={kind === k.id}
                class="flex items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-primary-400 {kind ===
                k.id
                    ? 'border-primary-500/60 bg-primary-500/10'
                    : 'border-surface-700 bg-surface-800/40 hover:border-surface-500'}"
                onclick={() => selectKind(k.id)}>
                <Icon
                    src={k.icon}
                    class="mt-0.5 h-5 w-5 shrink-0 {kind === k.id
                        ? 'text-primary-300'
                        : 'text-surface-400'}" />
                <span class="min-w-0">
                    <span class="block text-sm font-medium text-white">{k.title()}</span>
                    <span class="mt-0.5 block text-xs text-surface-400">{k.hint()}</span>
                </span>
            </button>
        {/each}
    </div>

    {#if kind === 'maintenance'}
        <MaintenanceNoticeCard embedded />
    {:else if kind === 'live'}
        <LiveMessageCard />
    {:else}
        <!-- Compose -->
        <section class="rounded-lg border border-surface-700 bg-surface-800/40 p-4">
            <h2 class="mb-3 text-sm font-semibold text-surface-100">
                {m.admin_broadcast_compose_heading()}
            </h2>

            <div class="space-y-3">
                <div>
                    <label for="broadcast-title" class="mb-1 block text-xs text-surface-300">
                        {m.admin_broadcast_field_title()}
                    </label>
                    <input
                        id="broadcast-title"
                        type="text"
                        bind:value={title}
                        maxlength="200"
                        disabled={sending}
                        class="w-full rounded border border-surface-600 bg-surface-900 px-2 py-1.5 text-sm text-surface-100 disabled:opacity-50" />
                </div>

                <div>
                    <label for="broadcast-body" class="mb-1 block text-xs text-surface-300">
                        {m.admin_broadcast_field_body()}
                    </label>
                    <textarea
                        id="broadcast-body"
                        bind:value={body}
                        rows="3"
                        maxlength="2000"
                        disabled={sending}
                        placeholder={m.admin_broadcast_field_body_placeholder()}
                        class="w-full rounded border border-surface-600 bg-surface-900 px-2 py-1.5 text-sm text-surface-100 placeholder:text-surface-500 disabled:opacity-50"
                    ></textarea>
                </div>

                <!-- Always visible, unlike the pin-expiry select next to the pin
                 checkbox: that one is meaningless without its checkbox, whereas
                 a link is independent of every other option here and hiding it
                 behind a toggle would be one click to discover a field that is
                 already optional. -->
                <div>
                    <label for="broadcast-link-url" class="mb-1 block text-xs text-surface-300">
                        {m.admin_broadcast_field_link_url()}
                    </label>
                    <input
                        id="broadcast-link-url"
                        type="url"
                        bind:value={linkUrl}
                        maxlength="2048"
                        disabled={sending}
                        placeholder={m.admin_broadcast_field_link_url_placeholder()}
                        class="w-full rounded border border-surface-600 bg-surface-900 px-2 py-1.5 text-sm text-surface-100 placeholder:text-surface-500 disabled:opacity-50" />
                    <p class="mt-1 text-xs text-surface-500">
                        {m.admin_broadcast_field_link_url_hint()}
                    </p>
                </div>

                <fieldset>
                    <legend class="mb-1 text-xs text-surface-300">
                        {m.admin_broadcast_audience()}
                    </legend>
                    <div class="flex flex-wrap gap-4">
                        <label
                            class="flex cursor-pointer items-center gap-1.5 text-sm text-surface-200">
                            <input
                                type="radio"
                                value="all"
                                bind:group={audience}
                                disabled={sending}
                                class="h-3.5 w-3.5 border-surface-500 bg-surface-900 text-primary-500" />
                            {m.admin_broadcast_audience_all()}
                        </label>
                        <label
                            class="flex cursor-pointer items-center gap-1.5 text-sm text-surface-200">
                            <input
                                type="radio"
                                value="users"
                                bind:group={audience}
                                disabled={sending}
                                class="h-3.5 w-3.5 border-surface-500 bg-surface-900 text-primary-500" />
                            {m.admin_broadcast_audience_users()}
                        </label>
                    </div>
                </fieldset>

                {#if audience === 'users'}
                    <UserMultiSelect {users} selected={selectedUserIds} disabled={sending} />
                {/if}

                <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <label
                        class="flex cursor-pointer items-center gap-1.5 text-sm text-surface-200">
                        <input
                            type="checkbox"
                            bind:checked={pinned}
                            disabled={sending}
                            class="h-3.5 w-3.5 rounded border-surface-500 bg-surface-900 text-primary-500" />
                        {m.admin_broadcast_pin()}
                    </label>

                    <label class="flex items-center gap-1.5 text-sm text-surface-200">
                        <span class="text-xs text-surface-400">
                            {m.admin_broadcast_pin_expiry()}
                        </span>
                        <select
                            bind:value={pinDurationHours}
                            disabled={sending || !pinned}
                            class="rounded border border-surface-600 bg-surface-900 px-2 py-1 text-sm text-surface-100 disabled:opacity-50">
                            <option value={0}>{m.admin_broadcast_pin_expiry_never()}</option>
                            <option value={24}>{m.admin_broadcast_pin_expiry_24h()}</option>
                            <option value={24 * 7}>{m.admin_broadcast_pin_expiry_7d()}</option>
                            <option value={24 * 30}>{m.admin_broadcast_pin_expiry_30d()}</option>
                        </select>
                    </label>

                    <label
                        class="flex cursor-pointer items-center gap-1.5 text-sm text-surface-200">
                        <input
                            type="checkbox"
                            bind:checked={pushEnabled}
                            disabled={sending}
                            class="h-3.5 w-3.5 rounded border-surface-500 bg-surface-900 text-primary-500" />
                        {m.admin_broadcast_push()}
                    </label>
                </div>

                <p class="text-xs text-surface-500">{m.admin_broadcast_push_hint()}</p>

                <div>
                    <button
                        type="button"
                        class="rounded bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-500 disabled:opacity-50"
                        disabled={!canSend}
                        onclick={send}>
                        {sending ? m.admin_broadcast_sending() : m.admin_broadcast_send()}
                    </button>
                </div>
            </div>
        </section>

        <!-- Recent -->
        <section class="rounded-lg border border-surface-700 bg-surface-800/40 p-4">
            <div class="mb-3 flex items-center justify-between">
                <h2 class="text-sm font-semibold text-surface-100">
                    {m.admin_broadcast_recent_heading()}
                </h2>
                <button
                    type="button"
                    class="flex items-center gap-1 rounded px-2 py-1 text-xs text-surface-400 hover:text-surface-200 disabled:opacity-50"
                    disabled={refreshing}
                    onclick={refresh}>
                    <Icon src={ArrowPath} class="h-3.5 w-3.5 {refreshing ? 'animate-spin' : ''}" />
                    {m.btn_refresh()}
                </button>
            </div>

            {#if broadcasts.length === 0}
                <p class="py-6 text-center text-sm text-surface-500">{m.admin_broadcast_empty()}</p>
            {:else}
                <div class="overflow-x-auto">
                    <table class="w-full min-w-[720px] text-left text-sm">
                        <thead class="text-xs text-surface-400">
                            <tr class="border-b border-surface-700">
                                <th class="py-2 pr-3 font-medium"
                                    >{m.admin_broadcast_col_title()}</th>
                                <th class="py-2 pr-3 font-medium"
                                    >{m.admin_broadcast_col_audience()}</th>
                                <th class="py-2 pr-3 font-medium">
                                    {m.admin_broadcast_col_recipients()}
                                </th>
                                <th class="py-2 pr-3 font-medium"
                                    >{m.admin_broadcast_col_pinned()}</th>
                                <th class="py-2 pr-3 font-medium"
                                    >{m.admin_broadcast_col_sent()}</th>
                                <th class="py-2 font-medium">{m.admin_broadcast_col_actions()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each broadcasts as broadcast (broadcast.id)}
                                <tr class="border-b border-surface-800">
                                    <td class="max-w-[18rem] py-2 pr-3">
                                        <p class="truncate text-surface-100">{broadcast.title}</p>
                                        {#if broadcast.body}
                                            <p class="truncate text-xs text-surface-500">
                                                {broadcast.body}
                                            </p>
                                        {/if}
                                    </td>
                                    <td class="py-2 pr-3 text-surface-300">
                                        {broadcast.audience === 'all'
                                            ? m.admin_broadcast_audience_all()
                                            : m.admin_broadcast_audience_users()}
                                    </td>
                                    <td class="py-2 pr-3 text-surface-300">
                                        {broadcast.recipientCount}
                                    </td>
                                    <td class="py-2 pr-3">
                                        {#if broadcast.isPinned}
                                            <span
                                                class="inline-flex items-center gap-1 text-xs text-primary-400">
                                                <Icon src={MapPin} class="h-3 w-3" />
                                                {m.admin_broadcast_pinned_yes()}
                                            </span>
                                            {#if broadcast.pinExpiresAt}
                                                <span class="block text-[11px] text-surface-500">
                                                    {formatDate(broadcast.pinExpiresAt)}
                                                </span>
                                            {/if}
                                        {:else}
                                            <span class="text-xs text-surface-600">—</span>
                                        {/if}
                                    </td>
                                    <td class="py-2 pr-3 text-xs text-surface-400">
                                        <span class="block">{formatDate(broadcast.createdAt)}</span>
                                        <span class="block text-surface-500"
                                            >{broadcast.createdBy}</span>
                                    </td>
                                    <td class="py-2">
                                        <div class="flex items-center gap-1">
                                            <button
                                                type="button"
                                                class="rounded px-2 py-1 text-xs text-primary-400 hover:text-primary-300 disabled:opacity-50"
                                                disabled={busyIds.has(broadcast.id)}
                                                onclick={() => togglePin(broadcast)}>
                                                {broadcast.isPinned
                                                    ? m.admin_broadcast_unpin_action()
                                                    : m.admin_broadcast_pin_action()}
                                            </button>
                                            <button
                                                type="button"
                                                class="rounded p-1 text-surface-500 hover:bg-surface-700/60 hover:text-red-400 disabled:opacity-50"
                                                disabled={busyIds.has(broadcast.id)}
                                                aria-label={m.admin_broadcast_delete_action()}
                                                title={m.admin_broadcast_delete_action()}
                                                onclick={() => requestDelete(broadcast)}>
                                                <Icon src={Trash} class="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}
        </section>
    {/if}
</div>
