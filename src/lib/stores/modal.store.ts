// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { writable, derived, get, type Readable } from 'svelte/store';
import type { Component } from 'svelte';

// Svelte 5 component type - accepts any props
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = Component<any, any, any>;

export interface ModalEntry<T = Record<string, unknown>> {
    id: string;
    component: AnyComponent;
    props: T;
    options?: ModalOptions;
    /** Resolves when THIS entry is finally closed. Reused across in-place swaps. */
    closed?: Promise<void>;
}

export interface ModalOptions {
    closeOnBackdrop?: boolean; // Default: true
    closeOnEscape?: boolean; // Default: true
    containerClass?: string;
    ariaLabel?: string; // Accessible name for the dialog (screen readers)
    kind?: 'music' | string; // Semantic tag used by surrounding chrome (e.g., MiniPlayer)
    onClosed?: () => void;
    beforeClose?: () => boolean | Promise<boolean>; // Can veto close
    /** Entity identity for the trail model: same key as top → swap; else push. */
    trailKey?: string;
    /** Human label for the back button that returns to this entry. */
    trailLabel?: string;
    /**
     * Backdrop click leaves the WHOLE trail (like the X) instead of stepping
     * one entry back. Set on entity modals that render their own back button —
     * without it, clicking outside "reopens" the previous card, which reads as
     * the dismissal failing. Sub-dialogs (confirm, pickers) leave this off so
     * their backdrop returns to the card that opened them.
     */
    backdropClosesTrail?: boolean;
}

const DEFAULT_OPTIONS: ModalOptions = {
    closeOnBackdrop: true,
    closeOnEscape: true,
    containerClass: '',
};

// Internal stack store
const stack = writable<ModalEntry[]>([]);

// UUID generator with fallback
function generateId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Open a modal and add it to the stack
 * Returns an object with the modal ID and a promise that resolves when closed
 */
function open<T extends Record<string, unknown>>(
    component: AnyComponent,
    props: T,
    options?: ModalOptions,
    retained: ModalEntry[] = get(stack),
): { id: string; closed: Promise<void> } {
    const id = generateId();

    let resolveClose: () => void;
    const closed = new Promise<void>((resolve) => {
        resolveClose = resolve;
    });

    const wrappedOptions: ModalOptions = {
        ...DEFAULT_OPTIONS,
        ...options,
        onClosed: () => {
            options?.onClosed?.();
            resolveClose();
        },
    };

    stack.set([...retained, { id, component, props, options: wrappedOptions, closed }]);

    return { id, closed };
}

/**
 * Swap the TOP entry's content in place — same id, same mounted component
 * instance — so a same-entity content change (season/episode within a series)
 * updates reactively instead of tearing the modal down and rebuilding it. That
 * remount is what makes the backdrop fade out/in and the whole page flicker on
 * every episode click. Preserves the top's wrapped onClosed so its original
 * `closed` promise still settles on the eventual real close.
 */
function swapTopInPlace<T extends Record<string, unknown>>(
    component: AnyComponent,
    props: T,
    options?: ModalOptions,
): { id: string; closed: Promise<void> } {
    const current = get(stack);
    const top = current[current.length - 1];
    if (!top) return open(component, props, options);

    const mergedOptions: ModalOptions = {
        ...top.options,
        ...options,
        // Keep the live close handler (holds this entry's resolveClose).
        onClosed: top.options?.onClosed,
    };

    stack.update((s) => {
        const next = [...s];
        next[next.length - 1] = { ...top, component, props, options: mergedOptions };
        return next;
    });

    return { id: top.id, closed: top.closed ?? Promise.resolve() };
}

/**
 * Close the top modal
 * Calls beforeClose hook if defined (can veto)
 */
async function close(): Promise<void> {
    const current = get(stack);
    if (current.length === 0) return;

    const closing = current[current.length - 1];

    // Call beforeClose hook if defined
    if (closing.options?.beforeClose) {
        const shouldClose = await closing.options.beforeClose();
        if (!shouldClose) return; // Veto close
    }

    if (!get(stack).some((entry) => entry.id === closing.id)) return;
    closing.options?.onClosed?.();
    stack.update((entries) => entries.filter((entry) => entry.id !== closing.id));
}

/**
 * Close a specific modal by ID
 */
async function closeById(id: string): Promise<void> {
    const current = get(stack);
    const index = current.findIndex((m) => m.id === id);

    if (index === -1) return;

    const closing = current[index];

    // Call beforeClose hook if defined
    if (closing.options?.beforeClose) {
        const shouldClose = await closing.options.beforeClose();
        if (!shouldClose) return; // Veto close
    }

    // Call onClosed callback
    closing.options?.onClosed?.();

    // Remove from stack
    stack.update((s) => s.filter((m) => m.id !== id));
}

/**
 * Close all modals (the "X" / Done gesture in the trail model).
 * Consults the top entry's beforeClose hook — a veto aborts the whole close
 * so unsaved-state guards still protect the visible card.
 */
async function closeAll(): Promise<void> {
    const current = get(stack);
    if (current.length === 0) return;

    const top = current[current.length - 1];
    if (top.options?.beforeClose) {
        const shouldClose = await top.options.beforeClose();
        if (!shouldClose) return; // Veto aborts the whole close
    }

    // Call onClosed for all modals
    current.forEach((modal) => {
        modal.options?.onClosed?.();
    });

    stack.set([]);
}

/**
 * Replace the top modal with a new one
 * Useful for loading states or workflow progressions
 */
function replace<T extends Record<string, unknown>>(
    component: AnyComponent,
    props: T,
    options?: ModalOptions,
): { id: string; closed: Promise<void> } {
    const current = get(stack);

    // Swap: resolve the outgoing entry's closed promise so any awaiter doesn't
    // hang forever, then remove it.
    if (current.length > 0) {
        const outgoing = current[current.length - 1];
        outgoing.options?.onClosed?.();
    }

    // Publish one transition so URL subscribers never see a temporary parent.
    return open(component, props, options, current.slice(0, -1));
}

const TRAIL_SOFT_CAP = 8;

/**
 * Open a modal as a trail step. Swap-vs-push is decided by `options.trailKey`:
 * - same key as the current top    → replace (content swap, no growth)
 * - key already deeper in the stack → cycle-collapse back to it, then swap
 * - otherwise                       → push (entity jump), dropping the oldest
 *   step once past the soft cap.
 *
 * With no trailKey it behaves exactly like `open`.
 */
function openEntity<T extends Record<string, unknown>>(
    component: AnyComponent,
    props: T,
    options?: ModalOptions,
): { id: string; closed: Promise<void> } {
    const key = options?.trailKey;
    if (!key) return open(component, props, options);

    const current = get(stack);
    const top = current[current.length - 1];

    // Same entity as the visible card → swap content in place (no remount, so
    // the backdrop stays put and the page doesn't flicker).
    if (top?.options?.trailKey === key) {
        return swapTopInPlace(component, props, options);
    }

    // Entity already on the trail → collapse back to it: close the steps at and
    // above it (resolving their promises) and reopen fresh, keeping everything
    // beneath untouched.
    const existingIdx = current.findIndex((e) => e.options?.trailKey === key);
    if (existingIdx >= 0) {
        current.slice(existingIdx).forEach((entry) => entry.options?.onClosed?.());
        return open(component, props, options, current.slice(0, existingIdx));
    }

    // New entity jump → push, enforcing the soft cap by dropping the oldest step.
    if (current.length >= TRAIL_SOFT_CAP) {
        const dropped = current[0];
        dropped.options?.onClosed?.();
        return open(component, props, options, current.slice(1));
    }
    return open(component, props, options);
}

/**
 * Merge partial props into an existing modal entry.
 * Useful when a modal loads additional metadata after opening.
 */
function updateProps<T extends Record<string, unknown>>(
    id: string,
    partialProps: Partial<T>,
): void {
    stack.update((entries) => {
        let changed = false;

        const nextEntries = entries.map((entry) => {
            if (entry.id !== id) return entry;
            changed = true;
            return {
                ...entry,
                props: {
                    ...entry.props,
                    ...partialProps,
                },
            };
        });

        return changed ? nextEntries : entries;
    });
}

// Derived stores
export const modalStack: Readable<ModalEntry[]> = derived(stack, ($stack) => $stack);

export const hasModals: Readable<boolean> = derived(stack, ($stack) => $stack.length > 0);

export const topModal: Readable<ModalEntry | null> = derived(
    stack,
    ($stack) => $stack[$stack.length - 1] || null,
);

export const topModalKind: Readable<string | null> = derived(
    stack,
    ($stack) => $stack[$stack.length - 1]?.options?.kind ?? null,
);

export const modalCount: Readable<number> = derived(stack, ($stack) => $stack.length);

/** The entry directly beneath the top — the trail step a back button returns to. */
export const trailPrev: Readable<ModalEntry | null> = derived(stack, ($stack) =>
    $stack.length >= 2 ? $stack[$stack.length - 2] : null,
);

// Main modal API
export const modals = {
    open,
    openEntity,
    close,
    closeAll,
    closeById,
    replace,
    updateProps,
    get stack() {
        return get(stack);
    },
    get count() {
        return get(stack).length;
    },
    get hasAny() {
        return get(stack).length > 0;
    },
};
