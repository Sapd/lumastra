// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDocumentTitleOverride, stopDocumentTitleOverride } from './document-title';

/**
 * Stands in for what a page does on navigation: Svelte compiles
 * `<svelte:head><title>` to exactly this assignment.
 */
function pageSetsTitle(title: string): void {
    document.title = title;
}

/** MutationObserver callbacks land on the microtask queue. */
async function flushObserver(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('document-title override', () => {
    beforeEach(() => {
        document.title = 'Page A';
    });

    afterEach(() => {
        stopDocumentTitleOverride();
    });

    it('paints the override over the page title', () => {
        setDocumentTitleOverride('▶ Song');
        expect(document.title).toBe('▶ Song');
    });

    it('restores the page title when the override is cleared', () => {
        setDocumentTitleOverride('▶ Song');
        setDocumentTitleOverride(null);
        expect(document.title).toBe('Page A');
    });

    it('re-asserts the override after a page sets its own title', async () => {
        setDocumentTitleOverride('▶ Song');

        pageSetsTitle('Page B');
        await flushObserver();

        expect(document.title).toBe('▶ Song');
    });

    it('restores the title the last-navigated page set, not the one at start', async () => {
        setDocumentTitleOverride('▶ Song');

        pageSetsTitle('Page B');
        await flushObserver();
        setDocumentTitleOverride(null);

        expect(document.title).toBe('Page B');
    });

    it('settles instead of ping-ponging with the page', async () => {
        setDocumentTitleOverride('▶ Song');

        pageSetsTitle('Page B');
        await flushObserver();
        // A feedback loop would keep rewriting; give it room to show itself.
        await flushObserver();
        await flushObserver();

        expect(document.title).toBe('▶ Song');
    });

    it('tracks page titles while no override is active', async () => {
        setDocumentTitleOverride(null);

        pageSetsTitle('Page B');
        await flushObserver();

        expect(document.title).toBe('Page B');
    });

    it('follows the current track through override changes', () => {
        setDocumentTitleOverride('▶ Song One');
        setDocumentTitleOverride('▶ Song Two');
        expect(document.title).toBe('▶ Song Two');
    });

    it('hands the title back on teardown', () => {
        setDocumentTitleOverride('▶ Song');
        stopDocumentTitleOverride();
        expect(document.title).toBe('Page A');
    });

    describe('titles the browser normalizes on read', () => {
        // Browsers "strip and collapse ASCII whitespace" when READING
        // document.title, so a written title with a double space reads back
        // different. Mirror that explicitly (DOM shims may not), and cap the
        // writes so a feedback loop fails the test instead of starving the
        // microtask queue — the real bug froze the whole tab.
        let writes = 0;

        beforeEach(() => {
            let proto: object | null = Object.getPrototypeOf(document);
            let native: PropertyDescriptor | undefined;
            while (proto && !native) {
                native = Object.getOwnPropertyDescriptor(proto, 'title');
                proto = Object.getPrototypeOf(proto);
            }
            if (!native?.get || !native.set) throw new Error('no native document.title accessor');
            writes = 0;
            Object.defineProperty(document, 'title', {
                configurable: true,
                get() {
                    return (native!.get!.call(this) as string)
                        .replace(/[\t\n\f\r ]+/g, ' ')
                        .replace(/^ | $/g, '');
                },
                set(value: string) {
                    if (++writes > 20) throw new Error('document.title write loop');
                    native!.set!.call(this, value);
                },
            });
        });

        afterEach(() => {
            stopDocumentTitleOverride();
            delete (document as { title?: string }).title;
        });

        it('does not loop on an override whose whitespace the browser collapses', async () => {
            setDocumentTitleOverride('▶ Falling Apart  (Radio Mix) · San Diego');
            for (let i = 0; i < 5; i++) await flushObserver();

            expect(writes).toBeLessThanOrEqual(2);
            expect(document.title).toBe('▶ Falling Apart (Radio Mix) · San Diego');
        });

        it('keeps the page title as its base, not the collapsed override', async () => {
            setDocumentTitleOverride('▶ Song  Two ');
            for (let i = 0; i < 5; i++) await flushObserver();
            setDocumentTitleOverride(null);

            expect(document.title).toBe('Page A');
        });

        it('settles when a page sets a title with extra whitespace', async () => {
            setDocumentTitleOverride('▶ Song');
            pageSetsTitle('  Page   B ');
            for (let i = 0; i < 5; i++) await flushObserver();

            expect(writes).toBeLessThanOrEqual(3);
            expect(document.title).toBe('▶ Song');
            setDocumentTitleOverride(null);
            expect(document.title).toBe('Page B');
        });
    });

    it('stops re-asserting after teardown', async () => {
        setDocumentTitleOverride('▶ Song');
        stopDocumentTitleOverride();

        pageSetsTitle('Page B');
        await flushObserver();

        expect(document.title).toBe('Page B');
    });
});
