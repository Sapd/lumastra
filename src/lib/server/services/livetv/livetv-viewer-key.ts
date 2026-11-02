// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';

const DEVICE_COOKIE = 'lumastra_livetv_device';
const DEVICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

interface ViewerKeyInput {
    locals: App.Locals;
    cookies: Pick<Cookies, 'get' | 'set'>;
    /** The request URL: `preview=1` marks a hover-preview stream (see `isLiveTvPreviewRequest`). */
    url?: URL;
}

/** Suffix that gives a hover preview its own viewer, so it never supersedes the real session. */
const PREVIEW_SUFFIX = ':preview';

/**
 * A hover preview marks its stream URL with `preview=1`. The marker can only ever isolate the
 * caller from their own playback (a separate viewer, always low priority); it cannot name
 * another user's viewer key, so it is safe to accept from the URL.
 */
export function isLiveTvPreviewRequest(url: URL | undefined): boolean {
    return url?.searchParams.get('preview') === '1';
}

/** Priority a viewer joins with: a preview never outranks (or evicts) real playback. */
export function liveTvJoinPriority<T extends string>(
    priority: T,
    preview: boolean,
): T | 'low' {
    return preview ? 'low' : priority;
}

/** Stable, non-secret fingerprint for credential forms whose raw token must not be logged. */
export function liveTvCredentialFingerprint(kind: string, credential: string): string {
    const digest = createHash('sha256').update(credential).digest('hex');
    return `${kind}:${digest}`;
}

function credentialDiscriminator(locals: App.Locals): string | undefined {
    if (locals.liveTvCredentialId) return locals.liveTvCredentialId;
    if (locals.jfDevice?.deviceId) return `jf-device:${locals.jfDevice.deviceId}`;
    if (locals.deviceSessionId) return `device:${locals.deviceSessionId}`;
    return undefined;
}

/**
 * The viewer key `deriveLiveTvViewerKey` gave this client, or null when it has none
 * yet. Never sets the browser cookie: for read-side bookkeeping (segment fetches)
 * that must not mint identities.
 */
export function peekLiveTvViewerKey(input: {
    locals: App.Locals;
    cookies: Pick<Cookies, 'get'>;
    url?: URL;
}): string | null {
    const username = input.locals.principal?.username ?? input.locals.user?.username;
    if (!username) return null;
    const discriminator = credentialDiscriminator(input.locals) ?? input.cookies.get(DEVICE_COOKIE);
    return discriminator
        ? `${username}:${discriminator}${isLiveTvPreviewRequest(input.url) ? PREVIEW_SUFFIX : ''}`
        : null;
}

/**
 * Build the proxy viewer identity from the authenticated credential, never URL input.
 * Browser forward-auth has no credential id, so it receives a private per-device cookie.
 */
export function deriveLiveTvViewerKey(
    input: ViewerKeyInput,
    opts: { preview?: boolean } = {},
): string {
    const username = input.locals.principal?.username ?? input.locals.user?.username;
    if (!username)
        throw new Error('Cannot derive Live TV viewer key without an authenticated user');

    let discriminator = credentialDiscriminator(input.locals);
    if (!discriminator) {
        discriminator = input.cookies.get(DEVICE_COOKIE);
        if (!discriminator) {
            discriminator = `browser:${randomUUID()}`;
            input.cookies.set(DEVICE_COOKIE, discriminator, {
                path: '/',
                httpOnly: true,
                sameSite: 'lax',
                maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
            });
        }
    }

    const preview = opts.preview ?? isLiveTvPreviewRequest(input.url);
    return `${username}:${discriminator}${preview ? PREVIEW_SUFFIX : ''}`;
}
