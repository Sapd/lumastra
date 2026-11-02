// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Debounced, serialized auto-save for settings editors.
 *
 * Guarantees, in the order they were learned the hard way:
 *  - a burst of edits becomes one request (debounce);
 *  - never two requests in flight: a request that starts while another is
 *    running waits for it, so a slow older save can never land after a newer
 *    one and write the stale state last;
 *  - leaving the page does not drop the last edit: `flush()` (called from
 *    `onDestroy` and on `pagehide`) saves immediately — still behind any
 *    request already in flight.
 *
 * `save` should read the CURRENT editor state when it runs, not capture it
 * when scheduled, so the request that finally goes out carries the latest
 * edits.
 */
export interface Autosave {
    /** Call after every edit. */
    schedule(): void;
    /** Save now if an edit is pending (still serialized behind any in-flight save). */
    flush(): Promise<void>;
    /** Drop a pending edit without saving (tests / explicit discard). */
    cancel(): void;
}

export function createAutosave(save: () => Promise<void>, delayMs = 600): Autosave {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;
    let chain: Promise<void> = Promise.resolve();

    function run(): Promise<void> {
        pending = false;
        // The editor's `save` reports its own failures (toast); swallowing here
        // keeps one failed request from rejecting every later one in the chain.
        chain = chain.then(save).catch(() => {});
        return chain;
    }

    return {
        schedule(): void {
            pending = true;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                void run();
            }, delayMs);
        },
        flush(): Promise<void> {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            return pending ? run() : chain;
        },
        cancel(): void {
            if (timer) clearTimeout(timer);
            timer = null;
            pending = false;
        },
    };
}
