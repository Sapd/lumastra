// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Plan-conformant token shape: {{media:<uuid>:<type>}} where uuid is the
// hex/hyphen UUID form (exactly 36 chars) and type is lowercase letters.
// The hex-only, fixed-length id class is a small parse-time guard and also
// guarantees an id can never contain ':' (which would corrupt id/type on
// reparse — see makeToken).
const TOKEN_RE = /\{\{media:([0-9a-fA-F-]{36}):([a-z]+)\}\}/g;

// Characters permitted in a media id when constructing a token. Mirrors the
// id portion of TOKEN_RE so a constructed token always round-trips.
const ID_RE = /^[0-9a-fA-F-]+$/;

/** @param {string} id @param {string} mediaType */
export function makeToken(id, mediaType) {
    if (typeof id !== 'string' || !ID_RE.test(id)) {
        throw new TypeError(`makeToken: invalid media id ${JSON.stringify(id)}`);
    }
    return `{{media:${id}:${mediaType}}}`;
}

/** Extract ordered media refs from a body. @param {string} body */
export function parseTokens(body) {
    if (typeof body !== 'string') return [];
    const out = [];
    for (const m of body.matchAll(TOKEN_RE)) {
        out.push({ id: m[1], mediaType: m[2] });
    }
    return out;
}

/**
 * Remove tokens whose `${id}:${mediaType}` key is NOT in `allowedKeys`.
 * @param {string} body @param {Set<string>} allowedKeys
 */
export function stripTokens(body, allowedKeys) {
    if (typeof body !== 'string') return body ?? '';
    const keys = allowedKeys ?? new Set();
    return body.replace(TOKEN_RE, (full, id, type) => (keys.has(`${id}:${type}`) ? full : ''));
}
