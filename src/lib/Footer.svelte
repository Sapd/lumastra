<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Footer BAR only: admin-configurable FOOTER_LINKS action buttons (incl. the
  Quick Connect special button). The account avatar/menu now lives in the hero
  nav row (see +page.svelte "Konto" button); user settings live in the slimmed
  UserMenuPopover it opens and in /settings.
-->
<script lang="ts">
    import { page } from '$app/stores';
    import { env } from '$env/dynamic/public';
    import { popup, type PopupSettings } from '$lib/utils/popup';
    import { bodyPortal } from '$lib/utils/body-portal';
    import { Z } from '$lib/utils/z-index';
    import { resolve } from '$lib/paths';
    import { toasts } from '$lib/stores/toast.store';
    import * as userApi from '$lib/api/user';
    import * as m from '$lib/paraglide/messages';
    import { Icon, CommandLine } from 'svelte-hero-icons';
    import type { FooterLink } from '../routes/+layout.server';

    // Footer links are admin-configured ONLY (FOOTER_LINKS) — empty by default.
    // A fresh install shows no footer unless an operator adds links; the
    // SHOW_FOOTER toggle can hide the bar regardless. Request / Wiki / Chat /
    // Quick Connect are no longer auto-generated from env — add them via
    // FOOTER_LINKS if wanted (Quick Connect via a link with id 'quickconnect').
    const activeFooterLinks = $derived(($page.data?.footerLinks as FooterLink[] | undefined) || []);
    const hasQuickConnectLink = $derived(activeFooterLinks.some((l) => l.id === 'quickconnect'));

    // --- popups ---
    const popupJellyfin: PopupSettings = {
        event: 'click',
        target: 'popupJellyfin',
        placement: 'top',
    };

    // --- quick connect ---
    interface QuickConnectResponse {
        result: number;
    }
    let code = $state('');
    function quickConnectNotification(success: boolean): void {
        if (success) {
            toasts.success(m.footer_quick_connect_success());
        } else {
            toasts.error(m.footer_quick_connect_error());
        }
        code = '';
    }
    async function handleQuickConnect(event: Event): Promise<void> {
        event.preventDefault();
        try {
            const { data, error } = await userApi.quickConnect({ code });
            if (!error && data) {
                const result = data as unknown as QuickConnectResponse;
                if (result?.result === 0) {
                    quickConnectNotification(true);
                } else {
                    quickConnectNotification(false);
                }
            } else {
                quickConnectNotification(false);
            }
        } catch (err) {
            console.error('Error submitting Quick Connect code:', err);
            quickConnectNotification(false);
        }
    }
</script>

<!-- Slim, muted text-link bar (dot-separated) — reads as a real page footer
     rather than a row of loud action buttons. Content is still admin-configurable
     via FOOTER_LINKS, and the whole bar can be hidden with the SHOW_FOOTER toggle. -->
<nav class="footer-links" aria-label="Footer">
    {#each activeFooterLinks as link, i (link.id)}
        {#if i > 0}
            <span class="footer-sep" aria-hidden="true">·</span>
        {/if}
        {#if link.id === 'quickconnect'}
            <button type="button" use:popup={popupJellyfin} class="footer-link">
                {link.label}
            </button>
        {:else if link.url}
            <a
                href={resolve(link.url)}
                class="footer-link"
                target={link.external !== false ? '_blank' : undefined}
                rel={link.external !== false ? 'noopener noreferrer' : undefined}>
                {link.label}
            </a>
        {/if}
    {/each}
</nav>

{#if hasQuickConnectLink}
    <div
        use:bodyPortal
        class="card p-4 variant-filled-surface w-80 shadow-xl"
        style="z-index: {Z.NAV_POPUP}"
        data-popup="popupJellyfin">
        <div class="flex flex-wrap">
            <p class="mb-2">
                {m.footer_quick_connect_instructions()}<br />
                <code class="code">{env.PUBLIC_JELLYFINURL}</code><br />
                {m.footer_quick_connect_https_note()}<br /><br />
                {m.footer_quick_connect_code_instructions()}
            </p>
            <form onsubmit={handleQuickConnect}>
                <input
                    class="input"
                    name="quickConnectCode"
                    bind:value={code}
                    placeholder={m.footer_quick_connect_placeholder()} />
                <button type="submit" class="btn variant-soft-primary mt-2">
                    <span>
                        <Icon src={CommandLine} class="w-6 h-6" />
                    </span>
                    <span>{m.footer_submit()}</span>
                </button>
            </form>
            <div class="arrow variant-filled-primary"></div>
        </div>
    </div>
{/if}

<style>
    .footer-links {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.35rem 0.6rem;
        font-size: 0.8125rem;
    }

    /* Quiet text links — buttons and anchors share one understated look. */
    .footer-link {
        appearance: none;
        background: none;
        border: none;
        padding: 0;
        margin: 0;
        font: inherit;
        line-height: 1.2;
        color: var(--color-surface-400, #7180a8);
        text-decoration: none;
        cursor: pointer;
        transition: color 0.15s ease;
    }
    .footer-link:hover {
        color: var(--color-surface-200, #c0c9e0);
        text-decoration: underline;
        text-underline-offset: 2px;
    }
    .footer-link:focus-visible {
        outline: 2px solid #7c86ff;
        outline-offset: 2px;
        border-radius: 2px;
    }

    .footer-sep {
        color: var(--color-surface-600, #3c4971);
        user-select: none;
    }

    @media (prefers-reduced-motion: reduce) {
        .footer-link {
            transition: none;
        }
    }
</style>
