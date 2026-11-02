<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    AzFilterPanel.svelte
    Popover for filtering /browse A-Z by audio (DE/EN/JA/KO) and subtitle
    (DE/EN) track languages, plus QUALITY (resolution / HDR / codec), with a
    single "include untagged" toggle covering both language + quality.
-->
<script lang="ts">
    import { clickOutside } from '$lib/utils/click-outside';
    import * as m from '$lib/paraglide/messages.js';
    import {
        AUDIO_FILTER_LANGUAGES,
        SUBTITLE_FILTER_LANGUAGES,
        LANGUAGE_LABELS,
        type AudioFilterLang,
        type SubtitleFilterLang,
    } from '$lib/shared/track-language';
    import {
        RESOLUTION_TIERS,
        HDR_TIERS,
        CODEC_TIERS,
        RESOLUTION_LABELS,
        HDR_LABELS,
        CODEC_LABELS,
        type ResolutionTier,
        type HdrTier,
        type CodecTier,
    } from '$lib/shared/quality-filter';

    interface Props {
        audioLangs?: AudioFilterLang[];
        subLangs?: SubtitleFilterLang[];
        resolutions?: ResolutionTier[];
        hdr?: HdrTier[];
        codecs?: CodecTier[];
        includeUnknown?: boolean;
        /** Fired after every mutation so the parent can refetch + persist. */
        onChange?: () => void;
    }

    let {
        audioLangs = $bindable([]),
        subLangs = $bindable([]),
        resolutions = $bindable([]),
        hdr = $bindable([]),
        codecs = $bindable([]),
        includeUnknown = $bindable(false),
        onChange,
    }: Props = $props();

    let open = $state(false);
    let isActive = $derived(
        audioLangs.length > 0 ||
            subLangs.length > 0 ||
            resolutions.length > 0 ||
            hdr.length > 0 ||
            codecs.length > 0 ||
            includeUnknown,
    );

    function toggleAudio(l: AudioFilterLang): void {
        audioLangs = audioLangs.includes(l)
            ? audioLangs.filter((x) => x !== l)
            : [...audioLangs, l];
        onChange?.();
    }

    function toggleSub(l: SubtitleFilterLang): void {
        subLangs = subLangs.includes(l) ? subLangs.filter((x) => x !== l) : [...subLangs, l];
        onChange?.();
    }

    function toggleResolution(t: ResolutionTier): void {
        resolutions = resolutions.includes(t)
            ? resolutions.filter((x) => x !== t)
            : [...resolutions, t];
        onChange?.();
    }

    function toggleHdr(t: HdrTier): void {
        hdr = hdr.includes(t) ? hdr.filter((x) => x !== t) : [...hdr, t];
        onChange?.();
    }

    function toggleCodec(t: CodecTier): void {
        codecs = codecs.includes(t) ? codecs.filter((x) => x !== t) : [...codecs, t];
        onChange?.();
    }

    function handleIncludeUnknown(e: Event): void {
        includeUnknown = (e.currentTarget as HTMLInputElement).checked;
        onChange?.();
    }

    function clearAll(): void {
        audioLangs = [];
        subLangs = [];
        resolutions = [];
        hdr = [];
        codecs = [];
        includeUnknown = false;
        onChange?.();
    }
</script>

<div class="raf-root" use:clickOutside={() => (open = false)}>
    <button
        class="raf-trigger az-type-chip {open ? 'active' : ''}"
        onclick={() => (open = !open)}
        type="button"
        aria-expanded={open}
        aria-haspopup="true">
        {m.az_filter_trigger()}
        {#if isActive}<span class="raf-active-dot" aria-hidden="true"></span>{/if}
    </button>

    {#if open}
        <div class="raf-popover" role="dialog" aria-label={m.az_filter_dialog_label()}>
            <section class="raf-section">
                <span class="raf-section-label">{m.az_filter_audio()}</span>
                <div class="raf-chips">
                    {#each AUDIO_FILTER_LANGUAGES as l (l)}
                        <button
                            class="az-type-chip raf-chip {audioLangs.includes(l) ? 'active' : ''}"
                            onclick={() => toggleAudio(l)}
                            type="button">{LANGUAGE_LABELS[l]}</button>
                    {/each}
                </div>
            </section>
            <section class="raf-section">
                <span class="raf-section-label">{m.az_filter_subtitles()}</span>
                <div class="raf-chips">
                    {#each SUBTITLE_FILTER_LANGUAGES as l (l)}
                        <button
                            class="az-type-chip raf-chip {subLangs.includes(l) ? 'active' : ''}"
                            onclick={() => toggleSub(l)}
                            type="button">{LANGUAGE_LABELS[l]}</button>
                    {/each}
                </div>
            </section>
            <section class="raf-section">
                <span class="raf-section-label">{m.az_filter_resolution()}</span>
                <div class="raf-chips">
                    {#each RESOLUTION_TIERS as t (t)}
                        <button
                            class="az-type-chip raf-chip {resolutions.includes(t) ? 'active' : ''}"
                            onclick={() => toggleResolution(t)}
                            type="button">{RESOLUTION_LABELS[t]}</button>
                    {/each}
                </div>
            </section>
            <section class="raf-section">
                <span class="raf-section-label">{m.az_filter_hdr()}</span>
                <div class="raf-chips">
                    {#each HDR_TIERS as t (t)}
                        <button
                            class="az-type-chip raf-chip {hdr.includes(t) ? 'active' : ''}"
                            onclick={() => toggleHdr(t)}
                            type="button">{HDR_LABELS[t]}</button>
                    {/each}
                </div>
            </section>
            <section class="raf-section">
                <span class="raf-section-label">{m.az_filter_codec()}</span>
                <div class="raf-chips">
                    {#each CODEC_TIERS as t (t)}
                        <button
                            class="az-type-chip raf-chip {codecs.includes(t) ? 'active' : ''}"
                            onclick={() => toggleCodec(t)}
                            type="button">{CODEC_LABELS[t]}</button>
                    {/each}
                </div>
            </section>
            <section class="raf-section">
                <label class="raf-toggle">
                    <input
                        type="checkbox"
                        checked={includeUnknown}
                        onchange={handleIncludeUnknown} />
                    {m.az_filter_include_untagged()}
                </label>
            </section>
            {#if isActive}
                <button class="raf-clear" onclick={clearAll} type="button"
                    >{m.az_filter_clear()}</button>
            {/if}
        </div>
    {/if}
</div>

<style lang="postcss">
    .raf-root {
        position: relative;
        display: inline-flex;
    }

    /* Reuse az-type-chip from AzBrowseView for the trigger */
    .raf-trigger {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.5rem 1rem;
        border-radius: 2rem;
        background: rgb(var(--color-surface-700-rgb) / 0.5);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-300);
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        white-space: nowrap;
    }

    .raf-trigger:hover {
        background: rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-100);
    }

    .raf-trigger.active {
        background: var(--color-primary-600);
        border-color: var(--color-primary-500);
        color: white;
    }

    .raf-active-dot {
        display: inline-block;
        width: 0.4rem;
        height: 0.4rem;
        border-radius: 50%;
        background: var(--color-primary-300);
        margin-left: 0.125rem;
    }

    .raf-trigger.active .raf-active-dot {
        background: white;
    }

    /* Popover panel */
    .raf-popover {
        position: absolute;
        top: calc(100% + 0.5rem);
        right: 0;
        z-index: 50;
        min-width: 18rem;
        max-width: 22rem;
        padding: 1rem;
        background: var(--color-surface-800);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.6);
        border-radius: 0.75rem;
        box-shadow: 0 8px 32px rgb(0 0 0 / 0.4);
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .raf-section {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
    }

    .raf-section-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-surface-400);
        text-transform: uppercase;
        letter-spacing: 0.06em;
    }

    .raf-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
    }

    /* Self-contained chip styling. Svelte scopes styles per component, so the
       .az-type-chip base/hover/active rules in AzBrowseView do NOT reach these
       chips — they must be styled here directly (a smaller pill). */
    .raf-chip {
        display: inline-flex;
        align-items: center;
        padding: 0.3rem 0.7rem;
        border-radius: 2rem;
        background: rgb(var(--color-surface-700-rgb) / 0.5);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-300);
        font-size: 0.8125rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
    }

    .raf-chip:hover {
        background: rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-100);
    }

    .raf-chip.active {
        background: var(--color-primary-600);
        border-color: var(--color-primary-500);
        color: white;
    }

    .raf-toggle {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.85rem;
        color: var(--color-surface-200);
        cursor: pointer;
    }

    .raf-clear {
        align-self: flex-start;
        background: transparent;
        border: none;
        color: var(--color-primary-400);
        font-size: 0.8rem;
        cursor: pointer;
        padding: 0;
    }
</style>
