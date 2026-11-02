<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Regular-user notification bell — `docs/architecture/user-events.md`, "Build
  — the in-app inbox". Reads unread count off the already-initialized
  `notificationInbox` store (init()'d once at the root layout, per that doc's
  "never per component" instruction — this component only toggles the
  drawer and renders the badge).

  Placement, and why it's a fixed corner button rather than inline in a
  header: admin/attention/NotificationBell.svelte sits inline in the admin
  shell's own header bar (`src/routes/admin/+layout.svelte`), but the regular
  app has no equivalent — `src/app.html`'s `.navbar` is a static, brandable
  logo bar with no icon slot, and Sidebar.svelte is a left icon DOCK, not a
  top bar. So this mirrors RequestNotificationWidget.svelte's solution to the
  identical problem: a self-positioned fixed overlay, mounted once at the
  layout root. Top-right rather than RequestNotificationWidget's bottom-right
  so the two never fight for the same corner. On < 768px the mobile sidebar
  toggle (Sidebar.svelte's `.mobile-toggle`) defaults to that same corner
  (draggable, so not a fixed collision, but worth clearing at rest) — the
  media query below drops the bell a further ~3.25rem so the two sit stacked
  rather than overlapping by default.
-->

<script lang="ts">
    import { Icon, Bell, Inbox } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { notificationInbox } from '$lib/stores/notification-inbox.js';
    import {
        notificationDrawerOpen,
        toggleNotificationDrawer,
    } from '$lib/stores/notification-drawer.js';

    interface Props {
        /**
         * Render in the flow of a host header (the admin shell's bar) instead of
         * as the fixed top-right overlay. The admin shell hides app.html's global
         * bar and has a header to sit in, so there it's inline.
         */
        inline?: boolean;
    }
    let { inline = false }: Props = $props();

    const unread = $derived($notificationInbox.unreadCount);
    const displayUnread = $derived(unread > 9 ? '9+' : String(unread));
    const bellAriaLabel = $derived(
        unread > 0 ? `${m.notifications_bell_label()} — ${unread}` : m.notifications_bell_label(),
    );
</script>

<div class="bell-anchor" class:bell-inline={inline}>
    <button
        type="button"
        class="bell-button"
        aria-label={bellAriaLabel}
        aria-haspopup="dialog"
        aria-expanded={$notificationDrawerOpen}
        onclick={toggleNotificationDrawer}>
        <!-- Inline in the admin header it sits beside the admin Alerts bell; a
             different glyph keeps "my notifications" and "server alerts" apart. -->
        <Icon src={inline ? Inbox : Bell} class="h-4 w-4" />
        {#if unread > 0}
            <span
                class="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-500 px-1 text-center text-[10px] leading-4 text-white"
                aria-hidden="true">{displayUnread}</span>
        {/if}
    </button>
</div>

<style>
    .bell-anchor {
        position: fixed;
        top: calc(1rem + env(safe-area-inset-top, 0px));
        right: 1rem;
        z-index: 500; /* Z.NAVBAR */
    }

    .bell-button {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2.25rem;
        height: 2.25rem;
        border-radius: 9999px;
        color: rgba(255, 255, 255, 0.85);
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        transition: all 0.15s ease;
    }

    .bell-button:hover {
        color: white;
        background: rgba(0, 0, 0, 0.65);
    }

    .bell-anchor.bell-inline {
        position: static;
    }
    .bell-inline .bell-button {
        width: 2rem;
        height: 2rem;
        border-radius: 0.375rem;
        color: rgb(148 163 184);
        background: transparent;
        border: none;
        box-shadow: none;
        backdrop-filter: none;
    }
    .bell-inline .bell-button:hover {
        color: rgb(226 232 240);
        background: rgb(51 65 85);
    }

    /*
     * DESKTOP ONLY. On mobile the notification entry point folds into the dock
     * instead — the unread badge rides Sidebar.svelte's draggable `.mobile-toggle`
     * and the drawer opens from inside the dock.
     *
     * This used to render here too, nudged down 4.25rem to "clear the toggle's
     * default resting spot". That was only ever right in the default case: the
     * toggle persists to `dock-trigger-position` and can be dragged to either
     * edge at any height, so dragging it LEFT left a dead 4.25rem gap in this
     * corner for nothing, and dragging it DOWN the right edge put it straight
     * on top of the bell — the toggle's own clamp (`triggerTopBounds`) knows
     * nothing about this element. Two independently-positioned fixed overlays
     * in one corner, one of them movable, cannot be kept apart by a constant.
     */
    @media (max-width: 767px) {
        .bell-anchor:not(.bell-inline) {
            display: none;
        }
    }
</style>
