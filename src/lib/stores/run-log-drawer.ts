// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { writable, type Readable } from 'svelte/store';

export interface RunLogDrawerState {
    runId: string | null;
}

interface RunLogDrawerStore extends Readable<RunLogDrawerState> {
    open(runId: string): void;
    close(): void;
}

function createStore(): RunLogDrawerStore {
    const { subscribe, set } = writable<RunLogDrawerState>({ runId: null });
    return {
        subscribe,
        open: (runId: string): void => set({ runId }),
        close: (): void => set({ runId: null }),
    };
}

export const runLogDrawer = createStore();
