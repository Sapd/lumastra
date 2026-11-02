<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  "Get the app" hint for Safari on iPhone/iPad, pointing at the public
  TestFlight. Rules live in app-install-hint.ts. Decided in onMount — never
  during SSR — so the server HTML is identical for every device and nothing
  shifts on load: the card floats (position: fixed) above the bottom safe area
  and slides in after hydration.

  Temporary: once the app is on the App Store this is replaced by Apple's
  Smart App Banner — see IOS_APP in $lib/native-apps.ts.
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { Icon, XMark, DevicePhoneMobile } from 'svelte-hero-icons';
    import { IOS_APP } from '$lib/native-apps';
    import {
        dismissInstallHint,
        isInstallHintDismissed,
        readInstallHintEnv,
        shouldShowInstallHint,
    } from './app-install-hint';
    import * as m from '$lib/paraglide/messages.js';

    let { enabled }: { enabled: boolean } = $props();

    let eligible = $state(false);

    onMount(() => {
        eligible = shouldShowInstallHint(readInstallHintEnv(), true, isInstallHintDismissed());
    });

    let visible = $derived(enabled && eligible);

    function dismiss() {
        dismissInstallHint();
        eligible = false;
    }
</script>

{#if visible}
    <aside class="app-install-hint" aria-label={m.app_install_hint_label()}>
        <Icon src={DevicePhoneMobile} class="h-5 w-5 shrink-0 text-violet-300" />
        <p class="min-w-0 flex-1 text-[13px] leading-snug text-slate-200">
            {m.app_install_hint_text()}
        </p>
        <a
            class="shrink-0 rounded-full bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500"
            href={IOS_APP.testFlightUrl}
            target="_blank"
            rel="noopener noreferrer">
            {m.app_install_hint_cta()}
        </a>
        <button
            type="button"
            class="-mr-1 shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
            aria-label={m.app_install_hint_dismiss()}
            onclick={dismiss}>
            <Icon src={XMark} class="h-4 w-4" />
        </button>
    </aside>
{/if}

<style>
    .app-install-hint {
        position: fixed;
        /* Above the music bottom nav + mini-player when they are mounted
           (--music-bottom-stack is 0 otherwise), and above the home indicator. */
        bottom: calc(var(--music-bottom-stack, 0px) + env(safe-area-inset-bottom) + 0.75rem);
        left: calc(env(safe-area-inset-left) + 0.75rem);
        right: calc(env(safe-area-inset-right) + 0.75rem);
        margin-inline: auto;
        max-width: 32rem;
        z-index: 550; /* Z.NAV_POPUP — below MUSIC_BAR (600) and every modal/player tier */
        display: flex;
        align-items: center;
        gap: 0.625rem;
        padding: 0.625rem 0.75rem;
        border-radius: 1rem;
        border: 1px solid rgb(255 255 255 / 0.08);
        background: rgb(15 23 42 / 0.92);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        box-shadow: 0 10px 30px rgb(0 0 0 / 0.45);
        animation: app-install-hint-in 260ms ease-out both;
    }

    @keyframes app-install-hint-in {
        from {
            opacity: 0;
            transform: translateY(0.75rem);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .app-install-hint {
            animation: none;
        }
    }
</style>
