// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { toastDefaultTimeoutMs } from './client-tuning.js';
import { reportUserFacingFailure } from '$lib/client-diagnostics/web-reporter.js';

/** Live TV simple mode keeps an error toast up at least this long. */
export const CALM_ERROR_TIMEOUT_MS = 20_000;

export type ToastType = 'success' | 'error' | 'warning' | 'info';

/**
 * Optional inline action on a toast (e.g. the "Undo" button for a
 * dismissal). Click dispatches `onClick` and auto-removes the toast
 * — callers don't need to call `remove` themselves.
 */
export interface ToastAction {
    /** Button label ("Undo", "Retry", etc.) */
    label: string;
    /** Invoked when the user clicks the action button */
    onClick: () => void;
}

export interface Toast {
    id: number;
    message: string;
    type: ToastType;
    timeout?: number;
    action?: ToastAction;
    /**
     * Maps to the `aria-live` attribute of the rendered toast region. Defaults
     * to undefined → no aria-live (relying on the container's polite default).
     * Set 'polite' or 'assertive' when the toast carries information that a
     * screen-reader user must hear, e.g. a session-supersede warning.
     */
    ariaLive?: 'polite' | 'assertive';
}

/** Extra options when creating a toast via the typed helpers. */
export interface ToastOptions {
    timeout?: number;
    action?: ToastAction;
    ariaLive?: 'polite' | 'assertive';
    /**
     * Error toasts only: the message KEY reported to Admin → Client diagnostics
     * (`audiobook_playback_failed`). Every error toast is reported; without a key
     * it is grouped as `untagged` by page and the API call that failed just before.
     * The toast text itself is never sent — it can carry titles or search terms.
     */
    diagnosticKey?: string;
    /** Error toasts only: the error behind the message, reported scrubbed. */
    diagnosticError?: unknown;
}

function createToastStore() {
    let toasts = $state<Toast[]>([]);
    let toastId = 0;
    /** Live TV simple-mode screens open right now (they can overlap on navigation). */
    let calmHolders = 0;
    const subscribers: Array<(value: Toast[]) => void> = [];

    function notify(): void {
        for (const fn of subscribers) {
            fn(toasts);
        }
    }

    /**
     * True when this toast is being pushed from an `/admin` page. The design
     * spec's "error toasts require acknowledge to dismiss" rule (§6/§7) is
     * explicitly scoped to the admin redesign ("Scope: The whole /admin
     * area" — §1; "Out of scope: ... main-app (non-admin) UI" — §8). This
     * store is a single global singleton shared by both the admin UI and the
     * consumer-facing app (`routes/+layout.svelte` and
     * `routes/admin/+layout.svelte` mount the same `ToastContainer`/store),
     * so the rule must not apply unconditionally — that would make every
     * failed "add to watchlist"/"rate"/"search" toast in the main app linger
     * forever instead of auto-clearing after 5s, a UX regression outside
     * this project's scope. Outside the browser (SSR, or this store's own
     * node-environment unit tests, which don't set up `window`) there is no
     * route to check; default to the safe/sticky admin behavior rather than
     * silently dropping an error toast's visibility guarantee.
     */
    function isAdminRoute(): boolean {
        return typeof window === 'undefined' || window.location.pathname.startsWith('/admin');
    }

    /**
     * Shared helper: appends a toast and schedules its removal. Kept
     * local so both the generic `show()` entry point and the typed
     * helpers (`success`, `error`, ...) share one implementation.
     *
     * Admin IA redesign, spec §6/§7: on `/admin` pages, "error toasts require
     * acknowledge to dismiss" — an error toast NEVER auto-times-out there,
     * regardless of what timeout the caller passed (or the configured default,
     * TOAST_DEFAULT_TIMEOUT_MS, 5s out of the box). The
     * user must click the dismiss button (or an inline action). Elsewhere in
     * the app (out of this redesign's scope), error toasts keep their
     * original caller-timeout-or-default behavior.
     */
    function push(message: string, type: ToastType, options?: ToastOptions): number {
        // Live TV simple mode: no surprise popups. Only errors show, and they
        // stay long enough to be read.
        const calm = calmHolders > 0;
        if (type === 'error') {
            reportUserFacingFailure({
                key: options?.diagnosticKey,
                error: options?.diagnosticError,
            });
        }
        if (calm && type !== 'error') return 0;
        const id = ++toastId;
        const timeout =
            type === 'error' && isAdminRoute()
                ? 0
                : calm && options?.timeout !== 0
                  ? Math.max(options?.timeout ?? 0, CALM_ERROR_TIMEOUT_MS)
                  : (options?.timeout ?? toastDefaultTimeoutMs());
        const toast: Toast = { id, message, type, timeout };
        if (options?.action) toast.action = options.action;
        if (options?.ariaLive) toast.ariaLive = options.ariaLive;

        toasts = [...toasts, toast];
        notify();

        if (timeout > 0) {
            setTimeout(() => {
                toasts = toasts.filter((t) => t.id !== id);
                notify();
            }, timeout);
        }

        return id;
    }

    return {
        subscribe(fn: (value: Toast[]) => void): () => void {
            subscribers.push(fn);
            fn(toasts);
            return () => {
                const idx = subscribers.indexOf(fn);
                if (idx >= 0) subscribers.splice(idx, 1);
            };
        },
        show: (message: string, type: ToastType = 'info', timeout = toastDefaultTimeoutMs()) =>
            push(message, type, { timeout }),
        remove: (id: number) => {
            toasts = toasts.filter((t) => t.id !== id);
            notify();
        },
        clear: () => {
            toasts = [];
            notify();
        },
        /**
         * Calm mode (Live TV simple mode): drop info/success/warning toasts and
         * keep errors up for at least CALM_ERROR_TIMEOUT_MS. Returns the undo.
         */
        setCalm: (on: boolean): (() => void) => {
            if (!on) return () => {};
            calmHolders++;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                calmHolders = Math.max(0, calmHolders - 1);
            };
        },
        // Typed helpers. Each accepts either a number (legacy: timeout
        // only) or a full ToastOptions object (for toasts that need an
        // action button). Existing call sites stay source-compatible.
        success: (
            message: string,
            timeoutOrOptions: number | ToastOptions = toastDefaultTimeoutMs(),
        ) =>
            push(
                message,
                'success',
                typeof timeoutOrOptions === 'number'
                    ? { timeout: timeoutOrOptions }
                    : timeoutOrOptions,
            ),
        error: (
            message: string,
            timeoutOrOptions: number | ToastOptions = toastDefaultTimeoutMs(),
        ) =>
            push(
                message,
                'error',
                typeof timeoutOrOptions === 'number'
                    ? { timeout: timeoutOrOptions }
                    : timeoutOrOptions,
            ),
        warning: (
            message: string,
            timeoutOrOptions: number | ToastOptions = toastDefaultTimeoutMs(),
        ) =>
            push(
                message,
                'warning',
                typeof timeoutOrOptions === 'number'
                    ? { timeout: timeoutOrOptions }
                    : timeoutOrOptions,
            ),
        info: (
            message: string,
            timeoutOrOptions: number | ToastOptions = toastDefaultTimeoutMs(),
        ) =>
            push(
                message,
                'info',
                typeof timeoutOrOptions === 'number'
                    ? { timeout: timeoutOrOptions }
                    : timeoutOrOptions,
            ),
    };
}

export const toasts = createToastStore();
