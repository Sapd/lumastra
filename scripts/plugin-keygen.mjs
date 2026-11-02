#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generate an Ed25519 plugin-signing keypair.
 *
 * Writes the PRIVATE key to a path you choose and prints the PUBLIC half in the
 * `keyId:base64Spki` wire format used by both `PLUGIN_TRUSTED_KEYS` and
 * `OFFICIAL_TRUSTED_KEY_ENTRIES`.
 *
 * THE PRIVATE KEY IS NEVER WRITTEN INSIDE THIS REPOSITORY. That is enforced
 * below, not merely advised: `trust-anchors.ts` states the invariant — "a
 * private key must NEVER appear in this file, the repo, the server, or the
 * website" — and a guard is worth more than a sentence, because the obvious
 * mistake is `--out ./official.pem` while standing in the repo root.
 *
 *   node scripts/plugin-keygen.mjs --key-id lumastra-official-2026 \
 *       --out ~/.secrets/lumastra-official-2026.pem
 *
 * Then:
 *   • paste the printed entry into OFFICIAL_TRUSTED_KEY_ENTRIES (public, in-repo)
 *   • keep the .pem offline — ideally an HSM or a hardware token, never CI
 *   • sign with: node scripts/plugin-sign.mjs --key <that .pem> --key-id <id> …
 *
 * Rotation: add the new public entry ALONGSIDE the old one and keep both until
 * every published manifest has been re-signed. Removing a key does not
 * uninstall anything — it only blocks future installs — so an early removal
 * silently strands upgrades rather than failing loudly.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
};

const keyId = arg('key-id');
const out = arg('out');

if (!keyId || !out) {
    console.error(
        'usage: plugin-keygen --key-id <id> --out <path-to-private-key.pem>\n' +
            '\n' +
            '  --key-id  a label you choose; it appears in the admin UI and the\n' +
            '            audit log so an operator can tell which key admitted\n' +
            '            which plugin. Dating it (lumastra-official-2026) makes\n' +
            '            rotation legible later.\n' +
            '  --out     where the PRIVATE key goes. Must be outside this repo.',
    );
    process.exit(2);
}

if (!/^[A-Za-z0-9._-]+$/.test(keyId)) {
    console.error(`refusing: key-id "${keyId}" — use [A-Za-z0-9._-] only.`);
    console.error('It is parsed out of a colon-separated list, so a colon would split the entry.');
    process.exit(2);
}

// ── the guard ───────────────────────────────────────────────────────────────
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = path.resolve(out.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
if (target === repoRoot || target.startsWith(repoRoot + path.sep)) {
    console.error(`refusing to write a private key inside the repository:\n  ${target}`);
    console.error(
        '\nA signing key in the working tree is one `git add -A` from being published,' +
            '\nand this repository is public. Choose a path outside it, e.g.' +
            `\n  --out ~/.secrets/${keyId}.pem`,
    );
    process.exit(2);
}
if (fs.existsSync(target)) {
    console.error(`refusing to overwrite an existing key: ${target}`);
    console.error('Overwriting a signing key silently invalidates everything signed with it.');
    process.exit(2);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

console.log(`\nPrivate key written to ${target} (mode 0600). Back it up offline.\n`);
console.log('Public entry — paste into OFFICIAL_TRUSTED_KEY_ENTRIES, or into');
console.log('PLUGIN_TRUSTED_KEYS if this is an operator key:\n');
console.log(`    ${keyId}:${spki}\n`);
console.log('Publish the same value at a stable URL so third parties can verify');
console.log(
    'what they are trusting: lumastra-web serves it at /.well-known/lumastra-signing-keys.json\n',
);
