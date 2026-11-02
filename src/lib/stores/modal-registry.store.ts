// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Component } from 'svelte';
import { writable } from 'svelte/store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = Component<any, any, any>;

type ModalComponents = {
    movie: AnyComponent;
    actor: AnyComponent;
    request: AnyComponent;
    seasonSelector: AnyComponent;
    similarMovies: AnyComponent;
    confirm: AnyComponent;
    album: AnyComponent;
    artist: AnyComponent;
};

/** Explicit consumers can request the registry before background bootstrap runs. */
export const modalRegistrationRequested = writable(false);

let registry: ModalComponents | null = null;
let resolveReady: (() => void) | null = null;
const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
});

export function registerModalComponents(components: ModalComponents): void {
    registry = components;
    modalRegistrationRequested.set(false);
    resolveReady?.();
}

export function getModalComponent<K extends keyof ModalComponents>(key: K): ModalComponents[K] {
    if (!registry)
        throw new Error('Modal registry not initialized — modal components are still loading');
    return registry[key];
}

/** Resolves when modal components have been lazily loaded and registered. */
export function waitForModals(): Promise<void> {
    if (!registry) modalRegistrationRequested.set(true);
    return readyPromise;
}
