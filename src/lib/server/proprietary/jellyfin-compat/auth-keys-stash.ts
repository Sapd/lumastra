// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Plaintext PAT stash for /j/Auth/Keys hand-off (Seerr setup-wizard flow).
//
// POST /j/Auth/Keys mints a `jellyfin_compat` PAT and stashes the plaintext
// here keyed by a UUID nonce; the subsequent GET /j/Auth/Keys consumes it
// (GETDEL) and returns it to the wizard.
//
// Design:
//   - Plaintext is stored under `jfcompat:auth_key_plaintext:<uuid>` (TTL 600s).
//   - A reverse pointer `jfcompat:auth_key_nonce_for_pat:<patId>` -> nonce
//     lets the GET handler look up the nonce by PAT id (TTL 600s).
//   - Both keys are written in a single atomic Batch (Valkey transaction) so
//     a crash mid-write never leaves a dangling plaintext without a pointer
//     or vice-versa.
//   - Consume is two GETDELs: first the pointer, then the plaintext. Both are
//     atomic per-key; the worst-case partial state is "pointer consumed but
//     plaintext already TTL-expired", which we treat as null (key gone).
//
// SECURITY: Plaintext lives in Valkey for at most 10 minutes, only readable
// to processes with the PAT id (which only the minting handler ever logs at
// debug level). After GET consumes it, both keys are deleted.

import { randomUUID } from 'node:crypto';
import { Batch, TimeUnit } from '@valkey/valkey-glide';
import { getCoordinationClient } from '$lib/server/cache/valkey';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinCompat:AuthKeysStash');

/** Stash entries live for 10 minutes — long enough for a wizard, short enough to limit exposure. */
const STASH_TTL_SECONDS = 600;

const plaintextKey = (nonce: string): string => `jfcompat:auth_key_plaintext:${nonce}`;

const nonceKey = (patId: string | number): string => `jfcompat:auth_key_nonce_for_pat:${patId}`;

function glideStringToString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (value instanceof Uint8Array || value instanceof Buffer) {
        return Buffer.from(value).toString('utf-8');
    }
    return String(value);
}

/**
 * Stash plaintext token atomically under a fresh UUID nonce + reverse pointer.
 *
 * Throws if Valkey is unavailable — callers must propagate the failure to the
 * minting handler so it can return 503 (Seerr would otherwise think the key
 * was registered and then find nothing on GET).
 */
export async function stashAuthKey(patId: string | number, plaintext: string): Promise<void> {
    const client = getCoordinationClient();
    if (!client) {
        throw new Error('Valkey unavailable: cannot stash auth key plaintext');
    }

    const nonce = randomUUID();
    const expiry = {
        type: TimeUnit.Seconds,
        count: STASH_TTL_SECONDS,
    } as const;

    // Atomic batch (transaction): both keys appear together, or neither does.
    const batch = new Batch(true)
        .set(plaintextKey(nonce), plaintext, { expiry })
        .set(nonceKey(patId), nonce, { expiry });

    const results = await client.exec(batch, true);
    if (!results) {
        // exec returns null only when a WATCHed key changed — we don't WATCH,
        // so this should be unreachable, but treat it as a hard failure.
        throw new Error('Auth-key stash transaction returned null');
    }

    logger.debug('Auth key plaintext stashed', { patId });
}

/**
 * Atomically pop the plaintext for a PAT id, deleting both keys.
 *
 * Returns null if the stash has already been consumed or has TTL-expired.
 */
export async function consumeAuthKey(patId: string | number): Promise<string | null> {
    const client = getCoordinationClient();
    if (!client) {
        logger.warn('Valkey unavailable: cannot consume auth key plaintext', {
            patId,
        });
        return null;
    }

    // Step 1: pop the nonce pointer.
    const noncePopped = await client.getdel(nonceKey(patId));
    const nonce = glideStringToString(noncePopped);
    if (!nonce) return null;

    // Step 2: pop the plaintext under that nonce. May be null if TTL already
    // expired between the two GETDELs (extremely unlikely with 600s TTL).
    // If the second GETDEL throws (Valkey error mid-consume), the pointer is
    // already gone — treat as null so callers see "expired/consumed" instead
    // of a 500. The plaintext orphan TTLs out within 10 minutes.
    let plaintextPopped: unknown;
    try {
        plaintextPopped = await client.getdel(plaintextKey(nonce));
    } catch (err) {
        logger.error(
            'Auth key plaintext GETDEL failed after nonce was already consumed',
            err as Error,
            { patId },
        );
        return null;
    }
    const plaintext = glideStringToString(plaintextPopped);
    if (!plaintext) {
        logger.warn('Auth key nonce found but plaintext already expired', {
            patId,
        });
        return null;
    }

    logger.debug('Auth key plaintext consumed', { patId });
    return plaintext;
}
