// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TrackTitleLine from './TrackTitleLine.svelte';
import { openArtistModal } from '$lib/utils/modal-utils';

vi.mock('$lib/utils/modal-utils', () => ({ openArtistModal: vi.fn() }));

afterEach(cleanup);

describe('TrackTitleLine', () => {
    it('links a separate remixer identity and follows the current credit after a track change', async () => {
        const { container, rerender } = render(TrackTitleLine, {
            props: {
                title: 'Harbortime (Ekoglow Remix)',
                artists: [{ id: 'performer', title: 'Northlight' }],
                remixerArtists: [{ id: 'eko', title: 'Ekoglow' }],
            },
        });
        const button = container.querySelector('button');
        expect(button?.textContent).toBe('Ekoglow');
        await fireEvent.click(button!);
        expect(openArtistModal).toHaveBeenLastCalledWith('eko');
        await rerender({
            title: 'Harbortime (Ekoglow Remix)',
            artists: [{ id: 'performer', title: 'Northlight' }],
            remixerArtists: [{ id: 'replacement', title: 'Ekoglow' }],
        });
        await fireEvent.click(container.querySelector('button')!);
        expect(openArtistModal).toHaveBeenLastCalledWith('replacement');
        expect(container.textContent).toBe('Harbortime (Ekoglow Remix)');
    });

    it('renders the title byte-for-byte with a linked remixer (no injected whitespace)', () => {
        const { container } = render(TrackTitleLine, {
            props: {
                title: 'Harbortime (Ekoglow Remix)',
                artists: [{ id: 'eko', title: 'Ekoglow' }],
            },
        });
        expect(container.textContent).toBe('Harbortime (Ekoglow Remix)');
    });

    it('renders plain text when nothing resolves', () => {
        const { container } = render(TrackTitleLine, {
            props: { title: 'Harbortime (radio edit)', artists: [] },
        });
        expect(container.textContent).toBe('Harbortime (radio edit)');
        expect(container.querySelector('button')).toBeNull();
    });

    it('with onPlainClick, unlinked segments are buttons and text is still exact', () => {
        const onPlainClick = vi.fn();
        const { container } = render(TrackTitleLine, {
            props: {
                title: 'Harbortime (Ekoglow Remix)',
                artists: [{ id: 'eko', title: 'Ekoglow' }],
                onPlainClick,
            },
        });
        expect(container.textContent).toBe('Harbortime (Ekoglow Remix)');
        const buttons = container.querySelectorAll('button');
        expect(buttons.length).toBeGreaterThanOrEqual(2);
    });

    it('a blank/whitespace-only title with onPlainClick never renders an unnamed button', () => {
        const onPlainClick = vi.fn();
        const { container } = render(TrackTitleLine, {
            props: { title: '  ', onPlainClick },
        });
        expect(container.querySelector('button')).toBeNull();
    });

    it('with onPlainClick, no plain button carries edge whitespace (browser would collapse it)', () => {
        // Regression: "Berlin (Marina Radio Edit)" rendered "(ManilaRadio Edit)"
        // because the plain segment " Radio Edit)" kept its leading space
        // INSIDE the button, where the inline formatting context collapses it.
        const onPlainClick = vi.fn();
        const { container } = render(TrackTitleLine, {
            props: {
                title: 'Berlin (feat. Milo Sebastian) (Marina Radio Edit)',
                artists: [{ id: 'marina', title: 'Marina' }],
                onPlainClick,
            },
        });
        expect(container.textContent).toBe('Berlin (feat. Milo Sebastian) (Marina Radio Edit)');
        for (const button of container.querySelectorAll('button')) {
            expect(button.textContent).not.toMatch(/^\s|\s$/);
        }
    });

    it('plain segments carry no hover styling — only the caller-provided class', async () => {
        // Design decision (user feedback): the title must not underline on
        // hover — only real artist links do. Plain segments stay visually
        // inert (pointer cursor via plainClass) even while clickable.
        const onPlainClick = vi.fn();
        const { container } = render(TrackTitleLine, {
            props: {
                title: 'Berlin (feat. Milo Sebastian) (Marina Radio Edit)',
                artists: [{ id: 'marina', title: 'Marina' }],
                onPlainClick,
                plainClass: 'cursor-pointer',
            },
        });
        const plainButtons = [...container.querySelectorAll('button.cursor-pointer')];
        expect(plainButtons.length).toBeGreaterThanOrEqual(2);
        plainButtons[0].dispatchEvent(new MouseEvent('mouseenter'));
        await Promise.resolve();
        for (const button of plainButtons) {
            expect(button.className).toBe('cursor-pointer');
        }
    });
});
