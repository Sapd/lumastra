// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stub for `@sveltejs/kit` in the worker-isolation bundle.
 *
 * `@sveltejs/kit` is a devDependency and is removed by `npm prune --production`
 * in the Docker image, so it CANNOT be externalized (it wouldn't resolve at
 * runtime — this exact failure surfaced on the 2026-05-31 preprod soak). The
 * worker thread never serves HTTP, so the handful of helpers some server
 * modules import (`json`, `fail`, occasionally `error`/`redirect`) are never
 * meaningfully invoked from a background task's `execute()`. These functional
 * stand-ins keep the bundle self-contained while behaving sanely if a shared
 * code path does call them.
 *
 * Wired via the esbuild `alias` in `scripts/build-sandbox.ts`. If a NEW
 * `@sveltejs/kit` export starts being imported by the worker graph, the
 * build-time prod-import guard in that script will fail loudly until it's added
 * here.
 */

export const json = (data, init) =>
    new Response(JSON.stringify(data), {
        ...init,
        headers: {
            'content-type': 'application/json',
            ...(init && init.headers),
        },
    });

export const text = (body, init) => new Response(body, init);

export function error(status, body) {
    const err = new Error(
        typeof body === 'string' ? body : (body && body.message) || String(status),
    );
    err.status = status;
    err.body = typeof body === 'string' ? { message: body } : body;
    throw err;
}

export function redirect(status, location) {
    const err = new Error('Redirect');
    err.status = status;
    err.location = String(location);
    throw err;
}

export const fail = (status, data) => ({ status, data });

export const isHttpError = (_e, _status) => false;
export const isRedirect = (_e) => false;
export const isActionFailure = (_e) => false;
