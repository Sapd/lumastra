#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const BLOCK = 512;

/**
 * The contract ABI this checkout's SDK declares, parsed out of its source
 * rather than imported — the SDK ships as TypeScript and this signer is a plain
 * .mjs with no build step in front of it.
 */
const HOST_SDK_ABI = (() => {
    const sdkTypes = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'packages/@sapd/lumastra-plugin-sdk/src/types.ts',
    );
    const m = /export const PLUGIN_SDK_ABI = (\d+)/.exec(fs.readFileSync(sdkTypes, 'utf8'));
    if (!m) {
        console.error('could not read PLUGIN_SDK_ABI from the SDK sources');
        process.exit(2);
    }
    return Number(m[1]);
})();

/** One canonical ustar header (file entries only, typeflag '0', mtime/uid/gid 0). */
function ustarHeader(name, size) {
    // ASCII path assumption (Buffer.byteLength) — enforce the 100/155 limits.
    const nameBytes = Buffer.byteLength(name, 'utf8');
    if (nameBytes > 100) throw new Error(`path exceeds 100 bytes (shorten): ${name}`);
    const b = Buffer.alloc(BLOCK);
    b.write(name, 0, 'utf8');
    b.write('0000644', 100, 'ascii'); // mode
    b.write('0000000', 108, 'ascii'); // uid
    b.write('0000000', 116, 'ascii'); // gid
    b.write(size.toString(8).padStart(11, '0'), 124, 'ascii');
    b.write('00000000000', 136, 'ascii'); // mtime = 0
    b.write('0', 156, 'ascii'); // typeflag: regular file
    b.write('ustar\0', 257, 'binary');
    b.write('00', 263, 'ascii');
    b.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += b[i];
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return b;
}

/** Deterministic ustar over regular files (sorted by POSIX path). */
export function buildCanonicalTar(files) {
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const parts = [];
    for (const f of sorted) {
        parts.push(ustarHeader(f.path, f.data.length));
        const padded = Buffer.alloc(Math.ceil(f.data.length / BLOCK) * BLOCK);
        f.data.copy(padded);
        parts.push(padded);
    }
    parts.push(Buffer.alloc(BLOCK * 2)); // two zero blocks
    return Buffer.concat(parts);
}

/**
 * Content identity of a bundle: sha256 over a canonical listing of its files.
 *
 * MUST stay byte-identical to `computeTreeDigestFromFiles` in
 * src/lib/server/plugins/external-install/archive.ts — same sort, same
 * `${sha256}  ${size}  ${path}\n` line (TWO spaces), same utf8 join. The
 * signer is a standalone .mjs and the runtime is TS behind $lib aliases, so the
 * formula is duplicated on purpose; plugin-tree-digest-parity.test.ts is the
 * seam that keeps the two honest.
 *
 * WHY THIS AND NOT THE ARCHIVE HASH. `checksum` is sha256 of the SHIPPED BYTES,
 * which is the right transport-integrity check but is NOT reproducible: with
 * --gzip those bytes come out of zlib, and zlib's output moves between versions
 * (Node 22 and Node 26 disagree today). So the same source rebuilt elsewhere
 * produces a different `checksum`, and nobody can independently verify that a
 * published bundle matches its source.
 *
 * The tree digest has no such problem — it is computed over file CONTENT, so it
 * is identical on every machine, at every compression level, and survives a
 * proxy or CDN re-compressing the archive in transit.
 */
export function computeBundleTreeDigest(files) {
    const listing = [...files]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map(
            (f) =>
                `${crypto.createHash('sha256').update(f.data).digest('hex')}  ${f.data.length}  ${f.path}\n`,
        )
        .join('');
    return crypto.createHash('sha256').update(Buffer.from(listing, 'utf8')).digest('hex');
}

/** Enumerate <src> recursively (regular files only), returning {path,data}[]. */
function enumerateFiles(src) {
    const out = [];
    const walk = (abs, rel) => {
        for (const nm of fs.readdirSync(abs)) {
            if (nm === '.git' || nm === 'node_modules') continue;
            const a = path.join(abs, nm);
            const st = fs.lstatSync(a);
            if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
                throw new Error(`refusing non-regular entry: ${path.join(rel, nm)}`);
            }
            if (st.isDirectory()) walk(a, path.join(rel, nm));
            else out.push({ path: rel ? `${rel}/${nm}` : nm, data: fs.readFileSync(a) });
        }
    };
    walk(src, '');
    return out;
}

/** Build a (optionally gzipped) reproducible bundle archive from <src>. */
export function buildBundle(src, { gzip }) {
    const files = enumerateFiles(src);
    if (files.length === 0) throw new Error('no files to bundle');
    // Warn on a bundled package.json that would flip ESM/CJS semantics.
    const pkg = files.find((f) => f.path === 'package.json');
    if (pkg) {
        try {
            const parsed = JSON.parse(pkg.data.toString('utf8'));
            if (parsed.type === 'commonjs' || parsed.type === undefined) {
                console.warn(
                    'WARNING: bundled package.json declares/omits "type"; plugins must ship ESM ("type":"module" or .mjs entry).',
                );
            }
        } catch {
            /* ignore */
        }
    }
    let archive = buildCanonicalTar(files);
    if (gzip) {
        archive = zlib.gzipSync(archive, { level: 9 });
        // Zero the two platform-varying gzip header bytes so the archive checksum
        // is reproducible across machines (§3.10 step 3 / §8.7):
        //   MTIME  = bytes 4–7 (zlib stamps current time)
        //   OS byte = byte 9 (zlib.OS_CODE: 0x03 unix vs 0x0a/0x0b windows)
        // XFL (byte 8) is deterministic for a fixed level; zero it explicitly too
        // rather than by accident. Note fill's end is EXCLUSIVE — fill(0,4,9) would
        // stop at byte 8 and leave the OS byte (9) untouched, so set it separately.
        // Byte 3 is FLG. Everything below indexes fixed offsets that are only
        // MTIME/XFL/OS when no optional gzip fields are present; if any zlib
        // ever sets FNAME/FCOMMENT/FEXTRA those offsets shift and this would
        // silently mangle the archive while the checksum still "matched" the
        // mangled bytes. Assert rather than assume — this is the one place that
        // has to be reproducible, and "zlib output moves between versions" is
        // exactly the hazard the treeDigest/checksum split exists to escape.
        if (archive[3] !== 0) {
            console.error(
                `refusing: gzip FLG byte is 0x${archive[3].toString(16)}, not 0. ` +
                    'Optional header fields shift the MTIME/XFL/OS offsets this ' +
                    'code zeroes, so the archive would be corrupted silently.',
            );
            process.exit(2);
        }
        archive.fill(0, 4, 8); // MTIME (4–7)
        archive[8] = 0; // XFL
        archive[9] = 0; // OS
    }
    return { archive, files };
}

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * The contract-kind field to sign, read from the plugin's own `plugin.json`.
 *
 * A single-contract plugin declares `kind: 'task'`; a multi-contract one
 * declares `kinds: ['watch-sync', 'task']` — every contract its default export
 * registers. Exactly one of the two, matching ExternalPluginManifestSchema, so
 * a manifest this script emits can never be rejected at install for a shape
 * mistake the author could have been told about here.
 */
/**
 * The contract ABI to sign into the manifest.
 *
 * Read from the plugin's `plugin.json` when it names one, otherwise the ABI
 * this checkout's SDK declares — the signer lives in the same repo as the SDK,
 * so its own version IS the right default and an author never has to keep a
 * number in sync by hand.
 */
function sdkAbiField(meta) {
    if (meta.sdkAbi === undefined) return { sdkAbi: HOST_SDK_ABI };
    if (!Number.isInteger(meta.sdkAbi) || meta.sdkAbi < 1) {
        console.error("plugin.json 'sdkAbi' must be a positive integer");
        process.exit(2);
    }
    return { sdkAbi: meta.sdkAbi };
}

/**
 * Signed catalog metadata, read from the plugin's own `plugin.json`.
 *
 * These live inside the signature because an operator's install decision reads
 * them: a catalog that could substitute `description` or `capabilities` could
 * describe a watch-sync-with-database bundle as a harmless theme.
 */
function metadataFields(meta) {
    const out = {};
    for (const key of [
        'publisher',
        'description',
        'license',
        'sourceUrl',
        'capabilities',
        'minAppVersion',
    ]) {
        if (meta[key] !== undefined) out[key] = meta[key];
    }
    if (!out.publisher || !out.description) {
        console.warn(
            'WARNING: plugin.json declares no publisher/description. Operators see these ' +
                'in the install confirmation — without them the plugin is an anonymous blob.',
        );
    }
    return out;
}

function kindField(meta) {
    const hasKind = meta.kind !== undefined;
    const hasKinds = meta.kinds !== undefined;
    if (hasKind === hasKinds) {
        console.error(
            "plugin.json must declare exactly one of 'kind' (single contract) or " +
                "'kinds' (array, multi-contract)",
        );
        process.exit(2);
    }
    if (hasKinds) {
        if (!Array.isArray(meta.kinds) || meta.kinds.length === 0) {
            console.error("plugin.json 'kinds' must be a non-empty array");
            process.exit(2);
        }
        if (new Set(meta.kinds).size !== meta.kinds.length) {
            console.error("plugin.json 'kinds' must not repeat a contract kind");
            process.exit(2);
        }
        return { kinds: meta.kinds };
    }
    return { kind: meta.kind };
}

async function main() {
    const dir = arg('dir'),
        keyPath = arg('key'),
        keyId = arg('key-id'),
        version = arg('version'),
        bundleUrl = arg('bundle-url'),
        manifestUrl = arg('manifest-url'),
        out = arg('out');
    if (!dir || !keyPath || !version || !bundleUrl || !manifestUrl || !out) {
        console.error(
            'usage: plugin-sign --dir --key --key-id --version --bundle-url --manifest-url --out [--format single|bundle] [--entry index.js] [--gzip]',
        );
        process.exit(2);
    }
    fs.mkdirSync(out, { recursive: true });

    const format = arg('format') || 'single';
    const entry = arg('entry') || 'index.js';
    const gzip = process.argv.includes('--gzip');

    if (format === 'bundle') {
        const { archive, files } = buildBundle(dir, { gzip });
        const archiveName = gzip ? 'bundle.tar.gz' : 'bundle.tar';
        fs.writeFileSync(path.join(out, archiveName), archive);
        const checksum = crypto.createHash('sha256').update(archive).digest('hex');
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
        const manifest = {
            name: meta.name,
            version,
            ...kindField(meta),
            ...sdkAbiField(meta),
            ...metadataFields(meta),
            bundleUrl,
            checksum,
            // Reproducible content identity, signed alongside the transport
            // checksum. See computeBundleTreeDigest for why both exist.
            treeDigest: computeBundleTreeDigest(files),
            format: 'bundle',
            entry,
            ...(keyId ? { keyId } : {}),
        };
        const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
        fs.writeFileSync(path.join(out, 'manifest.json'), manifestBytes);
        const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
        const sig = crypto.sign(null, manifestBytes, privateKey).toString('base64');
        fs.writeFileSync(path.join(out, 'manifest.json.sig'), sig);
        console.log(
            `Signed BUNDLE ${manifest.name}@${version}\n  archive: ${path.join(out, archiveName)}\n  entry: ${entry}\n  checksum: ${checksum}\n  treeDigest: ${manifest.treeDigest}`,
        );
        console.log('IMPORTANT: serve manifest.json AND the archive BYTE-FOR-BYTE as written.');
        process.exit(0);
    }

    // --- single-file mode (default): esbuild a self-contained ESM index.js ---
    // 1. Bundle to a single self-contained ESM index.js (SDK is types-only → external).
    //
    // Resolve the SOURCE entry rather than assuming index.js: a plugin may ship
    // index.ts (esbuild compiles it) or index.mjs. Absolute, because esbuild
    // reads a bare relative path as a PACKAGE specifier and fails to resolve it.
    // The OUTPUT is always index.js — the built artefact's name is the host's
    // convention, independent of what the author wrote it in.
    const sourceEntry = [arg('entry'), 'index.js', 'index.mjs', 'index.ts']
        .filter(Boolean)
        .map((f) => path.resolve(dir, f))
        .find((f) => fs.existsSync(f));
    if (!sourceEntry) {
        console.error(`no entry found in ${dir} (looked for index.js, index.mjs, index.ts)`);
        process.exit(2);
    }
    await build({
        entryPoints: [sourceEntry],
        bundle: true,
        platform: 'node',
        format: 'esm',
        external: ['@sapd/lumastra-plugin-sdk'],
        outfile: path.join(out, 'index.js'),
    });

    // 2. checksum
    const checksum = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(out, 'index.js')))
        .digest('hex');

    // 3. read name/kind from the plugin's own metadata
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    const manifest = {
        name: meta.name,
        version,
        ...kindField(meta),
        // Single-file manifests carry the SAME signed fields as bundle ones.
        // Omitting sdkAbi here made every single-file plugin read as ABI 1
        // forever (absent ⇒ 1), so each would refuse to load on any host past
        // ABI 1; omitting the metadata left the operator's install
        // confirmation with nothing verified to show, and left `capabilities`
        // undeclared — which is the upper bound the host enforces after load.
        ...sdkAbiField(meta),
        ...metadataFields(meta),
        bundleUrl,
        checksum,
        ...(keyId ? { keyId } : {}),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8'); // exact bytes we sign AND serve
    fs.writeFileSync(path.join(out, 'manifest.json'), manifestBytes);

    // 4. sign the exact manifest bytes
    const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
    const sig = crypto.sign(null, manifestBytes, privateKey).toString('base64');
    fs.writeFileSync(path.join(out, 'manifest.json.sig'), sig);

    console.log(
        `Signed ${manifest.name}@${version}\n  manifest: ${path.join(out, 'manifest.json')}\n  sig: ${path.join(out, 'manifest.json.sig')}\n  checksum: ${checksum}`,
    );
    console.log(
        'IMPORTANT: serve manifest.json BYTE-FOR-BYTE as written — any re-minification breaks the signature.',
    );
}

// Only run the CLI when executed directly (not when imported by tests).
const invokedDirectly =
    process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    await main();
}
