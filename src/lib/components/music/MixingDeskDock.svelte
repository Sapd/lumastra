<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  MixingDeskDock — compact collapsible band on the /music page.

  A slim bar that persists across browse and inline-search mode.
  Reads/writes the shared musicAlchemyStore — no local pad state.
  Collapsed by default (store default). Expanding reveals the seed/avoid
  pads, knobs strip, brew button, and brew ticket inline.
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { musicAlchemyStore } from '$lib/stores/music-alchemy.store.svelte';
    import SeedAvoidPad from './SeedAvoidPad.svelte';
    import ConsoleKnob from './ConsoleKnob.svelte';
    import BrewTicket from './BrewTicket.svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { Icon, ChevronDown, ChevronUp, Beaker } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';

    onMount(() => {
        musicAlchemyStore.init();
    });

    function handleToggle(e: MouseEvent): void {
        e.stopPropagation();
        musicAlchemyStore.toggleDock();
    }

    function handleBrew(e: MouseEvent): void {
        e.stopPropagation();
        void musicAlchemyStore.brew();
    }
</script>

<section class="dock" aria-label="Mixing Desk Dock">
    <!-- Always-visible slim header bar -->
    <div class="dock-header">
        <button
            class="dock-toggle"
            onclick={handleToggle}
            aria-expanded={!musicAlchemyStore.dockCollapsed}
            aria-controls="dock-body">
            <span class="dock-icon" aria-hidden="true">
                <Icon src={Beaker} class="h-4 w-4" />
            </span>
            <span class="dock-title">
                {m.music_alchemy_dock_header({ count: musicAlchemyStore.seedCount })}
            </span>
            <span class="dock-chevron" aria-hidden="true">
                {#if musicAlchemyStore.dockCollapsed}
                    <Icon src={ChevronDown} class="h-4 w-4" />
                {:else}
                    <Icon src={ChevronUp} class="h-4 w-4" />
                {/if}
            </span>
        </button>

        <!-- Brew button always visible in header for quick access -->
        <button
            class="dock-brew-btn"
            disabled={!musicAlchemyStore.canBrew}
            onclick={handleBrew}
            aria-label="Brew mix">
            {#if musicAlchemyStore.brewing}
                <span class="brew-spinner" aria-hidden="true"></span>
                Brewing…
            {:else}
                BREW
            {/if}
        </button>
    </div>

    <!-- Expandable body -->
    {#if !musicAlchemyStore.dockCollapsed}
        <div id="dock-body" class="dock-body">
            <!-- Pads row -->
            <div class="dock-pads">
                <div class="dock-pad">
                    <SeedAvoidPad
                        tracks={musicAlchemyStore.seedTracks}
                        type="seed"
                        onremove={(t) => musicAlchemyStore.removeFromSeed(t)}
                        ondrop={(ts) => musicAlchemyStore.addToSeed(ts)} />
                </div>
                <div class="dock-knobs">
                    <ConsoleKnob
                        value={musicAlchemyStore.energy}
                        onchange={(v) => musicAlchemyStore.setEnergy(v)}
                        label={m.music_alchemy_energy()}
                        labelMin={m.music_alchemy_calm()}
                        labelMax={m.music_alchemy_hot()}
                        color="#ef4444"
                        sensitivity={80} />
                    <ConsoleKnob
                        value={musicAlchemyStore.tempo}
                        onchange={(v) => musicAlchemyStore.setTempo(v)}
                        label={m.music_alchemy_tempo()}
                        labelMin={m.music_alchemy_slow()}
                        labelMax={m.music_alchemy_fast()}
                        color="#f59e0b"
                        sensitivity={80} />
                    <ConsoleKnob
                        value={musicAlchemyStore.obscurity}
                        onchange={(v) => musicAlchemyStore.setObscurity(v)}
                        label={m.music_alchemy_obscurity()}
                        labelMin={m.music_alchemy_pop()}
                        labelMax={m.music_alchemy_deep()}
                        color="#8b5cf6"
                        sensitivity={80} />
                </div>
                <div class="dock-pad">
                    <SeedAvoidPad
                        tracks={musicAlchemyStore.avoidTracks}
                        type="avoid"
                        onremove={(t) => musicAlchemyStore.removeFromAvoid(t)}
                        ondrop={(ts) => musicAlchemyStore.addToAvoid(ts)} />
                </div>
            </div>

            <!-- Brew result + hint/link row -->
            <div class="dock-footer">
                {#if musicAlchemyStore.hasBrewed || musicAlchemyStore.brewing}
                    <div class="dock-ticket">
                        <BrewTicket
                            compact
                            tracks={musicAlchemyStore.brewedTracks}
                            totalDurationMs={musicAlchemyStore.totalDurationMs}
                            loading={musicAlchemyStore.brewing}
                            hasBrewed={musicAlchemyStore.hasBrewed}
                            onclear={() => musicAlchemyStore.clearBrew()}
                            fullDeskHref={resolve('/music/alchemy')} />
                    </div>
                {:else}
                    <p class="dock-hint" aria-live="polite">
                        {m.music_alchemy_dock_add_seed_hint()}
                    </p>
                    <a href={resolve('/music/alchemy')} class="dock-full-link">
                        {m.music_alchemy_dock_open_full()} →
                    </a>
                {/if}
            </div>
        </div>
    {/if}
</section>

<style>
    .dock {
        border: 1px solid rgb(var(--color-surface-800-rgb) / 0.8);
        border-radius: 0.875rem;
        background: rgb(var(--color-surface-950-rgb) / 0.85);
        backdrop-filter: blur(8px);
        overflow: hidden;
        box-shadow: 0 -2px 16px rgb(0 0 0 / 0.3);
    }

    /* Header ---------------------------------------------------------------- */

    .dock-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid transparent;
        transition: border-color 0.2s;
    }

    .dock:not(:has(#dock-body)) .dock-header,
    .dock-header:has(+ #dock-body) {
        border-bottom-color: rgb(30 41 59 / 0.6);
    }

    .dock-toggle {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        background: none;
        border: none;
        color: rgb(203 213 225);
        cursor: pointer;
        padding: 0.25rem 0;
        text-align: left;
        transition: color 0.15s;
        min-width: 0;
    }

    .dock-toggle:hover {
        color: rgb(226 232 240);
    }

    .dock-icon {
        color: rgb(167 139 250);
        flex-shrink: 0;
    }

    .dock-title {
        font-size: 0.8rem;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
    }

    .dock-chevron {
        flex-shrink: 0;
        color: rgb(100 116 139);
    }

    /* Brew button in header ------------------------------------------------- */

    .dock-brew-btn {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        background: linear-gradient(135deg, rgb(124 58 237), rgb(109 40 217));
        color: #fff;
        border: none;
        border-radius: 0.5rem;
        padding: 0.35rem 0.875rem;
        font-size: 0.7rem;
        font-weight: 800;
        letter-spacing: 0.09em;
        cursor: pointer;
        flex-shrink: 0;
        transition:
            opacity 0.15s,
            transform 0.1s;
        box-shadow: 0 2px 10px rgb(124 58 237 / 0.35);
    }

    .dock-brew-btn:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 4px 14px rgb(124 58 237 / 0.5);
    }

    .dock-brew-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
        box-shadow: none;
    }

    .brew-spinner {
        width: 0.65rem;
        height: 0.65rem;
        border: 1.5px solid rgb(255 255 255 / 0.3);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
        flex-shrink: 0;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    /* Expanded body --------------------------------------------------------- */

    .dock-body {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 0.75rem;
    }

    .dock-pads {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        gap: 0.75rem;
        align-items: start;
    }

    .dock-pad {
        min-width: 0;
    }

    .dock-knobs {
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        justify-content: center;
        min-width: 0;
        gap: 0.75rem;
        align-items: center;
        padding: 0 0.25rem;
    }

    /* Footer row: ticket + open-full link ----------------------------------- */

    .dock-footer {
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
    }

    .dock-ticket {
        flex: 1;
        min-width: 0;
    }

    .dock-hint {
        flex: 1;
        font-size: 0.7rem;
        color: rgb(71 85 105);
        margin: 0;
    }

    .dock-full-link {
        font-size: 0.7rem;
        color: rgb(124 58 237);
        text-decoration: none;
        white-space: nowrap;
        flex-shrink: 0;
        transition: color 0.15s;
    }

    .dock-full-link:hover {
        color: rgb(167 139 250);
        text-decoration: underline;
    }

    /* Responsive ------------------------------------------------------------ */

    @media (max-width: 640px) {
        .dock-pads {
            grid-template-columns: 1fr;
        }

        .dock-knobs {
            flex-direction: row;
            justify-content: center;
        }
    }
</style>
