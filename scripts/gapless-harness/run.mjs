// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gapless boundary harness driver. See README.md.
 *
 * Generates the fixtures with ffmpeg, bundles the SHIPPED
 * `GaplessAdvanceScheduler` for the page, serves the directory, drives a real
 * browser, and prints gap + content-loss per strategy.
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseBoundary, CHIRP_BASE_HZ, CHIRP_RATE_HZ_PER_S, TONE_A_HZ } from './analysis.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '.fixtures');
const REPO = join(HERE, '..', '..');

const args = new Map(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? 'true'];
    }),
);
const ENGINE = args.get('engine') ?? 'chromium';
const FORMATS = (args.get('format') ?? 'mp3,m4a').split(',');

/** Seconds. Long enough that the scheduler's prewarm and lead both fit. */
const SECTION_SECONDS = 3;

const STRATEGIES = [
    { name: 'control_gap_200', kind: 'control', gapMs: 200, clipMs: 0 },
    { name: 'control_clip_200', kind: 'control', gapMs: 0, clipMs: 200 },
    { name: 'naive_ended', kind: 'control', gapMs: 0, clipMs: 0 },
    { name: 'predictive_lead_50', kind: 'predictive', leadMs: 50 },
    { name: 'predictive_lead_150', kind: 'predictive', leadMs: 150 },
    { name: 'predictive_lead_250', kind: 'predictive', leadMs: 250 },
];

function sh(cmd, argv) {
    return execFileSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/**
 * Fixture A — a constant tone. Fixture B — a linear chirp.
 *
 * The chirp's PHASE is 2π(base·t + rate·t²/2), the integral of its
 * instantaneous frequency. Writing `sin(2π·f(t)·t)` instead sweeps at twice the
 * intended rate and would halve every content-loss reading.
 */
function generateFixtures() {
    mkdirSync(FIXTURES, { recursive: true });
    const chirp = `sin(2*PI*(${CHIRP_BASE_HZ}*t + ${CHIRP_RATE_HZ_PER_S}*t*t/2))`;
    const tone = `sin(2*PI*${TONE_A_HZ}*t)`;

    for (const format of FORMATS) {
        const codec =
            format === 'mp3'
                ? ['-c:a', 'libmp3lame', '-b:a', '128k']
                : ['-c:a', 'aac', '-b:a', '128k'];
        for (const [name, expr] of [
            ['a', tone],
            ['b', chirp],
        ]) {
            const out = join(FIXTURES, `${name}.${format}`);
            if (existsSync(out) && statSync(out).size > 0) continue;
            sh('ffmpeg', [
                '-y',
                '-f',
                'lavfi',
                '-i',
                `aevalsrc=${expr}:s=44100:d=${SECTION_SECONDS}`,
                '-ac',
                '1',
                ...codec,
                out,
            ]);
        }
    }
}

function bundleScheduler() {
    const entry = join(FIXTURES, 'scheduler-entry.ts');
    const out = join(FIXTURES, 'scheduler.js');
    // Written every run: the point is to measure the CURRENT scheduler, so a
    // stale bundle would be worse than no harness at all.
    execFileSync(
        'node',
        [
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(entry)},
                "export { GaplessAdvanceScheduler } from '${join(REPO, 'src/lib/audio/gapless-advance').replace(/\\/g, '/')}';\\n")`,
        ],
        { stdio: 'inherit' },
    );
    sh('npx', ['esbuild', entry, '--bundle', '--format=esm', `--outfile=${out}`]);
}

const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
};

function serve() {
    const server = createServer((req, res) => {
        const name = (req.url ?? '/').split('?')[0];
        const path = name === '/' ? join(HERE, 'harness.html') : resolveAsset(name);
        if (!path || !existsSync(path)) {
            res.writeHead(404).end('not found');
            return;
        }
        const size = statSync(path).size;
        const type = MIME[extname(path)] ?? 'application/octet-stream';
        const common = {
            'Content-Type': type,
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes',
        };

        // Range support is LOAD-BEARING, not politeness. Without it Chromium
        // silently refuses to seek an <audio> element, and the clip control —
        // which works by starting file B 200 ms in — reported 14 ms instead of
        // 200 and was indistinguishable from the naive strategy. That is the
        // control doing its job: the harness was broken, not the browser.
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        if (range) {
            const start = range[1] === '' ? 0 : Number(range[1]);
            const end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
            if (start >= size || start > end) {
                res.writeHead(416, { ...common, 'Content-Range': `bytes */${size}` }).end();
                return;
            }
            res.writeHead(206, {
                ...common,
                'Content-Range': `bytes ${start}-${end}/${size}`,
                'Content-Length': end - start + 1,
            });
            createReadStream(path, { start, end }).pipe(res);
            return;
        }

        res.writeHead(200, { ...common, 'Content-Length': size });
        createReadStream(path).pipe(res);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function resolveAsset(name) {
    const base = name.replace(/^\/+/, '');
    if (base.includes('..')) return null;
    if (base === 'harness.html') return join(HERE, base);
    return join(FIXTURES, base);
}

function pad(value, width) {
    return String(value).padStart(width);
}

async function main() {
    generateFixtures();
    bundleScheduler();

    const { server, port } = await serve();
    const { chromium, webkit, firefox } = await import('playwright');
    const launcher = { chromium, webkit, firefox }[ENGINE];
    if (!launcher) throw new Error(`unknown engine ${ENGINE}`);

    const browser = await launcher.launch({
        args:
            ENGINE === 'chromium'
                ? ['--autoplay-policy=no-user-gesture-required', '--mute-audio']
                : undefined,
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    // WebKit refuses play() and AudioContext without a trusted gesture — the
    // same constraint the real player has on resume-after-navigation.
    await page.click('#go');

    const rows = [];
    for (const format of FORMATS) {
        for (const strategy of STRATEGIES) {
            const result = await page.evaluate(
                ([s, urlA, urlB, runMs]) => window.__runStrategy(s, urlA, urlB, { runMs }),
                [strategy, `/a.${format}`, `/b.${format}`, (SECTION_SECONDS * 2 + 0.6) * 1000],
            );
            const analysis = analyseBoundary(Float32Array.from(result.samples), result.sampleRate);
            rows.push({
                format,
                strategy: strategy.name,
                committed: result.committed,
                ...analysis,
            });
        }
    }

    await browser.close();
    server.close();

    report(rows);
}

function report(rows) {
    console.log(`\nengine: ${ENGINE}\n`);
    console.log(
        `${'format'.padEnd(6)} ${'strategy'.padEnd(20)} ${pad('gap(ms)', 9)} ${pad('lost(ms)', 9)} ${pad('join(ms)', 9)} ${pad('slope', 8)} ${pad('r²', 6)}`,
    );
    for (const row of rows) {
        // An unusable row prints dashes across the board rather than its
        // partially-computed numbers. A failed capture that renders as "gap 0.0"
        // reads as the best possible result, which is the one way this harness
        // could actively mislead.
        const cells = row.usable
            ? `${pad(fmt(row.gapMs), 9)} ${pad(fmt(row.contentLostMs), 9)} ` +
              `${pad(fmt(row.joinMs), 9)} ${pad(fmt(row.chirpSlopeHzPerS, 0), 8)} ${pad(row.fitR2.toFixed(3), 6)}`
            : `${pad('—', 9)} ${pad('—', 9)} ${pad(fmt(row.joinMs), 9)} ${pad('—', 8)} ${pad('—', 6)}`;
        console.log(`${row.format.padEnd(6)} ${row.strategy.padEnd(20)} ${cells}`);
    }

    const unusable = rows.filter((r) => !r.usable);
    if (unusable.length > 0) {
        console.log(
            `\n⚠️  ${unusable.length} row(s) produced no usable reading ` +
                `(${unusable.map((r) => `${r.format}/${r.strategy}`).join(', ')}). ` +
                `\n    Either the capture never reached file B, or the chirp fit was too ` +
                `noisy to extrapolate.`,
        );
    }

    // The controls are not decoration. Without a gap control the gap column is
    // unfalsifiable; without a clip control the loss column is. Both are
    // checked here so a bad run announces itself rather than being read as a
    // result.
    console.log('');
    let ok = true;
    for (const format of new Set(rows.map((r) => r.format))) {
        const gapControl = rows.find(
            (r) => r.format === format && r.strategy === 'control_gap_200',
        );
        const clipControl = rows.find(
            (r) => r.format === format && r.strategy === 'control_clip_200',
        );
        ok = checkControl(`${format} gap control`, gapControl?.gapMs, 200, 60) && ok;
        ok = checkControl(`${format} clip control`, clipControl?.contentLostMs, 200, 60) && ok;
    }
    if (unusable.length > 0) ok = false;
    if (!ok) {
        console.log(
            '\n⚠️  A control missed its target. The corresponding column is NOT a measurement\n' +
                '    this run — do not quote it. Codec priming delay and a busy machine are the\n' +
                '    usual causes; re-run before concluding anything about the strategies.',
        );
        process.exitCode = 1;
    }
}

function checkControl(label, actual, expected, tolerance) {
    if (actual === null || actual === undefined || Number.isNaN(actual)) {
        console.log(`✗ ${label}: no reading`);
        return false;
    }
    const ok = Math.abs(actual - expected) <= tolerance;
    console.log(`${ok ? '✓' : '✗'} ${label}: ${fmt(actual)} (expected ~${expected} ±${tolerance})`);
    return ok;
}

function fmt(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return value.toFixed(digits);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
