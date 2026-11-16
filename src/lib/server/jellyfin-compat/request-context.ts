// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-request /j facts resolved once by withJellyfinAuth, after auth succeeded,
 * and read by the DTO serializers deep inside handlers (CanDownload,
 * Policy.EnableContentDownloading). AsyncLocalStorage keeps concurrent requests
 * apart and needs no plumbing through ~36 serializer call sites.
 *
 * Outside a /j request the getter returns undefined and serializers treat the
 * permission as absent (false). Background passes never see a request's value.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface JellyfinRequestContext {
    /** Whether the authenticated caller may download (canDownload). */
    canDownload: boolean;
}

const storage = new AsyncLocalStorage<JellyfinRequestContext>();

/** Run `fn` with `ctx` bound to the current async context. */
export function runWithJellyfinRequestContext<T>(ctx: JellyfinRequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
}

/** The active /j request's resolved facts, or undefined outside one. */
export function currentJellyfinRequestContext(): JellyfinRequestContext | undefined {
    return storage.getStore();
}
