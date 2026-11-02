// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export class LiveTvStartupDeadline {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private controller: AbortController | undefined;
    begin(onExpired: () => void, timeoutMs = 25_000): AbortSignal {
        this.cancel();
        const controller = new AbortController();
        this.controller = controller;
        this.timer = setTimeout(() => {
            if (this.controller !== controller) return;
            controller.abort();
            this.timer = undefined;
            onExpired();
        }, timeoutMs);
        return controller.signal;
    }
    cancel(abort = true): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        if (abort) this.controller?.abort();
        this.controller = undefined;
    }
}
