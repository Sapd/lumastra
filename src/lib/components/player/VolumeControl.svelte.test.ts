// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import VolumeControl from './VolumeControl.svelte';
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

it('allows keyboard and assistive activation of mute without a preceding mouse press', async () => {
    const onmute = vi.fn();
    const view = render(VolumeControl, { volume: 1, isMuted: false, onmute });
    await fireEvent.click(view.getByRole('button'), { detail: 0 });
    expect(onmute).toHaveBeenCalledOnce();
});

it('does not mute after a quick volume-icon drag', async () => {
    const onmute = vi.fn();
    const onvolume = vi.fn();
    const view = render(VolumeControl, { volume: 1, isMuted: false, onmute, onvolume });
    const button = view.getByRole('button');
    await fireEvent.mouseDown(button, { clientX: 100 });
    await fireEvent.mouseMove(document, { clientX: 70 });
    await fireEvent.mouseUp(document);
    await fireEvent.click(button, { detail: 1 });
    expect(onvolume).toHaveBeenCalled();
    expect(onmute).not.toHaveBeenCalled();
});

it('removes drag listeners when the control unmounts', async () => {
    const onvolume = vi.fn();
    const view = render(VolumeControl, { volume: 1, isMuted: false, onvolume });
    await fireEvent.mouseDown(view.getByRole('button'), { clientX: 100 });
    view.unmount();
    await fireEvent.mouseMove(document, { clientX: 70 });
    expect(onvolume).not.toHaveBeenCalled();
});

it('a mobile sound-button touch remains a mute action despite movement and a slow release', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);
    const mediaQuery = vi
        .spyOn(window, 'matchMedia')
        .mockReturnValue({ matches: true } as MediaQueryList);
    const onmute = vi.fn();
    const onvolume = vi.fn();
    const view = render(VolumeControl, { volume: 1, isMuted: true, onmute, onvolume });
    const button = view.getByRole('button', { name: 'Unmute' });
    await fireEvent.touchStart(button, { touches: [{ clientX: 100 }] });
    now.mockReturnValue(500);
    await fireEvent.touchMove(document, { touches: [{ clientX: 80 }] });
    await fireEvent.touchEnd(document);
    await fireEvent.click(button, { detail: 1 });
    expect(onvolume).not.toHaveBeenCalled();
    expect(onmute).toHaveBeenCalledOnce();
    mediaQuery.mockRestore();
});
