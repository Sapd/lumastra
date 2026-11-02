// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { SubtitleRendererManager } from './subtitle-renderer';

describe.each(['pgsRenderer', 'vobsubRenderer'] as const)('%s sizing', (field) => {
    it('keeps relative bitmap size independent of initialization and resize geometry', () => {
        const manager = new SubtitleRendererManager();
        const video = document.createElement('video');
        let height = 1080;
        Object.defineProperty(video, 'clientHeight', { get: () => height });
        manager.setVideoElement(video);
        const setDisplaySettings = vi.fn();
        Object.assign(manager, { [field]: { setDisplaySettings } });

        // The renderer already maps source pixels into the video at each height.
        // Reapplying unchanged preferences after resize must not change its multiplier.
        for (height of [1080, 720, 360, 2160]) {
            manager.applyStyle({ fontSize: 1 });
            expect(setDisplaySettings).toHaveBeenLastCalledWith({ scale: 0.66 });
        }
        manager.setVideoElement(null);
    });

    it('preserves user scaling and server bitmap calibration', () => {
        const manager = new SubtitleRendererManager({ sizeMultiplier: 1.5, pgsScale: 75 });
        const setDisplaySettings = vi.fn();
        Object.assign(manager, { [field]: { setDisplaySettings } });

        manager.applyStyle({ fontSize: 2, positionY: 85 });

        expect(setDisplaySettings).toHaveBeenCalledWith({
            scale: 2.25,
            verticalOffset: 0,
        });
    });
});

it('preserves authored ASS styles when user size and server multipliers change', () => {
    const manager = new SubtitleRendererManager({ sizeMultiplier: 2, pgsScale: 100 });
    const styleOverride = vi.fn();
    Object.assign(manager, { assRenderer: { styleOverride } });

    manager.applyStyle({ fontSize: 2, textColor: '#ff0000', positionY: 50 });

    expect(styleOverride).not.toHaveBeenCalled();
});
