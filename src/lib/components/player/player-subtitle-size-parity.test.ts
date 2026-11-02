// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerController } from './player-controller.svelte';
import { DEFAULT_SUBTITLE_STYLE, SUBTITLE_STYLE_PRESETS } from './preferences-sync.svelte';

function subtitleController(height = 1080, portrait = false): PlayerController {
    const controller = Object.create(PlayerController.prototype) as PlayerController;
    Object.defineProperties(controller, {
        videoHeight: { value: height, writable: true },
        isPortrait: { value: portrait, writable: true },
        props: { value: {}, writable: true },
        subtitleStyle: {
            value: {
                fontSize: 1,
                fontFamily: 'system',
                textColor: '#ffffff',
                backgroundColor: 'transparent',
                outlineWidth: 2,
                outlineColor: '#000000',
                shadowBlur: 0,
            },
            writable: true,
            configurable: true,
        },
    });
    return controller;
}

function expectSize(controller: PlayerController, pixels: number): void {
    // Exercise both generated native selectors and the actual overlay getter.
    expect(controller.subtitleCueCSS.match(/font-size: (\d+)px !important/g)).toEqual([
        `font-size: ${pixels}px !important`,
        `font-size: ${pixels}px !important`,
    ]);
    expect(controller.subtitleCueCSS).not.toMatch(/font-size: [\d.]+%/);
    expect(controller.portraitSubtitleInlineStyle).toContain(`font-size: ${pixels}px`);
}

afterEach(() => vi.restoreAllMocks());

describe('real controller native and overlay text subtitle sizing', () => {
    it.each([
        [720, 22],
        [1080, 34],
        [2160, 67],
    ])('uses the same default CSS-pixel size at %ipx video height', (height, pixels) =>
        expectSize(subtitleController(height), pixels),
    );

    it('updates both getters after geometry and user or server settings change', () => {
        const controller = subtitleController();
        expectSize(controller, 34);
        controller.videoHeight = 2160;
        expectSize(controller, 67);
        controller.subtitleStyle.fontSize = 1.5;
        expectSize(controller, 101);
        controller.props.subtitleSizeMultiplier = 1;
        expectSize(controller, 84);
        controller.props.subtitleSrtScale = 70;
        expectSize(controller, 42);
    });

    it('preserves the portrait width floor and existing native cue hiding', () => {
        vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(393);
        const controller = subtitleController(360, true);
        expectSize(controller, 24);
        expect(controller.subtitleCueCSS).toContain('@media (orientation: portrait)');
        expect(controller.subtitleCueCSS).toContain('font-size: 0 !important');
    });

    it('keeps invalid inputs finite in both actual presentation paths', () => {
        const controller = subtitleController(NaN);
        controller.subtitleStyle.fontSize = NaN;
        controller.props.subtitleSizeMultiplier = Infinity;
        controller.props.subtitleSrtScale = NaN;
        expectSize(controller, 16);
    });

    it('uses CSS pixels regardless of display pixel density', () => {
        vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(3);
        expectSize(subtitleController(), 34);
    });

    it('paints the Outlined preset and complete reset in native and overlay renderers', () => {
        const controller = subtitleController();
        Object.defineProperty(controller, 'subtitleStyle', {
            value: {
                ...DEFAULT_SUBTITLE_STYLE,
                fontSize: 1.7,
                positionY: 64,
                ...SUBTITLE_STYLE_PRESETS.outlined,
                preset: 'outlined',
            },
            writable: true,
            configurable: true,
        });
        expect(controller.subtitleCueCSS).toContain('background: transparent !important');
        expect(controller.subtitleCueCSS).toContain('-3px -3px 0 #000000');
        expect(controller.subtitleCueCSS).toContain('2px 2px 2px rgba(0, 0, 0, 0.9)');
        expect(controller.portraitSubtitleInlineStyle).toContain('-3px -3px 0 #000000');
        expect(controller.portraitSubtitleInlineStyle).toContain('2px 2px 2px rgba(0,0,0,0.9)');

        Object.defineProperty(controller, 'subtitleStyle', {
            value: { ...DEFAULT_SUBTITLE_STYLE },
        });
        expect(controller.subtitleCueCSS).toContain('background-color: rgba(0, 0, 0, 0.75)');
        expect(controller.portraitSubtitleInlineStyle).toContain(
            'background-color: rgba(0, 0, 0, 0.75)',
        );
        expect(controller.portraitSubtitleInlineStyle).not.toContain('-3px -3px');
    });
});
