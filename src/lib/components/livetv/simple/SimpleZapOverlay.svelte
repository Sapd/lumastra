<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // Live TV simple mode on the player page: a big channel banner (number,
    // name, now/next) on start, on every zap and on any movement; large ▲ ▼
    // and "Channels" buttons; Up/Down/PageUp/PageDown zap like a TV, digits
    // tune a channel number. Lives OUTSIDE the player's {#key} so it survives
    // the remount of every zap. Renders nothing unless simple mode is on.
    import { onMount } from 'svelte';
    import { beforeNavigate, goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { getLiveTvChannels } from '$lib/api/playback.js';
    import { getSimpleMode } from '$lib/api/livetv-simple-mode.js';
    import type { LiveTvStation } from '$lib/schemas/livetv.js';
    import type { LiveTvSimpleMode } from '$lib/schemas/livetv-simple-mode.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import SimpleChannelDisc from './SimpleChannelDisc.svelte';
    import SimpleNowNext from './SimpleNowNext.svelte';
    import { SimpleGuide } from './simple-guide.svelte.js';
    import { liveTvSimpleContext } from './simple-context.svelte.js';
    import { DigitEntry, digitOf, isTypingTarget } from './digit-entry.svelte.js';
    import {
        buildSimpleLineup,
        findByNumber,
        stepChannel,
        writeLastWatched,
        type SimpleChannel,
    } from './simple-lineup.js';

    interface Props {
        currentChannelId: string;
        /** The persistent page wrapper; fullscreen moves to it before a zap. */
        pageEl?: HTMLElement | null;
        username?: string;
    }

    let { currentChannelId, pageEl, username }: Props = $props();

    const BANNER_MS = 6000;
    const ZAP_SETTLE_MS = 800;

    let mode = $state<LiveTvSimpleMode | undefined>();
    let channels = $state<LiveTvStation[]>([]);
    let lineup = $derived(mode ? buildSimpleLineup(mode.stationIds, channels) : []);
    let active = $derived(mode?.enabled === true && lineup.length > 0);

    const guide = new SimpleGuide();
    $effect(() => {
        if (active) return guide.start(lineup.map((c) => c.channel.id));
    });
    $effect(() => {
        if (active) return toasts.setCalm(true);
    });
    // The player's failure card reads this: plain wording, and "Next channel" zaps.
    $effect(() => {
        if (!active) return;
        liveTvSimpleContext.active = true;
        liveTvSimpleContext.zapNext = () => zap(1);
        return () => {
            liveTvSimpleContext.active = false;
            liveTvSimpleContext.zapNext = null;
        };
    });

    /** The channel the banner shows: the one being zapped to, else the playing one. */
    let pendingId = $state<string | undefined>();
    let shownId = $derived(pendingId ?? currentChannelId);
    let shown = $derived(lineup.find((c) => c.channel.id === shownId));
    let bannerVisible = $state(true);
    let listOpen = $state(false);
    let bannerTimer: ReturnType<typeof setTimeout> | undefined;
    let zapTimer: ReturnType<typeof setTimeout> | undefined;
    let listEls = $state<HTMLButtonElement[]>([]);
    let rootEl = $state<HTMLDivElement | undefined>();

    // The player may put its own container into fullscreen; the overlay then
    // moves into that element to stay visible, and back home before any
    // navigation (the container is destroyed by the remount).
    function followFullscreen(): void {
        if (!rootEl) return;
        const fs = document.fullscreenElement;
        const target = fs && fs.tagName !== 'VIDEO' ? fs : pageEl;
        if (target && rootEl.parentElement !== target) target.appendChild(rootEl);
    }
    function moveHome(): void {
        if (rootEl && pageEl && rootEl.parentElement !== pageEl) pageEl.appendChild(rootEl);
    }
    /**
     * The player's own container is destroyed by the remount; keep fullscreen
     * on the persistent wrapper (as the watch page does for next episodes).
     */
    function keepFullscreen(): void {
        const fs = document.fullscreenElement;
        if (!fs || !pageEl || fs === pageEl) return;
        moveHome();
        pageEl.requestFullscreen?.().catch(() => {
            try {
                sessionStorage.setItem('restoreFullscreen', 'true');
            } catch {
                // Storage blocked: the viewer can press fullscreen again.
            }
        });
    }
    beforeNavigate(moveHome);

    function showBanner(): void {
        bannerVisible = true;
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => {
            if (!listOpen && !entry.active) bannerVisible = false;
        }, BANNER_MS);
    }

    const entry = new DigitEntry(
        (num) => {
            const hit = findByNumber(lineup, num);
            if (hit) tune(hit, true);
            else showBanner();
        },
        () => lineup.length,
    );

    function zap(delta: number): void {
        const next = stepChannel(lineup, shownId, delta);
        if (next) tune(next, false);
    }

    /**
     * Rapid presses only move the banner; the stream changes once the viewer
     * stops pressing, so zapping through five channels starts one stream.
     */
    function tune(item: SimpleChannel, now: boolean): void {
        // Inside the key press or click: Safari only allows fullscreen there.
        keepFullscreen();
        pendingId = item.channel.id;
        showBanner();
        clearTimeout(zapTimer);
        zapTimer = setTimeout(() => void navigate(item), now ? 0 : ZAP_SETTLE_MS);
    }

    async function navigate(item: SimpleChannel): Promise<void> {
        if (item.channel.id === currentChannelId) {
            pendingId = undefined;
            return;
        }
        writeLastWatched(username, item.channel.id);
        moveHome();
        try {
            sessionStorage.setItem('continuePlayback', 'true');
        } catch {
            // Autoplay may then need a click; the banner still says where we are.
        }
        await goto(resolve(`/watch/${item.channel.id}`), { replaceState: true });
    }

    // The page navigated (our zap, or the player's own channel switcher).
    $effect(() => {
        void currentChannelId;
        pendingId = undefined;
        writeLastWatched(username, currentChannelId);
        showBanner();
    });

    function openList(): void {
        listOpen = true;
        bannerVisible = true;
        clearTimeout(bannerTimer);
        const index = Math.max(
            0,
            lineup.findIndex((c) => c.channel.id === currentChannelId),
        );
        queueMicrotask(() => listEls[index]?.focus());
    }

    function closeList(): void {
        listOpen = false;
        showBanner();
    }

    function home(): void {
        void goto(resolve('/livetv'));
    }

    // Capture phase: runs before the player's own keys (Up/Down = volume
    // there), which simple mode turns into channel keys.
    function onKeydown(e: KeyboardEvent): void {
        if (!active || isTypingTarget(e.target)) return;
        const target = e.target instanceof HTMLElement ? e.target : null;
        // The player's own menus and sliders keep every key.
        if (target?.closest('[role=menu], [role=listbox], [role=slider], [role=dialog]')) return;
        // Enter/Space on a focused button (ours or the player's) presses it.
        if (target?.closest('button, a, [role=button]') && (e.key === 'Enter' || e.key === ' '))
            return;
        if (listOpen) {
            if (e.key === 'Escape' || e.key === 'Backspace') {
                e.preventDefault();
                e.stopImmediatePropagation();
                closeList();
            }
            return;
        }
        const digit = digitOf(e);
        let handled = true;
        if (digit) entry.push(digit);
        else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'ChannelUp') zap(1);
        else if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'ChannelDown') zap(-1);
        else if (e.key === 'Enter' && entry.active) entry.commit();
        else if (e.key === 'Escape' && entry.active) entry.cancel();
        else if (e.key === 'Enter' || e.key === 'ContextMenu') openList();
        else handled = false;
        if (handled) {
            e.preventDefault();
            e.stopImmediatePropagation();
        } else {
            showBanner();
        }
    }

    function onListKeydown(e: KeyboardEvent, index: number): void {
        const n = lineup.length;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            listEls[(index + 1) % n]?.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            listEls[(index - 1 + n) % n]?.focus();
        }
    }

    onMount(() => {
        let cancelled = false;
        void (async () => {
            const modeResult = await getSimpleMode();
            if (cancelled || !modeResult.data?.enabled) return;
            const lineupResult = await getLiveTvChannels();
            if (cancelled) return;
            channels = lineupResult.data?.items ?? [];
            mode = modeResult.data;
            showBanner();
        })();
        window.addEventListener('keydown', onKeydown, { capture: true });
        const onMove = (): void => {
            if (active) showBanner();
        };
        window.addEventListener('pointermove', onMove, { passive: true });
        window.addEventListener('pointerdown', onMove, { passive: true });
        document.addEventListener('fullscreenchange', followFullscreen);
        // If the element the overlay moved into goes away without a navigation
        // (the player restarts after an error), bring the overlay back home.
        const orphanWatch = new MutationObserver(() => {
            if (rootEl && !rootEl.isConnected) {
                pageEl?.appendChild(rootEl);
            }
        });
        if (pageEl) orphanWatch.observe(pageEl, { childList: true, subtree: true });
        return () => {
            orphanWatch.disconnect();
            document.removeEventListener('fullscreenchange', followFullscreen);
            cancelled = true;
            clearTimeout(bannerTimer);
            clearTimeout(zapTimer);
            window.removeEventListener('keydown', onKeydown, { capture: true });
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerdown', onMove);
        };
    });
</script>

{#if active}
    <div class="overlay" class:xlarge={mode?.textSize === 'xlarge'} bind:this={rootEl}>
        {#if bannerVisible || listOpen}
            <div class="side" role="group" aria-label={m.livetv_simple_zap_group()}>
                <button
                    type="button"
                    class="zap"
                    onclick={() => zap(1)}
                    aria-label={m.livetv_simple_channel_up()}>▲</button>
                <button type="button" class="zap list-button" onclick={openList}
                    >☰<span>{m.livetv_simple_channels()}</span></button>
                <button
                    type="button"
                    class="zap"
                    onclick={() => zap(-1)}
                    aria-label={m.livetv_simple_channel_down()}>▼</button>
            </div>
        {/if}

        {#if (bannerVisible || entry.active) && shown && !listOpen}
            {@const info = guide.for(shown.channel)}
            <div class="banner" role="status" aria-live="polite">
                <span class="number">{shown.number}</span>
                <SimpleChannelDisc channel={shown.channel} size={5.5} />
                <div class="banner-text">
                    <span class="name">{shown.channel.name}</span>
                    <div class="info"><SimpleNowNext {info} now={guide.now} /></div>
                </div>
            </div>
        {/if}

        {#if entry.active}
            <div class="digits" role="status">{entry.digits}</div>
        {/if}

        {#if listOpen}
            <div
                class="list"
                role="dialog"
                aria-modal="true"
                aria-label={m.livetv_simple_channels()}>
                <div class="list-head">
                    <h2>{m.livetv_simple_channels()}</h2>
                    <button type="button" class="pill" onclick={closeList}
                        >{m.livetv_simple_back_to_tv()}</button>
                </div>
                <ul>
                    {#each lineup as item, i (item.channel.id)}
                        {@const info = guide.for(item.channel)}
                        <li>
                            <button
                                type="button"
                                class="row"
                                class:current={item.channel.id === currentChannelId}
                                bind:this={listEls[i]}
                                onkeydown={(e) => onListKeydown(e, i)}
                                onclick={() => {
                                    listOpen = false;
                                    tune(item, true);
                                }}>
                                <span class="number">{item.number}</span>
                                <SimpleChannelDisc channel={item.channel} />
                                <span class="row-text">
                                    <span class="name">{item.channel.name}</span>
                                    {#if info.now}<span class="row-now">{info.now.title}</span>{/if}
                                </span>
                            </button>
                        </li>
                    {/each}
                </ul>
                <button type="button" class="pill home" onclick={home}
                    >{m.livetv_simple_all_channels_home()}</button>
            </div>
        {/if}
    </div>
{/if}

<style>
    .overlay {
        --fs: 1.5rem;
        position: fixed;
        inset: 0;
        z-index: 60;
        pointer-events: none;
        color: #fff;
        font-size: var(--fs);
        line-height: 1.3;
    }
    .overlay.xlarge {
        --fs: 1.875rem;
    }
    .overlay button {
        pointer-events: auto;
        font: inherit;
        color: inherit;
        cursor: pointer;
    }
    button:focus-visible {
        outline: 6px solid #fde047;
        outline-offset: 4px;
    }
    .side {
        position: absolute;
        right: clamp(0.75rem, 2vw, 2rem);
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }
    .zap {
        width: 5.5rem;
        height: 5.5rem;
        border-radius: 1.25rem;
        background: rgb(0 0 0 / 0.8);
        border: 3px solid rgb(255 255 255 / 0.7);
        font-size: 2.2rem;
        font-weight: 800;
    }
    .list-button {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        font-size: 1.8rem;
    }
    .list-button span {
        font-size: 0.85rem;
        font-weight: 700;
    }
    .banner {
        position: absolute;
        left: clamp(0.75rem, 3vw, 3rem);
        right: clamp(7rem, 10vw, 10rem);
        /* Above the player's controls and its own now/next strip. */
        bottom: 13rem;
        display: flex;
        align-items: center;
        gap: 1.25rem;
        padding: 1.25rem 1.5rem;
        border-radius: 1.5rem;
        background: rgb(3 7 18 / 0.92);
        border: 3px solid rgb(255 255 255 / 0.3);
    }
    .banner-text {
        min-width: 0;
        flex: 1;
    }
    .info {
        margin-top: 0.4rem;
        font-size: 0.85em;
        max-width: 48rem;
    }
    .number {
        font-size: 2.4em;
        font-weight: 800;
        color: #fde68a;
        font-variant-numeric: tabular-nums;
        min-width: 2ch;
        text-align: right;
    }
    .name {
        font-size: 1.4em;
        font-weight: 800;
        overflow-wrap: anywhere;
    }
    .digits {
        position: absolute;
        top: 2rem;
        right: 2rem;
        padding: 0.1em 0.5em;
        border-radius: 1rem;
        background: #000;
        border: 4px solid #fde047;
        font-size: 4.5rem;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
    }
    .list {
        pointer-events: auto;
        position: absolute;
        inset: 0;
        overflow-y: auto;
        padding: 1.5rem clamp(1rem, 4vw, 4rem) 2rem;
        background: rgb(3 7 18 / 0.96);
    }
    .list-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1.25rem;
    }
    h2 {
        font-size: 1.6em;
        font-weight: 800;
    }
    ul {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        max-width: 60rem;
    }
    .row {
        display: flex;
        width: 100%;
        align-items: center;
        gap: 1rem;
        padding: 0.7rem 1rem;
        border-radius: 1rem;
        background: #111827;
        border: 3px solid #374151;
        text-align: left;
    }
    .row.current {
        border-color: #fde047;
    }
    .row .number {
        font-size: 1.4em;
    }
    .row .name {
        font-size: 1.15em;
    }
    .row-text {
        display: flex;
        min-width: 0;
        flex-direction: column;
    }
    .row-now {
        font-size: 0.8em;
        color: #d1d5db;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .pill {
        min-height: 4rem;
        padding: 0.4em 1.2em;
        border-radius: 999px;
        background: #fde047;
        color: #111827 !important;
        font-weight: 800;
    }
    .home {
        margin-top: 1.5rem;
        background: #374151;
        color: #fff !important;
    }
</style>
