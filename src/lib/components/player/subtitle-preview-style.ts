// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Inline CSS that renders a subtitle style preview.
 *
 * Shared by the in-player style popover and the settings page editor so the
 * two previews cannot drift apart.
 */

import {
    DEFAULT_SUBTITLE_STYLE,
    SUBTITLE_STYLE_PRESETS,
    type SubtitleStylePreset,
    type SubtitleStyleSettings,
} from './preferences-sync.svelte';

const FONT_FAMILY_CSS: Record<SubtitleStyleSettings['fontFamily'], string> = {
    system: 'system-ui, -apple-system, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: '"SF Mono", "Monaco", "Consolas", monospace',
};

export function subtitlePreviewStyle(style: SubtitleStyleSettings): string {
    let textShadow = '';
    if (style.outlineWidth > 0) {
        // Stroke effect from eight offset shadows.
        const c = style.outlineColor;
        const w = style.outlineWidth;
        textShadow = [
            `-${w}px -${w}px 0 ${c}`,
            `${w}px -${w}px 0 ${c}`,
            `-${w}px ${w}px 0 ${c}`,
            `${w}px ${w}px 0 ${c}`,
            `0 -${w}px 0 ${c}`,
            `0 ${w}px 0 ${c}`,
            `-${w}px 0 0 ${c}`,
            `${w}px 0 0 ${c}`,
        ].join(', ');
    }
    if (style.shadowBlur > 0) {
        const shadowPart = `2px 2px ${style.shadowBlur}px rgba(0, 0, 0, 0.9)`;
        textShadow = textShadow ? `${textShadow}, ${shadowPart}` : shadowPart;
    }

    const hasBackground = style.backgroundColor !== 'transparent';

    return [
        `font-family: ${FONT_FAMILY_CSS[style.fontFamily]}`,
        `font-size: ${style.fontSize}em`,
        `color: ${style.textColor}`,
        `background: ${hasBackground ? style.backgroundColor : 'none'}`,
        `text-shadow: ${textShadow || 'none'}`,
        `padding: ${hasBackground ? '4px 12px' : '0'}`,
        `border-radius: ${hasBackground ? '4px' : '0'}`,
    ].join('; ');
}

/** Small "Aa" swatch for a preset button. */
export function subtitlePresetSwatchStyle(preset: SubtitleStylePreset): string {
    return subtitlePreviewStyle({
        ...DEFAULT_SUBTITLE_STYLE,
        ...SUBTITLE_STYLE_PRESETS[preset],
        fontSize: 0.7,
        preset,
    });
}

/**
 * `positionY` is stored as the caption's distance from the TOP (in %), while
 * people think of it as height above the bottom. The sliders work in the
 * latter so dragging right moves the caption UP — the stored value slid the
 * other way, so the knob and the "% from bottom" label moved in opposite
 * directions.
 */
export const SUBTITLE_HEIGHT_MIN = 5;
export const SUBTITLE_HEIGHT_MAX = 50;

/**
 * Clamped to the slider's range: the schema allows any 0–100, and a value the
 * range input cannot show would pin its knob at an end while the preview sat
 * somewhere else.
 */
export function heightFromPositionY(positionY: number): number {
    return Math.min(SUBTITLE_HEIGHT_MAX, Math.max(SUBTITLE_HEIGHT_MIN, 100 - positionY));
}

export function positionYFromHeight(height: number): number {
    return 100 - height;
}
