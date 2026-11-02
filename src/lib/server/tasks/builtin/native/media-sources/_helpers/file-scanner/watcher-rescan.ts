// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** One bounded reconciliation request for a burst, with a cooldown and no overlapping submissions. */
export class WatcherRescanCoalescer {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private dirty = false;
    private active: Promise<void> | null = null;
    private stopped = false;
    private nextAllowedAt = 0;

    constructor(
        private readonly submit: () => Promise<void | boolean>,
        private readonly onError: (error: unknown) => void,
        private readonly burstMs = 1000,
        private readonly cooldownMs = 30_000,
    ) {}

    /** Includes newer requests received while a previous submission is still running. */
    get pending(): boolean {
        return this.dirty || this.active !== null;
    }

    request(): void {
        if (this.stopped) return;
        this.dirty = true;
        this.arm();
    }

    /** Suspend scheduling without losing an unaccepted reconciliation request. */
    pause(): void {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    resume(): void {
        this.stopped = false;
        this.arm();
    }

    stop(): void {
        this.pause();
        this.dirty = false;
    }

    /** One bounded final submission while the caller still holds its context/leadership. */
    async flush(timeoutMs = 5000): Promise<boolean> {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                (async () => {
                    await this.active;
                    if (this.dirty) await this.submitOnce();
                })(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('Watcher reconciliation flush timed out')),
                        timeoutMs,
                    );
                }),
            ]);
            return !this.dirty;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private submitOnce(): Promise<void> {
        if (this.active) return this.active;
        this.dirty = false;
        this.nextAllowedAt = Date.now() + this.cooldownMs;
        this.active = Promise.resolve()
            .then(() => this.submit())
            .then((accepted) => {
                // A running scan may already have passed the changed path.
                if (accepted === false) this.dirty = true;
            })
            .catch((error: unknown) => {
                this.dirty = true;
                this.onError(error);
            })
            .finally(() => {
                this.active = null;
                this.arm();
            });
        return this.active;
    }

    private arm(): void {
        if (this.timer || this.active || !this.dirty || this.stopped) return;
        this.timer = setTimeout(
            () => {
                this.timer = null;
                void this.submitOnce();
            },
            Math.max(this.burstMs, this.nextAllowedAt - Date.now()),
        );
        this.timer.unref();
    }
}
