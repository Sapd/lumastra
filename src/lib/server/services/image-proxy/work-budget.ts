// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiProblem } from '$lib/server/api/problem';

export interface ImageWork {
    provider?: boolean;
    encode?: boolean;
}

interface ImageBudget {
    charge: () => Promise<Response | null>;
    chargeEncode?: () => Promise<Response | null>;
    providerResult?: Promise<Response | null>;
    denied?: Response;
    restricted: boolean;
}

interface ImageWorkContext {
    budget: ImageBudget;
    admitted: ImageWork;
    signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<ImageWorkContext>();

/** A caller's refusal must never be recorded as an upstream outage or a missing image. */
export class ImageWorkBudgetExceededError extends Error {}
export class ImageProviderBudgetExceededError extends ImageWorkBudgetExceededError {
    constructor() {
        super('Image provider work budget exhausted');
        this.name = 'ImageProviderBudgetExceededError';
    }
}
export class ImageEncodeBudgetExceededError extends ImageWorkBudgetExceededError {
    constructor() {
        super('Image encode work budget exhausted');
        this.name = 'ImageEncodeBudgetExceededError';
    }
}

export class ImageEncodeQueueFullError extends ImageWorkBudgetExceededError {
    constructor() {
        super('Image encode queue is full');
        this.name = 'ImageEncodeQueueFullError';
    }
}

function encodeUnavailableResponse(): Response {
    return ApiProblem.dependencyUnavailable('Image encoder is busy', { retryAfter: 2 });
}

/** Retain the 503 even when an image fallback catches the queue refusal. */
export function recordImageEncodeQueueFull(): void {
    const context = storage.getStore();
    if (context) context.budget.denied ??= encodeUnavailableResponse();
}

export function imageWorkSignal(): AbortSignal | undefined {
    return storage.getStore()?.signal;
}

export function restrictImageRequest(event: RequestEvent): boolean {
    const user =
        event.locals.principal?.userId ??
        event.locals.user?.userId ??
        event.locals.principal?.username ??
        event.locals.user?.username;
    return !user || event.url?.searchParams.has('sig') === true;
}

export function hasImageWorkBudget(): boolean {
    return storage.getStore() !== undefined;
}

/** Fail closed for parameter parsing outside a request scope too. */
export function isRestrictedImageRequest(): boolean {
    return storage.getStore()?.budget.restricted ?? true;
}

export async function requireImageProviderBudget(): Promise<void> {
    const context = storage.getStore();
    if (!context || context.admitted.provider) return;
    const { budget } = context;
    budget.providerResult ??= budget.charge();
    const denied = await budget.providerResult;
    if (denied) {
        budget.denied = denied;
        throw new ImageProviderBudgetExceededError();
    }
}

/** A separate token for each uncached transform, including local/legacy/avatar work. */
export async function requireImageEncodeBudget(): Promise<void> {
    const context = storage.getStore();
    if (!context || context.admitted.encode || !context.budget.chargeEncode) return;
    const denied = await context.budget.chargeEncode();
    if (denied) {
        context.budget.denied = denied;
        throw new ImageEncodeBudgetExceededError();
    }
}

/** Called AFTER a cache read but BEFORE entering any shared promise. */
export async function admitImageWork(work: ImageWork): Promise<void> {
    if (work.provider) await requireImageProviderBudget();
    if (work.encode) await requireImageEncodeBudget();
}

/**
 * Keep admitted work in the request pool, but never let the leader's disconnect
 * cancel a shared flight that other requests may still need.
 */
export function runAdmittedImageWork<T>(work: ImageWork, factory: () => Promise<T>): Promise<T> {
    const context = storage.getStore();
    if (!context) return factory();
    return storage.run(
        {
            budget: context.budget,
            admitted: {
                provider: context.admitted.provider || work.provider,
                encode: context.admitted.encode || work.encode,
            },
        },
        factory,
    );
}

/** Preserve the caller's 429 even if an image fallback catches the admission error. */
export async function runImageProviderBudget(
    charge: () => Promise<Response | null>,
    handler: () => Promise<Response>,
    chargeEncode?: () => Promise<Response | null>,
    restricted = true,
    signal?: AbortSignal,
): Promise<Response> {
    const budget: ImageBudget = { charge, chargeEncode, restricted };
    return storage.run({ budget, admitted: {}, signal }, async () => {
        try {
            const response = await handler();
            return budget.denied ?? response;
        } catch (error) {
            if (budget.denied) return budget.denied;
            if (error instanceof ImageEncodeQueueFullError) return encodeUnavailableResponse();
            throw error;
        }
    });
}
