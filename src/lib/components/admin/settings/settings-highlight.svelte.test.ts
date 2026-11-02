// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { scrollToSetting } from '$lib/utils/admin/settings-highlight';

type AnimationCallback = (time: number) => void;

afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it('cancels an old layout wait when a newer location takes over', async () => {
    const callbacks: AnimationCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: AnimationCallback): number =>
        callbacks.push(callback),
    );
    document.body.innerHTML = '<div id="setting-OLD"></div>';
    const old = document.getElementById('setting-OLD')!;
    const scroll = vi.fn();
    old.scrollIntoView = scroll;
    let current = true;
    const pending = scrollToSetting({
        sectionId: 'one',
        settingKey: 'OLD',
        isCurrent: () => current,
    });
    await tick();
    current = false;
    while (callbacks.length) callbacks.shift()!(0);
    expect(await pending).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
    expect(old.classList.contains('search-highlight')).toBe(false);
});

it('cancels the delayed smooth-scroll correction after navigation', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: AnimationCallback): number => {
        callback(0);
        return 1;
    });
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: false }),
    });
    document.body.innerHTML = '<div id="setting-OLD"></div>';
    const old = document.getElementById('setting-OLD')!;
    const scroll = vi.fn();
    old.scrollIntoView = scroll;
    let current = true;
    await scrollToSetting({ sectionId: 'one', settingKey: 'OLD', isCurrent: () => current });
    expect(scroll).toHaveBeenCalledTimes(1);
    current = false;
    vi.advanceTimersByTime(450);
    expect(scroll).toHaveBeenCalledTimes(1);
});

it('keeps the newest flash when overlapping operations reselect the same target', async () => {
    const callbacks: AnimationCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: AnimationCallback): number =>
        callbacks.push(callback),
    );
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: true }),
    });
    document.body.innerHTML = '<div id="setting-SAME"></div>';
    const target = document.getElementById('setting-SAME')!;
    target.scrollIntoView = vi.fn();
    let generation = 1;
    const first = scrollToSetting({
        sectionId: 'one',
        settingKey: 'SAME',
        isCurrent: () => generation === 1,
    });
    await tick();
    generation = 2;
    const second = scrollToSetting({
        sectionId: 'one',
        settingKey: 'SAME',
        isCurrent: () => generation === 2,
    });
    await tick();
    while (callbacks.length) callbacks.shift()!(0);
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(target.classList.contains('search-highlight')).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
});
