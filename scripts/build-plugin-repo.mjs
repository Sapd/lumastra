#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Build a plugin REPOSITORY from a directory of plugins.
 *
 * A repository is one JSON index plus the signed manifests and bundles it
 * points at — nothing more. This script signs each plugin with `plugin-sign`
 * and lays the results out as static files, so the output can be served by any
 * web server (or a CDN, or an object store) with no application behind it.
 *
 *   node scripts/build-plugin-repo.mjs \
 *       --src examples/plugins --out /tmp/repo \
 *       --base-url https://plugins.example.com \
 *       --key ~/.secrets/lumastra-official-2026.pem \
 *       --key-id lumastra-official-2026
 *
 * Layout (manifestUrl is immutable per version, by convention and by design —
 * the index is the mutable pointer, manifests are the immutable signed leaves):
 *
 *   index.json
 *   <name>/<version>/manifest.json
 *   <name>/<version>/manifest.json.sig
 *   <name>/<version>/<entry or archive>
 *
 * BASE URL IS SIGNED. `bundleUrl` lives inside the manifest bytes, so moving a
 * repository to a different origin means RE-SIGNING every manifest. Choose the
 * final hostname before publishing, or accept the re-sign.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : d;
};

const src = arg('src');
const out = arg('out');
const baseUrl = (arg('base-url') ?? '').replace(/\/+$/, '');
const key = arg('key');
const keyId = arg('key-id');
const repoName = arg('name', 'Lumastra example repository');
const repoDesc = arg('description', 'Sample plugins, signed with the official key.');

if (!src || !out || !baseUrl || !key || !keyId) {
    console.error(
        'usage: build-plugin-repo --src <dir> --out <dir> --base-url <url> --key <pem> --key-id <id>\n' +
            '                        [--name <repo name>] [--description <text>]',
    );
    process.exit(2);
}

/** A plugin ships as a bundle when it is more than a lone entry file. */
function chooseFormat(dir) {
    const files = fs.readdirSync(dir).filter((f) => f !== 'plugin.json');
    const entries = files.filter((f) => /^index\.(js|mjs|ts)$/.test(f));
    if (entries.length === 0) throw new Error(`${dir}: no index.{js,mjs,ts} entry`);
    // More than the entry alone (assets, extra modules) ⇒ must ship as a tar.
    return { format: files.length > 1 ? 'bundle' : 'single', entry: entries[0] };
}

fs.mkdirSync(out, { recursive: true });
const plugins = [];
let failed = 0;

for (const name of fs.readdirSync(src).sort()) {
    const dir = path.join(src, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const metaPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(metaPath)) {
        console.error(`SKIP ${name}: no plugin.json (unsignable)`);
        failed++;
        continue;
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const version = meta.version ?? '1.0.0';
    const { format, entry } = chooseFormat(dir);
    const rel = `${name}/${version}`;
    const destDir = path.join(out, rel);
    fs.mkdirSync(destDir, { recursive: true });

    // In single mode the served payload is the esbuild OUTPUT, always named
    // index.js — never the source entry, which may be index.ts and is not what
    // the manifest checksum covers.
    // Names must match what plugin-sign actually writes, or bundleUrl points
    // at a file that does not exist and install 404s after a valid verify.
    const bundleFile = format === 'bundle' ? 'bundle.tar.gz' : 'index.js';
    const signArgs = [
        path.join(HERE, 'plugin-sign.mjs'),
        '--dir',
        dir,
        '--key',
        key,
        '--key-id',
        keyId,
        '--version',
        version,
        '--manifest-url',
        `${baseUrl}/${rel}/manifest.json`,
        '--bundle-url',
        `${baseUrl}/${rel}/${bundleFile}`,
        '--out',
        destDir,
        '--format',
        format,
    ];
    if (format === 'bundle') signArgs.push('--entry', entry, '--gzip');

    try {
        execFileSync(process.execPath, signArgs, { stdio: 'pipe' });
    } catch (e) {
        console.error(`FAIL ${name}: ${e.stderr?.toString().trim() || e.message}`);
        failed++;
        continue;
    }

    // The signer already wrote the payload it signed into destDir (the bundled
    // index.js, or the tar). Copying the SOURCE over it here would replace the
    // bytes the checksum was computed from and every install would fail the
    // integrity check after a perfectly valid signature verify.
    if (!fs.existsSync(path.join(destDir, bundleFile))) {
        console.error(`FAIL ${name}: signer produced no ${bundleFile}`);
        failed++;
        continue;
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(destDir, 'manifest.json'), 'utf-8'));
    const signature = fs.readFileSync(path.join(destDir, 'manifest.json.sig'), 'utf-8').trim();

    plugins.push({
        name,
        title: meta.title ?? name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        description: meta.description,
        publisher: meta.publisher,
        homepage: meta.sourceUrl,
        tags: meta.kinds ?? [meta.kind],
        versions: [
            {
                version,
                manifestUrl: `${baseUrl}/${rel}/manifest.json`,
                signature,
                sdkAbi: manifest.sdkAbi,
                keyId,
            },
        ],
    });
    console.log(`signed ${name}@${version} (${format})`);
}

const index = {
    schemaVersion: 1,
    name: repoName,
    description: repoDesc,
    updatedAt: new Date().toISOString(),
    plugins,
};
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`\nindex.json: ${plugins.length} plugin(s), ${failed} failed → ${out}`);
if (failed) process.exitCode = 1;
