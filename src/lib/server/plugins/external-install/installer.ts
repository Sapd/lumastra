// installer.ts
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type postgres from 'postgres';

import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, type AuditActor } from '$lib/server/utils/audit-log.js';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import {
    externalPluginsDir,
    lastLoadError,
    loadAndWirePlugin,
} from '$lib/server/plugins/runtime/loader.js';
import {
    deleteExternalPluginRow,
    snapshotExternalPlugin,
    upsertExternalPlugin,
    type ExternalPluginRow,
    type ExternalPluginUpsert,
} from '$lib/server/database/queries/external-plugins.queries.js';
import { fetchWithGuards } from './fetch-and-verify.js';
import { verifyManifestSignature } from './verify.js';
import { readLoadedCapabilities } from './loaded-capabilities.js';
import { buildEffectiveTrustedKeys } from './trust-anchors.js';
import {
    ExternalPluginManifestSchema,
    compareSemver,
    isMultiContract,
    manifestKinds,
    manifestSdkAbi,
    capabilitySubsetViolation,
    type ExternalPluginManifest,
} from './manifest.js';
import { PLUGIN_SDK_ABI } from '@sapd/lumastra-plugin-sdk';
import { inflateIfGzip, extractTarball } from './archive.js';
import { bundleLimitsFromConfig } from './bundle-limits.js';
import { isInvalidBundle, type BundleArtifact } from './bundle-artifact.js';

const logger = Logger.for('PluginInstaller');

export type InstallMode = 'fresh' | 'upgrade';

export interface InstallResultBody {
    id?: string;
    name?: string;
    version?: string;
    /** First declared contract kind. For a single-contract plugin, the only one. */
    kind?: string;
    /** Every contract kind the manifest declared. Length 1 for single-contract. */
    kinds?: string[];
    enabled?: boolean;
    status?: 'installed' | 'uninstalled';
    loaded?: boolean;
    error?: string;
    restartRequired?: boolean;
    signingKeyId?: string;
    signingKeySource?: 'official' | 'operator';
}

export interface InstallResult {
    status: number; // 201 fresh | 200 upgrade | 400 | 409 | 422 | 500
    body: InstallResultBody | { error: string };
}

export interface InstallInput {
    manifestUrl: string;
    signature: string;
    checksum?: string;
    force?: boolean;
}

/**
 * Decide fresh-vs-upgrade. A dir currently loaded in-process (even without an
 * installed registry row, e.g. legacy drop-in) is treated as an upgrade so the
 * fresh branch never re-imports code that is already live. [Fable-8]
 */
export function classifyInstall(
    prior: { status: 'installed' | 'uninstalled' } | null,
    wasLoaded: boolean,
): InstallMode {
    if (wasLoaded) return 'upgrade';
    if (prior && prior.status === 'installed') return 'upgrade';
    return 'fresh';
}

/**
 * Reject a plugin built against a different contract ABI, or null to accept.
 *
 * Returns the operator-facing message. It names BOTH numbers on purpose: this
 * is the only place anyone learns which side is stale, and it exists precisely
 * to replace the failure mode it prevents — a TypeError thrown at first call
 * from inside third-party code, months after the install that caused it.
 */
export function sdkAbiRejection(declared: number, host: number): string | null {
    if (declared === host) return null;
    const direction = declared < host ? 'older than' : 'newer than';
    return (
        `plugin targets SDK ABI ${declared}, which is ${direction} this host's ABI ${host}. ` +
        (declared < host
            ? 'Rebuild the plugin against the current SDK.'
            : 'Upgrade Lumastra, or install a build of the plugin for this ABI.')
    );
}

/**
 * Refuse an upgrade signed by a different key than the one that installed the
 * plugin, or null to accept. Returns the operator-facing message.
 *
 * THE ATTACK. An operator who trusts two keys — say two community
 * repositories — has, without this, no protection against the second key's
 * owner publishing a plugin under the FIRST one's name at a higher version.
 * Both signatures verify, because verification tries the whole effective
 * trusted set and asks only "is this signed by someone I trust", never "is
 * this signed by whoever I got this plugin from". The anti-rollback check does
 * not help: the attacker publishes a HIGHER version. The result is a silent
 * publisher swap on a plugin that runs with full host trust.
 *
 * The fix is signature continuity, the same rule application stores use:
 * name-to-key is pinned at first install. Rotation is legitimate, so `force`
 * overrides — but as an explicit operator decision that the audit log records
 * with both key ids, rather than something the host decides on its own.
 *
 * A NULL prior key means legacy/pre-migration or a registry-less drop-in:
 * nothing was pinned, so there is nothing to enforce.
 */
export function signingKeyContinuityRejection(
    priorKeyId: string | null,
    offeredKeyId: string,
    force: boolean,
): string | null {
    if (priorKeyId === null || priorKeyId === offeredKeyId || force) return null;
    return (
        `this plugin is installed under signing key '${priorKeyId}' but the update is ` +
        `signed by '${offeredKeyId}'. That is either a key rotation by the same publisher ` +
        `or a different publisher claiming the name — pass force to accept the new key.`
    );
}

/**
 * The `x.y.z` core of a version string, ignoring anything after it.
 *
 * Deliberately tolerant, because real `APP_VERSION` values are not bare
 * semver: CI stamps `git describe` (`v0.1.0-2609-gabc1234`) and the running
 * production container reports the channel name `stable`. What we need is the
 * comparable core when there is one, and "not comparable" otherwise.
 */
const VERSION_CORE_RE = /^v?(\d+)\.(\d+)\.(\d+)/;

/** The comparable `x.y.z` core, or null when the string has none. */
function versionCore(value: string | undefined): string | null {
    const m = value ? VERSION_CORE_RE.exec(value) : null;
    return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/**
 * Refuse a plugin that needs a newer Lumastra than this one, or null to accept.
 *
 * `minAppVersion` has been a REQUIRED field on the SDK's task definition and a
 * recorded manifest column since signed install shipped, and nothing ever
 * compared it — authors were filling in a gate that granted no protection,
 * which is worse than no field at all, because it reads like one.
 *
 * FAILS OPEN on an unanswerable question. `config.APP_VERSION` falls back to
 * `'unknown'` when a build does not stamp one, and an unparseable requirement
 * is the plugin author's typo; in either case refusing every install would turn
 * a missing build stamp into a total outage of the plugin system. The gate
 * exists to catch an honest incompatibility, not to police version strings.
 */
export function minAppVersionRejection(
    required: string | undefined,
    appVersion: string,
): string | null {
    // Both sides are reduced to a comparable core FIRST. `compareSemver` is
    // strict and THROWS on anything else — and this function is called from
    // inside the install and preview handlers, so a throw here is a 500 on
    // every install of every manifest that carries `minAppVersion`. That is the
    // total plugin-system outage the fail-open rule exists to prevent, so the
    // parsing must never hand it something it can reject.
    const requiredCore = versionCore(required);
    const appCore = versionCore(appVersion);
    if (!requiredCore || !appCore) return null;
    if (compareSemver(appCore, requiredCore) >= 0) return null;
    return (
        `this plugin needs Lumastra ${requiredCore} or newer, but this server is ` +
        `${appVersion}. Upgrade the server, or install a build of the plugin ` +
        `that supports ${appVersion}.`
    );
}

/**
 * Every reason an install may be refused, in one place and one order.
 *
 * This exists because the same verdicts have to be reached twice — once by the
 * install and once by the preview that promises to predict it — and two copies
 * of an ordered decision drift. The preview's own comment says it must "never
 * say fine about something that then fails", which is a guarantee, not a hope,
 * so both now call this.
 *
 * The ordering is deliberate: a rollback is more specific than a key change, a
 * key change is more actionable than an ABI complaint, and only the ABI gate
 * ignores `force` (force exists to let an operator re-install or roll back, not
 * to load code built against contracts this host no longer has).
 *
 * Continuity is evaluated against ANY retained row, not only a live one. The
 * `version` column already survives uninstall so an old signed manifest cannot
 * be replayed; `signing_key_id` survives on exactly the same row, and trusting
 * one but not the other made uninstall a door around name-to-key pinning.
 */
/**
 * Is the prior install's payload still on disk?
 *
 * Only meaningful when a prior row exists. Used to distinguish a genuine
 * same-version rollback attempt from a REPAIR of an install whose files were
 * destroyed underneath it (see installGateRejection's `priorOnDisk`).
 */
function priorPayloadOnDisk(prior: { version: string } | null, name: string): boolean | undefined {
    if (!prior) return undefined;
    return fs.existsSync(path.join(externalPluginsDir(), name));
}

export function installGateRejection(input: {
    prior: { version: string; signingKeyId: string | null } | null;
    version: string;
    keyId: string;
    abi: number;
    hostAbi: number;
    /** What the plugin says it needs. Advisory until compared — which is the bug. */
    minAppVersion?: string;
    /** This server's version. `'unknown'` disables the check, never the install. */
    appVersion: string;
    /**
     * Whether the prior install's payload is still on disk. Absent ⇒ assumed
     * present, so every existing caller keeps today's behaviour exactly.
     *
     * A same-version install is a ROLLBACK only if something is installed to
     * roll back from. `PLUGINS_EXTERNAL_DIR` defaults into the container image
     * layer, so an image update deletes the directory while the registry row
     * survives — and anti-rollback then refused the one action that repairs it,
     * leaving a row that claims "installed" with no payload and no way back
     * short of `force` (which is documented for rollbacks, not repairs) or an
     * uninstall. Re-installing the version the row already names restores
     * exactly what was there; it smuggles nothing past the gate.
     */
    priorOnDisk?: boolean;
    force: boolean;
}): string | null {
    // A repair re-installs the SAME version the row claims. A strictly older
    // version is still a downgrade — deleting a directory must not become a way
    // around anti-rollback.
    const repairingMissingPayload =
        input.prior !== null &&
        input.priorOnDisk === false &&
        compareSemver(input.version, input.prior.version) === 0;
    if (
        input.prior &&
        compareSemver(input.version, input.prior.version) <= 0 &&
        !input.force &&
        !repairingMissingPayload
    ) {
        return 'version not newer than installed';
    }
    const keyError = signingKeyContinuityRejection(
        input.prior?.signingKeyId ?? null,
        input.keyId,
        input.force,
    );
    if (keyError) return keyError;
    // Before the ABI gate: "your server is too old" is a more useful sentence
    // than "contract ABI mismatch", and it is the same underlying situation
    // stated in terms the operator can act on.
    const versionError = minAppVersionRejection(input.minAppVersion, input.appVersion);
    if (versionError) return versionError;
    return sdkAbiRejection(input.abi, input.hostAbi);
}

function sha256Hex(buf: Buffer): string {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function isReadOnlyFsError(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        ((err as { code?: unknown }).code === 'EROFS' ||
            (err as { code?: unknown }).code === 'EACCES')
    );
}

/**
 * Union the capabilities of every contract a bundle registered.
 *
 * A multi-contract plugin has one registry row and one capabilities blob, and
 * the admin card reads it to answer "what can this plugin do" — so the honest
 * answer is the union: any boolean true in any contract is true for the
 * install, and `allowedDomains` is the concatenation (deduped), matching what
 * the HTTP client will actually permit across the bundle.
 *
 * `ids` is the loader's registration list; each is looked up under its own
 * kind, positionally paired.
 */
function readBundleCapabilities(ids: string[], kinds: string[]): Record<string, unknown> | null {
    const merged: Record<string, unknown> = {};
    const domains: string[] = [];
    let sawAny = false;

    for (let i = 0; i < ids.length; i++) {
        const caps = readLoadedCapabilities(ids[i], kinds[i] ?? '');
        if (!caps) continue;
        sawAny = true;
        for (const [key, value] of Object.entries(caps)) {
            if (key === 'allowedDomains') {
                if (Array.isArray(value)) domains.push(...value.map(String));
                continue;
            }
            // Booleans OR together; anything else takes the first definition.
            if (typeof value === 'boolean') {
                merged[key] = merged[key] === true || value;
            } else if (!(key in merged)) {
                merged[key] = value;
            }
        }
    }

    if (!sawAny) return null;
    if (domains.length > 0) merged.allowedDomains = [...new Set(domains)];
    return merged;
}

/** Read one loaded def's `capabilities` object from the registry for persistence. */
interface PreambleData {
    manifest: ExternalPluginManifest;
    bundle: Buffer;
    keyId: string;
    signingKeySource: 'official' | 'operator';
    prior: ExternalPluginRow | null;
    wasLoaded: boolean;
    mode: InstallMode;
}

/**
 * Shared preamble: guards, fetch+verify manifest, parse+validate, fetch bundle,
 * checksum, classify, anti-rollback. Returns either the validated data or a
 * terminal error result. A fetch throw (SSRF/timeout/size/HTTP) NEVER escapes —
 * it is mapped to a 400 result.
 */
async function runPreamble(
    sql: postgres.Sql,
    input: InstallInput,
): Promise<PreambleData | InstallResult> {
    if (!config.PLUGINS_EXTERNAL_INSTALL_ENABLED) {
        return { status: 400, body: { error: 'external plugin install disabled' } };
    }
    const trustedKeys = buildEffectiveTrustedKeys(); // official anchor ∪ operator env
    if (trustedKeys.length === 0) {
        return { status: 400, body: { error: 'no trusted signing keys configured' } };
    }

    // 2. Fetch manifest bytes (guarded).
    let rawBytes: Buffer;
    try {
        const fetched = await fetchWithGuards(input.manifestUrl, {
            maxBytes: config.PLUGIN_INSTALL_MAX_MANIFEST_BYTES,
            allowPrivate: config.PLUGIN_INSTALL_ALLOW_PRIVATE,
            timeoutMs: config.PLUGIN_INSTALL_FETCH_TIMEOUT_MS,
        });
        rawBytes = fetched.bytes;
    } catch (err) {
        return { status: 400, body: { error: `manifest fetch failed: ${String(err)}` } };
    }

    // 3. Verify detached signature over RAW bytes.
    const verified = verifyManifestSignature(rawBytes, input.signature, trustedKeys);
    if (!verified) {
        return { status: 400, body: { error: 'signature not trusted' } };
    }

    // 4. Parse + validate manifest.
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawBytes.toString('utf8'));
    } catch {
        return { status: 400, body: { error: 'invalid manifest: not JSON' } };
    }
    const result = ExternalPluginManifestSchema.safeParse(parsed);
    if (!result.success) {
        return { status: 400, body: { error: `invalid manifest: ${result.error.message}` } };
    }
    const manifest = result.data;

    // Cross-check the manifest's advisory keyId against the key that actually
    // verified. A mismatch is NON-FATAL (the crypto is authoritative) but logged
    // — it usually means a stale/misconfigured signer manifest.
    if (manifest.keyId && manifest.keyId !== verified.keyId) {
        logger.warn('manifest.keyId does not match the verifying key', {
            name: manifest.name,
            claimed: manifest.keyId,
            verified: verified.keyId,
        });
    }

    // 5. Fetch bundle bytes (guarded).
    let bundle: Buffer;
    try {
        const fetched = await fetchWithGuards(manifest.bundleUrl, {
            maxBytes: config.PLUGIN_INSTALL_MAX_BUNDLE_BYTES,
            allowPrivate: config.PLUGIN_INSTALL_ALLOW_PRIVATE,
            timeoutMs: config.PLUGIN_INSTALL_FETCH_TIMEOUT_MS,
        });
        bundle = fetched.bytes;
    } catch (err) {
        return { status: 400, body: { error: `bundle fetch failed: ${String(err)}` } };
    }

    // 6. Checksum: bundle sha256 must equal manifest.checksum AND any client hint.
    const bundleHash = sha256Hex(bundle);
    if (bundleHash !== manifest.checksum) {
        return { status: 400, body: { error: 'checksum mismatch' } };
    }
    if (input.checksum && input.checksum !== manifest.checksum) {
        return { status: 400, body: { error: 'checksum mismatch' } };
    }

    // 7. Classify.
    const prior = await snapshotExternalPlugin(sql, manifest.name);
    const wasLoaded = taskRegistry.hasPluginRegistered(manifest.name);
    const mode = classifyInstall(prior, wasLoaded);

    // 8. Anti-rollback, signing-key continuity and the ABI gate — one ordered
    //    decision, shared with the preview so the two cannot disagree. All
    //    three are evaluated against the RETAINED row: uninstall only flips
    //    status/enabled, so neither a downgrade window nor a publisher swap
    //    reopens just because the plugin is no longer loaded.
    const gateError = installGateRejection({
        prior,
        version: manifest.version,
        keyId: verified.keyId,
        abi: manifestSdkAbi(manifest),
        hostAbi: PLUGIN_SDK_ABI,
        minAppVersion: manifest.minAppVersion,
        appVersion: config.APP_VERSION,
        priorOnDisk: priorPayloadOnDisk(prior, manifest.name),
        force: !!input.force,
    });
    if (gateError) {
        // The ABI rejection is a bad request (the bundle is wrong for this
        // host); the other two are conflicts with what is already recorded.
        const status =
            gateError === sdkAbiRejection(manifestSdkAbi(manifest), PLUGIN_SDK_ABI) ? 400 : 409;
        return { status, body: { error: gateError } };
    }

    return {
        manifest,
        bundle,
        keyId: verified.keyId,
        signingKeySource: verified.source,
        prior,
        wasLoaded,
        mode,
    };
}

/**
 * What an operator sees BEFORE deciding to install.
 *
 * Everything in here is verified rather than claimed. A catalog can advertise
 * whatever it likes about a plugin; this is the manifest as actually signed,
 * the key that actually verified it, and the host's actual verdict on ABI,
 * version and publisher continuity — one click before anything is installed.
 */
export interface InstallPreview {
    name: string;
    version: string;
    kinds: string[];
    sdkAbi: number;
    /** The trusted key that cryptographically matched, never the manifest's claim. */
    signingKeyId: string;
    signingKeySource: 'official' | 'operator';
    /** Signed catalog metadata, or null when the publisher declared none. */
    metadata: Record<string, unknown> | null;
    mode: InstallMode;
    /** Version currently installed, when this would be an upgrade. */
    installedVersion?: string;
    /** Why installing would fail, if it would. Null when it would proceed. */
    blockedReason: string | null;
}

/**
 * Dry-run an install: fetch and verify the MANIFEST only, then report what
 * would happen. Performs no writes and does not fetch the bundle.
 *
 * This also upgrades the manual paste-a-URL flow from "install and find out"
 * to "look, then install", which is why it is worth having before any catalog
 * exists.
 */
export async function previewExternalPlugin(
    sql: postgres.Sql,
    input: { manifestUrl: string; signature: string },
): Promise<{ status: number; body: InstallPreview | { error: string } }> {
    if (!config.PLUGINS_EXTERNAL_INSTALL_ENABLED) {
        return { status: 400, body: { error: 'external plugin install disabled' } };
    }
    const trustedKeys = buildEffectiveTrustedKeys();
    if (trustedKeys.length === 0) {
        return { status: 400, body: { error: 'no trusted signing keys configured' } };
    }

    let rawBytes: Buffer;
    try {
        const fetched = await fetchWithGuards(input.manifestUrl, {
            maxBytes: config.PLUGIN_INSTALL_MAX_MANIFEST_BYTES,
            allowPrivate: config.PLUGIN_INSTALL_ALLOW_PRIVATE,
            timeoutMs: config.PLUGIN_INSTALL_FETCH_TIMEOUT_MS,
        });
        rawBytes = fetched.bytes;
    } catch (err) {
        return { status: 400, body: { error: `manifest fetch failed: ${String(err)}` } };
    }

    const verified = verifyManifestSignature(rawBytes, input.signature, trustedKeys);
    if (!verified) {
        return { status: 400, body: { error: 'signature verification failed' } };
    }

    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(rawBytes.toString('utf8'));
    } catch {
        return { status: 400, body: { error: 'manifest is not valid JSON' } };
    }
    const result = ExternalPluginManifestSchema.safeParse(parsedJson);
    if (!result.success) {
        return { status: 400, body: { error: `invalid manifest: ${result.error.message}` } };
    }
    const manifest = result.data;

    const prior = await snapshotExternalPlugin(sql, manifest.name);
    const mode = classifyInstall(prior, taskRegistry.hasPluginRegistered(manifest.name));

    // Report the same verdicts the install would reach, in the same order, so
    // the preview can never say "fine" about something that then fails.
    const blockedReason = installGateRejection({
        prior,
        version: manifest.version,
        keyId: verified.keyId,
        abi: manifestSdkAbi(manifest),
        hostAbi: PLUGIN_SDK_ABI,
        minAppVersion: manifest.minAppVersion,
        appVersion: config.APP_VERSION,
        priorOnDisk: priorPayloadOnDisk(prior, manifest.name),
        force: false,
    });

    return {
        status: 200,
        body: {
            name: manifest.name,
            version: manifest.version,
            kinds: manifestKinds(manifest),
            sdkAbi: manifestSdkAbi(manifest),
            signingKeyId: verified.keyId,
            signingKeySource: verified.source,
            metadata: signedMetadataOf(manifest),
            mode,
            ...(prior ? { installedVersion: prior.version } : {}),
            blockedReason,
        },
    };
}

/** Best-effort recursive remove; never throws (leftover staging dir is non-fatal). */
function bestEffortRm(target: string): void {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {
        logger.debug('best-effort rm failed', { target, err: String(err) });
    }
}

/**
 * Atomic single-file write: `<dir>/.tmp-<name>-<rand>/index.js` → fsync → rename
 * to `<dest>`. Self-cleans its own staging dir if the write fails partway, so a
 * mkdir-then-write failure never leaks a `.tmp-*` dir. [staging leak]
 */
function stageFreshDir(bundle: Buffer, name: string): string {
    const baseDir = externalPluginsDir();
    const rand = crypto.randomBytes(6).toString('hex');
    const tmpDir = path.join(baseDir, `.tmp-${name}-${rand}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
        const tmpFile = path.join(tmpDir, 'index.js');
        const fd = fs.openSync(tmpFile, 'w');
        try {
            fs.writeSync(fd, bundle);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    } catch (err) {
        bestEffortRm(tmpDir);
        throw err;
    }
    return tmpDir;
}

/**
 * Stage a signed multi-file bundle: extract the archive into a private
 * `.tmp-<name>-<rand>` dir (path/typeflag/bomb guards enforced by
 * `extractTarball`), assert the declared entry is a real regular file present in
 * the extracted tree, and return the derived `BundleArtifact` (entry +
 * treeDigest + per-file digests) for persistence. On ANY failure the staging dir
 * is best-effort removed and the error rethrown, so a partial tree never leaks
 * and the caller sees a clean failure. [staging leak]
 */
function stageFreshBundle(
    archive: Buffer,
    name: string,
    entry: string,
    /**
     * `manifest.treeDigest` when the signer emitted one. Verified against the
     * digest derived from the ACTUALLY EXTRACTED tree, so a bundle whose content
     * does not match what was signed is rejected before anything is persisted.
     *
     * Undefined for manifests signed before the field existed — those still
     * install on the transport checksum alone, exactly as before.
     */
    expectedTreeDigest?: string,
): { tmpDir: string; artifact: BundleArtifact } {
    const baseDir = externalPluginsDir();
    const rand = crypto.randomBytes(6).toString('hex');
    const tmpDir = path.join(baseDir, `.tmp-${name}-${rand}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
        const limits = bundleLimitsFromConfig();
        const inflated = inflateIfGzip(archive, limits);
        const { files, treeDigest } = extractTarball(inflated, tmpDir, limits);
        // Content identity, checked against the SIGNED value before the entry
        // lookup so a mismatched tree never gets further. `checksum` already
        // pinned the compressed bytes; this pins what those bytes decompress
        // to, which is the part that is reproducible from source.
        if (expectedTreeDigest !== undefined && treeDigest !== expectedTreeDigest) {
            throw new Error('tree digest mismatch');
        }
        const entryFile = files.find((f) => f.path === entry);
        if (!entryFile) throw new Error('entry not found in archive');
        // A dir would never appear in files[] (dirs are implicit) — but the
        // declared entry must resolve to a real regular file on disk.
        const entryAbs = path.join(tmpDir, entry);
        if (!fs.existsSync(entryAbs) || !fs.statSync(entryAbs).isFile()) {
            throw new Error('entry not a regular file');
        }
        try {
            const dfd = fs.openSync(tmpDir, 'r');
            try {
                fs.fsyncSync(dfd);
            } finally {
                fs.closeSync(dfd);
            }
        } catch (err) {
            logger.debug('best-effort dir fsync failed', { tmpDir, err: String(err) });
        }
        return { tmpDir, artifact: { entry, treeDigest, files } };
    } catch (err) {
        bestEffortRm(tmpDir);
        throw err;
    }
}

/** Test-only re-export of the staging primitive (unit tests bypass HTTP/DB). */
export const __test_stageFreshBundle = stageFreshBundle;

function toUpsert(
    manifest: ExternalPluginManifest,
    input: InstallInput,
    capabilities: Record<string, unknown> | null,
    enabled: boolean,
    actor: AuditActor | null,
    bundle: BundleArtifact | null,
    signingKeyId: string | null,
): ExternalPluginUpsert {
    return {
        name: manifest.name,
        version: manifest.version,
        checksum: manifest.checksum,
        sourceManifestUrl: input.manifestUrl,
        signature: input.signature,
        capabilities,
        enabled,
        status: 'installed',
        installedBy: actor?.username ?? null,
        bundle,
        signingKeyId,
        // Persisted so EVERY LOAD can re-check it, not just this install. A
        // plugin installed today outlives the host version that accepted it.
        sdkAbi: manifestSdkAbi(manifest),
        manifestMetadata: signedMetadataOf(manifest),
    };
}

/**
 * The signed catalog fields, or null when the manifest declared none.
 *
 * Copied verbatim rather than merged with anything a catalog said: the point of
 * these being inside the signature is that the value shown to the operator is
 * the publisher's, not a repository's.
 */
function signedMetadataOf(manifest: ExternalPluginManifest): Record<string, unknown> | null {
    const entries = Object.entries({
        publisher: manifest.publisher,
        description: manifest.description,
        license: manifest.license,
        sourceUrl: manifest.sourceUrl,
        capabilities: manifest.capabilities,
        minAppVersion: manifest.minAppVersion,
        releasedAt: manifest.releasedAt,
    }).filter(([, v]) => v !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function rowToUpsert(row: ExternalPluginRow, actor: AuditActor | null): ExternalPluginUpsert {
    // Restore the PRIOR row verbatim on an upgrade-failure rollback. An
    // InvalidBundle sentinel is NOT a writable artifact — collapse it to null
    // (that row stays refused on the next load anyway); a valid artifact is
    // carried through unchanged so a restored bundle row remains loadable.
    const bundle = row.bundle === null || isInvalidBundle(row.bundle) ? null : row.bundle;
    // EVERY persisted field must be carried, not just the obvious ones. The
    // upsert writes `?? null` for anything absent, so a field omitted here is
    // not "left alone" — it is DESTROYED on the rollback that was supposed to
    // leave the working plugin untouched. `sdkAbi` and `manifestMetadata` were
    // both missing: a failed upgrade nulled the ABI (which then reads as 1, so
    // any host past ABI 1 refuses to load the untouched prior version) and
    // discarded the signed publisher/description/capabilities the operator
    // approved.
    return {
        name: row.name,
        version: row.version,
        sdkAbi: row.sdkAbi ?? undefined,
        manifestMetadata: row.manifestMetadata ?? undefined,
        checksum: row.checksum,
        sourceManifestUrl: row.sourceManifestUrl,
        signature: row.signature,
        capabilities: row.capabilities,
        enabled: row.enabled,
        status: row.status,
        installedBy: row.installedBy ?? actor?.username ?? null,
        bundle,
        signingKeyId: row.signingKeyId,
    };
}

/**
 * Install (or upgrade) an offline-signed external plugin from a remote manifest
 * URL + detached Ed25519 signature. Fresh installs hot-load into the running
 * process; upgrades stage the new bundle and require a restart to take effect.
 */
export async function installExternalPlugin(
    sql: postgres.Sql,
    input: InstallInput,
    actor: AuditActor | null,
): Promise<InstallResult> {
    const pre = await runPreamble(sql, input);
    if ('status' in pre) return pre; // terminal error result
    const { manifest, bundle, keyId, signingKeySource, prior, wasLoaded, mode } = pre;
    const name = manifest.name;
    const isBundle = manifest.format === 'bundle';
    const baseDir = externalPluginsDir();
    const destDir = path.join(baseDir, name);

    if (mode === 'fresh') {
        // --- Branch A: fresh hot-load ---
        let tmpDir: string | undefined;
        let artifact: BundleArtifact | null = null;
        try {
            if (isBundle) {
                const staged = stageFreshBundle(
                    bundle,
                    name,
                    manifest.entry as string,
                    manifest.treeDigest,
                );
                tmpDir = staged.tmpDir;
                artifact = staged.artifact;
            } else {
                tmpDir = stageFreshDir(bundle, name);
            }
            fs.renameSync(tmpDir, destDir);
        } catch (err) {
            // The rename may have failed with the staged .tmp-* dir still on
            // disk — remove it so a failed install never leaks staging. [staging leak]
            if (tmpDir) bestEffortRm(tmpDir);
            if (isReadOnlyFsError(err)) {
                return {
                    status: 500,
                    body: {
                        error: 'plugins directory is read-only — mount PLUGINS_EXTERNAL_DIR writable to install',
                    },
                };
            }
            // Extraction/bomb/path-escape/entry-missing → 400 (malformed input),
            // consistent with the checksum-mismatch 400; only a real FS failure is 500.
            if (isBundle) {
                return { status: 400, body: { error: `invalid bundle: ${String(err)}` } };
            }
            return { status: 500, body: { error: `failed to stage plugin: ${String(err)}` } };
        }

        // 10a. Persist registry row (capabilities filled after load). The pre-load
        //      row MUST carry the freshly-computed artifact so `loadOneDir` picks
        //      the bundle branch (a null here would brick a bundle install). [§3.7]
        await upsertExternalPlugin(
            sql,
            toUpsert(manifest, input, null, true, actor, artifact, keyId),
        );

        // 11a. Hot-load + wire. The identity/kind/isolation gate is threaded in
        //      so a mismatched or worker-isolated bundle is REFUSED
        //      pre-registration (never registers a def, never starts a worker) —
        //      the only failure the installer sees is a clean, unregistered
        //      rejection that files+row rollback fully undoes. [Fable-1]
        const wired = await loadAndWirePlugin(destDir, sql, {
            expectedName: manifest.name,
            ...(isMultiContract(manifest)
                ? { expectedKinds: manifestKinds(manifest) }
                : { expectedKind: manifest.kind }),
            rejectWorkerIsolation: true,
        });

        // A fresh install can sit on a retained 'uninstalled' row whose version
        // and signing key still gate replays and publisher swaps: put it back
        // rather than deleting it, or one failed attempt drops both pins.
        const rollback = async (): Promise<void> => {
            if (prior) await upsertExternalPlugin(sql, rowToUpsert(prior, actor));
            else await deleteExternalPluginRow(sql, name);
            bestEffortRm(destDir);
        };

        if (!wired.loaded) {
            await rollback();
            const loadErr = wired.error ?? lastLoadError.get(name) ?? 'bundle failed to execute';
            // Identity / kind / isolation mismatches are caught pre-registration
            // (nothing registered) → 400; a genuine execute-time throw → 422.
            return { status: wired.constraintViolation ? 400 : 422, body: { error: loadErr } };
        }

        // Persist real capabilities read from the loaded def(s). The
        // pre-registration gate guarantees the loaded kinds equal what the
        // manifest declared, so the ids/kinds the loader reports are the ones
        // signed for. [Fable-1]
        const capabilities = readBundleCapabilities(
            wired.ids ?? [name],
            wired.kinds ?? manifestKinds(manifest),
        );

        // The signed declaration is an upper bound, not decoration. An operator
        // approved this install against what the manifest CLAIMED; a bundle
        // that then registers more than that made the confirmation a lie.
        //
        // Checked after load because capabilities are a property of the loaded
        // definitions — which means the offending code has, unavoidably, already
        // run. The rollback below still removes it from disk and from the
        // registry, and the operator gets told why; what this cannot do is
        // un-execute it. That is the standing no-sandbox caveat, not a new one.
        const capsViolation = capabilitySubsetViolation(manifest.capabilities, capabilities);
        if (capsViolation) {
            await rollback();
            logger.error('External plugin exceeded its declared capabilities', undefined, {
                name,
                reason: capsViolation,
            });
            return { status: 422, body: { error: capsViolation } };
        }
        await upsertExternalPlugin(
            sql,
            toUpsert(manifest, input, capabilities, true, actor, artifact, keyId),
        );

        auditLog('plugin.external.install', name, actor, {
            version: manifest.version,
            keyId,
            source: signingKeySource,
            checksum: manifest.checksum,
            force: !!input.force,
            mode,
        });

        return {
            status: 201,
            body: {
                id: name,
                name,
                version: manifest.version,
                kind: manifestKinds(manifest)[0],
                kinds: manifestKinds(manifest),
                enabled: true,
                status: 'installed',
                loaded: true,
                restartRequired: false,
                signingKeyId: keyId,
                signingKeySource,
            },
        };
    }

    // --- Branch B: upgrade / reinstall (stage for restart) ---
    const rand = crypto.randomBytes(6).toString('hex');
    const oldDir = path.join(baseDir, `.old-${name}-${rand}`);
    let swapStarted = false;
    let tmpDir: string | undefined;
    // Recomputed for the NEW archive; never carried forward from the prior row.
    // A single-file upgrade (format absent/'single') leaves this null → a
    // bundle→single downgrade correctly persists bundle: null (no stale brick).
    let artifact: BundleArtifact | null = null;
    try {
        if (isBundle) {
            const staged = stageFreshBundle(
                bundle,
                name,
                manifest.entry as string,
                manifest.treeDigest,
            );
            tmpDir = staged.tmpDir;
            artifact = staged.artifact;
        } else {
            tmpDir = stageFreshDir(bundle, name);
        }
        if (fs.existsSync(destDir)) {
            fs.renameSync(destDir, oldDir);
            swapStarted = true;
        }
        fs.renameSync(tmpDir, destDir);
        // best-effort cleanup of the displaced old dir
        if (swapStarted) {
            bestEffortRm(oldDir);
        }
    } catch (err) {
        // The swap may have failed with the staged .tmp-* dir still on disk —
        // remove it so a failed upgrade never leaks staging. [staging leak]
        if (tmpDir && fs.existsSync(tmpDir)) bestEffortRm(tmpDir);
        // Restore — NEVER delete the registry row / dest dir on upgrade failure.
        if (swapStarted && !fs.existsSync(destDir)) {
            try {
                fs.renameSync(oldDir, destDir);
            } catch (restoreErr) {
                logger.error('failed to restore old plugin dir after upgrade failure', {
                    name,
                    err: String(restoreErr),
                });
            }
        }
        if (prior) {
            await upsertExternalPlugin(sql, rowToUpsert(prior, actor));
        }
        if (isReadOnlyFsError(err)) {
            return {
                status: 500,
                body: {
                    error: 'plugins directory is read-only — mount PLUGINS_EXTERNAL_DIR writable to install',
                },
            };
        }
        return { status: 500, body: { error: `failed to stage plugin upgrade: ${String(err)}` } };
    }

    // 10b. Persist new fields; preserve prior enabled/capabilities.
    try {
        await upsertExternalPlugin(
            sql,
            toUpsert(
                manifest,
                input,
                prior?.capabilities ?? null,
                prior?.enabled ?? true,
                actor,
                artifact,
                keyId,
            ),
        );
    } catch (err) {
        if (prior) {
            await upsertExternalPlugin(sql, rowToUpsert(prior, actor));
        }
        return {
            status: 500,
            body: { error: `failed to persist plugin registry row: ${String(err)}` },
        };
    }

    auditLog('plugin.external.install', name, actor, {
        version: manifest.version,
        keyId,
        // The key this upgrade REPLACED. Only interesting when it differs —
        // that case only reaches here via `force`, so this is the record of an
        // operator accepting a new publisher for an installed plugin, which is
        // the single most security-relevant thing this endpoint can do.
        priorKeyId: prior?.signingKeyId ?? null,
        source: signingKeySource,
        checksum: manifest.checksum,
        force: !!input.force,
        mode,
    });

    return {
        status: 200,
        body: {
            id: name,
            name,
            version: manifest.version,
            kind: manifestKinds(manifest)[0],
            kinds: manifestKinds(manifest),
            enabled: prior?.enabled ?? true,
            status: 'installed',
            loaded: wasLoaded,
            restartRequired: true,
            signingKeyId: keyId,
            signingKeySource,
        },
    };
}
