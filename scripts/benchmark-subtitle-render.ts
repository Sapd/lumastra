// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { makeLargePgsFixture } from './subtitle-render-fixture.js';
import { runSubtitleWorker } from '../src/lib/server/services/subtitle-render-worker.js';

const generationStarted = performance.now();
const fixture = makeLargePgsFixture(960);
const generationMs = performance.now() - generationStarted;
const wallMs: number[] = [];
let images = 0;
for (let run = 0; run < 3; run++) {
    // Includes worker startup, byte transfer, parsing, rendering, packing and teardown.
    // Every run uses a fresh worker; no hot/disk rendered-subtitle cache participates.
    const started = performance.now();
    const blob = await runSubtitleWorker(fixture.data);
    wallMs.push(performance.now() - started);
    assert(blob);
    const manifest = JSON.parse(blob.subarray(8, 8 + blob.readUInt32BE(4)).toString()) as {
        canvas: { w: number; h: number };
        cues: unknown[];
        index: Record<string, unknown>;
    };
    assert.deepEqual(manifest.canvas, { w: 1920, h: 1080 });
    assert.equal(manifest.cues.length, fixture.cues);
    images = Object.keys(manifest.index).length;
    assert.equal(images, fixture.uniqueObjects);
}
console.log(
    JSON.stringify({
        canvas: '1920x1080',
        cues: fixture.cues,
        displaySets: fixture.displaySets,
        objectSize: `${fixture.objectWidth}x${fixture.objectHeight}`,
        references: fixture.references,
        uniqueObjects: fixture.uniqueObjects,
        uniquePixels: fixture.uniqueObjects * fixture.objectWidth * fixture.objectHeight,
        referencePixels: fixture.references * fixture.objectWidth * fixture.objectHeight,
        sourceBytes: fixture.data.length,
        images,
        generationMs: Math.round(generationMs),
        wallMs: wallMs.map(Math.round),
        maxWallMs: Math.round(Math.max(...wallMs)),
        deadlineMs: 30_000,
    }),
);
assert(
    Math.max(...wallMs) < 10_000,
    'Realistic subtitle render must stay below the 10-second target',
);
