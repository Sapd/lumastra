// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Path-prefix LIKE queries with `_` in the path, against a real Postgres.
 *
 * Every prefix query escapes `\`, `%` and `_` in JS and then ends in
 * `ESCAPE '\'`. Inside a postgres.js tagged template that is a COOKED string, so
 * `'\'` reaches Postgres as `''` — escaping switched OFF — and the pattern's
 * `\_` then means "a literal backslash, then any character". Any path with an
 * underscore matched nothing: on prod the folder lookup for
 * `/data/series/Futurama_ (1999)/Season 01` returned no item, so that show's
 * season artwork was never attached. The fix is `ESCAPE '\\'` in the source.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    findParentMediaItemByFolder,
    getMediaFilePathsByLibraryPrefix,
    loadMediaFileIdsByPrefix,
    loadMediaFilesByPrefix,
} from './media-files.queries.js';
import { loadExternalSubtitlesByPrefix } from './external-subtitles.queries.js';
import { convergeSidecarLanguagesByPrefix } from './media-item-languages.queries.js';

const LIB = '/lib/tv_shows';
const SEASON = `${LIB}/Futurama_ (1999)/Season 01`;
const VIDEO = `${SEASON}/e1.mkv`;
// `_` must stay literal, never a one-character wildcard.
const DECOY = '/lib/tvXshows/Other/e1.mkv';

describe('path-prefix LIKE queries with an underscore in the path', () => {
    let sql: postgres.Sql;
    let episodeId: string;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        const [ep] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('episode', 'Ep', 'active', true) RETURNING id`;
        episodeId = ep.id;
        const [decoy] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('episode', 'Decoy', 'active', true) RETURNING id`;
        for (const [filePath, itemId] of [
            [VIDEO, episodeId],
            [DECOY, decoy.id],
        ]) {
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path) VALUES (${filePath}) RETURNING id`;
            await sql`INSERT INTO media_file_items (media_item_id, file_id)
                      VALUES (${itemId}, ${file.id})`;
            await sql`INSERT INTO external_subtitle_files (file_id, subtitle_path, language, format)
                      VALUES (${file.id}, ${filePath.replace('.mkv', '.en.srt')}, 'eng', 'srt')`;
        }
    });

    it('library-prefix loaders find the file and skip the decoy', async () => {
        expect([...(await loadMediaFileIdsByPrefix(sql, LIB)).keys()]).toEqual([VIDEO]);
        expect([...(await loadMediaFilesByPrefix(sql, LIB)).keys()]).toEqual([VIDEO]);
        expect(await getMediaFilePathsByLibraryPrefix(sql, LIB)).toEqual([VIDEO]);
        expect([...(await loadExternalSubtitlesByPrefix(sql, LIB)).keys()]).toEqual([
            `${SEASON}/e1.en.srt`,
        ]);
    });

    it('resolves the item of a folder whose name contains an underscore', async () => {
        expect(await findParentMediaItemByFolder(sql, SEASON)).toBe(episodeId);
    });

    it('converges the sidecar languages of an underscore library', async () => {
        await expect(convergeSidecarLanguagesByPrefix(sql, LIB)).resolves.toEqual({
            items: 1,
            series: 0,
        });
    });
});
