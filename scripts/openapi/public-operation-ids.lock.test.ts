// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins every public operationId in `public-operation-ids.lock.json` against
 * PUBLIC_TAXONOMY (the source, not the generated YAML).
 *
 * The operationIds are the method names of every generated client (Swift, TS,
 * third parties). This test fails when:
 *   1. a locked `METHOD path` is gone from PUBLIC_TAXONOMY (removed or moved),
 *   2. a locked operation has a different operationId now (renamed),
 *   3. a PUBLIC_TAXONOMY operation is not in the lock (new, unlocked).
 *
 * To add a public operation: add its line to public-operation-ids.lock.json in
 * the same commit (keep the lock sorted by path, then method).
 *
 * Renaming, moving or removing a locked operationId breaks every generated
 * client. Don't edit the lock to make this test pass. Follow docs/api/API.md,
 * "Stability and deprecation": add the new operation with a new id alongside,
 * mark the old one `stability: 'deprecated'` with a `deprecation: { since,
 * sunset, replacement }` block (emitted as `x-deprecation`), keep it for at
 * least two minor releases or 90 days, and delete its lock line only in the
 * release whose changelog lists the removal (or in a new major API version).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTaxonomyIndex, PUBLIC_TAXONOMY } from './public-taxonomy';

const GUIDANCE = `
Public operationIds are pinned in scripts/openapi/public-operation-ids.lock.json.

- Adding a public operation: add its line to public-operation-ids.lock.json in the same commit.
- Renaming, moving or removing a locked operationId breaks every generated client (Swift, TS,
  third parties). Don't edit the lock to make this test pass. Follow docs/api/API.md,
  "Stability and deprecation": add the new operation (new id) alongside, mark the old one
  stability: 'deprecated' with a deprecation: { since, sunset, replacement } block, keep it for at
  least two minor releases or 90 days, and delete its lock line only in the release whose changelog
  lists the removal (or in a new major API version).
`;

const lock = JSON.parse(
    readFileSync(resolve(__dirname, 'public-operation-ids.lock.json'), 'utf-8'),
) as Record<string, string>;

const taxonomy = buildTaxonomyIndex(PUBLIC_TAXONOMY);

/** Path first, then method: the order the lock file is written in. */
function lockOrder(a: string, b: string): number {
    const [methodA, ...pathA] = a.split(' ');
    const [methodB, ...pathB] = b.split(' ');
    const pa = pathA.join(' ');
    const pb = pathB.join(' ');
    if (pa !== pb) return pa < pb ? -1 : 1;
    return methodA < methodB ? -1 : methodA > methodB ? 1 : 0;
}

describe('public operationId lock (public-operation-ids.lock.json)', () => {
    it('no locked operation was removed or moved', () => {
        const problems: string[] = [];
        for (const [key, id] of Object.entries(lock)) {
            if (!taxonomy.has(key))
                problems.push(`\`${key}\` (operationId \`${id}\`) was removed or moved`);
        }
        expect(problems, GUIDANCE).toEqual([]);
    });

    it('no locked operationId was renamed', () => {
        const problems: string[] = [];
        for (const [key, id] of Object.entries(lock)) {
            const current = taxonomy.get(key);
            if (current && current.operationId !== id) {
                problems.push(
                    `\`${key}\`: operationId changed \`${id}\` → \`${current.operationId}\``,
                );
            }
        }
        expect(problems, GUIDANCE).toEqual([]);
    });

    it('every public operation is in the lock', () => {
        const problems: string[] = [];
        for (const [key, entry] of taxonomy) {
            if (!(key in lock))
                problems.push(
                    `add to public-operation-ids.lock.json: "${key}": "${entry.operationId}",`,
                );
        }
        expect(problems, GUIDANCE).toEqual([]);
    });

    it('the lock is sorted by path then method and has no duplicate operationIds', () => {
        const keys = Object.keys(lock);
        const ids = Object.values(lock);
        const problems: string[] = [];
        const sorted = [...keys].sort(lockOrder);
        if (keys.some((k, i) => k !== sorted[i]))
            problems.push('keys are not sorted by path, then method');
        const seen = new Set<string>();
        for (const id of ids) {
            if (seen.has(id))
                problems.push(`operationId \`${id}\` is used by more than one operation`);
            seen.add(id);
        }
        expect(problems, GUIDANCE).toEqual([]);
    });
});
