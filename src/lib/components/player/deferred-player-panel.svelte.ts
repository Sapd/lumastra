// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Cache a panel constructor per player; no panel code is requested before load(). */
export class DeferredPlayerPanel<T> {
    component: T | null = $state.raw(null);
    #pending: Promise<void> | null = null;

    constructor(private readonly loader: () => Promise<T>) {}

    load(): Promise<void> {
        if (this.component !== null) return Promise.resolve();
        if (this.#pending) return this.#pending;
        const pending = Promise.resolve()
            .then(this.loader)
            .then((component) => {
                this.component = component;
            })
            .finally(() => {
                if (this.#pending === pending) this.#pending = null;
            });
        this.#pending = pending;
        return pending;
    }
}
