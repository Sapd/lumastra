// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConsoleKnob from './ConsoleKnob.svelte';

afterEach(cleanup);

describe('console knob keyboard and pointer interaction', () => {
    it.each([
        ['ArrowUp', 0.55],
        ['ArrowRight', 0.55],
        ['ArrowDown', 0.45],
        ['ArrowLeft', 0.45],
        ['Home', 0],
        ['End', 1],
    ])('%s updates the value and prevents page scrolling', async (key, expected) => {
        const onchange = vi.fn();
        render(ConsoleKnob, { label: 'Energy', value: 0.5, onchange });
        const slider = screen.getByRole('slider', { name: 'Energy' });
        const event = new KeyboardEvent('keydown', {
            key: String(key),
            bubbles: true,
            cancelable: true,
        });
        await fireEvent(slider, event);
        expect(event.defaultPrevented).toBe(true);
        expect(onchange).toHaveBeenCalledOnce();
        expect(onchange.mock.calls[0][0]).toBeCloseTo(Number(expected));
        expect(Number(slider.getAttribute('aria-valuenow'))).toBe(
            Math.round(Number(expected) * 100),
        );
    });

    it('clamps repeated arrow changes at both ends', async () => {
        const onchange = vi.fn();
        render(ConsoleKnob, { label: 'Energy', value: 0.99, onchange });
        const slider = screen.getByRole('slider');
        await fireEvent.keyDown(slider, { key: 'ArrowUp' });
        await fireEvent.keyDown(slider, { key: 'ArrowUp' });
        expect(onchange).toHaveBeenLastCalledWith(1);
        await fireEvent.keyDown(slider, { key: 'Home' });
        await fireEvent.keyDown(slider, { key: 'ArrowDown' });
        expect(onchange).toHaveBeenLastCalledWith(0);
        expect(
            onchange.mock.calls.every(
                ([value]) => typeof value === 'number' && value >= 0 && value <= 1,
            ),
        ).toBe(true);
    });

    it('leaves unrelated keys available to the browser', async () => {
        const onchange = vi.fn();
        render(ConsoleKnob, { label: 'Energy', onchange });
        const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        await fireEvent(screen.getByRole('slider'), event);
        expect(event.defaultPrevented).toBe(false);
        expect(onchange).not.toHaveBeenCalled();
    });

    it('offers increment and decrement buttons that report the same 0.05 steps', async () => {
        const onchange = vi.fn();
        render(ConsoleKnob, { label: 'Energy', value: 0.5, onchange });
        const slider = screen.getByRole('slider');
        await fireEvent.click(screen.getByRole('button', { name: 'Increase Energy' }));
        expect(onchange).toHaveBeenLastCalledWith(0.55);
        expect(slider.getAttribute('aria-valuenow')).toBe('55');
        await fireEvent.click(screen.getByRole('button', { name: 'Decrease Energy' }));
        expect(onchange).toHaveBeenLastCalledWith(0.5);
        expect(slider.getAttribute('aria-valuenow')).toBe('50');
    });

    it('associates tap controls with a unique live value for each knob', async () => {
        render(ConsoleKnob, { label: 'Energy', value: 0.5 });
        render(ConsoleKnob, { label: 'Tempo', value: 0.25 });
        const energy = screen.getByRole('button', { name: 'Increase Energy' });
        const tempo = screen.getByRole('button', { name: 'Increase Tempo' });
        const energyId = energy.getAttribute('aria-describedby');
        const tempoId = tempo.getAttribute('aria-describedby');
        expect(energyId).toBeTruthy();
        expect(tempoId).toBeTruthy();
        expect(energyId).not.toBe(tempoId);
        const status = document.getElementById(energyId ?? '');
        expect(status?.getAttribute('role')).toBe('status');
        expect(status?.getAttribute('aria-live')).toBe('polite');
        expect(status?.textContent).toContain('50%');
        await fireEvent.click(energy);
        expect(status?.textContent).toContain('55%');
        expect(document.getElementById(tempoId ?? '')?.textContent).toContain('25%');
    });

    it.each([
        [0.99, 'Increase Energy', 1],
        [0.01, 'Decrease Energy', 0],
    ])('clamps button changes starting at %s', async (initial, name, expected) => {
        const onchange = vi.fn();
        render(ConsoleKnob, { label: 'Energy', value: Number(initial), onchange });
        const button = screen.getByRole('button', { name: String(name) });
        await fireEvent.click(button);
        await fireEvent.click(button);
        expect(onchange).toHaveBeenCalledTimes(2);
        expect(onchange).toHaveBeenLastCalledWith(expected);
        expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe(
            String(Number(expected) * 100),
        );
    });

    it('stops changing the value after a pointer drag is cancelled', async () => {
        const onchange = vi.fn();
        render(ConsoleKnob, { label: 'Energy', value: 0.5, onchange });
        const slider = screen.getByRole('slider');
        const release = vi.fn();
        Object.defineProperties(slider, {
            setPointerCapture: { value: vi.fn() },
            hasPointerCapture: { value: () => true },
            releasePointerCapture: { value: release },
        });
        await fireEvent.pointerDown(slider, { button: 0, clientY: 100, pointerId: 1 });
        await fireEvent.pointerMove(slider, { clientY: 40, pointerId: 1 });
        expect(onchange).toHaveBeenLastCalledWith(1);
        await fireEvent.pointerCancel(slider, { pointerId: 1 });
        onchange.mockClear();
        await fireEvent.pointerMove(slider, { clientY: 200, pointerId: 1 });
        expect(onchange).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledWith(1);
    });
});
