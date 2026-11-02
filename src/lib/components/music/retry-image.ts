// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

interface RetryImageOptions {
    src: string | null;
    onerror: () => void;
}

/** Retry a failed image once per URL; only the second failure shows the fallback. */
export function retryImage(
    node: HTMLImageElement,
    initial: RetryImageOptions,
): {
    update(options: RetryImageOptions): void;
    destroy(): void;
} {
    let options = initial;
    let retried = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function clearTimer(): void {
        clearTimeout(timer);
        timer = undefined;
    }

    function onerror(): void {
        if (timer !== undefined) return;
        if (retried || !options.src) {
            options.onerror();
            return;
        }
        retried = true;
        timer = setTimeout(
            () => {
                timer = undefined;
                // Reassigning src retries a broken image without fragmenting the
                // browser/CDN cache with a new query parameter.
                if (options.src) node.src = options.src;
            },
            2000 + Math.random() * 1000,
        );
    }

    node.addEventListener('error', onerror);
    node.addEventListener('load', clearTimer);
    return {
        update(next): void {
            if (next.src !== options.src) {
                clearTimer();
                retried = false;
            }
            options = next;
        },
        destroy(): void {
            clearTimer();
            node.removeEventListener('error', onerror);
            node.removeEventListener('load', clearTimer);
        },
    };
}
