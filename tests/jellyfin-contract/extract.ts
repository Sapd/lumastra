// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Regenerates tests/jellyfin-contract/jellyfin-contract.json from the exact
 * openapi.json each jellyfin-sdk-kotlin release was generated from. The file is a
 * git-LFS object, so it is read from media.githubusercontent.com (raw.* returns a pointer).
 * Run: npx tsx tests/jellyfin-contract/extract.ts
 * Re-run when a new SDK line ships (and add it to SDK_VERSIONS).
 */
import { writeFileSync } from 'node:fs';
import {
    buildDigest,
    type OpenApiDoc,
} from '../../src/lib/server/jellyfin-compat/contract/build-digest';

export const SDK_VERSIONS = ['1.6.3', '1.7.1', '1.8.12', '1.9.2'];
const OUT = new URL('./jellyfin-contract.json', import.meta.url);

const inputs = [];
for (const sdk of SDK_VERSIONS) {
    const url = `https://media.githubusercontent.com/media/jellyfin/jellyfin-sdk-kotlin/v${sdk}/openapi.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    inputs.push({ sdk, spec: (await res.json()) as OpenApiDoc });
}
const digest = buildDigest(inputs);
writeFileSync(OUT, JSON.stringify(digest) + '\n');
console.log(
    `wrote ${Object.keys(digest.schemas).length} schemas, ${digest.routes.length} routes for`,
    digest.versions,
);
