// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Pure AES-256-GCM secret-box primitives shared by the plugin secret store
// (tasks/secrets.ts) and the config service (config/config.service.ts).
//
// Two layers live here:
//
//   1. Low-level buffer crypto — deriveMasterKey / encrypt / decrypt. These
//      produce/consume a raw blob: iv(12) | tag(16) | ciphertext(N). The plugin
//      secret store persists that blob directly in a BYTEA column.
//
//   2. String envelope — sealSecret / openSecret / isSealed. JSON config files
//      can only hold strings, so sensitive settings are stored as a tagged,
//      versioned base64 envelope: `enc:v1:<base64(iv|tag|ciphertext)>`. The tag
//      lets the loader auto-detect whether a stored value is an encrypted
//      envelope or legacy plaintext.
//
// ROW BINDING (security review 2026-09-13, C19). Both layers take an optional
// `aad` context string. AES-GCM authenticates it without encrypting it, so a
// blob sealed under one row's context FAILS to open under another's — an
// attacker with database write access can no longer copy an admin's ciphertext
// into their own row and have a reveal endpoint decrypt it for them.
//
// A context-bound value is tagged `v2`, in both layers, with the SAME marker:
//   - envelope: the `enc:v2:` prefix replaces `enc:v1:`
//   - raw blob: the 7 ASCII bytes `enc:v2:` are PREPENDED to iv|tag|ciphertext
//     (the BYTEA columns have nowhere else to carry a version, and a random
//     12-byte IV colliding with that marker is a 2^-56 event)
//
// Compatibility is one-directional and deliberate: `v1` values keep opening
// with no context (so nothing written before this change is locked out), every
// WRITE that supplies a context produces `v2`, and master-key rotation upgrades
// `v1` → `v2`. Opening a `v2` value with the WRONG context, or with none at
// all, throws.
//
// THE CONTEXT STRING IS AN ON-DISK CONTRACT, and it must start with the name of
// the store it belongs to:
//
//     <store>:<row identity>              e.g. `subsonic_client_passwords:<uuid>`
//     <store>:<row identity>/<sub-part>   e.g. `livetv_sources:<uuid>/xtream_password`
//
// The prefix is not decoration. Two stores whose identities are both free-form
// text can otherwise produce the SAME context for different rows — a plugin
// secret keyed `<uuid>/access_token` collided with that user's credential for
// the same plugin — which is exactly the binding this is supposed to provide.
// And because rotation re-opens with the context the code computes TODAY, a
// context that is changed after values have been sealed under it orphans every
// one of them: there is no migration, only re-entry. Choose it once.
//
// The master key is derived from LUMASTRA_MASTER_KEY (64-char hex → raw 32 bytes,
// or arbitrary passphrase → scrypt KDF). The key is NEVER persisted or mirrored.

import crypto from 'node:crypto';

// The resolver registers host-only backup bookkeeping after resolving a key.
// The crypto module itself stays free of filesystem/config dependencies and
// The observer only matches the sealing key; it never receives the secret value.
let secretSealedObserver: ((masterKey: Buffer) => void) | undefined;

export function registerSecretSealedObserver(observer: (masterKey: Buffer) => void): void {
    secretSealedObserver = observer;
}

// ── Master key derivation ──────────────────────────────────────────────────────

/**
 * Per-deployment salt for the passphrase KDF. Override via LUMASTRA_KDF_SALT
 * (recommended for production — a unique salt per deployment defeats
 * precomputed/rainbow attacks). Falls back to a fixed application constant so
 * the passphrase path works out-of-the-box; the constant still gives scrypt's
 * memory-hardness, just without per-deployment uniqueness.
 *
 * NOTE: changing the salt (or LUMASTRA_KDF_SALT) re-derives a DIFFERENT key, so
 * existing passphrase-encrypted secrets become undecryptable and must be
 * re-entered. The 64-char-hex key path bypasses the KDF and is unaffected.
 */
const KDF_SALT = process.env.LUMASTRA_KDF_SALT || 'lumastra-plugin-secrets-kdf-v1';

/**
 * Derive a 32-byte AES key from the env value.
 * Accepts a 64-char hex string (raw key) or any passphrase (scrypt KDF).
 *
 * Security constraints:
 *   - 64-char hex string: accepted as-is (32 raw bytes) — the preferred path.
 *   - Arbitrary passphrase: must be ≥ 24 characters AND contain at least two
 *     character classes (digits + letters at minimum). Shorter or single-class
 *     passphrases are rejected with an operator-actionable message. Derived via
 *     scrypt (memory-hard, salted) rather than a bare SHA-256 so a leaked
 *     ciphertext table can't be brute-forced cheaply offline.
 */
export function deriveMasterKey(envValue: string): Buffer {
    if (!envValue) throw new Error('LUMASTRA_MASTER_KEY not set');
    if (/^[0-9a-fA-F]{64}$/.test(envValue)) {
        return Buffer.from(envValue, 'hex');
    }
    // Passphrase path — enforce minimum strength requirements.
    if (envValue.length < 24) {
        throw new Error(
            'LUMASTRA_MASTER_KEY passphrase must be ≥ 24 characters. ' +
                'Prefer a 64-character hex string (e.g. openssl rand -hex 32).',
        );
    }
    const hasDigit = /\d/.test(envValue);
    const hasLetter = /[a-zA-Z]/.test(envValue);
    const hasSymbol = /[^a-zA-Z0-9]/.test(envValue);
    const classCount = [hasDigit, hasLetter, hasSymbol].filter(Boolean).length;
    if (classCount < 2) {
        throw new Error(
            'LUMASTRA_MASTER_KEY passphrase must contain at least two character classes ' +
                '(letters and digits, or letters and symbols). ' +
                'Prefer a 64-character hex string (e.g. openssl rand -hex 32).',
        );
    }
    // scrypt with N=16384, r=8, p=1 → ~16 MB working set (fits Node's default
    // 32 MB scrypt maxmem). Memory-hard + salted, unlike a single-round
    // unsalted SHA-256.
    return crypto.scryptSync(envValue, KDF_SALT, 32, { N: 16384, r: 8, p: 1 });
}

/**
 * Deterministically derive a hex sub-secret from LUMASTRA_MASTER_KEY for use as a
 * default when a dedicated secret (e.g. JWT_SECRET) is unset. Same master key →
 * same output on every replica and across restarts (so issued tokens stay valid),
 * with no persistence and no new infrastructure. One-way (HMAC), so the derived
 * value never reveals the master key. Returns '' when the master key is unset or
 * invalid (caller then treats the secret as unconfigured, exactly as before).
 *
 * Anyone holding the master key can already decrypt every stored secret, so
 * deriving a token-signing key from it adds no new exposure.
 */
export function deriveSubSecret(masterKeyEnv: string | undefined, label: string): string {
    if (!masterKeyEnv) return '';
    try {
        const key = deriveMasterKey(masterKeyEnv);
        return crypto.createHmac('sha256', key).update(label).digest('hex');
    } catch {
        return '';
    }
}

// ── Version markers ────────────────────────────────────────────────────────────

/** Prefix marking a value as an encrypted secret envelope with NO row binding. */
const ENVELOPE_PREFIX_V1 = 'enc:v1:';

/** Prefix marking a value as an encrypted secret envelope BOUND to a row context. */
const ENVELOPE_PREFIX_V2 = 'enc:v2:';

/**
 * The same `enc:v2:` marker in raw bytes, prepended to a context-bound BYTEA
 * blob. The blob columns (plugin_secrets.value_encrypted,
 * task_webhook_hooks.secret_encrypted, …) have no prefix of their own, so the
 * marker is how `decrypt()` tells a bound blob from a legacy one.
 */
const BLOB_MAGIC_V2 = Buffer.from(ENVELOPE_PREFIX_V2, 'utf8');

/**
 * Whether a stored ENVELOPE is bound to a row context (`enc:v2:`). A `v1`
 * envelope, or plaintext, returns false. Rotation uses this to decide which
 * values still need upgrading.
 */
export function isAadBound(value: string): boolean {
    return value.startsWith(ENVELOPE_PREFIX_V2);
}

/** Whether a stored BYTEA blob is bound to a row context. The blob twin of {@link isAadBound}. */
export function isAadBoundBlob(blob: Buffer): boolean {
    return (
        blob.length > BLOB_MAGIC_V2.length &&
        blob.subarray(0, BLOB_MAGIC_V2.length).equals(BLOB_MAGIC_V2)
    );
}

// ── Low-level buffer crypto ─────────────────────────────────────────────────────

/** Seal plaintext into iv(12) | tag(16) | ciphertext(N), optionally binding `aad`. */
function encryptCore(plaintext: string, masterKey: Buffer, aad: string | undefined): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, tag, enc]);
    secretSealedObserver?.(masterKey);
    return blob;
}

/** Open an iv|tag|ciphertext blob. Throws when the tag (or the bound `aad`) does not verify. */
function decryptCore(blob: Buffer, masterKey: Buffer, aad: string | undefined): string {
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const ciphertext = blob.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(tag);
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    // Successfully opening an older envelope proves that this key already
    // sealed a secret, including on an install upgrading to backup tracking.
    secretSealedObserver?.(masterKey);
    return plain;
}

/**
 * Encrypt plaintext → iv(12) | tag(16) | ciphertext(N).
 *
 * Pass `aad` — a stable identifier for the row this value belongs to, e.g.
 * `${pluginId}/${key}` — to bind the ciphertext to that row. The result is then
 * prefixed with the `enc:v2:` marker and only `decrypt(blob, key, aad)` with
 * the SAME context can open it.
 */
export function encrypt(plaintext: string, masterKey: Buffer, aad?: string): Buffer {
    const blob = encryptCore(plaintext, masterKey, aad);
    return aad === undefined ? blob : Buffer.concat([BLOB_MAGIC_V2, blob]);
}

/**
 * Decrypt a blob produced by encrypt().
 *
 * Readers thread their row context unconditionally: a legacy (unbound) blob
 * ignores it, a bound one requires it. A bound blob opened with no context at
 * all throws rather than silently degrading to an unauthenticated read.
 */
export function decrypt(blob: Buffer, masterKey: Buffer, aad?: string): string {
    if (!isAadBoundBlob(blob)) return decryptCore(blob, masterKey, undefined);
    if (aad === undefined) {
        throw new Error(
            'Encrypted value is bound to a row context but none was supplied ' +
                '(enc:v2 blob opened without aad)',
        );
    }
    return decryptCore(blob.subarray(BLOB_MAGIC_V2.length), masterKey, aad);
}

// ── String envelope (for JSON config storage) ───────────────────────────────────

/**
 * Whether a stored string is an encrypted envelope produced by sealSecret().
 * Plaintext values (legacy or written without a master key) return false.
 * True for BOTH envelope versions — callers that care which one must ask
 * {@link isAadBound}.
 */
export function isSealed(value: string): boolean {
    return value.startsWith(ENVELOPE_PREFIX_V1) || value.startsWith(ENVELOPE_PREFIX_V2);
}

/**
 * Encrypt a plaintext string into a tagged base64 envelope suitable for JSON
 * storage: `enc:v2:<base64(iv|tag|ciphertext)>` when a row context is supplied,
 * `enc:v1:<…>` when it is not.
 *
 * Pass `aad` unless the value genuinely has no stable row identity — an
 * unbound envelope can be copied into another row and opened there.
 */
export function sealSecret(plaintext: string, masterKey: Buffer, aad?: string): string {
    const blob = encryptCore(plaintext, masterKey, aad);
    const prefix = aad === undefined ? ENVELOPE_PREFIX_V1 : ENVELOPE_PREFIX_V2;
    return prefix + blob.toString('base64');
}

/**
 * Decrypt an envelope produced by sealSecret() back to plaintext.
 * Throws if the value is not a valid envelope or fails authentication.
 *
 * As with {@link decrypt}, readers pass their row context unconditionally: a
 * `v1` envelope ignores it, a `v2` envelope requires it and rejects any other.
 */
export function openSecret(envelope: string, masterKey: Buffer, aad?: string): string {
    if (!isSealed(envelope)) {
        throw new Error('Value is not an encrypted secret envelope');
    }
    const bound = isAadBound(envelope);
    if (bound && aad === undefined) {
        throw new Error(
            'Encrypted value is bound to a row context but none was supplied ' +
                '(enc:v2 envelope opened without aad)',
        );
    }
    // Strip the prefix this value actually carries, not a shared length — the
    // two happen to be the same width today, and a future `enc:v10:` would
    // silently corrupt every decode if that were assumed.
    const prefix = bound ? ENVELOPE_PREFIX_V2 : ENVELOPE_PREFIX_V1;
    const blob = Buffer.from(envelope.slice(prefix.length), 'base64');
    return decryptCore(blob, masterKey, bound ? aad : undefined);
}
