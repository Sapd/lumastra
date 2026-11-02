// installer.test.ts
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PLUGIN_SDK_ABI } from '@sapd/lumastra-plugin-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    classifyInstall,
    __test_stageFreshBundle,
    sdkAbiRejection,
    signingKeyContinuityRejection,
    installGateRejection,
    minAppVersionRejection,
} from './installer.js';

const BLOCK = 512;

/** Canonical ustar header for a regular file (mirrors archive.test.ts / the signer). */
function header(name: string, size: number, typeflag = '0'): Buffer {
    const b = Buffer.alloc(BLOCK);
    b.write(name, 0, 'utf8');
    b.write('0000644', 100, 'ascii');
    b.write('0000000', 108, 'ascii');
    b.write('0000000', 116, 'ascii');
    b.write(size.toString(8).padStart(11, '0'), 124, 'ascii');
    b.write('00000000000', 136, 'ascii');
    b.write(typeflag, 156, 'ascii');
    b.write('ustar\0', 257, 'binary');
    b.write('00', 263, 'ascii');
    b.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += b[i];
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return b;
}

function buildTar(entries: Array<{ name: string; content: string; typeflag?: string }>): Buffer {
    const parts: Buffer[] = [];
    for (const e of entries) {
        const data = Buffer.from(e.content, 'utf8');
        parts.push(header(e.name, data.length, e.typeflag ?? '0'));
        const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK);
        data.copy(padded);
        parts.push(padded);
    }
    parts.push(Buffer.alloc(1024));
    return Buffer.concat(parts);
}

describe('classifyInstall', () => {
    it('fresh when no prior row and not loaded', () => {
        expect(classifyInstall(null, false)).toBe('fresh');
    });
    it('fresh when prior is uninstalled and not loaded', () => {
        expect(classifyInstall({ status: 'uninstalled' }, false)).toBe('fresh');
    });
    it('upgrade when prior is installed', () => {
        expect(classifyInstall({ status: 'installed' }, false)).toBe('upgrade');
    });
    it('upgrade when the id is currently loaded even if prior missing', () => {
        expect(classifyInstall(null, true)).toBe('upgrade');
    });
    it('upgrade when uninstalled row but still loaded in-process', () => {
        expect(classifyInstall({ status: 'uninstalled' }, true)).toBe('upgrade');
    });
});

describe('sdkAbiRejection', () => {
    it('accepts a manifest declaring the host ABI', () => {
        expect(sdkAbiRejection(PLUGIN_SDK_ABI, PLUGIN_SDK_ABI)).toBeNull();
    });

    it('accepts an ABI-less manifest on an ABI-1 host', () => {
        // Manifests signed before the field existed report 1 via manifestSdkAbi.
        expect(sdkAbiRejection(1, 1)).toBeNull();
    });

    it('rejects a plugin built for an older ABI', () => {
        const msg = sdkAbiRejection(1, 2);
        expect(msg).not.toBeNull();
        // The operator has to know which side is stale, and the message is the
        // only place they will see it — this is the error a plugin that dies at
        // first call would otherwise never produce.
        expect(msg).toContain('1');
        expect(msg).toContain('2');
    });

    it('rejects a plugin built for a newer ABI', () => {
        expect(sdkAbiRejection(3, 2)).not.toBeNull();
    });
});

describe('signingKeyContinuityRejection', () => {
    it('accepts an upgrade signed by the same key that installed it', () => {
        expect(signingKeyContinuityRejection('alice-2026', 'alice-2026', false)).toBeNull();
    });

    it('REFUSES an upgrade signed by a different trusted key', () => {
        // The takeover this closes: an operator who trusts two community keys
        // has nothing stopping the second key's owner from publishing a plugin
        // named `trakt` at version 99.0.0 and replacing the first one's. Both
        // signatures verify — the whole effective key set is tried — so
        // without this check the swap is silent.
        const msg = signingKeyContinuityRejection('alice-2026', 'mallory-2026', false);
        expect(msg).not.toBeNull();
        expect(msg).toContain('alice-2026');
        expect(msg).toContain('mallory-2026');
    });

    it('allows a deliberate key rotation via force', () => {
        // Publishers do rotate keys. The operator confirms it explicitly and
        // the audit log records both ids, rather than the host guessing.
        expect(signingKeyContinuityRejection('alice-2026', 'alice-2027', true)).toBeNull();
    });

    it('does not block a row installed before key ids were recorded', () => {
        // NULL means legacy/pre-migration or a registry-less drop-in. There is
        // no pinned key to compare against, so there is nothing to enforce —
        // refusing here would strand plugins on an unfixable error.
        expect(signingKeyContinuityRejection(null, 'anyone', false)).toBeNull();
    });
});

describe('stageFreshBundle', () => {
    let base: string;
    beforeEach(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-bundle-'));
        process.env.PLUGINS_EXTERNAL_DIR = base;
    });
    afterEach(() => {
        fs.rmSync(base, { recursive: true, force: true });
        delete process.env.PLUGINS_EXTERNAL_DIR;
    });

    it('extracts into a .tmp dir and returns a matching artifact', () => {
        const tar = buildTar([
            { name: 'index.js', content: 'export default {};' },
            { name: 'lib/a.js', content: 'x' },
        ]);
        const { tmpDir, artifact } = __test_stageFreshBundle(tar, 'p', 'index.js');
        expect(path.basename(tmpDir).startsWith('.tmp-p-')).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'index.js'))).toBe(true);
        expect(artifact.entry).toBe('index.js');
        expect(artifact.files.map((f) => f.path)).toEqual(['index.js', 'lib/a.js']);
        expect(artifact.treeDigest).toMatch(/^[a-f0-9]{64}$/);
    });

    // ── signed content identity ───────────────────────────────────────────
    //
    // `checksum` pins the SHIPPED BYTES; `treeDigest` pins what those bytes
    // decompress to. Only the second is reproducible from source (gzip output
    // moves between zlib versions), so it is the one a third party can use to
    // confirm a published bundle matches the code it claims to be.

    it('accepts a bundle whose tree matches the signed treeDigest', () => {
        const tar = buildTar([
            { name: 'index.js', content: 'export default {};' },
            { name: 'lib/a.js', content: 'x' },
        ]);
        // Derive the expected value the way the installer does, then hand it
        // back in as if it had come off a signed manifest.
        const { artifact: probe } = __test_stageFreshBundle(tar, 'p', 'index.js');
        const { artifact } = __test_stageFreshBundle(tar, 'p', 'index.js', probe.treeDigest);
        expect(artifact.treeDigest).toBe(probe.treeDigest);
    });

    it('REJECTS a bundle whose tree does not match the signed treeDigest', () => {
        const tar = buildTar([{ name: 'index.js', content: 'export default {};' }]);
        expect(() => __test_stageFreshBundle(tar, 'p', 'index.js', 'b'.repeat(64))).toThrow(
            /tree digest mismatch/,
        );
    });

    it('rejects content tampering that keeps the same file names', () => {
        // The case the digest exists for: an attacker who can swap bundle bytes
        // but must keep the manifest signature intact.
        const honest = buildTar([{ name: 'index.js', content: 'export default {};' }]);
        const tampered = buildTar([{ name: 'index.js', content: 'evil();' }]);
        const { artifact } = __test_stageFreshBundle(honest, 'p', 'index.js');
        expect(() =>
            __test_stageFreshBundle(tampered, 'p', 'index.js', artifact.treeDigest),
        ).toThrow(/tree digest mismatch/);
    });

    it('still installs a manifest that carries no treeDigest (back-compat)', () => {
        // Manifests signed before the field existed must keep working — they are
        // covered by `checksum` alone, exactly as before.
        const tar = buildTar([{ name: 'index.js', content: 'export default {};' }]);
        const { artifact } = __test_stageFreshBundle(tar, 'p', 'index.js', undefined);
        expect(artifact.entry).toBe('index.js');
    });

    it('throws when the declared entry is absent from the archive', () => {
        const tar = buildTar([{ name: 'index.js', content: 'x' }]);
        expect(() => __test_stageFreshBundle(tar, 'p', 'missing.js')).toThrow(/entry not found/);
    });

    it('throws when the entry names a directory (not a regular file)', () => {
        const tar = buildTar([{ name: 'a/b.js', content: 'x' }]);
        expect(() => __test_stageFreshBundle(tar, 'p', 'a')).toThrow(
            /entry not a regular file|entry not found/,
        );
    });

    it('cleans up its .tmp dir on a malicious archive', () => {
        const tar = buildTar([{ name: '../evil', content: 'x' }]);
        expect(() => __test_stageFreshBundle(tar, 'p', 'index.js')).toThrow();
        expect(fs.readdirSync(base)).toEqual([]);
    });

    it('leaves no partial tree when the archive is truncated (missing end blocks)', () => {
        const full = buildTar([{ name: 'index.js', content: 'export default {};' }]);
        const truncated = full.subarray(0, full.length - 1024);
        expect(() => __test_stageFreshBundle(truncated, 'p', 'index.js')).toThrow(
            /missing end-of-archive blocks/,
        );
        expect(fs.readdirSync(base)).toEqual([]);
    });
});

describe('installGateRejection — one ordering, shared by install and preview', () => {
    const abi = PLUGIN_SDK_ABI;
    const fresh = {
        prior: null,
        version: '1.0.0',
        keyId: 'alice',
        abi,
        hostAbi: abi,
        appVersion: '1.0.0',
        force: false,
    };

    it('accepts a genuinely fresh install — nothing is pinned yet', () => {
        expect(installGateRejection(fresh)).toBeNull();
    });

    // Recovery from the missing-files state. PLUGINS_EXTERNAL_DIR defaults into
    // the container image layer, so an image update deletes an installed
    // plugin's directory while its registry row survives. Re-installing the SAME
    // version is then the only sensible repair — and anti-rollback refused it,
    // stranding the operator with a row claiming "installed" and no way back
    // that does not involve `force` (documented for rollbacks) or an uninstall.
    //
    // A same-version install is only a "rollback" if something is actually
    // installed. When the payload is gone there is nothing to roll back FROM.
    it('allows a same-version REPAIR when the prior install is no longer on disk', () => {
        expect(
            installGateRejection({
                ...fresh,
                prior: { version: '1.0.0', signingKeyId: 'alice' },
                priorOnDisk: false,
                version: '1.0.0',
            }),
        ).toBeNull();
    });

    it('still blocks a genuine DOWNGRADE even when the files are gone', () => {
        // Repair means restoring what the row claims, not smuggling an older
        // build past anti-rollback by deleting a directory first.
        expect(
            installGateRejection({
                ...fresh,
                prior: { version: '2.0.0', signingKeyId: 'alice' },
                priorOnDisk: false,
                version: '1.0.0',
            }),
        ).toBe('version not newer than installed');
    });

    it('still blocks a same-version re-install when the files ARE present', () => {
        expect(
            installGateRejection({
                ...fresh,
                prior: { version: '1.0.0', signingKeyId: 'alice' },
                priorOnDisk: true,
                version: '1.0.0',
            }),
        ).toBe('version not newer than installed');
    });

    it('blocks a downgrade against a retained uninstalled row', () => {
        expect(
            installGateRejection({
                ...fresh,
                prior: { version: '2.0.0', signingKeyId: 'alice' },
                version: '1.0.0',
            }),
        ).toMatch(/not newer/);
    });

    it('blocks a DIFFERENT publisher reinstalling over an UNINSTALLED plugin', () => {
        // The retained row is already trusted for anti-rollback, so trusting it
        // for the key too is the consistent reading. Without this, uninstall +
        // restart is a door around name-to-key pinning: the attacker publishes
        // a HIGHER version under someone else's name, both signatures verify
        // because verification only asks "signed by someone I trust", and the
        // swap is silent.
        expect(
            installGateRejection({
                ...fresh,
                prior: { version: '1.0.0', signingKeyId: 'alice' },
                version: '2.0.0',
                keyId: 'mallory',
            }),
        ).toMatch(/different publisher claiming the name/);
    });

    it('still blocks the same swap on a live upgrade', () => {
        expect(
            installGateRejection({
                ...fresh,
                prior: { version: '1.0.0', signingKeyId: 'alice' },
                version: '2.0.0',
                keyId: 'mallory',
            }),
        ).not.toBeNull();
    });

    it('lets force through a key rotation, as an explicit operator decision', () => {
        expect(
            installGateRejection({
                ...fresh,
                prior: { version: '1.0.0', signingKeyId: 'alice' },
                version: '2.0.0',
                keyId: 'alice-2027',
                force: true,
            }),
        ).toBeNull();
    });

    it('reports the ROLLBACK first when a downgrade and a key change coincide', () => {
        // The more specific error is the more useful one, and the ordering is
        // what preview has to reproduce exactly.
        expect(
            installGateRejection({
                ...fresh,
                prior: { version: '2.0.0', signingKeyId: 'alice' },
                version: '1.0.0',
                keyId: 'mallory',
            }),
        ).toMatch(/not newer/);
    });

    it('reports the key swap before an ABI complaint', () => {
        expect(
            installGateRejection({
                ...fresh,
                prior: { version: '1.0.0', signingKeyId: 'alice' },
                version: '2.0.0',
                keyId: 'mallory',
                abi: abi + 1,
            }),
        ).toMatch(/different publisher/);
    });

    it('blocks an ABI mismatch that force cannot override', () => {
        expect(installGateRejection({ ...fresh, abi: abi + 1, force: true })).toMatch(
            /abi|contract/i,
        );
    });

    it('does not enforce continuity when nothing was pinned (legacy drop-in)', () => {
        expect(
            installGateRejection({
                ...fresh,
                prior: { version: '1.0.0', signingKeyId: null },
                version: '2.0.0',
                keyId: 'anyone',
            }),
        ).toBeNull();
    });
});

describe('minAppVersionRejection — a required field that gated nothing', () => {
    it('accepts when the host is newer than required', () => {
        expect(minAppVersionRejection('1.2.0', '1.5.0')).toBeNull();
    });

    it('accepts when the host matches exactly', () => {
        expect(minAppVersionRejection('1.2.0', '1.2.0')).toBeNull();
    });

    it('REJECTS when the host is older, naming both versions', () => {
        const msg = minAppVersionRejection('2.0.0', '1.5.0');
        expect(msg).toMatch(/2\.0\.0/);
        expect(msg).toMatch(/1\.5\.0/);
    });

    it('compares numerically, not lexically', () => {
        // '1.10.0' > '1.9.0' numerically; the string compare says otherwise and
        // would admit a plugin the host cannot actually run.
        expect(minAppVersionRejection('1.10.0', '1.9.0')).not.toBeNull();
        expect(minAppVersionRejection('1.9.0', '1.10.0')).toBeNull();
    });

    it('accepts when the plugin declares nothing', () => {
        expect(minAppVersionRejection(undefined, '1.5.0')).toBeNull();
        expect(minAppVersionRejection('', '1.5.0')).toBeNull();
    });

    it('accepts when the HOST version is unknown — never block on an unanswerable question', () => {
        // config.APP_VERSION falls back to 'unknown' when the build did not
        // stamp one. Refusing every plugin because the host cannot say what it
        // is would be far worse than admitting one that might be too new.
        expect(minAppVersionRejection('9.9.9', 'unknown')).toBeNull();
        expect(minAppVersionRejection('9.9.9', '')).toBeNull();
    });

    it('accepts an unparseable requirement rather than guessing at it', () => {
        expect(minAppVersionRejection('next', '1.5.0')).toBeNull();
    });
});

describe('installGateRejection — version gate ordering', () => {
    const abi = PLUGIN_SDK_ABI;
    const base = {
        prior: null,
        version: '1.0.0',
        keyId: 'alice',
        abi,
        hostAbi: abi,
        appVersion: '1.5.0',
        force: false,
    };

    it('refuses a plugin that needs a newer server', () => {
        expect(installGateRejection({ ...base, minAppVersion: '2.0.0' })).toMatch(/2\.0\.0/);
    });

    it('says "server too old" BEFORE complaining about the ABI', () => {
        // Same underlying situation, but one sentence tells the operator what
        // to do and the other does not.
        const msg = installGateRejection({
            ...base,
            minAppVersion: '2.0.0',
            abi: abi + 1,
        });
        expect(msg).toMatch(/needs Lumastra/);
    });

    it('force does NOT override it — the code genuinely will not run', () => {
        expect(
            installGateRejection({ ...base, minAppVersion: '2.0.0', force: true }),
        ).not.toBeNull();
    });
});

describe('minAppVersionRejection — real-world APP_VERSION shapes', () => {
    it('accepts a git-describe version, which is what CI stamps', () => {
        // docker-publish.yml stamps `git describe --tags --match 'v*'`, e.g.
        // `v0.1.0-2609-gabc1234`. A leading `v` and a suffix must not make the
        // gate throw or misread the version.
        expect(minAppVersionRejection('0.1.0', 'v0.1.0-2609-gabc1234')).toBeNull();
        expect(minAppVersionRejection('9.9.9', 'v0.1.0-2609-gabc1234')).toMatch(/9\.9\.9/);
    });

    it('accepts a channel name like the running prod container reports', () => {
        // APP_VERSION=stable on prod. Not comparable, so the gate must no-op.
        expect(minAppVersionRejection('9.9.9', 'stable')).toBeNull();
    });

    it('does NOT throw on a prerelease host version', () => {
        // The prefix regex admits `1.2.3-rc1`, and compareSemver is STRICT and
        // THROWS on it. Unhandled, that is a 500 on install AND preview for
        // every manifest carrying minAppVersion — the total plugin-system
        // outage the fail-open rule exists to prevent.
        expect(() => minAppVersionRejection('1.0.0', '1.2.3-rc1')).not.toThrow();
        expect(minAppVersionRejection('1.0.0', '1.2.3-rc1')).toBeNull();
        expect(() => minAppVersionRejection('9.9.9', '1.2.3-rc1')).not.toThrow();
    });

    it('does not throw on a prerelease REQUIREMENT either', () => {
        expect(() => minAppVersionRejection('2.0.0-beta', '1.0.0')).not.toThrow();
    });
});

describe('readLoadedCapabilities covers every contract kind', () => {
    // Not a style check. `readLoadedCapabilities` maps a manifest kind to the
    // registry getter that can report what a plugin ACTUALLY registered, and
    // `capabilitySubsetViolation` opens with `if (!declared || !loaded) return
    // null`. So a kind missing from that switch does not fail loudly — it
    // silently disables the signed capability bound for that entire contract
    // family. subtitle-provider, lyrics-provider and auth-provider were absent
    // from the day they shipped, and a lyrics provider declaring nothing while
    // registering `database: true` installed clean.
    //
    // The function is module-private and needs a live registry, so this reads
    // the source: the cheapest thing that actually fails when the two lists
    // drift, which is the failure mode that bit us.
    const src = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'loaded-capabilities.ts'),
        'utf-8',
    );
    const manifestSrc = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'manifest.ts'),
        'utf-8',
    );

    it('has a case for every kind PLUGIN_KIND accepts', () => {
        const kinds = [
            ...manifestSrc
                .slice(manifestSrc.indexOf('const PLUGIN_KIND = z.enum(['))
                .slice(
                    0,
                    manifestSrc
                        .slice(manifestSrc.indexOf('const PLUGIN_KIND = z.enum(['))
                        .indexOf(']'),
                )
                .matchAll(/'([a-z-]+)'/g),
        ].map((m) => m[1]);
        expect(kinds.length).toBeGreaterThanOrEqual(11);

        const body = src.slice(src.indexOf('export function readLoadedCapabilities'), src.length);
        const missing = kinds.filter((k) => !body.includes(`case '${k}':`));
        expect(
            missing,
            `kinds with no case in readLoadedCapabilities: ${missing.join(', ')}`,
        ).toEqual([]);
    });
});
