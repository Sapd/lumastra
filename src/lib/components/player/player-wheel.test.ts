// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { playerWheelAction } from './player-wheel';

afterEach(() => document.body.replaceChildren());

describe('player wheel scrolling', () => {
    it.each(['player-menu', 'player-drawer'])(
        'preserves native scrolling inside %s, including nested subtitle settings',
        (className) => {
            const player = document.createElement('div');
            player.innerHTML = `<div class="${className}"><div><button>Subtitle</button></div></div>`;
            document.body.append(player);
            const volumeShortcut = vi.fn((event: WheelEvent) => event.preventDefault());
            const action = playerWheelAction(player, volumeShortcut);
            const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });

            player.querySelector('button')!.dispatchEvent(event);

            expect(event.defaultPrevented).toBe(false);
            expect(volumeShortcut).not.toHaveBeenCalled();
            action.destroy();
        },
    );

    it('retains volume scrolling on the video surface and removes the listener on teardown', () => {
        const player = document.createElement('div');
        const video = document.createElement('video');
        player.append(video);
        document.body.append(player);
        const volumeShortcut = vi.fn((event: WheelEvent) => event.preventDefault());
        const action = playerWheelAction(player, volumeShortcut);
        const wheel = (): WheelEvent =>
            new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
        const event = wheel();
        video.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(volumeShortcut).toHaveBeenCalledOnce();

        action.destroy();
        const afterDestroy = wheel();
        video.dispatchEvent(afterDestroy);
        expect(afterDestroy.defaultPrevented).toBe(false);
        expect(volumeShortcut).toHaveBeenCalledOnce();
    });
});
