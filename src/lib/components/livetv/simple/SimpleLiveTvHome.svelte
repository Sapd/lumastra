<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // Live TV simple mode home: the viewer's own channels, numbered, large and
    // calm. "list" = numbered rows + the highlighted channel's now/next;
    // "tiles" = big tiles. The "tv" layout shows the list too, but opens the
    // picture first (once per browser session, see AUTOSTART_SESSION_KEY).
    import { onMount } from 'svelte';
    import { invalidateAll } from '$app/navigation';
    import * as m from '$lib/paraglide/messages.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import { resolve } from '$lib/paths';
    import type { LiveTvStation } from '$lib/schemas/livetv.js';
    import type { LiveTvSimpleMode } from '$lib/schemas/livetv-simple-mode.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import SimpleChannelDisc from './SimpleChannelDisc.svelte';
    import SimpleNowNext from './SimpleNowNext.svelte';
    import { SimpleGuide } from './simple-guide.svelte.js';
    import { DigitEntry, digitOf, isTypingTarget } from './digit-entry.svelte.js';
    import {
        AUTOSTART_SESSION_KEY,
        buildSimpleLineup,
        findByNumber,
        pickStartChannel,
        readLastWatched,
        type SimpleChannel,
    } from './simple-lineup.js';

    interface Props {
        mode: LiveTvSimpleMode;
        /** The visible lineup. */
        channels: LiveTvStation[];
        username?: string;
        /** The lineup could not be loaded (provider outage). */
        loadError?: boolean;
        onwatch: (channel: LiveTvStation) => void;
    }

    let { mode, channels, username, loadError = false, onwatch }: Props = $props();

    // A helper may change the setup from far away: pick it up when the screen
    // comes back after a while (TV switched on again, tab reopened).
    const REFRESH_AFTER_MS = 5 * 60 * 1000;
    $effect(() => {
        let hiddenAt = 0;
        const onVisibility = (): void => {
            if (document.hidden) hiddenAt = Date.now();
            else if (hiddenAt && Date.now() - hiddenAt > REFRESH_AFTER_MS) void invalidateAll();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    });

    let lineup = $derived(buildSimpleLineup(mode.stationIds, channels));
    const guide = new SimpleGuide();
    $effect(() => guide.start(lineup.map((c) => c.channel.id)));

    // No surprise popups while the simple screen is open.
    $effect(() => toasts.setCalm(true));

    let selectedIndex = $state(0);
    let selected = $derived(lineup[Math.min(selectedIndex, lineup.length - 1)]);
    let rowEls = $state<HTMLButtonElement[]>([]);

    let clock = $derived(
        new Date(guide.now).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }),
    );
    let today = $derived(
        new Date(guide.now).toLocaleDateString(getLocale(), {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
        }),
    );

    const entry = new DigitEntry(
        (num) => {
            const hit = findByNumber(lineup, num);
            if (hit) watch(hit);
        },
        () => lineup.length,
    );

    function watch(item: SimpleChannel): void {
        onwatch(item.channel);
    }

    function focusRow(index: number): void {
        if (lineup.length === 0) return;
        selectedIndex = (index + lineup.length) % lineup.length;
        rowEls[selectedIndex]?.focus();
    }

    function onRowKeydown(e: KeyboardEvent, index: number): void {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusRow(index + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusRow(index - 1);
        } else if (e.key === 'Home') {
            e.preventDefault();
            focusRow(0);
        } else if (e.key === 'End') {
            e.preventDefault();
            focusRow(lineup.length - 1);
        }
    }

    function onWindowKeydown(e: KeyboardEvent): void {
        if (isTypingTarget(e.target)) return;
        const digit = digitOf(e);
        if (digit) {
            e.preventDefault();
            entry.push(digit);
        } else if (e.key === 'Enter' && entry.active) {
            e.preventDefault();
            entry.commit();
        } else if (e.key === 'Escape' && entry.active) {
            entry.cancel();
        }
    }

    onMount(() => {
        const last = readLastWatched(username);
        const start = pickStartChannel(lineup, mode.startStationId, last);
        if (start) selectedIndex = start.number - 1;
        // TV layout: straight into the picture, once per browser session, so
        // Back from the player lands here instead of bouncing to the player.
        if (mode.layout === 'tv' && start) {
            let done: boolean;
            try {
                done = sessionStorage.getItem(AUTOSTART_SESSION_KEY) === '1';
                sessionStorage.setItem(AUTOSTART_SESSION_KEY, '1');
            } catch {
                // No session storage: never bounce to the player.
                done = true;
            }
            if (!done) {
                watch(start);
                return;
            }
        }
        if (mode.layout !== 'tiles') rowEls[selectedIndex]?.focus();
    });
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="simple" class:xlarge={mode.textSize === 'xlarge'} data-testid="livetv-simple-home">
    <header>
        <h1>{m.livetv_simple_title()}</h1>
        <div class="clock" aria-live="off">
            <span class="time">{clock}</span>
            <span class="date">{today}</span>
        </div>
    </header>

    {#if loadError}
        <section class="empty" role="alert">
            <p>{m.livetv_simple_unavailable()}</p>
            <button type="button" class="big-button" onclick={() => void invalidateAll()}
                >{m.common_retry()}</button>
        </section>
    {:else if lineup.length === 0}
        <section class="empty">
            <p>{m.livetv_simple_empty()}</p>
            {#if !mode.locked}
                <a class="big-button" href={resolve('/livetv/simple-setup')}
                    >{m.livetv_simple_choose_channels()}</a>
            {/if}
        </section>
    {:else if mode.layout === 'tiles'}
        <ul class="tiles" aria-label={m.livetv_simple_channels_label()}>
            {#each lineup as item (item.channel.id)}
                {@const info = guide.for(item.channel)}
                <li>
                    <button
                        type="button"
                        class="tile"
                        onclick={() => watch(item)}
                        aria-label={m.livetv_simple_watch_channel({
                            number: item.number,
                            name: item.channel.name,
                        })}>
                        <span class="tile-top">
                            <span class="number">{item.number}</span>
                            <SimpleChannelDisc channel={item.channel} size={5.5} />
                        </span>
                        <span class="name">{item.channel.name}</span>
                        <span class="tile-info">
                            <SimpleNowNext {info} now={guide.now} showNext={false} />
                        </span>
                    </button>
                </li>
            {/each}
        </ul>
    {:else}
        <div class="list-layout">
            <ul class="rows" aria-label={m.livetv_simple_channels_label()}>
                {#each lineup as item, i (item.channel.id)}
                    {@const info = guide.for(item.channel)}
                    <li>
                        <button
                            type="button"
                            class="row"
                            class:selected={i === selectedIndex}
                            bind:this={rowEls[i]}
                            tabindex={i === selectedIndex ? 0 : -1}
                            onfocus={() => (selectedIndex = i)}
                            onmouseenter={() => (selectedIndex = i)}
                            onkeydown={(e) => onRowKeydown(e, i)}
                            onclick={() => watch(item)}
                            aria-label={m.livetv_simple_watch_channel({
                                number: item.number,
                                name: item.channel.name,
                            })}>
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
            {#if selected}
                {@const info = guide.for(selected.channel)}
                <aside class="detail" aria-live="polite">
                    <div class="detail-head">
                        <SimpleChannelDisc channel={selected.channel} size={7} />
                        <div>
                            <span class="number big">{selected.number}</span>
                            <h2>{selected.channel.name}</h2>
                        </div>
                    </div>
                    <div class="detail-info">
                        <SimpleNowNext {info} now={guide.now} />
                    </div>
                    <button type="button" class="big-button" onclick={() => watch(selected)}>
                        ▶ {m.livetv_simple_watch()}
                    </button>
                </aside>
            {/if}
        </div>
    {/if}

    {#if entry.active}
        <div class="digits" role="status">{entry.digits}</div>
    {/if}

    <footer>
        <p class="hint">{m.livetv_simple_hint()}</p>
        <a class="helper" href={`${resolve('/')}?home`}>{m.livetv_simple_other_media()}</a>
        <a class="helper" href={resolve('/livetv/simple-setup')}>
            {mode.locked ? m.livetv_simple_helper_locked() : m.livetv_simple_helper()}
        </a>
    </footer>
</div>

<style>
    .simple {
        --fs: 1.5rem;
        font-size: var(--fs);
        color: #fff;
        background: #030712;
        min-height: calc(100dvh - 4rem);
        padding: 1.5rem clamp(1rem, 3vw, 3rem) 2rem;
        line-height: 1.3;
    }
    /* Clear the fixed top bar of the desktop layout. */
    @media (min-width: 1024px) {
        .simple {
            padding-top: 5.5rem;
        }
    }
    .simple.xlarge {
        --fs: 1.875rem;
    }
    header {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
        margin-bottom: 1.5rem;
    }
    h1 {
        font-size: 1.6em;
        font-weight: 800;
    }
    .clock {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
    }
    .clock .time {
        font-size: 1.8em;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
    }
    .clock .date {
        font-size: 0.75em;
        color: #d1d5db;
    }
    .number {
        font-size: 1.4em;
        font-weight: 800;
        min-width: 2ch;
        text-align: right;
        color: #fde68a;
        font-variant-numeric: tabular-nums;
    }
    .number.big {
        font-size: 2em;
        text-align: left;
    }
    button,
    a {
        color: inherit;
        font: inherit;
    }
    button:focus-visible,
    a:focus-visible,
    .row.selected:focus {
        outline: 6px solid #fde047;
        outline-offset: 4px;
    }
    .list-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 1.5rem;
    }
    @media (min-width: 900px) {
        .list-layout {
            grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
            align-items: start;
        }
        .detail {
            position: sticky;
            top: 1.5rem;
        }
    }
    .rows {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
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
        cursor: pointer;
    }
    .row.selected {
        background: #1f2937;
        border-color: #fde047;
    }
    .row-text {
        display: flex;
        min-width: 0;
        flex-direction: column;
    }
    .name {
        font-size: 1.15em;
        font-weight: 800;
        overflow-wrap: anywhere;
    }
    .row-now {
        font-size: 0.8em;
        color: #d1d5db;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .detail {
        padding: 1.5rem;
        border-radius: 1.25rem;
        background: #111827;
        border: 3px solid #374151;
    }
    .detail-head {
        display: flex;
        align-items: center;
        gap: 1.25rem;
        margin-bottom: 1.25rem;
    }
    h2 {
        font-size: 1.5em;
        font-weight: 800;
        overflow-wrap: anywhere;
    }
    .detail-info {
        font-size: 1.05em;
        margin-bottom: 1.5rem;
    }
    .big-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.5em;
        min-height: 4.5rem;
        padding: 0.5em 1.4em;
        border-radius: 999px;
        background: #fde047;
        color: #111827;
        font-size: 1.1em;
        font-weight: 800;
        cursor: pointer;
        text-decoration: none;
    }
    .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
        gap: 1.25rem;
    }
    .tile {
        display: flex;
        width: 100%;
        height: 100%;
        flex-direction: column;
        gap: 0.6rem;
        padding: 1.25rem;
        border-radius: 1.25rem;
        background: #111827;
        border: 3px solid #374151;
        text-align: left;
        cursor: pointer;
    }
    .tile:hover {
        border-color: #fde047;
    }
    .tile-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .tile-info {
        font-size: 0.85em;
    }
    .empty {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 1.5rem;
        max-width: 40rem;
        padding: 2rem 0;
    }
    .digits {
        position: fixed;
        top: 6rem;
        right: 3rem;
        z-index: 50;
        min-width: 3ch;
        padding: 0.2em 0.5em;
        border-radius: 1rem;
        background: #000;
        border: 4px solid #fde047;
        font-size: 4rem;
        font-weight: 800;
        text-align: center;
        font-variant-numeric: tabular-nums;
    }
    footer {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-top: 2.5rem;
        font-size: 0.75em;
        color: #d1d5db;
    }
    .helper {
        padding: 0.6em 1em;
        border-radius: 0.75rem;
        border: 2px solid #4b5563;
        text-decoration: none;
    }
</style>
