// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for TopShelfArtifactStore (§9.1): manifest CRUD, touch, pinning
 * window, retention GC, size-cap eviction, and stale-tmp cleanup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import {
    TopShelfArtifactStore,
    type TopShelfVariantManifestEntry,
} from './topshelf-artifact.store';

let rootDir: string;
let store: TopShelfArtifactStore;
let clockMs: number;

function makeEntry(
    overrides: Partial<TopShelfVariantManifestEntry> = {},
): TopShelfVariantManifestEntry {
    return {
        contentKey: 'abc1234567890def',
        source: 'snippet',
        bytes: 1024,
        createdAt: new Date(clockMs).toISOString(),
        lastRequestedAt: new Date(clockMs).toISOString(),
        ...overrides,
    };
}

async function writeArtifactFile(
    mediaUuid: string,
    variant: 'preview' | 'cinemagraph',
    contentKey: string,
) {
    const dir = join(rootDir, mediaUuid);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, `${variant}-${contentKey}.mp4`), Buffer.alloc(1024));
}

beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'topshelf-store-test-'));
    clockMs = Date.parse('2026-01-01T00:00:00.000Z');
    store = new TopShelfArtifactStore({
        rootDir,
        maxBytes: 10 * 1024 * 1024,
        retentionDays: 14,
        urlTtlSeconds: 172800, // 48h
        now: () => clockMs,
    });
});

afterEach(async () => {
    store.stopGcLoop();
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
});

describe('getVariantArtifact', () => {
    it('returns no_entry when there is no manifest', async () => {
        const result = await store.getVariantArtifact('item-1', 'preview');
        expect(result.status).toBe('no_entry');
    });

    it('returns ready when the manifest entry and file both exist', async () => {
        await store.recordVariant('item-1', 'preview', makeEntry());
        await writeArtifactFile('item-1', 'preview', 'abc1234567890def');
        const result = await store.getVariantArtifact('item-1', 'preview');
        expect(result.status).toBe('ready');
        if (result.status === 'ready') {
            expect(result.path).toContain('preview-abc1234567890def.mp4');
        }
    });

    it('returns missing_file when the manifest entry exists but the file is gone', async () => {
        await store.recordVariant('item-1', 'preview', makeEntry());
        // Deliberately do NOT write the artifact file.
        const result = await store.getVariantArtifact('item-1', 'preview');
        expect(result.status).toBe('missing_file');
    });
});

describe('touch', () => {
    it('advances lastRequestedAt for an existing entry', async () => {
        await store.recordVariant('item-1', 'preview', makeEntry());
        clockMs += 60_000;
        await store.touch('item-1', 'preview');
        const manifest = await store.readManifest('item-1');
        expect(manifest?.variants.preview?.lastRequestedAt).toBe(new Date(clockMs).toISOString());
    });

    it('is a no-op when the variant has no manifest entry', async () => {
        await expect(store.touch('item-1', 'preview')).resolves.toBeUndefined();
        const manifest = await store.readManifest('item-1');
        expect(manifest).toBeNull();
    });
});

describe('sweepOnce — pinning window', () => {
    it('never evicts an artifact whose lastRequestedAt is fresh, even over the size cap', async () => {
        // Size cap is tiny; every entry is "fresh" (inside the 48h+6h pinning window).
        const tinyStore = new TopShelfArtifactStore({
            rootDir,
            maxBytes: 1, // effectively zero budget
            retentionDays: 14,
            urlTtlSeconds: 172800,
            now: () => clockMs,
        });
        await tinyStore.recordVariant('item-1', 'preview', makeEntry());
        await writeArtifactFile('item-1', 'preview', 'abc1234567890def');

        const result = await tinyStore.sweepOnce();
        expect(result.evicted).toBe(0);
        expect(result.deleted).toBe(0);

        const lookup = await tinyStore.getVariantArtifact('item-1', 'preview');
        expect(lookup.status).toBe('ready');
    });
});

describe('sweepOnce — retention TTL', () => {
    it('deletes a variant whose lastRequestedAt is older than the retention window', async () => {
        await store.recordVariant('item-1', 'preview', makeEntry());
        await writeArtifactFile('item-1', 'preview', 'abc1234567890def');

        // Advance the clock well past BOTH the pinning window (48h+6h) and the
        // retention window (14d) so the entry is genuinely GC-eligible.
        clockMs += 20 * 24 * 60 * 60 * 1000;

        const result = await store.sweepOnce();
        expect(result.deleted).toBe(1);

        const lookup = await store.getVariantArtifact('item-1', 'preview');
        expect(lookup.status).toBe('no_entry');
    });

    it('removes the item directory once its last variant is cleaned up', async () => {
        await store.recordVariant('item-1', 'preview', makeEntry());
        await writeArtifactFile('item-1', 'preview', 'abc1234567890def');
        clockMs += 20 * 24 * 60 * 60 * 1000;

        await store.sweepOnce();
        const exists = await fs
            .stat(join(rootDir, 'item-1'))
            .then(() => true)
            .catch(() => false);
        expect(exists).toBe(false);
    });
});

describe('sweepOnce — size-cap eviction (never past the pinning rule)', () => {
    it('evicts the oldest-lastRequestedAt UNPINNED entry first when over budget', async () => {
        // Make both entries old enough to be unpinned (past 48h+6h) but well
        // inside the 14-day retention window, so eviction is driven by the size
        // cap rather than retention expiry.
        const past = clockMs;
        clockMs += 55 * 60 * 60 * 1000; // ~55h later — unpinned, not yet retention-expired

        const bigStore = new TopShelfArtifactStore({
            rootDir,
            maxBytes: 1500, // fits exactly one 1024-byte artifact
            retentionDays: 14,
            urlTtlSeconds: 172800,
            now: () => clockMs,
        });

        await bigStore.recordVariant(
            'older-item',
            'preview',
            makeEntry({ lastRequestedAt: new Date(past).toISOString() }),
        );
        await writeArtifactFile('older-item', 'preview', 'abc1234567890def');

        await bigStore.recordVariant(
            'newer-item',
            'preview',
            makeEntry({ lastRequestedAt: new Date(past + 1000).toISOString() }),
        );
        await writeArtifactFile('newer-item', 'preview', 'abc1234567890def');

        const result = await bigStore.sweepOnce();
        expect(result.evicted).toBe(1);

        const olderLookup = await bigStore.getVariantArtifact('older-item', 'preview');
        expect(olderLookup.status).toBe('no_entry');
        const newerLookup = await bigStore.getVariantArtifact('newer-item', 'preview');
        expect(newerLookup.status).toBe('ready');
    });
});

describe('compound variant keys', () => {
    function makeStore(): TopShelfArtifactStore {
        return new TopShelfArtifactStore({
            rootDir,
            maxBytes: 10 * 1024 * 1024,
            retentionDays: 14,
            urlTtlSeconds: 172800,
            now: () => clockMs,
        });
    }

    it('records, reads back, and survives a manifest round-trip', async () => {
        const store = makeStore();
        const key = 'preview-ov-logo-tl-s1-x40';
        await store.recordVariant('media-x', key, {
            contentKey: '0123456789abcdef',
            source: 'snippet',
            mode: 'logo',
            bytes: 100,
            createdAt: new Date().toISOString(),
            lastRequestedAt: new Date().toISOString(),
        });
        const manifest = await store.readManifest('media-x');
        expect(manifest?.variants[key]?.contentKey).toBe('0123456789abcdef');
        expect(manifest?.variants[key]?.mode).toBe('logo');
    });

    it('tolerates an old preview-only manifest', async () => {
        const store = makeStore();
        await store.recordVariant('media-y', 'preview', {
            contentKey: '0000000000000000',
            source: 'trailer',
            bytes: 10,
            createdAt: new Date().toISOString(),
            lastRequestedAt: new Date().toISOString(),
        });
        const m = await store.readManifest('media-y');
        expect(m?.variants['preview']?.contentKey).toBe('0000000000000000');
    });
});

describe('sweepOnce — superseded compound-key artifact files', () => {
    it('keeps the current compound-key artifact and deletes a stale rotated-out one', async () => {
        // Compound storeKey (contains its own hyphens) so the greedy regex
        // `/^(.+)-([0-9a-f]{16})\.mp4$/` must split on the FINAL 16-hex
        // segment rather than the first hyphen.
        const key = 'preview-ov-logo-tl-s1-x40';
        const currentKey = '0123456789abcdef';
        const staleKey = 'fedcba9876543210';

        await store.recordVariant('media-z', key, {
            contentKey: currentKey,
            source: 'snippet',
            mode: 'logo',
            bytes: 1024,
            createdAt: new Date(clockMs).toISOString(),
            lastRequestedAt: new Date(clockMs).toISOString(),
        });

        const currentPath = store.artifactPath('media-z', key, currentKey);
        await fs.mkdir(join(rootDir, 'media-z'), { recursive: true });
        await fs.writeFile(currentPath, Buffer.alloc(1024));

        // Simulate a leftover file from a rotated-out render whose contentKey
        // the manifest no longer references — e.g. a crash between the
        // render's rename and its recordVariant() call, so recordVariant()'s
        // own supersede-unlink never ran for it. Only sweepOnce's
        // superseded-file pass should catch this one.
        const stalePath = store.artifactPath('media-z', key, staleKey);
        await fs.writeFile(stalePath, Buffer.alloc(1024));

        await store.sweepOnce();

        const currentExists = await fs
            .stat(currentPath)
            .then(() => true)
            .catch(() => false);
        const staleExists = await fs
            .stat(stalePath)
            .then(() => true)
            .catch(() => false);
        expect(currentExists).toBe(true);
        expect(staleExists).toBe(false);
    });
});

describe('sweepOnce — stale tmp cleanup', () => {
    it('removes *.tmp.* files older than 1 hour', async () => {
        const dir = join(rootDir, 'item-1');
        await fs.mkdir(dir, { recursive: true });
        const tmpPath = join(dir, 'preview-abc.mp4.tmp.1234');
        await fs.writeFile(tmpPath, 'partial');
        const oldTime = new Date(clockMs - 2 * 60 * 60 * 1000);
        await fs.utimes(tmpPath, oldTime, oldTime);

        await store.sweepOnce();

        const exists = await fs
            .stat(tmpPath)
            .then(() => true)
            .catch(() => false);
        expect(exists).toBe(false);
    });

    it('keeps *.tmp.* files younger than 1 hour', async () => {
        const dir = join(rootDir, 'item-1');
        await fs.mkdir(dir, { recursive: true });
        const tmpPath = join(dir, 'preview-abc.mp4.tmp.1234');
        await fs.writeFile(tmpPath, 'partial');

        await store.sweepOnce();

        const exists = await fs
            .stat(tmpPath)
            .then(() => true)
            .catch(() => false);
        expect(exists).toBe(true);
    });
});
