// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Page, Request, Response, TestInfo } from '@playwright/test';

interface ModuleFailure {
    path: string;
    error?: string;
    status?: number;
    contentType?: string;
    body?: string;
}

const observations = new WeakMap<
    Page,
    {
        failures: ModuleFailure[];
        recoveredErrors: Set<string>;
        pendingErrors: Set<string>;
        runtimeErrors: string[];
        exhausted: boolean;
        retry: () => Promise<boolean>;
    }
>();

/** Only the non-blocking probe may quarantine exhausted infrastructure recovery. */
export function networkQuarantineReason(page: Page): string | undefined {
    const observed = observations.get(page);
    if (
        !observed?.exhausted ||
        observed.runtimeErrors.length ||
        observed.failures.some(
            (failure) =>
                failure.status !== undefined ||
                (failure.error &&
                    !['net::ERR_NETWORK_CHANGED', 'net::ERR_ABORTED'].includes(failure.error)),
        )
    )
        return;
    return 'Runner network changed during client-module startup (net::ERR_NETWORK_CHANGED); two recovery reloads exhausted. See Client module failures attachment.';
}

/** A rejected lazy startup import is infrastructure-only only with pure transport evidence. */
export function isNetworkChangeModuleError(page: Page, error: unknown): boolean {
    const observed = observations.get(page);
    return Boolean(
        observed &&
        !observed.runtimeErrors.length &&
        String(error).includes('Failed to fetch dynamically imported module:') &&
        observed.failures.some((failure) => failure.error === 'net::ERR_NETWORK_CHANGED') &&
        !observed.failures.some(
            (failure) =>
                failure.status !== undefined ||
                (failure.error &&
                    !['net::ERR_NETWORK_CHANGED', 'net::ERR_ABORTED'].includes(failure.error)),
        ),
    );
}

/** Shares the same two-reload budget with automatic route startup recovery. */
export async function retryNetworkStartup(page: Page): Promise<boolean> {
    return (await observations.get(page)?.retry()) ?? false;
}

/**
 * Browser module-fetch TypeErrors follow parent imports too, so their URL need
 * not be the aborted dependency. Exclude them only when request diagnostics show
 * pure network-change aborts. HTTP/other network failures block this filter;
 * ordinary runtime errors remain in the caller's assertion.
 */
export function withoutNetworkChangeErrors(page: Page, errors: readonly string[]): string[] {
    const observed = observations.get(page);
    if (
        !observed ||
        !observed.failures.some((failure) => failure.error === 'net::ERR_NETWORK_CHANGED') ||
        observed.failures.some(
            (failure) =>
                failure.status !== undefined ||
                (failure.error &&
                    !['net::ERR_NETWORK_CHANGED', 'net::ERR_ABORTED'].includes(failure.error)),
        )
    ) {
        return [...errors];
    }
    return errors.filter(
        (error) => !/^Failed to fetch dynamically imported module: https?:\/\//.test(error),
    );
}

/**
 * Shared CI hosts create/remove network interfaces as other jobs start containers.
 * Chromium aborts in-flight scripts with ERR_NETWORK_CHANGED, leaving Kit's error
 * page or unhydrated SSR. Recover only that observed transport failure plus
 * missing client startup, at most twice.
 * HTTP errors, other network errors and ordinary assertion failures never retry.
 */
export function observeNetworkChanges(page: Page, info: TestInfo): () => Promise<void> {
    const failures: ModuleFailure[] = [];
    const reads: Promise<void>[] = [];
    const recoveredErrors = new Set<string>();
    const pendingErrors = new Set<string>();
    const runtimeErrors: string[] = [];
    const observed = {
        failures,
        recoveredErrors,
        pendingErrors,
        runtimeErrors,
        exhausted: false,
        retry: async () => false,
    };
    observations.set(page, observed);
    let changes = 0;
    let reloads = 0;
    let finishing = false;
    let recovery: Promise<void> | undefined;
    let forceStartup = false;

    async function recover(): Promise<void> {
        while (!finishing && reloads < 2) {
            if (!forceStartup) {
                try {
                    await page
                        .getByRole('heading', { name: 'Internal Error', exact: true })
                        .waitFor({ state: 'visible', timeout: 3000 });
                } catch {
                    // An aborted entry module can leave the SSR tree in place and
                    // never mount Kit's error page or hydration announcer.
                    if (
                        !(await page
                            .locator('.error-container.server-error')
                            .count()
                            .catch(() => 0)) &&
                        (await page
                            .locator('#svelte-announcer')
                            .count()
                            .catch(() => 1))
                    )
                        return;
                }
            }
            if (
                finishing ||
                runtimeErrors.length ||
                failures.some(
                    (failure) =>
                        failure.status !== undefined ||
                        (failure.error &&
                            !['net::ERR_NETWORK_CHANGED', 'net::ERR_ABORTED'].includes(
                                failure.error,
                            )),
                )
            )
                return;
            reloads++;
            const description = `Reload ${reloads}/2 after a script aborted with net::ERR_NETWORK_CHANGED`;
            info.annotations.push({ type: 'environmental-reload', description });
            console.warn(`[E2E network] ${description}`);
            const seen = changes;
            const attemptedErrors = [...pendingErrors];
            pendingErrors.clear();
            try {
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
            } catch {
                // The test's original assertion still fails if reload cannot recover.
                return;
            }
            for (const error of attemptedErrors) recoveredErrors.add(error);
            if (changes === seen) return;
            if (reloads === 2) observed.exhausted = true;
        }
    }

    observed.retry = async (): Promise<boolean> => {
        await recovery;
        if (
            finishing ||
            !failures.some((failure) => failure.error === 'net::ERR_NETWORK_CHANGED') ||
            runtimeErrors.length ||
            failures.some(
                (failure) =>
                    failure.status !== undefined ||
                    (failure.error &&
                        !['net::ERR_NETWORK_CHANGED', 'net::ERR_ABORTED'].includes(failure.error)),
            )
        )
            return false;
        if (reloads >= 2) {
            observed.exhausted = true;
            return false;
        }
        const before = reloads;
        forceStartup = true;
        recovery = Promise.resolve()
            .then(recover)
            .finally(() => {
                forceStartup = false;
                recovery = undefined;
            });
        await recovery;
        return reloads > before;
    };

    function requestFailed(request: Request): void {
        if (request.resourceType() !== 'script') return;
        const error = request.failure()?.errorText;
        failures.push({ path: new URL(request.url()).pathname, error });
        if (error !== 'net::ERR_NETWORK_CHANGED') return;
        changes++;
        if (reloads >= 2) observed.exhausted = true;
        if (finishing || recovery || reloads >= 2) return;
        recovery = Promise.resolve()
            .then(recover)
            .finally(() => {
                recovery = undefined;
            });
    }

    function responseReceived(response: Response): void {
        const resourceType = response.request().resourceType();
        // Synthetic fetch failures exercise retry UI and are declared by the
        // fixture itself. They cannot exempt document or module HTTP errors.
        if (
            resourceType !== 'script' &&
            resourceType !== 'document' &&
            response.headers()['x-e2e-expected-status'] === String(response.status())
        )
            return;

        if (resourceType !== 'script' && resourceType !== 'document' && response.status() < 500)
            return;
        const contentType = response.headers()['content-type'] ?? '';
        if (
            response.status() < 400 &&
            !(resourceType === 'script' && contentType.includes('text/html'))
        )
            return;
        const failure: ModuleFailure = {
            path: new URL(response.url()).pathname,
            status: response.status(),
            contentType,
        };
        failures.push(failure);
        reads.push(
            response
                .text()
                .then((body) => {
                    failure.body = body.slice(0, 1200);
                })
                .catch(() => {}),
        );
    }

    function pageError(error: Error): void {
        const moduleAbort = /^Failed to fetch dynamically imported module: https?:\/\//.test(
            error.message,
        );
        if (recovery && moduleAbort) pendingErrors.add(error.message);
        if (!moduleAbort) runtimeErrors.push(error.message);
    }

    page.on('pageerror', pageError);
    page.on('requestfailed', requestFailed);
    page.on('response', responseReceived);
    return async (): Promise<void> => {
        finishing = true;
        page.off('pageerror', pageError);
        page.off('requestfailed', requestFailed);
        page.off('response', responseReceived);
        await recovery;
        await Promise.allSettled(reads);
        if (failures.length) {
            await info.attach('Client module failures', {
                body: JSON.stringify(
                    {
                        reloads,
                        failures,
                        runtimeErrors,
                        exhausted: observed.exhausted,
                        recoveredPageErrors: [...recoveredErrors],
                    },
                    null,
                    2,
                ),
                contentType: 'application/json',
            });
        }
    };
}
