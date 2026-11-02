// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCanonicalTar, buildBundle, computeBundleTreeDigest } from './plugin-sign.mjs';
import {
    extractTarball,
    inflateIfGzip,
} from '../src/lib/server/plugins/external-install/archive.ts';

const BUNDLE_LIMITS = { maxTotalBytes: 1 << 20, maxEntries: 64, maxFileBytes: 1 << 19 };

describe('plugin-sign.mjs', () => {
    it('produces a manifest whose signature verifies against the derived public key', () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-'));
        const src = path.join(work, 'src');
        fs.mkdirSync(src);
        fs.writeFileSync(
            path.join(src, 'index.js'),
            `export default { id: 'sample-plugin', kind: 'task', inputSchema: { type: 'object' }, execute: async () => ({}) };`,
        );
        fs.writeFileSync(
            path.join(src, 'plugin.json'),
            JSON.stringify({ name: 'sample-plugin', kind: 'task' }),
        );
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const keyPath = path.join(work, 'priv.pem');
        fs.writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
        const out = path.join(work, 'dist');

        execFileSync(
            'node',
            [
                'scripts/plugin-sign.mjs',
                '--dir',
                src,
                '--key',
                keyPath,
                '--key-id',
                'test',
                '--version',
                '1.0.0',
                '--bundle-url',
                'https://cdn/x/1.0.0/index.js',
                '--manifest-url',
                'https://cdn/x/1.0.0/manifest.json',
                '--out',
                out,
            ],
            { stdio: 'pipe' },
        );

        const manifestBytes = fs.readFileSync(path.join(out, 'manifest.json'));
        const sig = Buffer.from(
            fs.readFileSync(path.join(out, 'manifest.json.sig'), 'utf8').trim(),
            'base64',
        );
        expect(crypto.verify(null, manifestBytes, publicKey, sig)).toBe(true);
        const manifest = JSON.parse(manifestBytes.toString('utf8'));
        const checksum = crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(out, 'index.js')))
            .digest('hex');
        expect(manifest.checksum).toBe(checksum);
        expect(manifest.name).toBe('sample-plugin');
        fs.rmSync(work, { recursive: true, force: true });
    });
});

describe('plugin-sign canonical tar (bundle mode)', () => {
    it('is byte-reproducible for the same input', () => {
        const files = [
            { path: 'index.js', data: Buffer.from('a') },
            { path: 'lib/x.js', data: Buffer.from('bb') },
        ];
        const t1 = buildCanonicalTar(files);
        const t2 = buildCanonicalTar([...files].reverse()); // signer sorts internally
        expect(t1.equals(t2)).toBe(true);
    });
    it('is accepted by the host extractor', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-tar-'));
        try {
            const tar = buildCanonicalTar([
                { path: 'index.js', data: Buffer.from('export default {};') },
                { path: 'lib/x.js', data: Buffer.from('x') },
            ]);
            const res = extractTarball(tar, dir, BUNDLE_LIMITS);
            expect(res.files.map((f) => f.path)).toEqual(['index.js', 'lib/x.js']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    it('errors on a name longer than 100 bytes', () => {
        expect(() =>
            buildCanonicalTar([{ path: 'a'.repeat(101), data: Buffer.from('x') }]),
        ).toThrow(/100/);
    });
});

describe('plugin-sign gzip determinism (canonical header)', () => {
    function writeSrc() {
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-gz-src-'));
        fs.writeFileSync(path.join(src, 'index.js'), 'export default {};');
        fs.mkdirSync(path.join(src, 'lib'));
        fs.writeFileSync(path.join(src, 'lib', 'x.js'), 'export const x = 1;');
        return src;
    }

    it('gzips reproducibly with a zeroed MTIME/XFL/OS header', () => {
        const src = writeSrc();
        try {
            const a = buildBundle(src, { gzip: true }).archive;
            const b = buildBundle(src, { gzip: true }).archive;
            // Byte-for-byte reproducible (same machine) …
            expect(a.equals(b)).toBe(true);
            // … and the two platform-varying header regions are zeroed: MTIME
            // (4–7), XFL (8), OS (9). A `fill(0,4,9)` off-by-one would leave byte
            // 9 = zlib.OS_CODE (0x03 unix / 0x0a win), so this catches the wrong
            // slice.
            expect(Array.from(a.subarray(4, 10))).toEqual([0, 0, 0, 0, 0, 0]);
        } finally {
            fs.rmSync(src, { recursive: true, force: true });
        }
    });

    it('locks the UNCOMPRESSED tar sha256, which is reproducible everywhere', () => {
        // This used to lock sha256 of the GZIPPED archive, and it could not hold.
        // gzip output depends on the zlib build: Node 26.7.0 (zlib 1.2.12) and
        // Node 22 produce different compressed bytes for identical input, so the
        // constant matched whichever machine last regenerated it and failed on
        // the other. It sat red in CI while passing locally.
        //
        // Re-locking it against CI's zlib would only invert the failure. The
        // compressed bytes are not a property worth pinning: they are transport
        // encoding. What must be stable is what the archive DECOMPRESSES to, and
        // buildCanonicalTar is deterministic by construction — sorted paths,
        // fixed mode/uid/gid, mtime 0, no platform-varying field anywhere.
        //
        // The gzip layer is still guarded, by the test above: same-machine
        // byte-for-byte reproducibility plus the zeroed MTIME/XFL/OS header
        // bytes. That is the part of gzip determinism that IS achievable.
        const src = writeSrc();
        try {
            const { files } = buildBundle(src, { gzip: false });
            const tar = buildCanonicalTar(files);
            const got = crypto.createHash('sha256').update(tar).digest('hex');
            // A mismatch means the canonical tar FORMAT changed (header layout,
            // sort order, padding) — which changes plugin identity for every
            // publisher. Regenerate only for an intentional format change, and
            // treat it as a breaking change to the bundle wire format.
            const EXPECTED_TAR_SHA256 =
                'a787080876af71e7b69795c2ad9e3b57214a2ce24659878ece7bce1a3eca209f';
            expect(got).toBe(EXPECTED_TAR_SHA256);
        } finally {
            fs.rmSync(src, { recursive: true, force: true });
        }
    });

    it('gzipping does not change the signed content identity', () => {
        // The point of moving identity off the compressed bytes: the same source
        // has one identity whether or not it ships gzipped, so a publisher
        // toggling --gzip does not mint a different plugin.
        const src = writeSrc();
        try {
            const plain = buildBundle(src, { gzip: false });
            const gzipped = buildBundle(src, { gzip: true });
            expect(computeBundleTreeDigest(gzipped.files)).toBe(
                computeBundleTreeDigest(plain.files),
            );
            // …while the transport checksums legitimately differ.
            const shaOf = (b) => crypto.createHash('sha256').update(b).digest('hex');
            expect(shaOf(gzipped.archive)).not.toBe(shaOf(plain.archive));
        } finally {
            fs.rmSync(src, { recursive: true, force: true });
        }
    });

    it('the gzipped bundle round-trips through inflateIfGzip + extractTarball', () => {
        const src = writeSrc();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-gz-out-'));
        try {
            const archive = buildBundle(src, { gzip: true }).archive;
            const raw = inflateIfGzip(archive, BUNDLE_LIMITS);
            const res = extractTarball(raw, dir, BUNDLE_LIMITS);
            expect(res.files.map((f) => f.path)).toEqual(['index.js', 'lib/x.js']);
        } finally {
            fs.rmSync(src, { recursive: true, force: true });
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('single-file and bundle manifests sign the SAME fields', () => {
    /** Sign `src` in the given format and return the parsed manifest. */
    function signAndRead(format, extraFiles = {}) {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
        const src = path.join(work, 'src');
        fs.mkdirSync(src);
        fs.writeFileSync(
            path.join(src, 'index.js'),
            'export default { id: "p", execute: async () => ({}) };',
        );
        fs.writeFileSync(
            path.join(src, 'plugin.json'),
            JSON.stringify({
                name: 'p',
                kind: 'task',
                publisher: 'Someone',
                description: 'Does a thing',
                license: 'AGPL-3.0-only',
                capabilities: { database: true },
                minAppVersion: '1.0.0',
            }),
        );
        for (const [n, c] of Object.entries(extraFiles)) fs.writeFileSync(path.join(src, n), c);
        const { privateKey } = crypto.generateKeyPairSync('ed25519');
        const keyPath = path.join(work, 'priv.pem');
        fs.writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
        const out = path.join(work, 'dist');
        const args = [
            'scripts/plugin-sign.mjs',
            '--dir',
            src,
            '--key',
            keyPath,
            '--key-id',
            'k',
            '--version',
            '1.0.0',
            '--manifest-url',
            'https://x/m.json',
            '--bundle-url',
            'https://x/b',
            '--out',
            out,
            '--format',
            format,
        ];
        if (format === 'bundle') args.push('--entry', 'index.js');
        execFileSync('node', args, { stdio: 'pipe' });
        return JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf-8'));
    }

    // The single-file path signed neither sdkAbi nor the catalog metadata while
    // the bundle path signed both. Consequences, both silent:
    //   - absent sdkAbi ⇒ 1, so every single-file plugin refuses to load on any
    //     host past ABI 1 — with no signal until that host ships;
    //   - absent `capabilities` ⇒ no upper bound for the host to enforce after
    //     load, which is the whole point of declaring them inside the signature.
    it.each(['single', 'bundle'])('%s carries sdkAbi and the signed metadata', (format) => {
        const m = signAndRead(format, format === 'bundle' ? { 'extra.js': '// asset' } : {});
        expect(m.sdkAbi).toBeGreaterThanOrEqual(1);
        expect(m.publisher).toBe('Someone');
        expect(m.description).toBe('Does a thing');
        expect(m.license).toBe('AGPL-3.0-only');
        expect(m.capabilities).toEqual({ database: true });
        expect(m.minAppVersion).toBe('1.0.0');
    });

    it('signs a TypeScript entry given a bare relative --dir', () => {
        // The bug was NOT the extension: esbuild resolves index.js -> index.ts by
        // TypeScript convention, so hardcoding index.js still found the file. The
        // bug was passing a BARE relative path — no './' and no '../' — which
        // esbuild reads as a PACKAGE specifier ("Could not resolve ..."). That is
        // how the repo build invokes it (`--dir examples/plugins/<name>`), and a
        // path built with path.relative() to a tmpdir gets a '../' prefix that
        // esbuild accepts, so it CANNOT reproduce this. The directory has to live
        // under the cwd.
        const rel = 'tmp-sign-parity-fixture';
        const abs = path.join(process.cwd(), rel);
        fs.rmSync(abs, { recursive: true, force: true });
        fs.mkdirSync(abs, { recursive: true });
        try {
            expect(rel.startsWith('.')).toBe(false);
            fs.writeFileSync(
                path.join(abs, 'index.ts'),
                'const d: { id: string } = { id: "p" };\nexport default d;',
            );
            fs.writeFileSync(
                path.join(abs, 'plugin.json'),
                JSON.stringify({ name: 'p', kind: 'task' }),
            );
            const { privateKey } = crypto.generateKeyPairSync('ed25519');
            const keyPath = path.join(abs, 'priv.pem');
            fs.writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
            const out = path.join(abs, 'dist');

            execFileSync(
                'node',
                [
                    'scripts/plugin-sign.mjs',
                    '--dir',
                    rel,
                    '--key',
                    keyPath,
                    '--key-id',
                    'k',
                    '--version',
                    '1.0.0',
                    '--manifest-url',
                    'https://x/m.json',
                    '--bundle-url',
                    'https://x/index.js',
                    '--out',
                    out,
                ],
                { stdio: 'pipe' },
            );

            expect(fs.existsSync(path.join(out, 'index.js'))).toBe(true);
            const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf-8'));
            const built = fs.readFileSync(path.join(out, 'index.js'));
            expect(crypto.createHash('sha256').update(built).digest('hex')).toBe(m.checksum);
        } finally {
            fs.rmSync(abs, { recursive: true, force: true });
        }
    });
});
