// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * globalTeardown for playwright.watch-together.config.ts: writes summary.json from the
 * ndjson rows every worker appended. It used to be a last test (zz-finalize), which
 * only works while one worker runs the files in order; with WT_WORKERS > 1 a test can
 * still be running when any given test finishes. Teardown runs once, after all of them
 * (and is not re-run by a worker restart, which was why it was not an afterAll).
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { outDir, webUrl } from './wt-env';
import { writeSummary } from './wt-harness';

export default async function globalTeardown(): Promise<void> {
    const summary = writeSummary();
    writeFileSync(join(outDir(), 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`[wt-web-e2e] summary: ${join(outDir(), 'summary.json')} (server ${webUrl()})`);
}
