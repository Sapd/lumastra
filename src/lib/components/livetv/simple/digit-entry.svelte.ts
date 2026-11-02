// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Typing a channel number like on a TV remote. The digits stay on screen in
 * large type; the channel tunes after a generous pause (older viewers look
 * from the keys to the screen between digits) or at once on Enter.
 */

export const DIGIT_COMMIT_MS = 3000;
const MAX_DIGITS = 2;

export class DigitEntry {
    digits = $state('');
    #timer: ReturnType<typeof setTimeout> | undefined;
    #commit: (num: number) => void;
    #maxNumber: () => number;

    /** `maxNumber`: the highest channel number; no wait when no more digit can follow. */
    constructor(commit: (num: number) => void, maxNumber: () => number) {
        this.#commit = commit;
        this.#maxNumber = maxNumber;
    }

    push(digit: string): void {
        // A full number is about to tune; a third digit must not shift it.
        if (this.digits.length >= MAX_DIGITS) return;
        this.digits += digit;
        clearTimeout(this.#timer);
        const typed = Number.parseInt(this.digits, 10);
        if (this.digits.length >= MAX_DIGITS || typed * 10 > this.#maxNumber()) {
            this.#timer = setTimeout(() => this.commit(), 600);
        } else {
            this.#timer = setTimeout(() => this.commit(), DIGIT_COMMIT_MS);
        }
    }

    commit(): void {
        clearTimeout(this.#timer);
        const num = Number.parseInt(this.digits, 10);
        this.digits = '';
        if (Number.isFinite(num) && num > 0) this.#commit(num);
    }

    cancel(): void {
        clearTimeout(this.#timer);
        this.digits = '';
    }

    get active(): boolean {
        return this.digits.length > 0;
    }
}

/** A plain digit key without modifiers (top row or numpad). */
export function digitOf(e: KeyboardEvent): string | null {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    return /^[0-9]$/.test(e.key) ? e.key : null;
}

/** Key events that come from typing into a field must not zap. */
export function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
        target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'
    );
}
