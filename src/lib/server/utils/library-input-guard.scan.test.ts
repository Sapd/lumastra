// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Source scan over every ffmpeg/ffprobe spawn site. A spawn whose `-i` is a
 * library file must carry the per-input `-format_whitelist` (see
 * `library-input-guard.ts`); one that does not must be on an allowlist with the
 * reason. A new sibling spawner that does neither fails here.
 *
 * Also: single-frame image outputs derived from a library file name need
 * `-update 1` (the image2 muxer expands `%d` in an output path), and the two
 * native decoders that cannot take a whitelist (fpcalc, essentia) must run the
 * content sniff right before they spawn.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP_ROOT = join(__dirname, '..', '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (['node_modules', '__tests__', '__testkit__'].includes(entry.name)) continue;
            walk(full, out);
        } else if (
            entry.name.endsWith('.ts') &&
            !/\.(test|spec)\.ts$/.test(entry.name) &&
            !/\.integration\./.test(entry.name) &&
            !entry.name.endsWith('.d.ts')
        ) {
            out.push(full);
        }
    }
    return out;
}

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

const files = walk(join(APP_ROOT, 'src')).map((full) => ({
    rel: relative(APP_ROOT, full),
    src: stripComments(readFileSync(full, 'utf8')),
}));

/** The text of every `spawnFFmpegSafely(...)` call in `src`, parens balanced. */
function spawnCalls(src: string): string[] {
    const calls: string[] = [];
    const re = /(?<![\w.])spawnFFmpegSafely\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        // Skip the declaration and imports.
        const before = src.slice(Math.max(0, m.index - 20), m.index);
        if (/function\s+$/.test(before)) continue;
        let depth = 0;
        let i = m.index + m[0].length - 1;
        const start = i;
        for (; i < src.length; i++) {
            if (src[i] === '(') depth++;
            else if (src[i] === ')' && --depth === 0) break;
        }
        calls.push(src.slice(start, i + 1));
    }
    return calls;
}

/** Spawn sites with no library input, or one guarded by another mechanism. */
const UNGUARDED_SPAWNS: Record<string, { count: number; reason: string }> = {
    'src/lib/server/jellyfin-compat/stream-limit-clip.ts': {
        count: 2,
        reason: "inputs are the app's own generated PNG, a lavfi source and its own clip",
    },
    'src/lib/server/utils/synthetic-iframe.ts': {
        count: 1,
        reason: 'input is a thumbnail piped on stdin',
    },
    'src/lib/server/services/transcoding/hardware-detection.ts': {
        count: 1,
        reason: 'encoder probes over a lavfi source',
    },
    'src/lib/server/services/music-transcode/fdk-aac-detection.ts': {
        count: 1,
        reason: '`-encoders` listing, no input',
    },
    'src/lib/server/services/ffmpeg-transcode.service.ts': {
        count: 2,
        reason: 'tail-cache GOP and transcode runs use FFmpegArgsBuilder, which emits -format_whitelist',
    },
};

/** Spawners that build their own argv; each must call a guard or be listed. */
const DIRECT_SPAWN =
    /\b(?:spawn|execFile|execFileAsync|execFileSync)\(\s*(?:config\.FFMPEG_PATH|config\.FFPROBE_PATH|ffmpegPath|ffprobePath|this\.ffmpegPath)\b/;
const GUARD_MARKERS = /guardLibraryInput\(|ffprobeLibraryInputArgs\(|format_whitelist/;

/**
 * Keyed `file#function` for one spawn site, or a bare `file` when nothing in the
 * file ever opens a library file. Judged per top-level function/class, so a
 * guarded function does not vouch for its unguarded siblings.
 */
const UNGUARDED_DIRECT: Record<string, string> = {
    'src/hooks.server.ts': '`-version` check',
    'src/lib/server/utils/ffmpeg-spawn.ts#spawnFFmpegNow':
        'the generic spawner: spawnFFmpegSafely() guards the argv first when libraryInput is set',
    'src/lib/server/utils/media-format-whitelist.ts':
        'enumerates demuxers (`-demuxers`, `-version`)',
    'src/lib/server/utils/ffprobe.ts#probeMediaFile':
        "scanner probe: it must see the playlist demuxer's name to classify a refusal; the scan-time and pre-spawn sniffs cover it",
    'src/lib/server/services/transcoding/gpu-access-probe.ts':
        'admin diagnostics over lavfi sources',
    'src/lib/server/api/defs/admin/ops/system-metrics.ts#readFFmpegVersion': '`-version` check',
    'src/lib/server/services/transcoding/process-runner.ts':
        'runs argv from FFmpegArgsBuilder, which emits -format_whitelist',
    'src/lib/server/jellyfin-compat/progressive-transcode-runner.ts#startFfmpeg':
        'spawns the argv guardedArgs() built (guardLibraryInput)',
    'src/lib/server/services/download-rendition/service.ts#spawnEncode':
        'spawns the argv runFfmpeg() guarded (guardLibraryInput)',
};

/** Split a module into top-level function/class chunks, named. */
function chunks(src: string): Array<{ name: string; text: string }> {
    const starts: Array<{ name: string; at: number }> = [];
    const re =
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class)\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function)/gm;
    for (const m of src.matchAll(re)) starts.push({ name: m[1] ?? m[2], at: m.index! });
    if (starts.length === 0 || starts[0].at > 0) starts.unshift({ name: '(module)', at: 0 });
    return starts.map((st, i) => ({
        name: st.name,
        text: src.slice(st.at, starts[i + 1]?.at ?? src.length),
    }));
}

describe('every ffmpeg/ffprobe spawn on a library file is format-whitelisted', () => {
    it('spawnFFmpegSafely callers pass libraryInput or are allowlisted', () => {
        const actual: Record<string, number> = {};
        for (const { rel, src } of files) {
            if (rel.endsWith('utils/ffmpeg-spawn.ts')) continue;
            const unguarded = spawnCalls(src).filter((call) => !/\blibraryInput\b/.test(call));
            if (unguarded.length > 0) actual[rel] = unguarded.length;
        }
        const expected = Object.fromEntries(
            Object.entries(UNGUARDED_SPAWNS).map(([f, v]) => [f, v.count]),
        );
        expect(
            actual,
            'a spawnFFmpegSafely call that opens a library file needs `libraryInput: <path>` (library-input-guard.ts)',
        ).toEqual(expected);
    });

    it('spawners with their own argv call a guard in the same function, or are allowlisted', () => {
        const unguarded = new Set<string>();
        for (const { rel, src } of files) {
            for (const chunk of chunks(src)) {
                if (DIRECT_SPAWN.test(chunk.text) && !GUARD_MARKERS.test(chunk.text)) {
                    unguarded.add(`${rel}#${chunk.name}`);
                }
            }
        }
        const allowed = Object.keys(UNGUARDED_DIRECT);
        const covered = (site: string) =>
            allowed.some((a) => a === site || (!a.includes('#') && site.startsWith(`${a}#`)));
        expect([...unguarded].filter((site) => !covered(site)).sort()).toEqual([]);
        // No stale entry.
        const used = (a: string) =>
            [...unguarded].some(
                (site) => a === site || (!a.includes('#') && site.startsWith(`${a}#`)),
            );
        expect(allowed.filter((a) => !used(a)).sort()).toEqual([]);
    });

    it('the guard is wired where the audit found library-input spawners', () => {
        const mustGuard = [
            'src/lib/server/utils/ffmpeg-subtitle-extractor.ts',
            'src/lib/server/services/trickplay-generator.service.ts',
            'src/lib/server/services/video-frame-extractor.service.ts',
            'src/lib/server/services/frame-candidate.service.ts',
            'src/lib/server/services/topshelf/topshelf-render.service.ts',
            'src/lib/server/services/download-rendition/service.ts',
            'src/lib/server/services/music-transcode/service.ts',
            'src/lib/server/jellyfin-compat/progressive-transcode-runner.ts',
            'src/lib/server/utils/ffmpeg-analysis.ts',
            'src/lib/server/api/defs/admin/transcode-failures/probe.ts',
        ];
        const bySrc = new Map(files.map(({ rel, src }) => [rel, src]));
        const missing = mustGuard.filter(
            (f) =>
                !GUARD_MARKERS.test(bySrc.get(f) ?? '') &&
                !/\blibraryInput\b/.test(bySrc.get(f) ?? ''),
        );
        expect(missing).toEqual([]);
    });

    it('native decoders that take no whitelist sniff the file right before spawning', () => {
        const bySrc = new Map(files.map(({ rel, src }) => [rel, src]));
        for (const f of [
            'src/lib/server/providers/implementations/musicbrainz/acoustid.ts',
            'src/lib/server/services/essentia-analysis.service.ts',
        ]) {
            expect(bySrc.get(f), f).toMatch(/assertTranscodeInputIsMedia\(/);
        }
    });
});

describe('single-frame image outputs are literal paths', () => {
    const SINGLE_FRAME = /'-(?:vframes|frames:v)',\s*'1'/;
    const NOT_LIBRARY_NAMED: Record<string, string> = {
        'src/lib/server/services/trickplay-generator.service.ts':
            'frames land at server-built paths under the trickplay temp dir',
        'src/lib/server/services/frame-candidate.service.ts':
            'candidates land in a mkdtemp dir under fixed candN.jpg names',
        'src/lib/server/utils/synthetic-iframe.ts': 'writes a server-named temp file',
        'src/lib/server/services/transcoding/hardware-detection.ts': 'lavfi probe, null output',
        'src/lib/server/services/transcoding/gpu-access-probe.ts': 'lavfi diagnostics, null output',
    };

    it('uses -update 1 unless the output path is server-named', () => {
        const without = files
            .filter(({ src }) => SINGLE_FRAME.test(src) && !/'-update'/.test(src))
            .map(({ rel }) => rel)
            .sort();
        expect(without).toEqual(Object.keys(NOT_LIBRARY_NAMED).sort());
    });
});
