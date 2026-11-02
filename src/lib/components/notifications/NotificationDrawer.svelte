<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  The durable notification inbox drawer — `docs/architecture/user-events.md`,
  "Build — the in-app inbox". Reads `$lib/stores/notification-inbox.ts`
  directly (a singleton store; no prop-drilling needed) rather than threading
  items down from NotificationBell the way the admin
  attention/NotificationDrawer.svelte does from adminStatus — that one is fed
  by a single polled snapshot shared with two OTHER admin surfaces (Home,
  Health), which is why it takes everything as props. This inbox has no
  sibling surface, so importing the store here is the simpler equivalent, not
  a departure from the pattern.

  Mechanics deliberately mirror admin/attention/NotificationDrawer.svelte:
  backdrop + panel pair on the same Z.MODAL / Z.MODAL+1 tier, body/html
  scroll-lock while open, `trapFocus` for focus containment, Escape closes,
  aria-modal dialog with an aria-label, and focus returns to the bell on
  close (handled by trapFocus itself, same as admin's).

  UX call, not an oversight: opening the drawer does NOT auto-mark everything
  read. The task brief allowed either "mark-read on open" or "mark-read per
  row"; auto-marking everything the instant the drawer opens (before the user
  has actually looked at a row) would clear the badge on a glance, which is
  the same complaint the admin attention system's explicit ack model exists
  to avoid. Per-row is the one consistent with that precedent, so read state
  only changes via a row click-through, its own "mark read" icon, or
  "mark all read" below.
-->

<script lang="ts">
    import { browser } from '$app/environment';
    import { fly, fade } from 'svelte/transition';
    import { flip } from 'svelte/animate';
    import { Icon, CheckCircle, Bell, BellSlash } from 'svelte-hero-icons';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { Z } from '$lib/utils/z-index';
    import * as m from '$lib/paraglide/messages.js';
    import { notificationInbox } from '$lib/stores/notification-inbox.js';
    import NotificationRow from './NotificationRow.svelte';
    import {
        getSeriesFollows,
        unfollowSeries as removeSeriesFollow,
    } from '$lib/api/notifications.js';

    interface Props {
        open: boolean;
        onclose: () => void;
    }

    let { open, onclose }: Props = $props();

    // Scroll lock + scrollbar compensation while open — same rationale and
    // implementation as admin/attention/NotificationDrawer.svelte: without
    // locking BOTH <body> and <html>, mobile's root scrolling element
    // (<html>) still scrolls behind the fixed drawer.
    let originalOverflow = '';
    let originalHtmlOverflow = '';
    let originalPaddingRight = '';
    $effect(() => {
        if (!browser) return;
        if (open) {
            originalOverflow = document.body.style.overflow;
            originalHtmlOverflow = document.documentElement.style.overflow;
            originalPaddingRight = document.body.style.paddingRight;

            const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

            document.body.style.overflow = 'hidden';
            document.documentElement.style.overflow = 'hidden';
            if (scrollbarWidth > 0) {
                document.body.style.paddingRight = `${scrollbarWidth}px`;
            }
        } else {
            document.body.style.overflow = originalOverflow;
            document.documentElement.style.overflow = originalHtmlOverflow;
            document.body.style.paddingRight = originalPaddingRight;
        }
    });

    // Rows go to NotificationRow as they came off the wire: the server already
    // rendered `display` and resolved `link`, so there is nothing to map.
    const items = $derived($notificationInbox.items);
    // Rendered in its own block ABOVE the scrolling list, not merged into it.
    // The server guarantees the two are disjoint (a pinned row is excluded from
    // `items` for as long as the pin holds), so this needs no de-duplication —
    // and it must not scroll away with the list, which is the whole point of a
    // pin. Same "section above the list" shape the followed-series block below
    // already uses.
    const pinned = $derived($notificationInbox.pinned);
    const unreadCount = $derived($notificationInbox.unreadCount);
    const loading = $derived($notificationInbox.loading);
    const error = $derived($notificationInbox.error);
    const hasMore = $derived($notificationInbox.hasMore);
    // First load with nothing yet known — distinguishes "loading" from "empty".
    const showSkeleton = $derived(loading && items.length === 0 && !error);
    let followedSeries = $state<Array<{ id: string; title: string }>>([]);
    let followedSeriesLoading = $state(false);

    $effect(() => {
        if (!open) return;
        void loadFollowedSeries();
    });

    async function loadFollowedSeries(): Promise<void> {
        followedSeriesLoading = true;
        const items: { id: string; title: string }[] = [];
        let offset = 0;
        while (true) {
            const { data } = await getSeriesFollows(100, offset);
            if (!data) break;
            items.push(...data.items);
            if (!data.page.hasMore) break;
            offset += data.page.limit;
        }
        followedSeries = items;
        followedSeriesLoading = false;
    }

    async function unfollowSeries(id: string): Promise<void> {
        const { error } = await removeSeriesFollow(id);
        if (!error) followedSeries = followedSeries.filter((series) => series.id !== id);
    }

    function handleDrawerKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.stopPropagation();
            onclose();
        }
    }

    function markRead(id: string): void {
        void notificationInbox.markRead(id);
    }

    function remove(id: string): void {
        void notificationInbox.remove(id);
    }

    function markAllRead(): void {
        void notificationInbox.markAllRead();
    }

    function loadMore(): void {
        void notificationInbox.loadMore();
    }
</script>

{#if open}
    <!-- Backdrop — Z.MODAL, same tier as admin's attention drawer, so it sits
         above the fixed navbar (Z.NAVBAR=500). -->
    <div
        class="fixed inset-0 bg-black/50"
        style="z-index: {Z.MODAL}"
        onclick={onclose}
        role="presentation"
        tabindex="-1"
        transition:fade={{ duration: 150 }}>
    </div>

    <!-- Drawer -->
    <div
        class="fixed right-0 top-0 bottom-0 flex w-[380px] max-w-[calc(100vw-1rem)] flex-col overflow-x-hidden border-l border-surface-700 bg-surface-800"
        style="z-index: {Z.MODAL + 1}"
        transition:fly={{ x: 380, duration: 200 }}
        role="dialog"
        aria-modal="true"
        aria-label={m.notifications_drawer_title()}
        tabindex="-1"
        use:trapFocus
        onkeydown={handleDrawerKeydown}>
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-surface-700 p-4">
            <h2 class="text-base font-semibold text-white">{m.notifications_drawer_title()}</h2>
            <div class="flex shrink-0 items-center gap-1">
                {#if unreadCount > 0}
                    <button
                        type="button"
                        class="rounded px-2 py-1 text-xs text-primary-400 hover:text-primary-300 hover:underline"
                        onclick={markAllRead}>
                        {m.notifications_mark_all_read()}
                    </button>
                {/if}
                <button
                    class="p-1 text-surface-400 hover:text-white"
                    onclick={onclose}
                    data-autofocus
                    aria-label={m.btn_close()}
                    title={m.btn_close()}>
                    ✕
                </button>
            </div>
        </div>

        <!-- Scrollable content -->
        <div class="flex-1 space-y-1 overflow-y-auto overflow-x-hidden p-3">
            {#if followedSeriesLoading || followedSeries.length > 0}
                <section
                    class="mb-3 rounded border border-surface-700 p-2.5"
                    aria-label={m.series_notifications_title()}>
                    <h3 class="mb-1.5 text-xs font-semibold text-surface-300">
                        {m.series_notifications_title()}
                    </h3>
                    {#if followedSeriesLoading}
                        <div class="h-7 animate-pulse rounded bg-surface-700/60"></div>
                    {:else}
                        {#each followedSeries as series (series.id)}
                            <div class="flex items-center justify-between gap-2 py-1">
                                <span class="truncate text-sm text-surface-200"
                                    >{series.title}</span>
                                <button
                                    type="button"
                                    class="shrink-0 rounded p-1 text-surface-400 hover:bg-surface-700 hover:text-surface-100"
                                    aria-label={m.series_notifications_unfollow({
                                        title: series.title,
                                    })}
                                    title={m.series_notifications_unfollow({ title: series.title })}
                                    onclick={() => unfollowSeries(series.id)}>
                                    <Icon src={BellSlash} class="h-4 w-4" />
                                </button>
                            </div>
                        {/each}
                    {/if}
                </section>
            {/if}
            {#if pinned.length > 0}
                <!-- Outside the skeleton/error/empty branch below on purpose: a
                     pinned announcement that has already loaded must keep
                     rendering while a later page or a failed refetch resolves.
                     It is also why the empty state checks BOTH lists — an inbox
                     holding only a pinned announcement is not "all clear". -->
                <section
                    class="mb-3 space-y-1 rounded border border-primary-700/40 bg-primary-950/20 p-2 pt-1.5"
                    aria-label={m.notifications_pinned_section()}>
                    <h3 class="px-1 text-xs font-semibold text-primary-300">
                        {m.notifications_pinned_section()}
                    </h3>
                    {#each pinned as item (item.id)}
                        <NotificationRow
                            {item}
                            onMarkRead={markRead}
                            onRemove={remove}
                            onNavigate={onclose} />
                    {/each}
                </section>
            {/if}
            {#if showSkeleton}
                <div class="space-y-2" aria-hidden="true">
                    <div class="h-12 animate-pulse rounded bg-surface-700/60"></div>
                    <div class="h-12 animate-pulse rounded bg-surface-700/60"></div>
                    <div class="h-12 animate-pulse rounded bg-surface-700/60"></div>
                </div>
                <p class="sr-only" role="status">{m.notifications_loading()}</p>
            {:else if error && items.length === 0}
                <!-- Distinguishable from the empty state: an outline bell, not the
                     green checkmark "all clear" uses — a fetch failure should never
                     read as "you have no notifications". -->
                <div class="flex flex-col items-center gap-2 px-4 py-10 text-center">
                    <Icon src={Bell} class="h-8 w-8 text-surface-600" />
                    <p class="text-sm text-surface-400">{m.notifications_error()}</p>
                </div>
            {:else if items.length === 0 && pinned.length === 0}
                <div class="flex flex-col items-center gap-2 px-4 py-10 text-center">
                    <Icon src={CheckCircle} class="h-8 w-8 text-green-600/70" />
                    <p class="text-sm text-surface-300">{m.notifications_empty_title()}</p>
                    <p class="text-xs text-surface-500">{m.notifications_empty_description()}</p>
                </div>
            {:else}
                {#each items as item (item.id)}
                    <div animate:flip={{ duration: 150 }}>
                        <NotificationRow
                            {item}
                            onMarkRead={markRead}
                            onRemove={remove}
                            onNavigate={onclose} />
                    </div>
                {/each}
                {#if hasMore}
                    <div class="pt-1 text-center">
                        <button
                            type="button"
                            class="rounded px-3 py-1.5 text-xs text-surface-400 hover:text-surface-200 disabled:opacity-50"
                            disabled={loading}
                            onclick={loadMore}>
                            {m.notifications_load_more()}
                        </button>
                    </div>
                {/if}
            {/if}
        </div>
    </div>
{/if}
