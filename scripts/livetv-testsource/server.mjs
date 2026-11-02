// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// Five feeds, four stations. HD/SD suffixes strip to the same base name; both
// kids feeds also share tvg-id/tvg-name (backup-group-detector.ts).
const feeds = [
    { id: 'news-one', station: 'news-one', name: 'News One', hz: 440 },
    { id: 'sports-two', station: 'sports-two', name: 'Sports Two', hz: 550 },
    { id: 'movies-three', station: 'movies-three', name: 'Movies Three', hz: 660 },
    { id: 'kids-four-hd', station: 'kids-four', name: 'Kids Four HD', hz: 770 },
    { id: 'kids-four-sd', station: 'kids-four', name: 'Kids Four SD', hz: 880 },
];
const stations = [
    ...new Map(feeds.map((feed) => [feed.station, feed.name.replace(/ (HD|SD)$/, '')])),
];
const portArg = process.argv.indexOf('--port');
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : process.env.PORT || 0);
const host = process.env.HOST || '127.0.0.1';
let limit = Number(process.env.PROVIDER_MAX_CONNECTIONS || 1);
if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be 0..65535; PROVIDER_MAX_CONNECTIONS must be a positive integer');
}
const font = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
].find((file) => existsSync(file));
/** @type {Set<import('node:child_process').ChildProcess>} */
const children = new Set();
/** @type {Map<import('node:child_process').ChildProcess, {id: string, connectedAt: string}>} */
const active = new Map();
/** @type {Array<{sequence: number, event: string, id: string, at: string}>} */
const events = [];
let sequence = 0;
let baseUrl = '';
/**
 * Failure modes for the failure-taxonomy e2e, set with POST /__control.
 * Keyed by feed id; '*' applies to every feed without its own entry.
 * `ok` | `status:<code>` (answer that HTTP status, optional `body`) | `stall` (headers,
 * then no bytes; open connections freeze) | `end` (open connections close; new ones
 * end right after the headers).
 * @type {Map<string, {mode: string, body?: string}>}
 */
const modes = new Map();

/** @param {string} id @returns {{mode: string, body?: string}} */
function modeFor(id) {
    return modes.get(id) ?? modes.get('*') ?? { mode: 'ok' };
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<unknown>} */
function readJson(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 4096) reject(new Error('body too large'));
        });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

/**
 * Apply a control request to the running connections of the affected feeds.
 * @param {string} feedId @param {string} mode @returns {void}
 */
function applyToActive(feedId, mode) {
    for (const [child, info] of active) {
        if (feedId !== '*' && info.id !== feedId) continue;
        if (mode === 'stall') child.kill('SIGSTOP');
        else if (mode === 'ok') child.kill('SIGCONT');
        else child.kill('SIGKILL');
    }
}

/** @param {string} event @param {string} id @returns {void} */
function log(event, id) {
    events.push({ sequence: ++sequence, event, id, at: new Date().toISOString() });
    if (events.length > 500) events.shift();
}

/** @param {number} ms @returns {string} */
function xmlTime(ms) {
    return new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
}

/** @returns {string} */
function guide() {
    const halfHour = 30 * 60_000;
    const start = Math.floor(Date.now() / halfHour) * halfHour - 3 * 60 * 60_000;
    return (
        '<?xml version="1.0" encoding="UTF-8"?><tv>' +
        stations
            .map(
                ([id, name]) =>
                    `<channel id="${id}"><display-name>${name}</display-name></channel>` +
                    Array.from(
                        { length: 13 },
                        (_, i) =>
                            `<programme channel="${id}" start="${xmlTime(start + i * halfHour)}" stop="${xmlTime(start + (i + 1) * halfHour)}"><title>${name} Signal Garden ${i + 1}</title><desc>A synthetic test programme.</desc></programme>`,
                    ).join(''),
            )
            .join('') +
        '</tv>'
    );
}

const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (path === '/__status') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
            JSON.stringify({
                connections: active.size,
                maxConnections: limit,
                modes: Object.fromEntries(modes),
                active: [...active.values()],
                events,
            }),
        );
        return;
    }
    if (path === '/__control' && req.method === 'POST') {
        readJson(req).then(
            (input) => {
                const body =
                    /** @type {{feed?: unknown, mode?: unknown, body?: unknown, maxConnections?: unknown}} */ (
                        input ?? {}
                    );
                const feedId = typeof body.feed === 'string' ? body.feed : '*';
                const mode = typeof body.mode === 'string' ? body.mode : 'ok';
                if (!/^(ok|stall|end|status:[1-5]\d\d)$/.test(mode)) {
                    res.writeHead(400).end('bad mode');
                    return;
                }
                if (feedId !== '*' && !feeds.some((feed) => feed.id === feedId)) {
                    res.writeHead(404).end('unknown feed');
                    return;
                }
                if (body.maxConnections !== undefined) {
                    const next = Number(body.maxConnections);
                    if (!Number.isInteger(next) || next < 1) {
                        res.writeHead(400).end('bad maxConnections');
                        return;
                    }
                    limit = next;
                }
                if (feedId === '*') modes.clear();
                if (mode === 'ok' && feedId !== '*') modes.delete(feedId);
                else if (mode !== 'ok') {
                    modes.set(feedId, {
                        mode,
                        ...(typeof body.body === 'string' ? { body: body.body.slice(0, 512) } : {}),
                    });
                }
                applyToActive(feedId, mode);
                log(`control:${mode}`, feedId);
                res.setHeader('Content-Type', 'application/json');
                res.end(
                    JSON.stringify({ modes: Object.fromEntries(modes), maxConnections: limit }),
                );
            },
            () => res.writeHead(400).end('bad json'),
        );
        return;
    }
    if (path === '/playlist.m3u') {
        res.setHeader('Content-Type', 'audio/x-mpegurl');
        res.end(
            `#EXTM3U x-tvg-url="${baseUrl}/guide.xml"\n` +
                feeds
                    .map(
                        (feed) =>
                            `#EXTINF:-1 tvg-id="${feed.station}" tvg-name="${feed.name.replace(/ (HD|SD)$/, '')}" group-title="Synthetic",${feed.name}\n${baseUrl}/stream/${feed.id}.ts\n`,
                    )
                    .join(''),
        );
        return;
    }
    if (path === '/guide.xml') {
        res.setHeader('Content-Type', 'application/xml');
        res.end(guide());
        return;
    }
    const feed = feeds.find((candidate) => path === `/stream/${candidate.id}.ts`);
    if (!feed) {
        res.writeHead(404).end();
        return;
    }
    const control = modeFor(feed.id);
    const statusMode = /^status:(\d{3})$/.exec(control.mode);
    if (statusMode) {
        log(`status:${statusMode[1]}`, feed.id);
        res.writeHead(Number(statusMode[1]), { 'Content-Type': 'text/plain' }).end(
            control.body ?? 'synthetic failure',
        );
        return;
    }
    if (control.mode === 'end') {
        log('ended', feed.id);
        res.writeHead(200, { 'Content-Type': 'video/mp2t' }).end();
        return;
    }
    if (control.mode === 'stall') {
        // Headers, then silence: the connection stays open and occupies no slot.
        log('stalled', feed.id);
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.flushHeaders();
        return;
    }
    if (active.size >= limit) {
        log('refused', feed.id);
        res.writeHead(429, { 'Retry-After': '1' }).end('provider connection limit');
        return;
    }
    const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-re',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=25',
        '-re',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${feed.hz}:sample_rate=48000`,
        ...(font
            ? [
                  '-vf',
                  `drawtext=fontfile=${font}:text='${feed.name}':fontsize=28:fontcolor=white:x=20:y=20`,
              ]
            : []),
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '25',
        '-keyint_min',
        '25',
        '-sc_threshold',
        '0',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-ac',
        '2',
        '-f',
        'mpegts',
        '-muxdelay',
        '0',
        'pipe:1',
    ];
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    active.set(child, { id: feed.id, connectedAt: new Date().toISOString() });
    log('opened', feed.id);
    const stop = () => {
        if (child.exitCode === null) child.kill('SIGKILL');
    };
    res.once('close', stop);
    child.once('error', (error) => {
        process.stderr.write(`testsource: ${error.message}\n`);
        res.destroy();
    });
    child.stderr.on('data', (data) => process.stderr.write(data));
    child.once('close', () => {
        children.delete(child);
        active.delete(child);
        log('closed', feed.id);
        res.end();
    });
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    child.stdout.pipe(res);
});
server.listen(port, host, () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP address');
    baseUrl = (process.env.PUBLIC_BASE_URL || `http://${host}:${address.port}`).replace(/\/$/, '');
    process.stdout.write(
        JSON.stringify({
            baseUrl,
            m3uUrl: `${baseUrl}/playlist.m3u`,
            xmltvUrl: `${baseUrl}/guide.xml`,
        }) + '\n',
    );
});
/** @returns {void} */
function shutdown() {
    for (const child of children) child.kill('SIGKILL');
    server.closeAllConnections();
    server.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
