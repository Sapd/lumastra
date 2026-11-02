// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { generateMusicMoodVectors, generateAudioMoodVectors } from './mood-vector.service.js';
import { MUSIC_MOOD_SEEDS, getMoodVectorSettings } from './mood-vector-seeds.js';
import { MSCLAP_MODEL_ID } from '../database/queries/sonic-constants.js';

describe('indexed music mood seeds', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    it('keeps the original text/audio seed multiset for every configured mood', async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            'media_embeddings',
            'media_audio_embeddings',
        ]);
        await sql`DELETE FROM mood_vectors WHERE mood_key = ANY(${Object.keys(MUSIC_MOOD_SEEDS)}::text[])`;
        const allKeywords = Object.values(MUSIC_MOOD_SEEDS).flatMap((mood) => mood.keywords);
        const metadata = [
            { genre: allKeywords.map((word) => word.toUpperCase()) },
            { essentia: { mood_tags: allKeywords } },
            { genre: allKeywords.map((word) => `prefix ${word} suffix`) },
            { genre: ['AMBIENT', null, 42, { tag: 'chill' }], essentia: { mood_tags: ['sad'] } },
            { genre: 'ambient', essentia: { mood_tags: 'happy' } },
            { genre: null, essentia: null },
            { genre: ['minor', 'key'] },
            { genre: ['plain'], essentia: { mood_tags: ['not a keyword'] } },
        ];
        const vector = `[${[1, ...new Array<number>(1023).fill(0)].join(',')}]`;
        for (const [index, customMetadata] of metadata.entries()) {
            const id = randomUUID();
            await sql`INSERT INTO media_items (id,title,media_type,status,custom_metadata)
                VALUES (${id}, ${`Mood fixture ${index}`}, 'track','active',${sql.json(customMetadata)})`;
            await sql`INSERT INTO media_embeddings (media_id,source,embedding)
                VALUES (${id},'music',${vector}::vector)`;
            if (index === 0) {
                // The original query has no source filter: preserve duplicate seeds.
                await sql`INSERT INTO media_embeddings (media_id,source,embedding)
                    VALUES (${id},'library',${vector}::vector)`;
            }
            await sql`INSERT INTO media_audio_embeddings (media_id,model_id,embedding)
                VALUES (${id},${MSCLAP_MODEL_ID},${vector}::vector),
                    (${id},'other-model',${vector}::vector)`;
        }
        for (const [mediaType, status] of [
            ['movie', 'active'],
            ['track', 'deleted'],
        ]) {
            const id = randomUUID();
            await sql`INSERT INTO media_items (id,title,media_type,status,custom_metadata)
                VALUES (${id},${id},${mediaType},${status},${sql.json({ genre: allKeywords })})`;
            await sql`INSERT INTO media_embeddings (media_id,source,embedding)
                VALUES (${id},'music',${vector}::vector)`;
            await sql`INSERT INTO media_audio_embeddings (media_id,model_id,embedding)
                VALUES (${id},${MSCLAP_MODEL_ID},${vector}::vector)`;
        }
        await generateMusicMoodVectors(sql);
        await generateAudioMoodVectors(sql);
        for (const [moodKey, mood] of Object.entries(MUSIC_MOOD_SEEDS)) {
            const patterns = mood.keywords.map((word) => `%${word}%`);
            // Original per-element predicate, with no indexed prefilter.
            const legacyMatch = sql`(
                EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(mi.custom_metadata->'genre')='array'
                        THEN mi.custom_metadata->'genre' ELSE '[]'::jsonb END) genre
                    WHERE genre ILIKE ANY(${patterns}::text[]))
                OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(mi.custom_metadata->'essentia'->'mood_tags')='array'
                        THEN mi.custom_metadata->'essentia'->'mood_tags' ELSE '[]'::jsonb END) tag
                    WHERE tag ILIKE ANY(${patterns}::text[])))`;
            for (const model of ['text', MSCLAP_MODEL_ID]) {
                const source =
                    model === 'text'
                        ? sql`media_embeddings embedding ON embedding.media_id=mi.id`
                        : sql`media_audio_embeddings embedding ON embedding.media_id=mi.id AND embedding.model_id=${model}`;
                const expected = await sql<{ id: string }[]>`SELECT mi.id FROM media_items mi
                    JOIN ${source} WHERE mi.media_type='track' AND mi.status='active'
                    AND embedding.embedding IS NOT NULL AND ${legacyMatch}`;
                expect(expected.length).toBeGreaterThanOrEqual(
                    getMoodVectorSettings().minSeedsRequired,
                );
                const [stored] = await sql<{ seed_media_ids: string[]; seed_count: number }[]>`
                    SELECT seed_media_ids,seed_count FROM mood_vectors WHERE mood_key=${moodKey} AND model_id=${model}`;
                expect(stored.seed_media_ids.sort(), `${moodKey}/${model}`).toEqual(
                    expected.map((row) => row.id).sort(),
                );
                expect(stored.seed_count).toBe(expected.length);
            }
        }
        // A wildcard can span tags in the concatenation, but not in the
        // original predicate. The exact EXISTS recheck must remain in place.
        const [cross] = await sql`SELECT
            music_mood_search_text('{"genre":["minor","key"]}') ILIKE '%minor%key%' AS candidate,
            EXISTS (SELECT 1 FROM jsonb_array_elements_text('["minor","key"]') tag
                WHERE tag ILIKE '%minor%key%') AS exact`;
        expect(cross).toMatchObject({ candidate: true, exact: false });
    });
});
