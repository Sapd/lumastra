<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Subtitle appearance on the settings page.

  This used to embed the player's own style popover as-is: a 340px black card
  with red accents inside a full-width settings card, a note about the track
  selector, and codec jargon. The popover stays in the player; this is the same
  preference (and the same preview CSS, via subtitle-preview-style.ts) laid out
  as ordinary settings rows.
-->
<script lang="ts">
    import { Icon, ArrowPath } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import {
        type SubtitleStylePreset,
        type SubtitleStyleSettings,
        SUBTITLE_STYLE_PRESETS,
        DEFAULT_SUBTITLE_STYLE,
        updatePreference,
        playbackPreferences,
    } from '$lib/components/player/preferences-sync.svelte';
    import {
        subtitlePreviewStyle,
        subtitlePresetSwatchStyle,
        heightFromPositionY,
        positionYFromHeight,
        SUBTITLE_HEIGHT_MIN,
        SUBTITLE_HEIGHT_MAX,
    } from '$lib/components/player/subtitle-preview-style';

    interface Props {
        onchange?: () => void;
    }
    let { onchange }: Props = $props();

    /** A stored style with numbered keys (an old serialisation bug) is ignored. */
    function currentStyle(): SubtitleStyleSettings {
        const saved = playbackPreferences.subtitleStyle as Partial<SubtitleStyleSettings> | null;
        if (!saved || typeof saved.fontSize !== 'number') return { ...DEFAULT_SUBTITLE_STYLE };
        return { ...DEFAULT_SUBTITLE_STYLE, ...saved };
    }

    const style = $derived(currentStyle());

    const PRESETS: SubtitleStylePreset[] = ['default', 'outlined', 'background', 'shadow', 'none'];
    const FONTS: SubtitleStyleSettings['fontFamily'][] = ['system', 'serif', 'mono'];

    function presetLabel(preset: SubtitleStylePreset): string {
        switch (preset) {
            case 'default':
                return m.player_subtitle_style_default();
            case 'outlined':
                return m.player_subtitle_style_outlined();
            case 'background':
                return m.player_subtitle_style_background();
            case 'shadow':
                return m.player_subtitle_style_shadow();
            case 'none':
                return m.player_subtitle_style_none();
        }
    }

    function fontLabel(font: SubtitleStyleSettings['fontFamily']): string {
        switch (font) {
            case 'system':
                return m.player_subtitle_font_system();
            case 'serif':
                return m.player_subtitle_font_serif();
            case 'mono':
                return m.player_subtitle_font_mono();
        }
    }

    function save(next: SubtitleStyleSettings): void {
        updatePreference('subtitleStyle', { ...next });
        onchange?.();
    }

    const height = $derived(heightFromPositionY(style.positionY));
</script>

<div class="p-4 space-y-5">
    <!-- Preview: a video-shaped frame so size and height read the way they will
         on screen. -->
    <div
        class="relative w-full max-w-lg aspect-[16/7] rounded-lg overflow-hidden bg-gradient-to-br from-surface-900 via-surface-800 to-primary-900/40 ring-1 ring-surface-700/60"
        aria-hidden="true">
        <div
            class="absolute inset-x-0 flex justify-center px-4 transition-[top] duration-200"
            style="top: {style.positionY}%; transform: translateY(-50%); font-size: clamp(12px, 2.4vw, 18px);">
            <span class="inline-block whitespace-nowrap" style={subtitlePreviewStyle(style)}>
                {m.player_subtitle_preview()}
            </span>
        </div>
    </div>

    <fieldset>
        <legend class="text-sm mb-2">{m.player_subtitle_style()}</legend>
        <div class="grid grid-cols-3 sm:grid-cols-5 gap-2 max-w-xl">
            {#each PRESETS as preset (preset)}
                <button
                    type="button"
                    aria-pressed={style.preset === preset}
                    class="flex flex-col items-center gap-1 rounded-lg border px-2 py-2 transition-colors {style.preset ===
                    preset
                        ? 'border-primary-500 bg-primary-500/15'
                        : 'border-surface-600/60 bg-surface-900/40 hover:bg-surface-700/40'}"
                    onclick={() => save({ ...style, ...SUBTITLE_STYLE_PRESETS[preset], preset })}>
                    <span
                        class="inline-block font-semibold leading-6 min-h-6"
                        style={subtitlePresetSwatchStyle(preset)}>Aa</span>
                    <span class="text-xs text-surface-300">{presetLabel(preset)}</span>
                </button>
            {/each}
        </div>
    </fieldset>

    <div class="max-w-xl">
        <div class="flex items-center justify-between mb-1">
            <label for="subtitle-size" class="text-sm">{m.player_subtitle_size()}</label>
            <span class="text-xs text-surface-400 tabular-nums"
                >{Math.round(style.fontSize * 100)}%</span>
        </div>
        <input
            id="subtitle-size"
            type="range"
            min="0.5"
            max="2.5"
            step="0.1"
            class="w-full accent-primary-500"
            value={style.fontSize}
            oninput={(e) => save({ ...style, fontSize: parseFloat(e.currentTarget.value) })} />
    </div>

    <div class="max-w-xl">
        <div class="flex items-center justify-between mb-1">
            <label for="subtitle-height" class="text-sm">{m.player_subtitle_height()}</label>
            <span class="text-xs text-surface-400 tabular-nums"
                >{m.player_subtitle_position_value({ percent: height })}</span>
        </div>
        <input
            id="subtitle-height"
            type="range"
            min={SUBTITLE_HEIGHT_MIN}
            max={SUBTITLE_HEIGHT_MAX}
            step="1"
            class="w-full accent-primary-500"
            value={height}
            oninput={(e) =>
                save({
                    ...style,
                    positionY: positionYFromHeight(parseInt(e.currentTarget.value)),
                })} />
        <p class="text-xs text-surface-400 mt-1">{m.player_subtitle_position_hint()}</p>
    </div>

    <fieldset>
        <legend class="text-sm mb-2">{m.player_subtitle_font()}</legend>
        <div class="flex flex-wrap gap-2">
            {#each FONTS as font (font)}
                <button
                    type="button"
                    aria-pressed={style.fontFamily === font}
                    class="btn btn-sm {style.fontFamily === font
                        ? 'variant-filled-primary'
                        : 'variant-ghost-surface'}"
                    onclick={() => save({ ...style, fontFamily: font })}>
                    {fontLabel(font)}
                </button>
            {/each}
        </div>
    </fieldset>

    <button
        type="button"
        class="btn btn-sm variant-soft-surface inline-flex items-center gap-1.5"
        onclick={() => save({ ...DEFAULT_SUBTITLE_STYLE })}>
        <Icon src={ArrowPath} class="w-4 h-4" />
        {m.player_subtitle_reset()}
    </button>
</div>
