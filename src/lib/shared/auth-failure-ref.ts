// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Correlation reference for sign-in failures — the auth-side counterpart of
 * `transcode-failure-report.ts`.
 *
 * The OIDC callback deliberately shows the browser a GENERIC message and keeps
 * the real cause in the server log (see the route's header docstring). That is
 * the right security posture, but it leaves a self-hosting user with nothing to
 * put in a GitHub issue except the sentence "Sign-in failed." This module adds a
 * short opaque token that appears in BOTH places, so a bug report and the log
 * lines that explain it can be tied together without disclosing anything.
 *
 * Lives in $lib/shared — NOT in the .svelte pages — so the login/setup banners,
 * the copy-for-GitHub button and these tests all execute the same code.
 * Formatting logic inside a .svelte file is unreachable from vitest and
 * invisible to tsgo, so a regression there would ship green.
 *
 * Two guards, deliberately separate:
 *   • sanitizeAuthFailureRef      — the ref arrives from the URL. Only the exact
 *     token shape is echoed back, so `?ref=` can never become a text-injection
 *     surface on the login page.
 *   • resolveAuthFailureMessage   — likewise for `?error=`. Only strings our own
 *     auth flows emit are rendered; anything else collapses to the generic
 *     message, so `/login?error=Call+1-800-…` can't be used to phish.
 */

import { stripSecrets } from './transcode-failure-report.js';

/** Query-parameter carrying the opaque correlation token. */
export const AUTH_FAILURE_REF_PARAM = 'ref';

/** Query-parameter carrying the (allowlisted) user-facing message. */
export const AUTH_FAILURE_ERROR_PARAM = 'error';

/** Shown when `?error=` is present but not one we emit. */
export const AUTH_FAILURE_GENERIC_MESSAGE = 'Sign-in failed. Please try again.';

/**
 * Every user-facing sign-in failure string the auth flows emit. This is the
 * SINGLE SOURCE OF TRUTH: the emitters import these constants (the OIDC callback
 * and /auth/oidc/login are both typed to `AuthFailureMessage`), and the
 * login/setup banners render a `?error=` value only if it is one of them — so
 * the allowlist cannot drift away from what is actually sent.
 *
 * Keeping an emitted message OUT of this list is not a safe default: it renders
 * as the generic "please try again", which for a rate-limited user is advice to
 * do the exact thing that keeps them rate-limited.
 */
export const AUTH_FAILURE_MESSAGES = [
    // /auth/oidc/callback
    'Sign-in was cancelled or failed.',
    AUTH_FAILURE_GENERIC_MESSAGE,
    'Sign-in is temporarily unavailable.',
    'This account is disabled.',
    'The first user must be in an admin group (see ADMIN_GROUPS).',
    // /auth/oidc/login
    'Too many attempts. Try again later.',
    'Single sign-on is unavailable.',
    // /api/auth/plugin/<id>/callback — the redirect kind. The only sign-in
    // failure a user can act on themselves, so it must not collapse to the
    // generic "please try again", which here would be advice to repeat
    // something that will keep failing.
    'That account is not linked on this server yet. Ask an administrator to link it.',
] as const;

export type AuthFailureMessage = (typeof AUTH_FAILURE_MESSAGES)[number];

/**
 * Emitters that redirect with a short CODE instead of the sentence. Only
 * forward-auth's disabled-account bounce does this
 * (`/login?error=account_disabled`); it is server middleware, deliberately kept
 * free of extra module-scope imports, so the mapping lives here instead.
 *
 * A Map, not an object literal: `?error=constructor` against a plain object
 * would resolve through Object.prototype and render a function body.
 */
const AUTH_FAILURE_CODES = new Map<string, AuthFailureMessage>([
    ['account_disabled', 'This account is disabled.'],
]);

const REF_RE = /^[0-9a-f]{8}$/;

/**
 * Mint a correlation token. Deliberately NOT a security token — it is a grep
 * key, so 32 bits of a v4 UUID is plenty and collisions only cost a maintainer
 * an extra log line to read.
 */
export function newAuthFailureRef(): string {
    return crypto.randomUUID().slice(0, 8);
}

/** Return the token only if it has the exact minted shape, else null. */
export function sanitizeAuthFailureRef(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    return REF_RE.test(value) ? value : null;
}

/**
 * Map a `?error=` value onto a message we are willing to render. Unknown text
 * (i.e. anything a link could have been crafted with) becomes the generic
 * message; an absent error renders no banner at all.
 */
export function resolveAuthFailureMessage(value: string | null | undefined): string | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    if ((AUTH_FAILURE_MESSAGES as readonly string[]).includes(value)) return value;
    return AUTH_FAILURE_CODES.get(value) ?? AUTH_FAILURE_GENERIC_MESSAGE;
}

/**
 * The banner line: the vetted message plus the correlation token when present.
 * Returns null when there is nothing to show.
 */
export function formatAuthFailureBanner(
    rawMessage: string | null | undefined,
    rawRef: string | null | undefined,
): string | null {
    const message = resolveAuthFailureMessage(rawMessage);
    if (!message) return null;
    const ref = sanitizeAuthFailureRef(rawRef);
    return ref ? `${message} (reference: ${ref})` : message;
}

export interface AuthFailureReportInput {
    /** Message as shown to the user; re-vetted here regardless of caller. */
    message: string | null | undefined;
    /** Correlation token; re-sanitized here regardless of caller. */
    ref: string | null | undefined;
    /** ISO-8601 instant the banner was shown. */
    occurredAt: string;
    /**
     * Build identifier, when the page had one. In practice it is EMPTY for the
     * only production caller: the copy button lives on /login, and
     * +layout.server.ts blanks `appVersion` for anonymous sessions on purpose
     * (version-disclosure gate). Hence the ask-the-reporter fallback below —
     * silently dropping the row would send every report in without a version.
     */
    appVersion?: string | null;
}

/** Rendered in the Version row when the page could not disclose one. */
const VERSION_UNKNOWN_PROMPT =
    '_please paste your Lumastra version or image tag (e.g. the tag in your compose file)_';

/**
 * A copy-pasteable, already-redacted GitHub-issue body for a sign-in failure.
 *
 * Everything here is either constant text, a vetted message, or the opaque
 * token — no username, no IdP URL, no request query (which on the callback
 * carries the OAuth `code`). `stripSecrets` is applied as defense-in-depth
 * because `appVersion` is operator-supplied free text. `redactPaths` from the
 * transcode report is deliberately NOT used: it needs library/transcode roots,
 * and no filesystem path can reach this output in the first place.
 */
export function formatAuthFailureReport(input: AuthFailureReportInput): string {
    const message = resolveAuthFailureMessage(input.message) ?? AUTH_FAILURE_GENERIC_MESSAGE;
    const ref = sanitizeAuthFailureRef(input.ref);
    const version = (input.appVersion ?? '').trim();

    const rows = [
        `| What the browser showed | ${message} |`,
        `| Reference | ${ref ? `\`${ref}\`` : '_(none — the page was opened without one)_'} |`,
        `| When (UTC) | ${input.occurredAt} |`,
        `| Version | ${version || VERSION_UNKNOWN_PROMPT} |`,
    ];

    const parts = ['### Sign-in failure', '', '| Field | Value |', '| --- | --- |', ...rows];

    if (ref) {
        parts.push(
            '',
            'The server logged the real cause under this reference. Paste the output of:',
            '',
            '```',
            `docker logs <lumastra-container> 2>&1 | grep ${ref}`,
            '```',
        );
    }

    return stripSecrets(parts.join('\n'));
}
