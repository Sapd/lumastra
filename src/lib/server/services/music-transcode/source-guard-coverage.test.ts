// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ruling T7-music: every music-transcode spawn is preceded by the source
 * guard (`assertTranscodeSourceIsMedia`). The guard lives at the top of
 * `MusicTranscodeService.streamFor`, the single entry point to the service's
 * one `spawn`; these checks fail if that stops being true — a new spawn, a
 * new path to the encode-arg builders that skips `streamFor`, the guard moved
 * below the cache lookup — or if an HTTP caller of `streamFor` does not turn
 * the refusal into its 415.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SERVICE = join(ROOT, 'src/lib/server/services/music-transcode/service.ts');

function productionSources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (name === 'node_modules' || name === 'paraglide') continue;
            productionSources(p, out);
        } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) {
            out.push(p);
        }
    }
    return out;
}

const sources = productionSources(join(ROOT, 'src')).map((p) => ({
    path: relative(ROOT, p),
    text: readFileSync(p, 'utf8'),
}));

describe('music-transcode source guard coverage', () => {
    const service = readFileSync(SERVICE, 'utf8');

    it('streamFor runs the guard before its slot, its cache lookup and any spawn', () => {
        const body = service.slice(service.indexOf('async streamFor('));
        const guard = body.indexOf('await assertTranscodeSourceIsMedia(req.sourcePath');
        expect(guard).toBeGreaterThan(-1);
        for (const later of ['acquireWithWait(', 'getCachedFinalPath(', 'encodeAndServe(']) {
            expect(body.indexOf(later), later).toBeGreaterThan(guard);
        }
    });

    it('the service spawns ffmpeg in exactly one place', () => {
        const codeLines = service.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
        expect(codeLines.filter((l) => /\bspawn\(/.test(l))).toHaveLength(1);
    });

    it('streamFor is the only public way into the service that reaches a spawn', () => {
        // Every non-private method of the class, apart from streamFor, must
        // not reach the encode/serve paths.
        const methods = [...service.matchAll(/^ {4}(?!private |static )(?:async )?(\w+)\(/gm)].map(
            (m) => m[1],
        );
        expect(methods).toContain('streamFor');
        for (const m of methods.filter((n) => n !== 'streamFor' && n !== 'constructor')) {
            const start = service.indexOf(`${m}(`);
            const next = service.indexOf('\n    }\n', start);
            const body = service.slice(start, next);
            expect(body, m).not.toMatch(
                /encodeAndServe|encodeMp4AndServe|serveFromCache|spawnFfmpeg|serveStreamCopySeek|serveMp4StreamCopySeek|tryServeDeduped/,
            );
        }
    });

    it('no module outside the service builds music-transcode ffmpeg arguments', () => {
        const builders =
            /\b(buildMp3EncodeArgs|buildOpusEncodeArgs|buildAacEncodeArgs|buildM4aEncodeArgs|buildStreamCopySeekArgs)\(/;
        const users = sources
            .filter((s) => builders.test(s.text))
            .map((s) => s.path)
            .filter((p) => !p.endsWith('music-transcode/service.ts'))
            .filter((p) => !p.endsWith('music-transcode/ffmpeg-args.ts'));
        expect(users).toEqual([]);
    });

    it('every caller of streamFor maps the refusal (status 415) to an HTTP 415', () => {
        const callers = sources.filter((s) => /\.streamFor\(/.test(s.text));
        expect(callers.length).toBeGreaterThan(0);
        for (const c of callers) {
            expect(c.text, c.path).toMatch(/status === 415/);
            expect(c.text, c.path).toMatch(/status: 415/);
        }
    });
});
