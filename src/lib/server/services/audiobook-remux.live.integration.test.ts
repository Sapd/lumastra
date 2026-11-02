// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The remux, run against the REAL AudiobookShelf with the REAL ffmpeg.
 *
 * The unit tests pin the argv and the process lifecycle against doubles, which
 * can only ever confirm what we believe ffmpeg does. This file asks the actual
 * binary the questions the design rests on:
 *
 *  1. Does the E-AC-3 file really arrive as `eac3` in an `audio/mp4` container —
 *     i.e. is the premise (ABS direct-plays something no browser decodes) still
 *     true on this server?
 *  2. Does the output really come out as ADTS AAC that ffprobe recognises?
 *  3. Is `-ss` before `-i` really cheap over HTTP — the entire justification for
 *     restart-on-seek instead of a pre-transcoded artifact?
 *
 * ## How it finds an E-AC-3 book, and why it used to find none
 *
 * It used to gate on `AUDIOBOOK_REMUX_TEST_ITEM_ID`, a variable set NOWHERE — not
 * in `.env`, not in any script, not in CI. So the only test that checks this
 * premise against the real server and the real binary was skipped on every run and
 * reported green by skipping: precisely the "passes whether or not the code is
 * right" shape the rest of this work exists to avoid.
 *
 * The target is now DISCOVERED, in this order, and the reason for any skip is
 * printed rather than left to be inferred:
 *
 *  1. `AUDIOBOOK_REMUX_TEST_ITEM_ID` when set — an explicit override still wins.
 *  2. The configured database, using the persisted per-file codec. That is the
 *     whole point of persisting it, and it costs one query rather than an expanded
 *     fetch per book (1188 of them on the measured server):
 *
 * ```sql
 * SELECT ei.external_id AS item_id, f->>'ino' AS ino
 *   FROM media_items mi
 *   JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'audiobookshelf'
 *   CROSS JOIN LATERAL jsonb_array_elements(
 *     mi.custom_metadata->'audiobookshelf'->'audioFiles') f
 *  WHERE mi.media_type = 'audiobook' AND lower(f->>'codec') = 'eac3'
 *  LIMIT 1;
 * ```
 *
 * A library with no E-AC-3 file genuinely cannot run these cases, and that is the
 * only legitimate skip.
 *
 * Measured on 2026-07-30 with the values that query returned: `eac3`, 6 channels,
 * 48 kHz, 768 kbit/s in `mov,mp4,m4a`; output `aac`, 2 channels; `-ss 2700` on the
 * HTTP input took 0.85 s wall / 0.19 s CPU while the same seek through a piped
 * stdin took 8.56 s / 2.74 s and pulled all 266 MB. Real Chrome refused the
 * original (`EncodingError: Unable to decode audio data`) and accepted the output.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse as parseDotenv } from 'dotenv';
import postgres from 'postgres';
import { absFilePath } from './audiobook-byte-proxy.service.js';
import { buildAudiobookRemuxArgs, startAudiobookRemux } from './audiobook-remux.service.js';

const BASE_URL = (process.env.AUDIOURL ?? '').replace(/\/+$/, '');
const API_KEY = process.env.AUDIOAPIKEY ?? '';
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

/**
 * The APPLICATION's database, which is where the persisted sweep output lives.
 *
 * Not `process.env.DATABASE_URL`: the integration harness deliberately overwrites
 * that with the fixtures database (`vitest.integration.config.ts` sets
 * `DATABASE_URL` to the resolved test DB so production modules snapshot the right
 * handle at load). `lumastra_tests` has never seen a real AudiobookShelf library —
 * measured: 0 rows with a persisted `eac3` codec, against 39 in the dev catalogue —
 * so reading the harness value would always discover nothing.
 *
 * `AUDIOBOOK_REMUX_TEST_DATABASE_URL` overrides. Otherwise `.env` is parsed for the
 * pre-override value with dotenv's own parser; when there is no `.env` (CI) the
 * suite skips and says so.
 */
function resolveCatalogueDbUrl(): string {
    const explicit = process.env.AUDIOBOOK_REMUX_TEST_DATABASE_URL ?? '';
    if (explicit !== '') return explicit;
    try {
        return parseDotenv(readFileSync('.env')).DATABASE_URL ?? '';
    } catch {
        return '';
    }
}

/**
 * The item (and optionally the file) to exercise: an explicit override, or the
 * first E-AC-3 file the persisted sweep knows about.
 *
 * Resolved at module load so the skip decision — and its REASON — is available
 * before the suite is declared. A missing target prints why; it never fails, since
 * a library without an E-AC-3 file has nothing for these cases to assert.
 */
async function resolveTarget(): Promise<{ itemId: string; ino: string } | null> {
    const override = process.env.AUDIOBOOK_REMUX_TEST_ITEM_ID ?? '';
    if (override !== '') {
        return { itemId: override, ino: process.env.AUDIOBOOK_REMUX_TEST_INO ?? '' };
    }

    const dbUrl = resolveCatalogueDbUrl();
    if (dbUrl === '') {
        console.warn(
            '[remux-live] no AUDIOBOOK_REMUX_TEST_ITEM_ID and no catalogue DATABASE_URL — cannot discover an E-AC-3 book',
        );
        return null;
    }

    const sql = postgres(dbUrl, { max: 1, idle_timeout: 2, connect_timeout: 5 });
    try {
        const rows = await sql<{ item_id: string; ino: string }[]>`
            SELECT ei.external_id AS item_id, f->>'ino' AS ino
              FROM media_items mi
              JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'audiobookshelf'
              CROSS JOIN LATERAL jsonb_array_elements(
                COALESCE(mi.custom_metadata->'audiobookshelf'->'audioFiles', '[]'::jsonb)) f
             WHERE mi.media_type = 'audiobook' AND lower(f->>'codec') = 'eac3'
             LIMIT 1
        `;
        if (rows.length === 0) {
            console.warn(
                '[remux-live] no audiobook with a persisted eac3 codec in this database — nothing to exercise',
            );
            return null;
        }
        // Only the item id is taken from the DB. The file is re-chosen from the
        // LIVE payload below (longest E-AC-3 file), because the persisted sweep can
        // name an inode the server no longer has.
        return { itemId: rows[0].item_id, ino: '' };
    } catch (error) {
        console.warn(`[remux-live] E-AC-3 discovery query failed: ${(error as Error).message}`);
        return null;
    } finally {
        await sql.end({ timeout: 2 }).catch(() => {});
    }
}

const target = BASE_URL && API_KEY ? await resolveTarget() : null;
if (!BASE_URL || !API_KEY) {
    console.warn('[remux-live] AUDIOURL/AUDIOAPIKEY not set — live remux cases skipped');
}

const ITEM_ID = target?.itemId ?? '';
const INO = target?.ino ?? '';
const LIVE = Boolean(BASE_URL && API_KEY && ITEM_ID);
const suite = LIVE ? describe : describe.skip;

interface ExpandedItem {
    media: {
        audioFiles: Array<{
            ino: string;
            codec?: string;
            mimeType?: string;
            duration?: number;
        }>;
    };
}

/** ffprobe one stream property of a local file. */
function ffprobe(path: string, entries: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(
            FFMPEG.replace(/ffmpeg$/, 'ffprobe'),
            ['-v', 'error', '-show_entries', entries, '-of', 'default=nk=1:nw=1', path],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let out = '';
        proc.stdout.on('data', (b: Buffer) => (out += b.toString()));
        proc.on('error', reject);
        proc.on('close', () => resolve(out.trim()));
    });
}

async function collect(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            total += value.length;
        }
        if (total >= maxBytes) {
            await reader.cancel();
            break;
        }
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

suite('audiobook remux against a live AudiobookShelf', () => {
    let ino = INO;
    let url = '';
    /** Length of the chosen file, seconds — 0 when it could not be read. */
    let durationSeconds = 0;

    beforeAll(async () => {
        const res = await fetch(`${BASE_URL}/api/items/${ITEM_ID}?expanded=1`, {
            headers: { Authorization: `Bearer ${API_KEY}` },
        });
        expect(res.status, 'expanded item fetch').toBe(200);
        const item = (await res.json()) as ExpandedItem;
        const eac3 = item.media.audioFiles.filter((f) => (f.codec ?? '').toLowerCase() === 'eac3');
        expect(eac3.length, `no E-AC-3 file on ${ITEM_ID}; pick another item`).toBeGreaterThan(0);

        // The LONGEST one, not the first. A real book's first file is often a
        // 60-second publisher intro — measured 63.5 s on the item this was
        // developed against — and seeking 45 minutes into it yields zero bytes,
        // which reads as "input seeking is broken" when nothing is broken.
        const chosen = INO
            ? eac3.find((f) => f.ino === INO)
            : eac3.reduce((a, b) => ((b.duration ?? 0) > (a.duration ?? 0) ? b : a));
        expect(chosen, `no E-AC-3 file with ino ${INO}`).toBeDefined();
        ino = chosen!.ino;
        durationSeconds = chosen!.duration ?? 0;
        url = `${BASE_URL}${absFilePath(ITEM_ID, ino)}`;
    });

    it('confirms the premise: E-AC-3 inside an mp4 container', async () => {
        // If this ever stops being true the remux is pointless, and a test that
        // only checked the OUTPUT would keep passing while doing nothing useful.
        const args = [
            '-v',
            'error',
            '-headers',
            `Authorization: Bearer ${API_KEY}\r\n`,
            '-show_entries',
            'stream=codec_name,channels:format=format_name',
            '-of',
            'default=nk=1:nw=1',
            url,
        ];
        const out = await new Promise<string>((resolve, reject) => {
            const proc = spawn(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let text = '';
            proc.stdout.on('data', (b: Buffer) => (text += b.toString()));
            proc.on('error', reject);
            proc.on('close', () => resolve(text));
        });
        expect(out).toContain('eac3');
        expect(out).toMatch(/mp4|m4a/);
    }, 60_000);

    it('produces ADTS AAC that ffprobe recognises', async () => {
        const stream = startAudiobookRemux(
            { url, apiKey: API_KEY, startSeconds: 5 },
            { ffmpegPath: FFMPEG },
        );
        const bytes = await collect(stream.body, 200_000);
        stream.stop();

        expect(bytes.length).toBeGreaterThan(10_000);
        // ADTS frames start with a 12-bit sync word: 0xFF followed by 0xF_.
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1] & 0xf0).toBe(0xf0);

        const { writeFile, unlink } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { tmpdir } = await import('node:os');
        const path = join(tmpdir(), `lumastra-remux-live-${process.pid}.aac`);
        await writeFile(path, bytes);
        try {
            expect(await ffprobe(path, 'stream=codec_name')).toBe('aac');
            // Downmixed: what real Chrome accepted was 2 channels.
            expect(await ffprobe(path, 'stream=channels')).toBe('2');
        } finally {
            await unlink(path).catch(() => {});
        }
    }, 120_000);

    it('reaches a mid-file offset quickly, which is what restart-on-seek costs', async () => {
        // The whole justification for not building a pre-transcoded artifact. If
        // input seeking regressed (e.g. `-ss` moved after `-i`), first audio at a
        // 45-minute offset would take seconds of CPU instead of a fraction.
        // Well inside the file: past its end would return zero bytes and look
        // like a seeking regression.
        const startSeconds = Math.max(1, Math.floor(durationSeconds * 0.6));
        const args = buildAudiobookRemuxArgs({ url, apiKey: API_KEY, startSeconds });
        expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));

        const started = Date.now();
        const stream = startAudiobookRemux(
            { url, apiKey: API_KEY, startSeconds },
            { ffmpegPath: FFMPEG },
        );
        const bytes = await collect(stream.body, 32_000);
        const elapsed = Date.now() - started;
        stream.stop();

        expect(bytes.length).toBeGreaterThan(0);
        // Measured 1.7 s on the live server; 8 s is the piped-stdin figure, so
        // this bound distinguishes the two without being flaky about network.
        expect(elapsed).toBeLessThan(8_000);
    }, 120_000);
});
