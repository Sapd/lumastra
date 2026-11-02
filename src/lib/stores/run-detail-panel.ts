// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { writable, type Readable } from 'svelte/store';

export interface RunDetailPanelState {
    runId: string | null;
    nonce: number;
}

interface RunDetailPanelStore extends Readable<RunDetailPanelState> {
    open(runId: string): void;
    close(): void;
}

function createStore(): RunDetailPanelStore {
    let nonce = 0;
    const { subscribe, set } = writable<RunDetailPanelState>({
        runId: null,
        nonce: 0,
    });
    return {
        subscribe,
        open: (runId: string): void => set({ runId, nonce: ++nonce }),
        close: (): void => set({ runId: null, nonce: ++nonce }),
    };
}

export const runDetailPanel = createStore();
