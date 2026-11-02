<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Mounts one plugin-authored ESM module into a host-owned element.

  Surface-agnostic on purpose: the home grid, the below-hero banner and every
  later surface pass their own `context` and let this component own the
  mechanics (import, mount, cleanup, failure, space reservation). A surface
  that needs to remount when its subject changes wraps this in `{#key …}` —
  keying is the caller's one-liner, not logic in here.
-->
<script lang="ts">
    import { browser } from '$app/environment';
    import { untrack } from 'svelte';
    import { mountPluginWidget } from './plugin-widget-mount.js';
    import { readPluginTheme } from './plugin-theme-tokens.js';
    import { getLocale } from '$lib/paraglide/runtime.js';

    interface WidgetMeta {
        featureId: string;
        id: string;
        title: string;
        entry: string;
    }

    interface Props {
        widget: WidgetMeta;
        /**
         * The viewer, in the SDK's `PluginUser` shape. Built once in the root
         * layout load — `userId` is the stable key a plugin stores against,
         * `username` is a mutable display handle.
         */
        user: { userId: string; username: string; groups: string[]; isAdmin: boolean } | null;
        /**
         * Reserved space while the plugin's module is being dynamically
         * import()ed and mounted — avoids a zero-height pop-in that shoves
         * whatever is below it. Released once `mount()` settles: an empty
         * host (the plugin rendered nothing into it) then naturally collapses
         * to 0, since nothing is left to hold the space open.
         */
        minHeight?: string;
        /**
         * Extra fields merged into what `mount()` receives — the surface's own
         * contribution (`surface`, and for a detail slot the item in view).
         * Host-owned keys (`apiBase`, `theme`, `user`) always win.
         */
        context?: Record<string, unknown>;
        /**
         * Render the app's standard card frame around the mount host, with the
         * widget title as its header. The cheapest way third-party UI reads as
         * native: whatever the plugin does inside, its outermost frame is ours.
         */
        chrome?: boolean;
    }

    let { widget, user, minHeight = '160px', context, chrome = false }: Props = $props();
    let host = $state<HTMLDivElement>();
    // False until the dynamic import + mount() call settles (success or
    // failure) — see the reservation comment on the `minHeight` prop above.
    let mounted = $state(false);
    let failed = $state(false);

    /**
     * How long to hold the reserved space for a module that never settles.
     *
     * `.finally()` covers resolve and reject, but not "never". A plugin served
     * from a hung endpoint would otherwise hold its gap open forever — merely
     * ugly on the home grid, unacceptable on any surface where that gap sits
     * between the viewer and something they need.
     */
    const MOUNT_TIMEOUT_MS = 15_000;

    /**
     * The identity of the thing to mount, as VALUES rather than as the `widget`
     * object.
     *
     * Callers pass `widget={{ … }}` inline, so the object is rebuilt on every
     * parent re-render — and the home page re-renders on every tab refocus
     * (`invalidate('app:watch-state')` on visibilitychange/focus/pageshow).
     * Reading `widget.entry` inside the effect would therefore tear down and
     * remount every plugin widget each time the viewer came back to the tab,
     * destroying whatever state the widget held. A derived whose value is
     * referentially identical does not propagate, so depending on these strings
     * means the effect re-runs only when the widget genuinely changes.
     */
    const featureId = $derived(widget.featureId);
    const entry = $derived(widget.entry);
    const label = $derived(widget.id);

    $effect(() => {
        if (!browser || !host) return;
        const el = host;
        const apiBase = `/api/plugins/${featureId}`;
        const url = `${apiBase}${entry}`;
        const widgetLabel = label;

        // A re-run means a genuinely different widget, so the previous one's
        // verdict must not leak onto it — a stuck `failed` would leave the new
        // widget's chrome hidden forever.
        mounted = false;
        failed = false;

        return mountPluginWidget({
            el,
            label: widgetLabel,
            timeoutMs: MOUNT_TIMEOUT_MS,
            load: () => import(/* @vite-ignore */ url),
            // `context`, `user` and the theme are INPUTS to the mount, not
            // reasons to remount, so they are read untracked — `context` is
            // another inline object literal and would otherwise reintroduce the
            // remount-on-refocus this derived pair exists to stop.
            ctx: () =>
                untrack(() => ({
                    ...(context ?? {}),
                    apiBase,
                    theme: readPluginTheme(),
                    user,
                    // The viewer's current UI language ('en' | 'de'), for a
                    // plugin that wants to localize its own strings — a host
                    // key like the others above, so a plugin cannot override it.
                    locale: getLocale(),
                })),
            onSettle: (didFail) => {
                mounted = true;
                if (didFail) failed = true;
            },
        });
    });
</script>

{#if chrome}
    <section class="lum-chrome" class:lum-chrome-failed={failed}>
        <h3 class="lum-chrome-title">{widget.title}</h3>
        <div
            bind:this={host}
            class="plugin-widget"
            data-widget-id={widget.id}
            style:min-height={mounted ? undefined : minHeight}>
        </div>
    </section>
{:else}
    <div
        bind:this={host}
        class="plugin-widget"
        data-widget-id={widget.id}
        style:min-height={mounted ? undefined : minHeight}>
    </div>
{/if}

<style>
    .plugin-widget {
        transition: min-height 0.2s ease;
    }

    .lum-chrome {
        background: var(--color-surface-900);
        border: 1px solid var(--color-surface-700);
        border-radius: var(--lum-radius-card);
        padding: 1rem;
    }

    /* A widget that never mounted leaves an empty titled frame. Collapse it
       rather than showing the viewer a heading over nothing. */
    .lum-chrome-failed {
        display: none;
    }

    .lum-chrome-title {
        font-family: var(--lum-font-heading);
        font-size: 1rem;
        font-weight: 600;
        color: var(--text);
        margin: 0 0 0.75rem;
    }

    @media (prefers-reduced-motion: reduce) {
        .plugin-widget {
            transition: none;
        }
    }
</style>
