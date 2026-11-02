// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * A glossary term must not emit a trailing space.
 *
 * Callers write `<TermTooltip term="task">Active</TermTooltip>:` — no space in
 * the markup — yet prod rendered "Active :". The newline between
 * `{@render children?.()}` and the `{#if open}` block became a real text node
 * INSIDE the underlined span, so every term in the admin picked up a trailing
 * space and the dotted underline ran past the word.
 *
 * Found by reading the rendered outerHTML on prod, not the source: the source
 * has no space in it. Asserting on `textContent` here is the closest a DOM
 * test gets to that — happy-dom has no layout engine, so the underline overrun
 * itself is only visible in a real browser.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { createRawSnippet } from 'svelte';

import TermTooltip from './TermTooltip.svelte';

function label(text: string) {
    return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe('TermTooltip whitespace', () => {
    afterEach(cleanup);

    it('renders the term with no trailing space', () => {
        const { container } = render(TermTooltip, {
            term: 'task',
            children: label('Active'),
        } as never);
        // "Active " would render as "Active :" at the call site.
        expect(container.textContent).toBe('Active');
    });

    it('still renders the label when the term is unknown to the glossary', () => {
        // The {:else} branch renders children bare; it must not regress either.
        const { container } = render(TermTooltip, {
            term: 'not-a-real-glossary-key',
            children: label('Active'),
        } as never);
        expect(container.textContent?.trim()).toBe('Active');
    });

    it('underlines only the label, not the whitespace around it', () => {
        const { container } = render(TermTooltip, {
            term: 'task',
            children: label('Active'),
        } as never);
        const underlined = container.querySelector('.border-dotted');
        expect(underlined).toBeTruthy();
        expect(underlined?.textContent).toBe('Active');
    });
});
