// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native-login password hashing.
 *
 * Independent, AGPL-core store for browser/web-UI login ONLY. This is NOT the
 * `/j` Jellyfin-client password store (jellyfin_client_passwords,
 * SHA-256 PINs) — the two are deliberately separate (different security model,
 * different purpose, and the core→module boundary is one-directional). Do
 * not share, migrate, or cross-read between them.
 *
 * Algorithm: scrypt (memory-hard, salted) — built into Node, no extra dependency
 * (argon2/bcrypt would add a native build step the project currently avoids).
 * Each password gets a fresh 16-byte random salt; verification is constant-time
 * via `timingSafeEqual`.
 *
 * Stored format (single self-describing column value):
 *   scrypt$N=<N>,r=<r>,p=<p>$<saltBase64>$<hashBase64>
 * The parameters live in the string so a future cost bump can be detected and the
 * hash transparently upgraded on the user's next successful login.
 */

import { scrypt as scryptCb, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { PASSWORD_MAX_LENGTH } from '$lib/shared/password-strength.js';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
    password: string | Buffer,
    salt: string | Buffer,
    keylen: number,
    options: ScryptOptions,
) => Promise<Buffer>;

// N=2^16 (65536), r=8, p=1 → ~64 MB working set. Stronger than the secret-box
// KDF (N=16384) because this guards user-chosen passwords (lower entropy than a
// generated master key) against offline cracking. maxmem is raised to fit the
// larger N (Node's default 32 MB cap would otherwise throw).
const SCRYPT_PARAMS = { N: 65536, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 128 * 1024 * 1024; // 128 MB headroom for N=65536,r=8
const KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * Upper bound on accepted password length. scrypt cost is independent of input
 * length, but an unbounded input is still a cheap memory-DoS vector — cap it.
 * The shared policy (`validatePasswordPolicy`) rejects longer inputs with a
 * 400 before any route reaches this module; this is the hard backstop.
 */
export const MAX_PASSWORD_LENGTH = PASSWORD_MAX_LENGTH;

/** Minimum accepted password length for native accounts. */
export const MIN_PASSWORD_LENGTH = 10;

export class PasswordTooLongError extends Error {
    constructor() {
        super(`Password exceeds the maximum length of ${MAX_PASSWORD_LENGTH} characters`);
        this.name = 'PasswordTooLongError';
    }
}

/**
 * Hash a plaintext password into the self-describing stored format.
 * Throws PasswordTooLongError if the input exceeds MAX_PASSWORD_LENGTH.
 */
export async function hashPassword(plaintext: string): Promise<string> {
    if (plaintext.length > MAX_PASSWORD_LENGTH) throw new PasswordTooLongError();
    const salt = randomBytes(SALT_BYTES);
    const derived = await scrypt(plaintext, salt, KEYLEN, {
        ...SCRYPT_PARAMS,
        maxmem: SCRYPT_MAXMEM,
    });
    const params = `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`;
    return `scrypt$${params}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

interface ParsedHash {
    N: number;
    r: number;
    p: number;
    salt: Buffer;
    hash: Buffer;
}

function parseStoredHash(stored: string): ParsedHash | null {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return null;
    const paramPart = parts[1];
    const params: Record<string, number> = {};
    for (const kv of paramPart.split(',')) {
        const [k, v] = kv.split('=');
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        params[k] = n;
    }
    if (!params.N || !params.r || !params.p) return null;
    try {
        const salt = Buffer.from(parts[2], 'base64');
        const hash = Buffer.from(parts[3], 'base64');
        if (salt.length === 0 || hash.length === 0) return null;
        return { N: params.N, r: params.r, p: params.p, salt, hash };
    } catch {
        return null;
    }
}

/**
 * Verify a plaintext password against a stored hash. Constant-time. Returns false
 * (never throws) for malformed stored values or over-long input, so a corrupt row
 * or an abusive request can't crash the auth path.
 */
export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
    if (plaintext.length > MAX_PASSWORD_LENGTH) return false;
    const parsed = parseStoredHash(stored);
    if (!parsed) return false;
    let derived: Buffer;
    try {
        derived = await scrypt(plaintext, parsed.salt, parsed.hash.length, {
            N: parsed.N,
            r: parsed.r,
            p: parsed.p,
            maxmem: SCRYPT_MAXMEM,
        });
    } catch {
        return false;
    }
    if (derived.length !== parsed.hash.length) return false;
    return timingSafeEqual(derived, parsed.hash);
}

/**
 * Whether a stored hash was produced with parameters weaker than the current
 * defaults — i.e. it should be re-hashed on the next successful login.
 */
export function needsRehash(stored: string): boolean {
    const parsed = parseStoredHash(stored);
    if (!parsed) return true;
    return parsed.N < SCRYPT_PARAMS.N || parsed.r < SCRYPT_PARAMS.r || parsed.p < SCRYPT_PARAMS.p;
}
