<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import * as m from '$lib/paraglide/messages';
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
        onChange?: () => void;
        content?: Snippet;
        contentCount?: number;
        onClearContent?: () => void;
    }
    let {
        audioLangs = $bindable([]),
        subLangs = $bindable([]),
        resolutions = $bindable([]),
        hdr = $bindable([]),
        codecs = $bindable([]),
        includeUnknown = $bindable(false),
        onChange,
        content,
        contentCount = 0,
        onClearContent,
    }: Props = $props();
    let dialog: HTMLDialogElement | undefined = $state();
    let open = $state(false);
    let pointerStartedOutside = false;
    function isOutsideDialog(event: MouseEvent): boolean {
        if (!dialog || event.target !== dialog) return false;
        const bounds = dialog.getBoundingClientRect();
        return (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
        );
    }
    function handleBackdropClick(event: MouseEvent): void {
        if (pointerStartedOutside && isOutsideDialog(event)) close();
        pointerStartedOutside = false;
    }
    const uid = $props.id();
    let count = $derived(
        contentCount +
            audioLangs.length +
            subLangs.length +
            resolutions.length +
            hdr.length +
            codecs.length +
            Number(includeUnknown),
    );
    function toggle<T>(values: T[], value: T): T[] {
        return values.includes(value)
            ? values.filter((item) => item !== value)
            : [...values, value];
    }
    let groups = $derived([
        {
            label: m.catalog_audio(),
            choices: AUDIO_FILTER_LANGUAGES.map((value) => ({
                value,
                label: LANGUAGE_LABELS[value],
                selected: audioLangs.includes(value),
                toggle: (): void => {
                    audioLangs = toggle(audioLangs, value);
                },
            })),
        },
        {
            label: m.catalog_subtitles(),
            choices: SUBTITLE_FILTER_LANGUAGES.map((value) => ({
                value,
                label: LANGUAGE_LABELS[value],
                selected: subLangs.includes(value),
                toggle: (): void => {
                    subLangs = toggle(subLangs, value);
                },
            })),
        },
        {
            label: m.catalog_resolution(),
            choices: RESOLUTION_TIERS.map((value) => ({
                value,
                label: RESOLUTION_LABELS[value],
                selected: resolutions.includes(value),
                toggle: (): void => {
                    resolutions = toggle(resolutions, value);
                },
            })),
        },
        {
            label: 'HDR',
            choices: HDR_TIERS.map((value) => ({
                value,
                label: HDR_LABELS[value],
                selected: hdr.includes(value),
                toggle: (): void => {
                    hdr = toggle(hdr, value);
                },
            })),
        },
        {
            label: m.catalog_codec(),
            choices: CODEC_TIERS.map((value) => ({
                value,
                label: CODEC_LABELS[value],
                selected: codecs.includes(value),
                toggle: (): void => {
                    codecs = toggle(codecs, value);
                },
            })),
        },
    ]);
    function show(): void {
        dialog?.showModal();
        open = true;
    }
    function close(): void {
        dialog?.close();
    }
    function clear(): void {
        audioLangs = [];
        subLangs = [];
        resolutions = [];
        hdr = [];
        codecs = [];
        includeUnknown = false;
        onClearContent?.();
        onChange?.();
    }
</script>

<button
    type="button"
    class="filter-trigger"
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={show}>
    <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6m8 4v6" /></svg>
    {m.catalog_filters()}{#if count}<span class="filter-count">{count}</span>{/if}
</button>
<dialog
    bind:this={dialog}
    class="filter-dialog"
    aria-labelledby={uid}
    onpointerdown={(event) => (pointerStartedOutside = isOutsideDialog(event))}
    onclick={handleBackdropClick}
    onclose={() => (open = false)}>
    <header>
        <div>
            <p class="eyebrow">{m.catalog_library_label()}</p>
            <h2 id={uid}>{m.catalog_filters()}</h2>
        </div>
        <button type="button" class="done" onclick={close}>{m.catalog_done()}</button>
    </header>
    <div class="filter-body">
        {#if content}<section class="content-section">
                <h3>{m.catalog_content()}</h3>
                {@render content()}
            </section>{/if}
        <section>
            <h3>{m.catalog_playback()}</h3>
            <p class="hint">{m.catalog_matching()}</p>
            {#each groups as group (group.label)}
                <fieldset>
                    <legend>{group.label}</legend>
                    <div class="choices">
                        {#each group.choices as choice (choice.value)}
                            <button
                                type="button"
                                aria-pressed={choice.selected}
                                onclick={() => {
                                    choice.toggle();
                                    onChange?.();
                                }}>{choice.label}</button>
                        {/each}
                    </div>
                </fieldset>
            {/each}
            <label class="unknown"
                ><input
                    type="checkbox"
                    bind:checked={includeUnknown}
                    onchange={() => onChange?.()} />{m.catalog_unknown()}</label>
            <p class="hint">{m.catalog_unknown_hint()}</p>
        </section>
    </div>
    <footer>
        <button type="button" disabled={!count} onclick={clear}>{m.catalog_clear()}</button>
    </footer>
</dialog>

<style>
    .filter-trigger,
    .done {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        min-height: 44px;
        padding: 0.6rem 1rem;
        border-radius: 0.55rem;
        background: var(--color-surface-800);
        color: var(--color-surface-100);
        cursor: pointer;
    }
    .filter-count {
        background: var(--color-primary-500);
        color: white;
        border-radius: 0.3rem;
        padding: 0 0.4rem;
        font-size: 0.75rem;
    }
    .filter-dialog {
        position: fixed;
        inset: 0 0 0 auto;
        margin: 0;
        width: min(27rem, 100vw);
        height: 100dvh;
        max-height: 100dvh;
        max-width: 100vw;
        padding: 0;
        border: 0;
        background: var(--color-surface-900);
        color: var(--color-surface-100);
        box-shadow: -16px 0 60px #0005;
    }
    .filter-dialog[open] {
        display: flex;
        flex-direction: column;
    }
    .filter-dialog::backdrop {
        background: #06081199;
    }
    header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 1.5rem;
        gap: 1rem;
    }
    h2 {
        font-size: 1.6rem;
        font-weight: 650;
    }
    h3 {
        font-size: 1rem;
        font-weight: 650;
        margin-bottom: 1rem;
    }
    .eyebrow {
        font-size: 0.75rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--color-primary-300);
    }
    .filter-body {
        overflow-y: auto;
        padding: 0 1.5rem 1.5rem;
        flex: 1;
    }
    .content-section {
        padding-bottom: 1.5rem;
        margin-bottom: 1.5rem;
        border-bottom: 1px solid #ffffff12;
    }
    fieldset {
        margin: 1.25rem 0;
    }
    legend {
        margin-bottom: 0.5rem;
        color: var(--color-surface-200);
        font-size: 0.875rem;
    }
    .choices {
        display: flex;
        flex-wrap: wrap;
        gap: 0.45rem;
    }
    .choices button {
        min-height: 40px;
        padding: 0.45rem 0.8rem;
        border-radius: 0.4rem;
        background: var(--color-surface-800);
        color: var(--color-surface-200);
        cursor: pointer;
    }
    .choices button[aria-pressed='true'] {
        background: var(--color-primary-700);
        color: white;
        box-shadow: inset 0 0 0 1px var(--color-primary-400);
    }
    .hint {
        color: var(--color-surface-400);
        font-size: 0.8rem;
        line-height: 1.6;
    }
    .unknown {
        display: flex;
        align-items: flex-start;
        gap: 0.65rem;
        font-size: 0.85rem;
        line-height: 1.5;
        margin-top: 1.5rem;
        margin-bottom: 0.5rem;
    }
    input {
        margin-top: 0.25rem;
        accent-color: var(--color-primary-500);
    }
    footer {
        padding: 1rem 1.5rem max(1rem, env(safe-area-inset-bottom));
        border-top: 1px solid #ffffff12;
    }
    footer button {
        color: var(--color-primary-300);
        min-height: 44px;
        cursor: pointer;
    }
    button:disabled {
        opacity: 0.4;
        cursor: default;
    }
    button:focus-visible {
        outline: 2px solid var(--color-primary-300);
        outline-offset: 3px;
    }
    @media (max-width: 600px) {
        .filter-dialog {
            inset: auto 0 0;
            width: 100%;
            height: 88dvh;
            border-radius: 1rem 1rem 0 0;
        }
    }
</style>
