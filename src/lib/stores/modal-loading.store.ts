// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { writable, derived, type Readable } from 'svelte/store';

const count = writable(0);

export const isModalLoading: Readable<boolean> = derived(count, (n) => n > 0);

export function bumpModalLoading(): void {
    count.update((n) => n + 1);
}

export function dropModalLoading(): void {
    count.update((n) => Math.max(0, n - 1));
}

export async function withModalLoading<T>(promise: Promise<T>): Promise<T> {
    bumpModalLoading();
    try {
        return await promise;
    } finally {
        dropModalLoading();
    }
}
