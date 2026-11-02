// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stand-in the server sends to the admin UI in place of a stored secret
 * (config settings marked `uiHints.sensitive`, plugin `secret` fields). It says
 * "a value is stored" without shipping the value to the browser. A save that
 * carries it back means "keep what is stored" and must never persist it.
 */
export const SECRET_CONFIGURED_SENTINEL = '__CONFIGURED__';

export function isSecretSentinel(value: unknown): boolean {
    return value === SECRET_CONFIGURED_SENTINEL;
}
