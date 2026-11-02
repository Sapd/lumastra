// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * P3: the standalone Live TV proxy (`lumastra-proxy`, `--profile livetv-proxy`
 * in docker-compose.example.yml) must never mount the `config` named volume.
 * That volume holds master.key (the app's encryption-at-rest key for every
 * stored secret — PATs, service tokens, webhook secrets, plugin/Subsonic/
 * Jellyfin credentials) and settings.json. The proxy is a separate,
 * network-facing container that runs ffmpeg against attacker-influenced Live
 * TV stream URLs; it only ever needed `/config` for the shared jellyfin-ffmpeg
 * binary cache (FFMPEG_CACHE_DIR=/config/bin), so it now mounts a dedicated
 * `ffmpeg-cache` volume at that one subpath instead of the whole `config`
 * volume.
 *
 * `docker compose config` isn't runnable here (no Docker), so this parses the
 * real example file with the `yaml` package (a direct dependency) and asserts
 * on the parsed service definition directly. A regression (someone
 * reintroducing `config:/config` on the proxy, e.g. while debugging locally)
 * fails this test.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_PATH = join(__dirname, '..', 'docker-compose.example.yml');

interface ComposeService {
    volumes?: string[];
    profiles?: string[];
}
interface ComposeDoc {
    services: Record<string, ComposeService>;
    volumes: Record<string, unknown>;
}

function loadCompose(): ComposeDoc {
    const text = readFileSync(COMPOSE_PATH, 'utf8');
    return parse(text) as ComposeDoc;
}

describe('docker-compose.example.yml: lumastra-proxy volumes (P3)', () => {
    it('parses as valid YAML with a lumastra-proxy service', () => {
        const doc = loadCompose();
        expect(doc.services['lumastra-proxy']).toBeDefined();
    });

    it('lumastra-proxy does NOT mount the config volume', () => {
        const doc = loadCompose();
        const volumes = doc.services['lumastra-proxy'].volumes ?? [];
        const mountsConfigRoot = volumes.some((v) => v.trim().startsWith('config:/config'));
        expect(mountsConfigRoot).toBe(false);
    });

    it('lumastra-proxy mounts the dedicated ffmpeg-cache volume at /config/bin (read-only — see the P4 test below)', () => {
        const doc = loadCompose();
        const volumes = doc.services['lumastra-proxy'].volumes ?? [];
        expect(volumes).toContain('ffmpeg-cache:/config/bin:ro');
    });

    it('P4: lumastra-proxy mounts ffmpeg-cache READ-ONLY — a compromised proxy must not be able to overwrite the shared ffmpeg binary web/worker later spawn', () => {
        // fetch-ffmpeg.sh's ffmpeg_ready() only runs `ffmpeg -version` on an
        // already-present binary and exits 0 without re-verifying its digest
        // (scripts/fetch-ffmpeg.sh) — an rw mount lets a compromised proxy
        // plant a binary that answers -version and have web/worker execute it
        // as uid node on the next transcode. Asserting the exact
        // 'ffmpeg-cache:/config/bin' string (as the test above does) would
        // pass equally for 'ffmpeg-cache:/config/bin:ro', so this checks the
        // trailing :ro mode explicitly.
        const doc = loadCompose();
        const volumes = doc.services['lumastra-proxy'].volumes ?? [];
        const ffmpegCacheMount = volumes.find((v) => v.trim().startsWith('ffmpeg-cache:'));
        expect(ffmpegCacheMount).toBeDefined();
        expect(ffmpegCacheMount).toBe('ffmpeg-cache:/config/bin:ro');
    });

    it('the top-level ffmpeg-cache volume is declared', () => {
        const doc = loadCompose();
        expect(doc.volumes['ffmpeg-cache']).toBeDefined();
    });

    it('web (lumastra) keeps both config AND the shared ffmpeg-cache mount', () => {
        const doc = loadCompose();
        const volumes = doc.services['lumastra'].volumes ?? [];
        expect(volumes).toContain('config:/config');
        expect(volumes).toContain('ffmpeg-cache:/config/bin');
    });
});
