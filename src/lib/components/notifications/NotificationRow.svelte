<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  A single durable-inbox row (`docs/architecture/user-events.md`, "Build — the
  in-app inbox").

  Renders the server's `display` envelope and routes the server's structured
  `link`. It reads `payload` for NOTHING — that is the point: a `kind` this
  build has never heard of renders correctly anyway, because the server rendered
  it. The only per-kind knowledge left here is the fallback GLYPH, which is
  cosmetic and degrades to a neutral bell.

  Interaction: clicking the row (when `link` gave it somewhere to go) marks it
  read AND navigates — mirroring AttentionItemRow's "Details" affordance. A
  `target: 'url'` link (an administrator's announcement pointing at a web
  address) is the exception: it is not a route, so it renders as a plain
  external anchor into a new tab and leaves the drawer open. Two
  small icon actions sit beside it: an explicit "mark read" (hidden once already
  read) and "dismiss", matching AttentionItemRow's ack/copy icon-button
  treatment rather than admin's earlier RecentlyAddedRow, which offers no
  per-row action at all — a durable row needs both.
-->

<script lang="ts">
    import {
        Icon,
        Check,
        Trash,
        Film,
        ArrowDownTray,
        Bell,
        Megaphone,
        MapPin,
    } from 'svelte-hero-icons';
    import type { IconSource } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { formatRelativeTime } from '$lib/utils/time-formatting';
    import {
        externalUrlFromLink,
        hrefFromLink,
        type InboxNotificationItem,
    } from '$lib/stores/notification-inbox.js';

    interface Props {
        item: InboxNotificationItem;
        onMarkRead: (id: string) => void;
        onRemove: (id: string) => void;
        /** Close the drawer before navigating — mirrors AttentionItemRow's `navigate()`. */
        onNavigate: () => void;
    }

    let { item, onMarkRead, onRemove, onNavigate }: Props = $props();

    const isUnread = $derived(item.readAt === null);
    const timeLabel = $derived(formatRelativeTime(item.createdAt));
    const href = $derived(hrefFromLink(item.link));
    // An administrator's announcement can point at an ordinary web address.
    // That is NOT a route: it never goes through `resolve()` or the client
    // router, and it renders as its own anchor below.
    const externalHref = $derived(externalUrlFromLink(item.link));

    // `pinnedAt` present === pinned by an administrator, right now. The server
    // drops the field the moment a pin lapses, so this needs no expiry logic of
    // its own — and must not grow any, or a client clock skewed by a few minutes
    // would disagree with the server about what is pinned.
    const isPinned = $derived(item.pinnedAt !== undefined);

    // `display.imageUrl` is best-effort — the image route serves a placeholder
    // for an item with no artwork, and the URL can still 404 — so a single
    // `onerror` drops to the per-kind glyph below. Reset when the row identity
    // changes, since Svelte reuses this component across items in a keyed list
    // and a stale flag would blank a perfectly good image.
    let imageFailed = $state(false);
    let imageFailedFor = $state<string | null>(null);
    $effect(() => {
        if (imageFailedFor !== item.id) {
            imageFailedFor = item.id;
            imageFailed = false;
        }
    });
    const imageSrc = $derived(imageFailed ? undefined : item.display.imageUrl);

    // Fallback glyph when no image candidate loaded — kept per-kind rather
    // than one generic icon so the row is still scannable at a glance, and
    // falls back to a neutral bell for a kind this build doesn't recognize.
    const kindIcon: IconSource = $derived(
        item.kind === 'library.new_episode'
            ? Film
            : item.kind === 'request.available'
              ? ArrowDownTray
              : item.kind === 'admin.broadcast'
                ? Megaphone
                : Bell,
    );

    // Only the anchor branch (a real deep link) closes the drawer via
    // onNavigate — a row the server marked non-navigable (an unrecognized
    // future kind) should still let the click mark it read without yanking the
    // drawer shut on a tap that went nowhere.
    function handleAnchorClick(): void {
        if (isUnread) onMarkRead(item.id);
        onNavigate();
    }

    function handleButtonClick(): void {
        if (isUnread) onMarkRead(item.id);
    }

    // An external link opens in a NEW tab, so this one deliberately does not
    // call `onNavigate()`: the drawer belongs to the page the user is still
    // looking at, and closing it would be a side effect of a navigation that
    // did not happen here.
    function handleExternalClick(): void {
        if (isUnread) onMarkRead(item.id);
    }
</script>

{#snippet content()}
    {#if imageSrc}
        <img
            src={imageSrc}
            alt=""
            loading="lazy"
            onerror={() => (imageFailed = true)}
            class="h-10 w-10 shrink-0 rounded object-cover bg-surface-700/60" />
    {:else}
        <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-700/60"
            aria-hidden="true">
            <Icon src={kindIcon} class="h-4 w-4 text-surface-400" />
        </div>
    {/if}
    <div class="min-w-0 flex-1">
        <p
            class="flex items-center gap-1 truncate text-[13px] {isUnread
                ? 'font-medium text-surface-100'
                : 'text-surface-300'}">
            {#if isUnread}<span class="sr-only">{m.notifications_unread_sr()} </span>{/if}
            {#if isPinned}
                <!-- Announced to assistive tech via the sr-only label rather
                     than a title attribute: the glyph also explains why the
                     dismiss button is missing, which is not information a
                     screen-reader user should have to hover to discover. -->
                <span class="sr-only">{m.notifications_pinned_sr()} </span>
                <Icon src={MapPin} class="h-3 w-3 shrink-0 text-primary-400" aria-hidden="true" />
            {/if}
            <span class="truncate">{item.display.title}</span>
        </p>
        {#if item.display.body}
            <p class="truncate text-xs text-surface-400">{item.display.body}</p>
        {/if}
        <p class="text-[11px] text-surface-500">{timeLabel}</p>
    </div>
{/snippet}

<div class="relative flex items-center gap-1 rounded {isUnread ? 'bg-surface-700/30' : ''}">
    {#if isUnread}
        <span
            class="absolute left-0.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-primary-500"
            aria-hidden="true"></span>
    {/if}
    {#if externalHref}
        <!-- A real anchor to somewhere outside this app, NOT a routed link:
             no `resolve()` (which would mangle an absolute URL) and no client
             navigation. `rel="noopener noreferrer"` is mandatory rather than
             stylistic — without `noopener` the opened page can steer this tab
             via `window.opener` (reverse tabnabbing), and the destination is
             whatever an operator typed. -->
        <a
            href={externalHref}
            target="_blank"
            rel="noopener noreferrer"
            class="flex min-w-0 flex-1 items-center gap-2.5 rounded px-2 py-1.5 pl-3.5 text-left no-underline hover:bg-surface-700/50"
            onclick={handleExternalClick}>
            {@render content()}
        </a>
    {:else if href}
        <a
            href={resolve(href)}
            class="flex min-w-0 flex-1 items-center gap-2.5 rounded px-2 py-1.5 pl-3.5 text-left no-underline hover:bg-surface-700/50"
            onclick={handleAnchorClick}>
            {@render content()}
        </a>
    {:else}
        <button
            type="button"
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 pl-3.5 text-left hover:bg-surface-700/50"
            onclick={handleButtonClick}>
            {@render content()}
        </button>
    {/if}
    <div class="flex shrink-0 items-center gap-0.5 pr-1">
        {#if isUnread}
            <button
                type="button"
                class="rounded p-1 text-surface-500 hover:bg-surface-700/60 hover:text-surface-200"
                aria-label={m.notifications_mark_read()}
                title={m.notifications_mark_read()}
                onclick={() => onMarkRead(item.id)}>
                <Icon src={Check} class="h-3.5 w-3.5" />
            </button>
        {/if}
        <!-- No dismiss control on a pinned row. The server refuses the DELETE
             with a 409 while the pin holds, so offering the button would mean
             showing an action that can only fail. Mark-read above stays
             available and is the intended interaction: it clears the badge
             while the announcement stays put. The row becomes dismissible on
             its own once an admin unpins it or the pin's expiry passes. -->
        {#if !isPinned}
            <button
                type="button"
                class="rounded p-1 text-surface-500 hover:bg-surface-700/60 hover:text-surface-200"
                aria-label={m.notifications_dismiss()}
                title={m.notifications_dismiss()}
                onclick={() => onRemove(item.id)}>
                <Icon src={Trash} class="h-3.5 w-3.5" />
            </button>
        {/if}
    </div>
</div>
