// install.integration.test.ts
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
//
// Full-path integration suite for the external-plugin install flow. Drives the
// real installer + loader against a live PostgreSQL and an ephemeral HTTP
// origin serving a signed manifest + bundle. The three focused describe blocks
// (security rejections / upgrade+rollback / discovery hardening) exercise every
// reject and lifecycle branch end-to-end.
//
// Test-isolation notes (why this harness diverges from a naive suite):
//   * Fresh registry per test — `installExternalPlugin` and the loader mutate
//     the module singleton `registry` from `$lib/server/tasks/registry.js`,
//     which has NO unregister primitive (unload is restart-only). Each test
//     assumes it begins as if in a fresh process (a plugin id not yet loaded;
//     the "reinstall older after uninstall → 201" case even requires
//     `wasLoaded === false`). So `beforeEach` runs `vi.resetModules()` and
//     re-imports the installer + loader + queries, giving every test an empty
//     `registry`.
//   * Fresh on-disk dir per test — every install lands the bundle at
//     `<dir>/sample-plugin/index.js`; Node's native ESM loader caches
//     `import('file://…')` by URL for the whole process and `vi.resetModules()`
//     does NOT clear that native cache. A unique `PLUGINS_EXTERNAL_DIR` per
//     test gives each install a distinct URL so the ACTUAL bundle (worker /
//     throwing / task) is executed, not a cached earlier one.
//   * `node:fs` is mocked (pass-through) so the mid-swap upgrade test can inject
//     a deterministic rename failure — the installer imports fs as a namespace
//     (`import * as fs`) whose ESM binding is frozen and cannot be `vi.spyOn`ed.
//
// `sql`, the HTTP origin, and the signing key are set up once in `beforeAll`.
// The config security getters read `process.env` live, so env flips in
// individual tests still take effect against the freshly-imported installer.
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    buildTar,
    buildGzipTar,
    TASK_BUNDLE_ENTRY,
    TASK_BUNDLE_SIB,
} from './__fixtures__/bundle-fixtures.js';

// Controllable rename failure injection for the non-destructive-upgrade test.
// Hoisted so the (hoisted) `vi.mock('node:fs')` factory can close over it.
const fsControl = vi.hoisted(() => ({ renameCalls: 0, failRenameOnCall: 0 }));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const renameSync = ((...args: Parameters<typeof actual.renameSync>): void => {
        fsControl.renameCalls += 1;
        if (
            fsControl.failRenameOnCall > 0 &&
            fsControl.renameCalls === fsControl.failRenameOnCall
        ) {
            throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
        }
        return actual.renameSync(...args);
    }) as typeof actual.renameSync;
    return { ...actual, renameSync, default: { ...actual, renameSync } };
});

// Delegating mock: buildEffectiveTrustedKeys is a spy that defaults to the REAL
// union builder; only the official test overrides it per-call. classifyKeyId,
// getOfficialTrustedKeys, etc. stay real (…actual).
vi.mock('./trust-anchors.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./trust-anchors.js')>();
    return { ...actual, buildEffectiveTrustedKeys: vi.fn(actual.buildEffectiveTrustedKeys) };
});
// auditLog spy (defaults to the real impl) so tests can assert the emitted source.
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: vi.fn() };
});

// Freshly re-imported per test (see beforeEach) so each test drives an empty
// `registry` singleton. Types are pulled from the modules without a static
// runtime import so the module graph is only realized after `vi.resetModules()`.
let installExternalPlugin: typeof import('./installer.js').installExternalPlugin;
let taskRegistry: typeof import('$lib/server/tasks/registry.js').registry;
let discoverExternalPlugins: typeof import('$lib/server/plugins/runtime/loader.js').discoverExternalPlugins;
let loadAndWirePlugin: typeof import('$lib/server/plugins/runtime/loader.js').loadAndWirePlugin;
let getExternalPlugin: typeof import('$lib/server/database/queries/external-plugins.queries.js').getExternalPlugin;
let deleteExternalPluginRow: typeof import('$lib/server/database/queries/external-plugins.queries.js').deleteExternalPluginRow;
let markExternalPluginUninstalled: typeof import('$lib/server/database/queries/external-plugins.queries.js').markExternalPluginUninstalled;
let setExternalPluginEnabled: typeof import('$lib/server/database/queries/external-plugins.queries.js').setExternalPluginEnabled;
// The mock factories re-run on each vi.resetModules(), producing a FRESH spy each
// time — so these must be re-imported per test (see loadFreshModules).
let buildEffectiveTrustedKeys: typeof import('./trust-anchors.js').buildEffectiveTrustedKeys;
let getOfficialTrustedKeys: typeof import('./trust-anchors.js').getOfficialTrustedKeys;
let classifyKeyId: typeof import('./trust-anchors.js').classifyKeyId;
let auditLog: typeof import('$lib/server/utils/audit-log.js').auditLog;

/** Current auditLog spy's calls: auditLog(action, target, actor, details). */
const auditCalls = (): unknown[][] => vi.mocked(auditLog).mock.calls;

async function loadFreshModules(): Promise<void> {
    vi.resetModules();
    ({ installExternalPlugin } = await import('./installer.js'));
    ({ registry: taskRegistry } = await import('$lib/server/tasks/registry.js'));
    ({ discoverExternalPlugins, loadAndWirePlugin } =
        await import('$lib/server/plugins/runtime/loader.js'));
    ({
        getExternalPlugin,
        deleteExternalPluginRow,
        markExternalPluginUninstalled,
        setExternalPluginEnabled,
    } = await import('$lib/server/database/queries/external-plugins.queries.js'));
    ({ buildEffectiveTrustedKeys, getOfficialTrustedKeys, classifyKeyId } =
        await import('./trust-anchors.js'));
    ({ auditLog } = await import('$lib/server/utils/audit-log.js'));
}

let sql: postgres.Sql;
let baseTmp: string;
let tmpDir: string;
let priv: crypto.KeyObject;
let server: http.Server;
let base: string;
let manifestBytes: Buffer;
let bundleBytes: Buffer;
let signature: string;
const NAME = 'sample-plugin';

function sign(bytes: Buffer): string {
    return crypto.sign(null, bytes, priv).toString('base64');
}
function sha256(b: Buffer): string {
    return crypto.createHash('sha256').update(b).digest('hex');
}

function buildFixture(version: string, bundleSrc: string): void {
    bundleBytes = Buffer.from(bundleSrc, 'utf8');
    const checksum = sha256(bundleBytes);
    const manifest = { name: NAME, version, kind: 'task', bundleUrl: `${base}/index.js`, checksum };
    manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    signature = sign(manifestBytes);
}

function buildManifest(overrides: Record<string, unknown>, bundleSrc: string, name = NAME): void {
    bundleBytes = Buffer.from(bundleSrc, 'utf8');
    const checksum = sha256(bundleBytes);
    const manifest = {
        name,
        version: '1.0.0',
        kind: 'task',
        bundleUrl: `${base}/index.js`,
        checksum,
        ...overrides,
    };
    manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    signature = sign(manifestBytes);
}

const TASK_SRC = (): string =>
    fs.readFileSync(path.join(__dirname, '__fixtures__/task-plugin.js'), 'utf8');
const THROW_SRC = (): string =>
    fs.readFileSync(path.join(__dirname, '__fixtures__/throwing-plugin.js'), 'utf8');
const WORKER_SRC = (): string =>
    fs.readFileSync(path.join(__dirname, '__fixtures__/worker-task-plugin.js'), 'utf8');
const manifestUrl = (): string => `${base}/manifest.json`;

beforeAll(async () => {
    sql = getTestDb();
    baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-install-'));
    process.env.PLUGINS_EXTERNAL_INSTALL_ENABLED = 'true';
    process.env.PLUGIN_INSTALL_ALLOW_PRIVATE = 'true';
    const kp = crypto.generateKeyPairSync('ed25519');
    priv = kp.privateKey;
    const spki = kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    process.env.PLUGIN_TRUSTED_KEYS = `test:${spki}`;

    server = http.createServer((req, res) => {
        if (req.url === '/manifest.json') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(manifestBytes);
        } else if (req.url === '/index.js') {
            res.writeHead(200, { 'content-type': 'application/javascript' });
            res.end(bundleBytes);
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    base = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';
});

beforeEach(async () => {
    // Fresh module graph (empty registry) + fresh on-disk dir (distinct import
    // URL) per test — see the file header for why both are required.
    await loadFreshModules();
    tmpDir = fs.mkdtempSync(path.join(baseTmp, 'ext-'));
    process.env.PLUGINS_EXTERNAL_DIR = tmpDir;
    fsControl.renameCalls = 0;
    fsControl.failRenameOnCall = 0;
    await deleteExternalPluginRow(sql, NAME);
});

afterEach(() => {
    fsControl.failRenameOnCall = 0;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
    server.close();
    fs.rmSync(baseTmp, { recursive: true, force: true });
    await deleteExternalPluginRow(sql, NAME);
    await closeTestDb();
    delete process.env.PLUGINS_EXTERNAL_DIR;
    delete process.env.PLUGINS_EXTERNAL_INSTALL_ENABLED;
    delete process.env.PLUGIN_INSTALL_ALLOW_PRIVATE;
    delete process.env.PLUGIN_TRUSTED_KEYS;
});

describe('external plugin install (full path)', () => {
    it('fresh install → 201, restartRequired false, task registered [happy path]', async () => {
        buildFixture('1.0.0', TASK_SRC());
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ loaded: true, restartRequired: false });
        expect(taskRegistry.hasPluginRegistered(NAME)).toBe(true);
        expect(await getExternalPlugin(sql, NAME)).not.toBeNull();
    });

    it('persists the verifying keyId and reports + audits operator source on a fresh install', async () => {
        buildFixture('1.0.0', TASK_SRC());
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(201);
        expect((r.body as { signingKeyId?: string }).signingKeyId).toBe('test');
        expect((r.body as { signingKeySource?: string }).signingKeySource).toBe('operator');
        const row = await getExternalPlugin(sql, NAME);
        expect(row?.signingKeyId).toBe('test');
        const last = auditCalls().at(-1);
        expect(last?.[0]).toBe('plugin.external.install');
        expect(last?.[3]).toMatchObject({ source: 'operator', keyId: 'test' });
    });

    it('a manifest.keyId that disagrees with the verifying key still installs; persisted keyId is the VERIFYING key', async () => {
        // Advisory keyId is bogus; the raw manifest bytes are still signed by the
        // trusted 'test' key, so it verifies and the persisted keyId is 'test'.
        buildManifest({ keyId: 'not-the-signer' }, TASK_SRC());
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(201);
        expect((r.body as { signingKeyId?: string }).signingKeyId).toBe('test'); // NOT 'not-the-signer'
        expect((await getExternalPlugin(sql, NAME))?.signingKeyId).toBe('test');
    });

    it('installs a manifest signed by an OFFICIAL key (operator env unset): persists official keyId, reports + audits source official', async () => {
        buildFixture('1.0.0', TASK_SRC());
        // Ephemeral OFFICIAL keypair — NEVER a committed key. Distinct from the harness operator key.
        const off = crypto.generateKeyPairSync('ed25519');
        const offSpki = off.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
        const officialEntry = `lumastra-official-test:${offSpki}`;

        // Re-sign the SAME manifestBytes with the official private key.
        const officialSig = crypto.sign(null, manifestBytes, off.privateKey).toString('base64');

        // Operator env UNSET — trust comes solely from the (mocked) official anchor for THIS install.
        const prevOperator = process.env.PLUGIN_TRUSTED_KEYS;
        delete process.env.PLUGIN_TRUSTED_KEYS;
        // getOfficialTrustedKeys is real (…actual) → parses the ephemeral entry, tagged source:'official'.
        vi.mocked(buildEffectiveTrustedKeys).mockReturnValueOnce(
            getOfficialTrustedKeys([officialEntry]),
        );
        try {
            const r = await installExternalPlugin(
                sql,
                { manifestUrl: manifestUrl(), signature: officialSig },
                { username: 'denis' },
            );
            expect(r.status).toBe(201);
            expect((r.body as { signingKeyId?: string }).signingKeyId).toBe(
                'lumastra-official-test',
            );
            expect((r.body as { signingKeySource?: string }).signingKeySource).toBe('official');

            const row = await getExternalPlugin(sql, NAME);
            expect(row?.signingKeyId).toBe('lumastra-official-test');

            const last = auditCalls().at(-1);
            expect(last?.[0]).toBe('plugin.external.install');
            expect(last?.[3]).toMatchObject({
                source: 'official',
                keyId: 'lumastra-official-test',
            });
        } finally {
            if (prevOperator === undefined) delete process.env.PLUGIN_TRUSTED_KEYS;
            else process.env.PLUGIN_TRUSTED_KEYS = prevOperator;
        }
    });
});

describe('install security rejections', () => {
    it('bad signature → 400', async () => {
        buildFixture('1.0.0', TASK_SRC());
        const badSig = sign(Buffer.from('not the manifest bytes', 'utf8'));
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature: badSig },
            { username: 'denis' },
        );
        expect(r.status).toBe(400);
        expect(taskRegistry.hasPluginRegistered(NAME)).toBe(false);
    });
    it('bundle checksum mismatch → 400', async () => {
        buildFixture('1.0.0', TASK_SRC());
        bundleBytes = Buffer.from('// different bytes than manifest.checksum', 'utf8'); // manifest+sig unchanged
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(400);
    });
    it('non-http(s) bundleUrl → 400 (schema reject)', async () => {
        buildManifest({ bundleUrl: 'file:///etc/passwd' }, TASK_SRC());
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(400);
    });
    it('loaded def id != manifest.name → 400, row+dir rolled back, NOTHING registered [Fable-4a/Fable-1]', async () => {
        buildManifest({ name: 'other-name' }, TASK_SRC(), 'other-name'); // fixture def.id is 'sample-plugin'
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(400);
        expect(await getExternalPlugin(sql, 'other-name')).toBeNull();
        expect(fs.existsSync(path.join(tmpDir, 'other-name'))).toBe(false);
        // Refused PRE-registration: neither the manifest name nor the real
        // exported def id ever registered (no runtime unload could undo it). [Fable-1]
        expect(taskRegistry.hasPluginRegistered('other-name')).toBe(false);
        expect(taskRegistry.hasPluginRegistered('sample-plugin')).toBe(false);
        await deleteExternalPluginRow(sql, 'other-name');
    });
    it('loaded def kind != manifest.kind → 400, NOTHING registered [Fable-4b/Fable-1]', async () => {
        buildManifest({ kind: 'provider' }, TASK_SRC()); // fixture is a task
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(400);
        expect(taskRegistry.hasPluginRegistered(NAME)).toBe(false);
        expect(await getExternalPlugin(sql, NAME)).toBeNull();
    });
    it("isolation:'worker' task → rejected pre-registration, NOTHING registered, NO worker started [Fable-7/Fable-1]", async () => {
        buildFixture('1.0.0', WORKER_SRC());
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(400);
        // The identity/kind/isolation gate is now enforced BEFORE
        // registerSdkDefinition (loader.ts), so a worker-isolated def never
        // registers a task and never starts a per-task BullMQ worker — closing
        // the ghost-registration hole where rollback (row+files only) could not
        // undo an already-live in-process registration. [Fable-1]
        expect(taskRegistry.hasPluginRegistered(NAME)).toBe(false);
        expect(await getExternalPlugin(sql, NAME)).toBeNull();
        expect(fs.existsSync(path.join(tmpDir, NAME))).toBe(false);
    });
    it('bundle throws at import → 422, row rolled back + dir removed [review C1]', async () => {
        buildFixture('1.0.0', THROW_SRC());
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(422);
        expect(await getExternalPlugin(sql, NAME)).toBeNull();
        expect(fs.existsSync(path.join(tmpDir, NAME))).toBe(false);
    });
    it('no trusted keys configured → 400', async () => {
        const prev = process.env.PLUGIN_TRUSTED_KEYS;
        delete process.env.PLUGIN_TRUSTED_KEYS;
        try {
            buildFixture('1.0.0', TASK_SRC());
            const r = await installExternalPlugin(
                sql,
                { manifestUrl: manifestUrl(), signature },
                { username: 'denis' },
            );
            expect(r.status).toBe(400);
        } finally {
            process.env.PLUGIN_TRUSTED_KEYS = prev;
        }
    });
    it('install disabled → 400', async () => {
        process.env.PLUGINS_EXTERNAL_INSTALL_ENABLED = 'false';
        try {
            buildFixture('1.0.0', TASK_SRC());
            const r = await installExternalPlugin(
                sql,
                { manifestUrl: manifestUrl(), signature },
                { username: 'denis' },
            );
            expect(r.status).toBe(400);
        } finally {
            process.env.PLUGINS_EXTERNAL_INSTALL_ENABLED = 'true';
        }
    });
    it('private manifest URL blocked when ALLOW_PRIVATE=false → >=400', async () => {
        process.env.PLUGIN_INSTALL_ALLOW_PRIVATE = 'false';
        try {
            buildFixture('1.0.0', TASK_SRC()); // base is 127.0.0.1 → private
            const r = await installExternalPlugin(
                sql,
                { manifestUrl: manifestUrl(), signature },
                { username: 'denis' },
            );
            expect(r.status).toBeGreaterThanOrEqual(400);
            expect(taskRegistry.hasPluginRegistered(NAME)).toBe(false);
        } finally {
            process.env.PLUGIN_INSTALL_ALLOW_PRIVATE = 'true';
        }
    });
});

describe('install upgrade + rollback', () => {
    async function install(
        version: string,
        src = TASK_SRC(),
        force = false,
    ): ReturnType<typeof installExternalPlugin> {
        buildFixture(version, src);
        return installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature, force },
            { username: 'denis' },
        );
    }

    it('upgrade 1.0.0 → 1.1.0: 200, restartRequired true, on-disk index.js is the new bytes, no ENOTEMPTY', async () => {
        expect((await install('1.0.0')).status).toBe(201);
        const r = await install('1.1.0');
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ restartRequired: true });
        const onDisk = sha256(fs.readFileSync(path.join(tmpDir, NAME, 'index.js')));
        expect(onDisk).toBe(sha256(bundleBytes)); // 1.1.0 checksum on disk
        expect((await getExternalPlugin(sql, NAME))?.version).toBe('1.1.0');
        expect(taskRegistry.hasPluginRegistered(NAME)).toBe(true); // old code still loaded (restart-only)
    });

    it('anti-rollback: 1.0.0 → 0.9.0 without force = 409; with force = 200 [Fable-9][review C9]', async () => {
        expect((await install('1.0.0')).status).toBe(201);
        expect((await install('0.9.0')).status).toBe(409);
        expect((await getExternalPlugin(sql, NAME))?.version).toBe('1.0.0'); // unchanged
        expect((await install('0.9.0', TASK_SRC(), true)).status).toBe(200);
        expect((await getExternalPlugin(sql, NAME))?.version).toBe('0.9.0');
    });

    it('anti-rollback survives uninstall: reinstall older after uninstall → 409 without force, 201 with force [Fable-9 hardening]', async () => {
        expect((await install('1.1.0')).status).toBe(201);
        // Model a real uninstall: mark the row uninstalled AND remove the files
        // (the uninstall handler deletes the managed dir), then a restart clears
        // the in-process registry.
        await markExternalPluginUninstalled(sql, NAME);
        fs.rmSync(path.join(tmpDir, NAME), { recursive: true, force: true });
        await loadFreshModules();
        // The retained version column (1.1.0) still gates the downgrade — an
        // uninstall must NOT reopen a downgrade window via a replayed old
        // still-valid signed manifest.
        expect((await install('1.0.0')).status).toBe(409);
        expect((await getExternalPlugin(sql, NAME))?.version).toBe('1.1.0'); // unchanged
        // Force still overrides (deliberate operator downgrade). Prior is
        // uninstalled + files gone → a genuine fresh install → 201.
        expect((await install('1.0.0', TASK_SRC(), true)).status).toBe(201);
        expect((await getExternalPlugin(sql, NAME))?.version).toBe('1.0.0');
    });

    it('a failed reinstall after uninstall keeps the retained pins (anti-rollback still holds)', async () => {
        expect((await install('1.1.0')).status).toBe(201);
        await markExternalPluginUninstalled(sql, NAME);
        fs.rmSync(path.join(tmpDir, NAME), { recursive: true, force: true });
        await loadFreshModules();

        // Same publisher, newer version, but the bundle throws at import: the
        // rollback used to DELETE the retained row, so the version pin that
        // blocks replaying an older signed manifest was gone.
        expect((await install('1.2.0', THROW_SRC())).status).toBe(422);
        const kept = await getExternalPlugin(sql, NAME);
        expect(kept?.version).toBe('1.1.0');
        expect(kept?.status).toBe('uninstalled');

        await loadFreshModules();
        expect((await install('1.0.0')).status).toBe(409);
    });

    it('fresh-stage rename failure leaves no leaked .tmp-* staging dir + no row [staging leak]', async () => {
        // Fail the single fresh-path rename (tmp → <name>); the installer must
        // best-effort rm the staged .tmp-* dir and delete nothing that survives.
        fsControl.renameCalls = 0;
        fsControl.failRenameOnCall = 1;
        try {
            const r = await install('1.0.0');
            expect(r.status).toBe(500);
        } finally {
            fsControl.failRenameOnCall = 0;
        }
        const leftovers = fs.readdirSync(tmpDir).filter((n) => n.startsWith('.tmp-'));
        expect(leftovers).toEqual([]);
        expect(await getExternalPlugin(sql, NAME)).toBeNull();
    });

    it('mid-swap fs failure during upgrade is NON-DESTRUCTIVE: prior row+files restored, live dir never rm-rf-ed [review C1]', async () => {
        expect((await install('1.0.0')).status).toBe(201);
        const before = sha256(fs.readFileSync(path.join(tmpDir, NAME, 'index.js')));
        // Fail the SECOND rename of the upgrade (the .tmp → <name> swap) to
        // exercise the non-destructive restore path.
        fsControl.renameCalls = 0;
        fsControl.failRenameOnCall = 2;
        try {
            const r = await install('1.1.0');
            expect(r.status).toBe(500); // upgrade failed
        } finally {
            fsControl.failRenameOnCall = 0;
        }
        // Non-destructive: old version + old bytes still present, dir intact, still loaded.
        expect(fs.existsSync(path.join(tmpDir, NAME, 'index.js'))).toBe(true);
        expect(sha256(fs.readFileSync(path.join(tmpDir, NAME, 'index.js')))).toBe(before);
        expect((await getExternalPlugin(sql, NAME))?.version).toBe('1.0.0');
        expect(taskRegistry.hasPluginRegistered(NAME)).toBe(true);
    });
});

describe('discovery hardening + lifecycle', () => {
    it('discovery skips a leftover .old-* staging dir even with a valid index.js [installer staging hole]', async () => {
        const staged = path.join(tmpDir, `.old-${NAME}-deadbeef`);
        fs.mkdirSync(staged, { recursive: true });
        fs.writeFileSync(path.join(staged, 'index.js'), TASK_SRC());
        const dirs = await discoverExternalPlugins(sql);
        expect(dirs.some((d) => d.includes('.old-'))).toBe(false); // never discovered → never unverified-loaded
        fs.rmSync(staged, { recursive: true, force: true });
    });

    it('package.json#main tamper post-install: reload still loads index.js, evil never runs [review C2]', async () => {
        buildFixture('1.0.0', TASK_SRC());
        expect(
            (
                await installExternalPlugin(
                    sql,
                    { manifestUrl: manifestUrl(), signature },
                    { username: 'denis' },
                )
            ).status,
        ).toBe(201);
        const dir = path.join(tmpDir, NAME);
        fs.writeFileSync(path.join(dir, 'evil.js'), `throw new Error('evil ran');`);
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'evil.js' }));
        // The reload conceptually happens in a fresh process (post-restart): the
        // registry has no unregister primitive, so reloading a still-registered
        // id in the SAME registry would collide. Reset to a fresh registry to
        // model the restart, then reload from disk (row + index.js persist).
        await loadFreshModules();
        const wired = await loadAndWirePlugin(dir, sql); // must NOT import evil.js; checksum(index.js) still matches
        expect(wired.loaded).toBe(true);
    });

    it('removing the signing key does NOT unload the installed plugin, and source becomes unknown', async () => {
        buildFixture('1.0.0', TASK_SRC());
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(201);

        // Rotate the key OUT of the operator env (anchor is empty in this build).
        const prev = process.env.PLUGIN_TRUSTED_KEYS;
        delete process.env.PLUGIN_TRUSTED_KEYS;
        try {
            // Model a restart (fresh registry) then reload from disk. The load gate
            // re-verifies checksum/tree-digest, NOT the signature — the plugin must
            // still load despite the trusted key being gone.
            await loadFreshModules();
            const wired = await loadAndWirePlugin(path.join(tmpDir, NAME), sql);
            expect(wired.loaded).toBe(true);
            expect(wired.error).toBeUndefined();

            // Reporting now classifies the persisted keyId as unknown (removed key).
            const row = await getExternalPlugin(sql, NAME);
            expect(row?.signingKeyId).toBe('test');
            expect(classifyKeyId(row!.signingKeyId, buildEffectiveTrustedKeys([], undefined))).toBe(
                'unknown',
            );
        } finally {
            if (prev === undefined) delete process.env.PLUGIN_TRUSTED_KEYS;
            else process.env.PLUGIN_TRUSTED_KEYS = prev;
        }
    });

    it('disabled row is not loaded on reload', async () => {
        buildFixture('1.0.0', TASK_SRC());
        expect(
            (
                await installExternalPlugin(
                    sql,
                    { manifestUrl: manifestUrl(), signature },
                    { username: 'denis' },
                )
            ).status,
        ).toBe(201);
        await setExternalPluginEnabled(sql, NAME, false);
        const wired = await loadAndWirePlugin(path.join(tmpDir, NAME), sql);
        expect(wired.loaded).toBe(false);
    });

    it('PLUGINS_REQUIRE_REGISTRY=true skips a registry-less dir [nice-to-have]', async () => {
        const orphan = path.join(tmpDir, 'orphan-plugin');
        fs.mkdirSync(orphan, { recursive: true });
        fs.writeFileSync(path.join(orphan, 'index.js'), TASK_SRC());
        process.env.PLUGINS_REQUIRE_REGISTRY = 'true';
        try {
            const dirs = await discoverExternalPlugins(sql);
            expect(dirs.some((d) => d.endsWith('orphan-plugin'))).toBe(false);
        } finally {
            delete process.env.PLUGINS_REQUIRE_REGISTRY;
            fs.rmSync(orphan, { recursive: true, force: true });
        }
    });
});

describe('external plugin BUNDLE install (full path)', () => {
    function serveBundle(archive: Buffer, entry: string, version = '1.0.0'): void {
        bundleBytes = archive;
        const checksum = sha256(archive);
        const manifest = {
            name: NAME,
            version,
            kind: 'task',
            bundleUrl: `${base}/index.js`,
            checksum,
            format: 'bundle',
            entry,
        };
        manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
        signature = sign(manifestBytes);
    }

    it('fresh tar bundle install → 201, entry executed, tree persisted', async () => {
        const archive = buildTar([
            { name: 'index.js', content: TASK_BUNDLE_ENTRY(NAME) },
            { name: 'schema.js', content: TASK_BUNDLE_SIB },
        ]);
        serveBundle(archive, 'index.js');
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(201);
        expect(taskRegistry.hasPluginRegistered(NAME)).toBe(true);
        const row = await getExternalPlugin(sql, NAME);
        expect(row?.bundle).not.toBeNull();
        expect(fs.existsSync(path.join(tmpDir, NAME, 'schema.js'))).toBe(true);
    });

    it('fresh tar.gz bundle install → 201', async () => {
        const archive = buildGzipTar([
            { name: 'index.js', content: TASK_BUNDLE_ENTRY(NAME) },
            { name: 'schema.js', content: TASK_BUNDLE_SIB },
        ]);
        serveBundle(archive, 'index.js');
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(201);
    });

    it('tampered archive byte → checksum mismatch → 400', async () => {
        const archive = buildTar([{ name: 'index.js', content: TASK_BUNDLE_ENTRY(NAME) }]);
        serveBundle(archive, 'index.js');
        bundleBytes = Buffer.from(archive);
        bundleBytes[0] ^= 0xff; // corrupt served bytes only (manifest+sig unchanged)
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(400);
        expect(fs.existsSync(path.join(tmpDir, NAME))).toBe(false);
    });

    it.each([
        ['zip-slip', () => buildTar([{ name: '../evil', content: 'x' }])],
        ['symlink', () => buildTar([{ name: 'link', content: '', typeflag: '2' }])],
        ['dir-entry', () => buildTar([{ name: 'd/', content: '', typeflag: '5' }])],
    ])('malicious archive (%s) → 400, nothing staged', async (_label, make) => {
        const archive = make();
        serveBundle(archive, 'index.js');
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(400);
        expect(String((r.body as { error?: string }).error)).toMatch(/invalid bundle/);
        expect(fs.existsSync(path.join(tmpDir, NAME))).toBe(false);
        // no staging dot-dir leaked
        expect(fs.readdirSync(tmpDir).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
    });

    it('upgrade single→bundle → 200 restartRequired, bundle persisted', async () => {
        buildFixture('1.0.0', TASK_SRC()); // single-file install first
        expect(
            (
                await installExternalPlugin(
                    sql,
                    { manifestUrl: manifestUrl(), signature },
                    { username: 'denis' },
                )
            ).status,
        ).toBe(201);
        const archive = buildTar([
            { name: 'index.js', content: TASK_BUNDLE_ENTRY(NAME) },
            { name: 'schema.js', content: TASK_BUNDLE_SIB },
        ]);
        serveBundle(archive, 'index.js', '2.0.0');
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ restartRequired: true });
        expect((await getExternalPlugin(sql, NAME))?.bundle).not.toBeNull();
    });

    it('upgrade bundle→single → row bundle nulled (no stale-artifact brick)', async () => {
        const archive = buildTar([
            { name: 'index.js', content: TASK_BUNDLE_ENTRY(NAME) },
            { name: 'schema.js', content: TASK_BUNDLE_SIB },
        ]);
        serveBundle(archive, 'index.js', '1.0.0');
        expect(
            (
                await installExternalPlugin(
                    sql,
                    { manifestUrl: manifestUrl(), signature },
                    { username: 'denis' },
                )
            ).status,
        ).toBe(201);
        buildFixture('2.0.0', TASK_SRC()); // single-file upgrade
        const r = await installExternalPlugin(
            sql,
            { manifestUrl: manifestUrl(), signature },
            { username: 'denis' },
        );
        expect(r.status).toBe(200);
        expect((await getExternalPlugin(sql, NAME))?.bundle).toBeNull();
    });

    it('upgrade-failure restore keeps the prior bundle row intact', async () => {
        const archive = buildTar([
            { name: 'index.js', content: TASK_BUNDLE_ENTRY(NAME) },
            { name: 'schema.js', content: TASK_BUNDLE_SIB },
        ]);
        serveBundle(archive, 'index.js', '1.0.0');
        expect(
            (
                await installExternalPlugin(
                    sql,
                    { manifestUrl: manifestUrl(), signature },
                    { username: 'denis' },
                )
            ).status,
        ).toBe(201);
        const before = await getExternalPlugin(sql, NAME);
        expect(before?.bundle).not.toBeNull();
        serveBundle(archive, 'index.js', '2.0.0');
        fsControl.renameCalls = 0;
        fsControl.failRenameOnCall = 2; // fail the swap mid-upgrade
        try {
            const r = await installExternalPlugin(
                sql,
                { manifestUrl: manifestUrl(), signature },
                { username: 'denis' },
            );
            expect(r.status).toBe(500);
        } finally {
            fsControl.failRenameOnCall = 0;
        }
        const after = await getExternalPlugin(sql, NAME);
        expect(after?.version).toBe('1.0.0');
        expect(after?.bundle).toEqual(before?.bundle); // NOT nulled
        // The restore must be VERBATIM. Asserting only version+bundle let a real
        // bug through: rowToUpsert omitted sdkAbi and manifestMetadata, and the
        // upsert writes `?? null` for absent fields — so a failed upgrade nulled
        // the ABI and destroyed the signed metadata of the plugin that was still
        // working. A null sdk_abi reads as ABI 1, which on any host past ABI 1
        // makes loadOneDir refuse the untouched 1.0.0 at the next restart.
        expect(after?.sdkAbi).toBe(before?.sdkAbi);
        expect(after?.manifestMetadata).toEqual(before?.manifestMetadata);
    });
});
