<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import './player-presentation.css';
    import {
        type SubtitleStylePreset,
        type SubtitleStyleSettings,
        SUBTITLE_STYLE_PRESETS,
        DEFAULT_SUBTITLE_STYLE,
        updatePreference,
        playbackPreferences,
    } from './preferences-sync.svelte';
    import { playerStore } from './playerStore.svelte';
    import { isAssCodec } from './subtitle-utils';
    import * as m from '$lib/paraglide/messages';
    import {
        subtitlePreviewStyle,
        subtitlePresetSwatchStyle,
        heightFromPositionY,
        positionYFromHeight,
        SUBTITLE_HEIGHT_MIN,
        SUBTITLE_HEIGHT_MAX,
    } from './subtitle-preview-style';

    interface Props {
        onstylechange?: (style: SubtitleStyleSettings) => void;
        onclose?: () => void;
        onwheel?: (event: WheelEvent) => void;
    }

    let { onstylechange, onclose, onwheel }: Props = $props();

    /**
     * Validate that a subtitleStyle object is valid and not corrupted.
     * Corrupted data has numbered character-index keys instead of proper property names.
     * Just check for fontSize as number - that's enough to distinguish valid from corrupted.
     */
    function isValidSubtitleStyle(style: unknown): style is SubtitleStyleSettings {
        if (!style || typeof style !== 'object') return false;
        const s = style as Record<string, unknown>;
        return typeof s.fontSize === 'number';
    }

    /**
     * Get validated initial style from preferences.
     * Falls back to defaults if stored style is corrupted.
     */
    function getValidatedStyle(): SubtitleStyleSettings {
        const saved = playbackPreferences.subtitleStyle;

        if (isValidSubtitleStyle(saved)) {
            // Copy properties explicitly with fallbacks for any missing values
            return {
                preset: saved.preset ?? DEFAULT_SUBTITLE_STYLE.preset,
                fontSize: saved.fontSize ?? DEFAULT_SUBTITLE_STYLE.fontSize,
                fontFamily: saved.fontFamily ?? DEFAULT_SUBTITLE_STYLE.fontFamily,
                textColor: saved.textColor ?? DEFAULT_SUBTITLE_STYLE.textColor,
                backgroundColor: saved.backgroundColor ?? DEFAULT_SUBTITLE_STYLE.backgroundColor,
                outlineColor: saved.outlineColor ?? DEFAULT_SUBTITLE_STYLE.outlineColor,
                outlineWidth: saved.outlineWidth ?? DEFAULT_SUBTITLE_STYLE.outlineWidth,
                shadowBlur: saved.shadowBlur ?? DEFAULT_SUBTITLE_STYLE.shadowBlur,
                positionY: saved.positionY ?? DEFAULT_SUBTITLE_STYLE.positionY,
            };
        }

        return { ...DEFAULT_SUBTITLE_STYLE };
    }

    // The preference store is the source of truth while this popover stays open.
    const workingStyle: SubtitleStyleSettings = $derived(getValidatedStyle());

    // Style presets for the selector
    const stylePresets: { id: SubtitleStylePreset; labelKey: string }[] = [
        { id: 'default', labelKey: 'default' },
        { id: 'outlined', labelKey: 'outlined' },
        { id: 'background', labelKey: 'background' },
        { id: 'shadow', labelKey: 'shadow' },
        { id: 'none', labelKey: 'none' },
    ];

    // Font families for the selector
    const fontFamilies: ('system' | 'serif' | 'mono')[] = ['system', 'serif', 'mono'];

    // Check if current subtitle is ASS (styling doesn't apply)
    let currentSubtitleTrack = $derived(
        playerStore.currentSubtitleTrackIndex !== null
            ? playerStore.subtitleTracks.find(
                  (t) => t.index === playerStore.currentSubtitleTrackIndex,
              )
            : null,
    );
    let isCurrentSubtitleAss = $derived(
        currentSubtitleTrack ? isAssCodec(currentSubtitleTrack.codec) : false,
    );

    function getPresetLabel(preset: SubtitleStylePreset): string {
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
            default:
                return preset;
        }
    }

    function getFontLabel(font: 'system' | 'serif' | 'mono'): string {
        switch (font) {
            case 'system':
                return m.player_subtitle_font_system();
            case 'serif':
                return m.player_subtitle_font_serif();
            case 'mono':
                return m.player_subtitle_font_mono();
            default:
                return font;
        }
    }

    // Apply a preset style
    function applyPreset(preset: SubtitleStylePreset) {
        saveStyle({
            ...workingStyle,
            ...SUBTITLE_STYLE_PRESETS[preset],
            preset,
        });
    }

    // Save the current style to preferences
    function saveStyle(next: SubtitleStyleSettings) {
        updatePreference('subtitleStyle', { ...next });
        onstylechange?.({ ...next });
    }

    // Reset to defaults
    function resetToDefault() {
        saveStyle({ ...DEFAULT_SUBTITLE_STYLE });
    }

    // Handle size change
    function handleSizeChange(e: Event) {
        const target = e.target as HTMLInputElement;
        saveStyle({ ...workingStyle, fontSize: parseFloat(target.value) });
    }

    // Handle position change
    function handlePositionChange(e: Event) {
        const target = e.target as HTMLInputElement;
        saveStyle({ ...workingStyle, positionY: positionYFromHeight(parseInt(target.value)) });
    }

    // Handle font family change
    function handleFontChange(font: 'system' | 'serif' | 'mono') {
        saveStyle({ ...workingStyle, fontFamily: font });
    }

    // Preview CSS lives in subtitle-preview-style.ts, shared with the
    // settings page editor.
    const getPreviewStyle = subtitlePreviewStyle;
    const getPresetMiniStyle = subtitlePresetSwatchStyle;

    // Handle wheel event (prevent propagation to player)
    function handleWheel(event: WheelEvent) {
        event.stopPropagation();
        onwheel?.(event);
    }
</script>

<div
    class="style-selector player-menu"
    role="dialog"
    aria-label="Subtitle style settings"
    onwheel={handleWheel}>
    <div class="settings-section forced-section">
        <p class="forced-moved-note">{m.player_forced_moved_note()}</p>
    </div>

    <hr class="section-divider" />

    <!-- ASS subtitle notice -->
    {#if isCurrentSubtitleAss}
        <div class="ass-notice">
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                class="notice-icon">
                <path
                    fill-rule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
                    clip-rule="evenodd" />
            </svg>
            <span>{m.player_subtitle_ass_notice()}</span>
        </div>
    {/if}

    <!-- Format hint -->
    <p class="format-hint">{m.player_subtitle_format_hint()}</p>

    <!-- Live Preview -->
    <div class="preview-section">
        <div class="preview-container" style="top: {workingStyle.positionY}%;">
            <span class="preview-text" style={getPreviewStyle(workingStyle)}>
                {m.player_subtitle_preview()}
            </span>
        </div>
    </div>

    <!-- Style Presets -->
    <div class="settings-section">
        <h3 class="section-title">{m.player_subtitle_style()}</h3>
        <div class="preset-grid">
            {#each stylePresets as preset (preset.id)}
                <button
                    class="preset-chip"
                    class:selected={workingStyle.preset === preset.id}
                    onclick={() => applyPreset(preset.id)}
                    title={getPresetLabel(preset.id)}>
                    <span class="preset-preview" style={getPresetMiniStyle(preset.id)}>Aa</span>
                    <span class="preset-label">{getPresetLabel(preset.id)}</span>
                </button>
            {/each}
        </div>
    </div>

    <!-- Size Slider -->
    <div class="settings-section">
        <div class="slider-header">
            <h3 class="section-title">{m.player_subtitle_size()}</h3>
            <span class="slider-value">{Math.round(workingStyle.fontSize * 100)}%</span>
        </div>
        <input
            type="range"
            min="0.5"
            max="2.5"
            step="0.1"
            value={workingStyle.fontSize}
            aria-label={m.player_subtitle_size()}
            oninput={handleSizeChange}
            class="style-slider" />
    </div>

    <!-- Position Slider -->
    <div class="settings-section">
        <div class="slider-header">
            <h3 class="section-title">{m.player_subtitle_height()}</h3>
            <span class="slider-value"
                >{m.player_subtitle_position_value({
                    percent: heightFromPositionY(workingStyle.positionY),
                })}</span>
        </div>
        <input
            type="range"
            min={SUBTITLE_HEIGHT_MIN}
            max={SUBTITLE_HEIGHT_MAX}
            step="1"
            value={heightFromPositionY(workingStyle.positionY)}
            aria-label={m.player_subtitle_height()}
            oninput={handlePositionChange}
            class="style-slider" />
        <p class="hint-text">{m.player_subtitle_position_hint()}</p>
    </div>

    <!-- Font Family -->
    <div class="settings-section">
        <h3 class="section-title">{m.player_subtitle_font()}</h3>
        <div class="font-grid">
            {#each fontFamilies as font (font)}
                <button
                    class="font-chip"
                    class:selected={workingStyle.fontFamily === font}
                    onclick={() => handleFontChange(font)}>
                    {getFontLabel(font)}
                </button>
            {/each}
        </div>
    </div>

    <!-- Reset Button -->
    <div class="settings-section reset-section">
        <button class="reset-btn" onclick={resetToDefault}>
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                class="reset-icon">
                <path
                    fill-rule="evenodd"
                    d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm-1.24-8.478a.75.75 0 011.449.39 7 7 0 01-11.712 3.138l-.31-.31v2.43a.75.75 0 01-1.5 0V4.352a.75.75 0 01.75-.75h4.243a.75.75 0 010 1.5H4.757l.312.311a5.5 5.5 0 019.201-2.466z"
                    clip-rule="evenodd" />
            </svg>
            {m.player_subtitle_reset()}
        </button>
    </div>
</div>

<style>
    .style-selector {
        padding: 1rem;
        width: 340px;
        max-height: 80vh;
        overflow-y: auto;
    }

    /* ASS subtitle notice */
    .ass-notice {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 11px;
        color: rgba(255, 200, 100, 0.9);
        background: rgba(255, 200, 100, 0.1);
        border: 1px solid rgba(255, 200, 100, 0.2);
        border-radius: 6px;
        padding: 0.5rem 0.75rem;
        margin-bottom: 0.5rem;
    }

    .notice-icon {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
    }

    /* Format hint */
    .format-hint {
        font-size: 10px;
        color: #94a3b8;
        text-align: center;
        margin: 0 0 0.5rem 0;
        padding: 0.25rem 0.5rem;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 4px;
    }

    /* Preview Section */
    .preview-section {
        position: relative;
        height: 80px;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        border-radius: 8px;
        margin-bottom: 0.75rem;
        overflow: hidden;
    }

    .preview-container {
        position: absolute;
        left: 0;
        right: 0;
        display: flex;
        justify-content: center;
        transform: translateY(-50%);
        transition: top 0.2s ease;
    }

    .preview-text {
        display: inline-block;
        white-space: nowrap;
        transition: all 0.2s ease;
    }

    /* Settings Sections */
    .settings-section {
        padding: 0.5rem 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .settings-section:last-child {
        border-bottom: none;
    }

    .section-title {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(255, 255, 255, 0.5);
        margin: 0 0 0.4rem 0;
    }

    /* Preset Grid */
    .preset-grid {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 0.5rem;
    }

    .preset-chip {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.25rem;
        padding: 0.5rem 0.25rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.15s ease;
        color: white;
    }

    .preset-chip:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.2);
    }

    .preset-chip.selected {
        background: rgba(129, 140, 248, 0.15);
        border-color: rgba(129, 140, 248, 0.5);
    }

    .preset-preview {
        display: inline-block;
        font-weight: 600;
        min-height: 24px;
        line-height: 24px;
    }

    .preset-label {
        font-size: 9px;
        color: rgba(255, 255, 255, 0.6);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
    }

    /* Sliders */
    .slider-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.5rem;
    }

    .slider-header .section-title {
        margin: 0;
    }

    .slider-value {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.7);
        font-variant-numeric: tabular-nums;
    }

    .style-slider {
        width: 100%;
        height: 4px;
        appearance: none;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 2px;
        cursor: pointer;
    }

    .style-slider::-webkit-slider-thumb {
        appearance: none;
        width: 16px;
        height: 16px;
        background: #a5b4fc;
        border-radius: 50%;
        cursor: grab;
        transition: transform 0.1s ease;
    }

    .style-slider::-webkit-slider-thumb:hover {
        transform: scale(1.2);
    }

    .style-slider::-webkit-slider-thumb:active {
        cursor: grabbing;
    }

    .style-slider::-moz-range-thumb {
        width: 16px;
        height: 16px;
        background: #a5b4fc;
        border: none;
        border-radius: 50%;
        cursor: grab;
    }

    .hint-text {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.35);
        margin: 0.5rem 0 0 0;
    }

    /* Font Grid */
    .font-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.5rem;
    }

    .font-chip {
        padding: 0.5rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        color: white;
        font-size: 11px;
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .font-chip:hover {
        background: rgba(255, 255, 255, 0.1);
    }

    .font-chip.selected {
        background: rgba(129, 140, 248, 0.15);
        border-color: rgba(129, 140, 248, 0.5);
    }

    /* Reset Button */
    .reset-section {
        display: flex;
        justify-content: center;
        padding-top: 1rem;
    }

    .reset-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        color: rgba(255, 255, 255, 0.7);
        font-size: 12px;
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .reset-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: white;
    }

    .reset-icon {
        width: 14px;
        height: 14px;
    }

    /* Scrollbar */
    .style-selector::-webkit-scrollbar {
        width: 6px;
    }

    .style-selector::-webkit-scrollbar-track {
        background: transparent;
    }

    .style-selector::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.3);
        border-radius: 3px;
    }

    /* Section Divider */
    .section-divider {
        border: none;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        margin: 0.75rem 0;
    }

    /* Forced Subtitles Section */
    .forced-section {
        padding-bottom: 0.25rem;
    }

    .forced-moved-note {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.35);
        margin: 0;
        padding: 0 0.25rem;
        font-style: italic;
    }

    /* Mobile */
    @media (max-width: 500px) {
        .style-selector {
            width: 300px;
        }

        .preset-grid {
            grid-template-columns: repeat(3, 1fr);
        }

        .preset-label {
            font-size: 8px;
        }
    }
</style>
