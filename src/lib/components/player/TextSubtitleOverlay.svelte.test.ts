// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, expect, test } from 'vitest';
import TextSubtitleOverlay from './TextSubtitleOverlay.svelte';

afterEach(cleanup);

test('rendered text caption follows the effective line and appearance without remounting', async () => {
    const view = render(TextSubtitleOverlay, {
        cue: 'Subtitle position regression',
        inlineStyle: 'color: rgb(255, 255, 255); background: transparent',
        positionY: 85,
    });
    const overlay = view.container.querySelector('.portrait-subtitle-overlay') as HTMLElement;
    const text = overlay.querySelector('.portrait-subtitle-text') as HTMLElement;
    expect(overlay.style.top).toBe('85%');
    expect(overlay.style.transform).toBe('translateY(-50%)');

    await view.rerender({
        cue: 'Updated cue',
        inlineStyle: 'color: rgb(255, 204, 204); background: transparent',
        positionY: 64,
    });
    expect(view.container.querySelector('.portrait-subtitle-overlay')).toBe(overlay);
    expect(overlay.style.top).toBe('64%');
    expect(text.textContent).toBe('Updated cue');
    expect(text.style.color).toBe('rgb(255, 204, 204)');
});
