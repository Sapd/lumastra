// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Master-key resolution with first-use auto-generation.
 *
 * The master key (LUMASTRA_MASTER_KEY) encrypts stored config secrets at rest and
 * is the root from which JWT_SECRET is derived when unset. Historically it was
 * ENV-only, so an operator who never set it got plaintext secrets and unsignable
 * tokens. This resolver makes "encrypted at rest" true by default: when the env
 * var is unset, the key is read from (or atomically generated into) a file in the
 * config directory, so it is STABLE across restarts and SHARED across replicas
 * that mount the same config volume.
 *
 * Resolution order (cached for the process lifetime):
 *   1. process.env.LUMASTRA_MASTER_KEY  (explicit — always wins)
 *   2. <configDir>/master.key            (previously generated)
 *   3. generate a new 32-byte key, atomically create the file (O_EXCL), chmod 600
 *
 * NEVER inside a plugin-isolation worker thread: there it throws
 * `IsolationWorkerKeyAccessError` before looking at env or file. The worker is a
 * security boundary that must not hold the key; letting it fall through to step
 * 2/3 either handed it the file key or wrote a SECOND key next to the operator's
 * env key (Windows new-user e2e 2026-09-27, B1).
 *
 * Multi-replica: the O_EXCL create + read-on-EEXIST means only the first replica
 * to win the race generates; the others read the same file — SAFE only when the
 * config dir is a shared volume. Deployments that don't share it must set
 * LUMASTRA_MASTER_KEY via env (which short-circuits generation). A loud warning is
 * logged on generation so this is never silent.
 *
 * Kept dependency-free of config.service (it owns config persistence) to avoid an
 * import cycle — the small config-dir resolution below mirrors getConfigFilePath().
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { deriveSubSecret, deriveMasterKey, registerSecretSealedObserver } from './secret-box.js';
import {
    IsolationWorkerKeyAccessError,
    isIsolationWorker,
} from '../tasks/isolation/isolation-context.js';

/**
 * Config-dir resolution — MUST match config.service.getConfigFilePath()'s
 * precedence exactly, or the master key lands in a different directory than
 * settings.json and stored secrets become undecryptable. Order (mirrors
 * config.service): CONFIG_PATH → CONFIG_DIR → /config → ./config → /app/config →
 * ./config (default). Kept local (not imported) to avoid a config.service cycle.
 */
function configDir(): string {
    const explicitFile = process.env.CONFIG_PATH?.trim();
    if (explicitFile) return dirname(explicitFile);
    const explicitDir = process.env.CONFIG_DIR?.trim();
    if (explicitDir) return explicitDir;
    if (existsSync('/config')) return '/config';
    if (existsSync('./config')) return resolve('./config');
    if (existsSync('/app/config')) return '/app/config';
    return resolve('./config');
}

/** Brief synchronous pause (ms) — tolerate a concurrent writer's open-before-write window. */
function sleepSyncMs(ms: number): void {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
        // SharedArrayBuffer unavailable — skip the pause.
    }
}

/** Read an existing key file, retrying briefly while it's blank (writer mid-flush). */
function readExistingKey(file: string): string {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            if (!existsSync(file)) return '';
            const k = readFileSync(file, 'utf8').trim();
            if (k) return k;
        } catch {
            return '';
        }
        // Reached only when the file exists but is blank → a concurrent writer is
        // mid-flush; spin briefly and retry the read.
        sleepSyncMs(25);
    }
    return '';
}

/** Absolute path of the master-key file (whether or not it exists yet). */
/**
 * Short, non-secret fingerprint of the resolved master key, for comparing
 * replicas without ever moving key material between them.
 *
 * HMAC-derived and truncated, so it is safe to put in a Valkey heartbeat
 * payload and render in the admin UI: it cannot be inverted to the key, and
 * 16 hex chars is far more than enough to distinguish "these two nodes hold
 * different keys" (the only question being asked).
 *
 * Returns '' when no key resolves — callers must treat that as "unknown",
 * never as a value to compare, or every unconfigured node would look like it
 * agrees with every other one.
 *
 * Why this matters: when LUMASTRA_MASTER_KEY is unset, each replica generates
 * its own key file. If the config dir is not a shared volume, replicas silently
 * diverge — and because JWT_SECRET is derived from this key when unset, that
 * shows up as users being randomly logged out depending on which replica served
 * them, plus unopenable plugin secrets and Subsonic tokens. Comparing
 * fingerprints turns that into a diagnosable condition.
 */
export function getMasterKeyFingerprint(): string {
    const key = resolveMasterKey();
    if (!key) return '';
    return deriveSubSecret(key, 'lumastra-master-key-fingerprint-v1').slice(0, 16);
}

export function getMasterKeyFilePath(): string {
    return join(configDir(), 'master.key');
}

let _cached: string | null = null;

/**
 * Where the currently-cached master key came from.
 *
 * `resolveMasterKey()` back-fills `process.env.LUMASTRA_MASTER_KEY` on every
 * non-env resolution path (file read, generation, race-loss read) so the rest
 * of the process can keep reading it as a plain env var — but that back-fill
 * also means `!!process.env.LUMASTRA_MASTER_KEY` can never tell you whether
 * the operator actually set it, only that resolution has run at least once.
 * Callers that need the real provenance (e.g. the security self-check's
 * standalone-proxy posture rule, C25) must read this instead.
 */
export type MasterKeySource = 'env' | 'file' | 'generated' | 'none';

let _source: MasterKeySource = 'none';

/**
 * Return the effective master key, generating and persisting one on first use if
 * neither the env var nor an existing key file is present. Returns '' only when a
 * key can be neither read nor written (e.g. an unwritable config dir) — in which
 * case callers degrade to plaintext, exactly as before.
 *
 * @throws IsolationWorkerKeyAccessError inside a plugin-isolation worker thread.
 */
export function resolveMasterKey(): string {
    if (isIsolationWorker()) {
        throw new IsolationWorkerKeyAccessError('The master key (LUMASTRA_MASTER_KEY)');
    }
    if (_cached) return _cached;

    const fromEnv = process.env.LUMASTRA_MASTER_KEY?.trim();
    if (fromEnv) return cacheResolvedKey(fromEnv, 'env');

    const file = getMasterKeyFilePath();
    const existing = readExistingKey(file);
    if (existing) return cacheResolvedKey(existing, 'file');

    const generated = randomBytes(32).toString('hex');
    try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, generated + '\n', { flag: 'wx', mode: 0o600 });
    } catch {
        // Lost the race: use the winner, without overwriting either its key or
        // its backup/usage markers. A transient unreadable key is not cached.
        const winner = readExistingKey(file);
        return winner ? cacheResolvedKey(winner, 'file') : '';
    }
    console.warn(
        `[MasterKey] No LUMASTRA_MASTER_KEY set — generated a new encryption key at ${file} ` +
            `(secrets are now encrypted at rest). BACK THIS FILE UP: losing it makes stored ` +
            `secrets unrecoverable. For multi-replica deployments, set LUMASTRA_MASTER_KEY via ` +
            `env or ensure this directory is a shared volume.`,
    );
    return cacheResolvedKey(generated, 'generated');
}

/** Durable, non-secret state for the current file key's backup reminder. */
export interface MasterKeyBackupState {
    fingerprint: string;
    hasSealedSecrets: boolean;
}

function backupMarker(fingerprint: string): string {
    return `${getMasterKeyFilePath()}.backup-${fingerprint}`;
}

/** Immutable, best-effort metadata must never prevent key resolution or crypto use. */
function createMarker(path: string): boolean {
    try {
        writeFileSync(path, '1\n', { flag: 'wx', mode: 0o600 });
        return true;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return true;
        console.warn(
            `[MasterKey] Could not record backup metadata at ${path}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return false;
    }
}

function cacheResolvedKey(key: string, source: MasterKeySource): string {
    const fingerprint = deriveSubSecret(key, 'lumastra-master-key-fingerprint-v1').slice(0, 16);
    const marker = backupMarker(fingerprint);
    // Also adopt pre-marker file keys on upgrade. The fingerprint matches the
    // previous attention identity, so an existing acknowledgement stays valid.
    if (fingerprint) {
        if (source !== 'env') createMarker(marker);
        const derived = deriveMasterKey(key);
        let recordedUse = existsSync(`${marker}.sealed`);
        registerSecretSealedObserver((sealedWith) => {
            if (recordedUse || !sealedWith.equals(derived) || !existsSync(marker)) return;
            recordedUse = createMarker(`${marker}.sealed`);
        });
    }
    _cached = key;
    _source = source;
    if (source !== 'env') process.env.LUMASTRA_MASTER_KEY = key;
    return key;
}

/** Re-read shared metadata, including usage recorded by a different replica. */
export function getMasterKeyBackupState(): MasterKeyBackupState | null {
    if (isIsolationWorker()) return null;
    const fingerprint = getMasterKeyFingerprint();
    if (!fingerprint || !existsSync(backupMarker(fingerprint))) return null;
    return { fingerprint, hasSealedSecrets: existsSync(`${backupMarker(fingerprint)}.sealed`) };
}

/**
 * The provenance of the currently-cached master key — see `MasterKeySource`.
 * Does NOT trigger resolution itself (a caller that needs the key resolved
 * first must call `resolveMasterKey()` explicitly): reading it before any
 * resolution has happened returns `'none'`, matching "no key cached yet"
 * rather than lying about a key that hasn't been looked up.
 */
export function getMasterKeySource(): MasterKeySource {
    return _source;
}

/** Short, non-secret sha256 prefix of a key, for log lines. Never log the key itself. */
function keyDigestPrefix(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** Two master keys configured side by side — see {@link warnIfMasterKeyFileConflicts}. */
export interface MasterKeyFileConflict {
    /** Path of the conflicting key file. */
    file: string;
    /** sha256 prefix of the env key (the one in effect). */
    envDigest: string;
    /** sha256 prefix of the file key (ignored while the env key is set). */
    fileDigest: string;
}

/**
 * Detect `LUMASTRA_MASTER_KEY` set in the environment while `<config>/master.key`
 * holds a DIFFERENT key. The env key always wins, so the file is dead weight at
 * best — and at worst holds the key some secrets were sealed under (an isolation
 * worker used to generate it, B1), which then silently fail to decrypt.
 *
 * Pure detection: never deletes or rewrites the file (it may be the only copy of
 * a key an operator still needs for a rotation). Returns null when there is no
 * env key, no readable file, or both agree. Always null inside an isolation
 * worker (it must not read the file).
 */
export function detectMasterKeyFileConflict(
    env: Record<string, string | undefined> = process.env,
): MasterKeyFileConflict | null {
    if (isIsolationWorker()) return null;
    const fromEnv = env.LUMASTRA_MASTER_KEY?.trim();
    if (!fromEnv) return null;
    const file = getMasterKeyFilePath();
    let fromFile: string;
    try {
        if (!existsSync(file)) return null;
        fromFile = readFileSync(file, 'utf8').trim();
    } catch {
        return null;
    }
    if (!fromFile || fromFile === fromEnv) return null;
    return { file, envDigest: keyDigestPrefix(fromEnv), fileDigest: keyDigestPrefix(fromFile) };
}

/**
 * Startup check (main process): log ONE warning naming the conflict found by
 * {@link detectMasterKeyFileConflict}, and which key is in effect. Only sha256
 * prefixes are logged — never key material. Returns the conflict (or null) so a
 * caller/test can act on it.
 */
export function warnIfMasterKeyFileConflicts(
    warn: (message: string) => void = console.warn,
    env: Record<string, string | undefined> = process.env,
): MasterKeyFileConflict | null {
    const conflict = detectMasterKeyFileConflict(env);
    if (!conflict) return null;
    warn(
        `[MasterKey] Two different master keys are configured: LUMASTRA_MASTER_KEY is set in the ` +
            `environment (sha256 ${conflict.envDigest}…) AND ${conflict.file} holds another key ` +
            `(sha256 ${conflict.fileDigest}…). The ENVIRONMENT key is in effect; the file is ignored. ` +
            `Secrets sealed under the file key will not decrypt (the log names them as "sealed under a ` +
            `different LUMASTRA_MASTER_KEY"). If nothing needs the file key, back the file up and remove ` +
            `it; otherwise re-seal those secrets under the env key (docs/security/master-key-rotation.md). ` +
            `The file was NOT changed.`,
    );
    return conflict;
}
