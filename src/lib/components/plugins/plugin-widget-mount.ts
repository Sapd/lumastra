// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lifecycle of one third-party widget mount.
 *
 * Extracted from `PluginWidgetSlot.svelte` because the cases worth testing are
 * unreachable from inside a component effect: a module that resolves after its
 * slot was released, a plugin that throws during teardown, a dispose that races
 * a pending import. Those are exactly the paths a misbehaving plugin takes, so
 * they are the ones that must be pinned.
 */

export interface PluginWidgetMountOptions {
    /** Loads the plugin module. Injected so a test does not need a module server. */
    load: () => Promise<{ mount?: (el: HTMLElement, ctx: unknown) => unknown }>;
    el: HTMLElement;
    /** Built lazily, at mount time, so it reflects the theme as it is then. */
    ctx: () => unknown;
    timeoutMs: number;
    /** Identifies the widget in console output. */
    label: string;
    /** Called exactly once: the slot may stop reserving space. */
    onSettle: (didFail: boolean) => void;
}

/** Tears the mount down. Safe to call at any point, including mid-import. */
export type DisposePluginWidget = () => void;

export function mountPluginWidget(opts: PluginWidgetMountOptions): DisposePluginWidget {
    let cleanup: (() => void) | undefined;
    let disposed = false;
    let settled = false;

    const settle = (didFail: boolean): void => {
        if (disposed || settled) return;
        settled = true;
        opts.onSettle(didFail);
    };

    const timer = setTimeout(() => {
        if (disposed || settled) return;
        console.error(
            `Plugin widget ${opts.label} did not mount within ${opts.timeoutMs}ms — releasing its slot`,
        );
        settle(true);
    }, opts.timeoutMs);

    opts.load()
        .then((mod) => {
            // `settled` here means the timeout already fired. Releasing the slot
            // is a DECISION that this widget does not get to run — mounting it a
            // second later means it runs invisibly (inside chrome the host has
            // already hidden), polling and timing and possibly playing audio,
            // with the viewer given no sign it is there. It also lands after the
            // reserved space was released, shoving the layout: the exact jump
            // the reservation exists to prevent.
            if (disposed || settled) return;

            const result = mod.mount?.(opts.el, opts.ctx());
            // Accept both shapes: a bare cleanup function (the original
            // contract, still used by shipped plugins) or a `{ destroy() }`
            // handle.
            const handle = result as { destroy?: () => void } | (() => void) | undefined;
            cleanup =
                typeof handle === 'function'
                    ? handle
                    : typeof handle?.destroy === 'function'
                      ? (): void => handle.destroy?.()
                      : undefined;
            settle(false);
        })
        .catch((err) => {
            console.error(`Plugin widget ${opts.label} failed to mount`, err);
            settle(true);
        })
        .finally(() => clearTimeout(timer));

    return () => {
        disposed = true;
        clearTimeout(timer);
        if (typeof cleanup === 'function') {
            // A plugin's own teardown must not take the host page down with it —
            // this runs during navigation and modal close.
            try {
                cleanup();
            } catch (err) {
                console.error(`Plugin widget ${opts.label} threw during cleanup`, err);
            }
        }
    };
}
