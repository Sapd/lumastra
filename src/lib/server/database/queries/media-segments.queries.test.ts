// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import {
    getSegmentsByMediaId,
    upsertSegments,
    getSegmentAnalysisStatus,
} from './media-segments.queries.js';

const VISUAL = { stageId: 'lumastra-intro-analyzer:visual', minVersion: 5 };
const ACOUSTIC = { stageId: 'lumastra-intro-analyzer:acoustic', minVersion: 4 };

function mockSqlWith(rows: unknown[]) {
    return vi.fn().mockResolvedValue(rows);
}

describe('getSegmentAnalysisStatus', () => {
    it('reports analyzed when both required stages are completed and current', async () => {
        const mockSql = mockSqlWith([
            {
                stage_id: 'lumastra-intro-analyzer:visual',
                status: 'completed',
                processing_version: 5,
                invalidated_at: null,
            },
            {
                stage_id: 'lumastra-intro-analyzer:acoustic',
                status: 'completed',
                processing_version: 4,
                invalidated_at: null,
            },
        ]);

        const result = await getSegmentAnalysisStatus(mockSql as never, 'item-1', [
            VISUAL,
            ACOUSTIC,
        ]);

        expect(result).toBe('analyzed');
    });

    it('reports analyzed when a stage is skipped_permanent (poison tombstone)', async () => {
        const mockSql = mockSqlWith([
            {
                stage_id: 'lumastra-intro-analyzer:visual',
                status: 'skipped_permanent',
                processing_version: 5,
                invalidated_at: null,
            },
            {
                stage_id: 'lumastra-intro-analyzer:acoustic',
                status: 'completed',
                processing_version: 4,
                invalidated_at: null,
            },
        ]);

        const result = await getSegmentAnalysisStatus(mockSql as never, 'item-1', [
            VISUAL,
            ACOUSTIC,
        ]);

        expect(result).toBe('analyzed');
    });

    it('reports pending when a required stage has no row at all', async () => {
        const mockSql = mockSqlWith([
            {
                stage_id: 'lumastra-intro-analyzer:visual',
                status: 'completed',
                processing_version: 5,
                invalidated_at: null,
            },
            // no acoustic row
        ]);

        const result = await getSegmentAnalysisStatus(mockSql as never, 'item-1', [
            VISUAL,
            ACOUSTIC,
        ]);

        expect(result).toBe('pending');
    });

    it('reports pending when both stages have no rows at all (never analysed)', async () => {
        const mockSql = mockSqlWith([]);

        const result = await getSegmentAnalysisStatus(mockSql as never, 'item-1', [
            VISUAL,
            ACOUSTIC,
        ]);

        expect(result).toBe('pending');
    });

    it('reports pending when a stage row is at a stale processing_version', async () => {
        const mockSql = mockSqlWith([
            {
                stage_id: 'lumastra-intro-analyzer:visual',
                // Below VISUAL.minVersion (5) — analyzer bumped its version since
                // this row was written, so the item is due for re-analysis.
                status: 'completed',
                processing_version: 4,
                invalidated_at: null,
            },
            {
                stage_id: 'lumastra-intro-analyzer:acoustic',
                status: 'completed',
                processing_version: 4,
                invalidated_at: null,
            },
        ]);

        const result = await getSegmentAnalysisStatus(mockSql as never, 'item-1', [
            VISUAL,
            ACOUSTIC,
        ]);

        expect(result).toBe('pending');
    });

    it('reports pending when a stage row has invalidated_at set', async () => {
        const mockSql = mockSqlWith([
            {
                stage_id: 'lumastra-intro-analyzer:visual',
                status: 'completed',
                processing_version: 5,
                invalidated_at: new Date('2026-08-01T00:00:00Z'),
            },
            {
                stage_id: 'lumastra-intro-analyzer:acoustic',
                status: 'completed',
                processing_version: 4,
                invalidated_at: null,
            },
        ]);

        const result = await getSegmentAnalysisStatus(mockSql as never, 'item-1', [
            VISUAL,
            ACOUSTIC,
        ]);

        expect(result).toBe('pending');
    });

    it('reports pending when a stage row is still pending/running/failed (not terminal)', async () => {
        const mockSql = mockSqlWith([
            {
                stage_id: 'lumastra-intro-analyzer:visual',
                status: 'running',
                processing_version: 5,
                invalidated_at: null,
            },
            {
                stage_id: 'lumastra-intro-analyzer:acoustic',
                status: 'completed',
                processing_version: 4,
                invalidated_at: null,
            },
        ]);

        const result = await getSegmentAnalysisStatus(mockSql as never, 'item-1', [
            VISUAL,
            ACOUSTIC,
        ]);

        expect(result).toBe('pending');
    });

    it('returns pending immediately when no requirements are given, without querying', async () => {
        const mockSql = vi.fn();

        const result = await getSegmentAnalysisStatus(mockSql as never, 'item-1', []);

        expect(result).toBe('pending');
        expect(mockSql).not.toHaveBeenCalled();
    });
});

describe('file-scoped segments', () => {
    it('reads media-wide markers and only the selected file markers', async () => {
        const sql = mockSqlWith([]);
        await getSegmentsByMediaId(sql as never, 'media', 'selected-file');
        const [strings, ...values] = sql.mock.calls[0];
        expect(strings.join('?')).toContain('file_id IS NULL OR file_id =');
        expect(values).toEqual(['media', 'selected-file', 'media']);
        expect(strings.join('?')).toContain('DISTINCT ON (type, source)');
    });

    it('records file identity and includes it in the conflict target', async () => {
        const sql = mockSqlWith([]);
        await upsertSegments(
            sql as never,
            'media',
            [{ type: 'Intro', startTime: 1, endTime: 2 }],
            'detector',
            'file',
        );
        const [strings, ...values] = sql.mock.calls[0];
        expect(strings.join('?')).toContain('ON CONFLICT (media_id, type, source, file_id)');
        expect(values).toEqual([
            'file',
            'media',
            'Intro',
            'detector',
            'media',
            'file',
            'Intro',
            1,
            2,
            'detector',
        ]);
        expect(strings.join('?')).toContain('WITH superseded AS');
    });

    it('records unknown analysed files as media-wide NULL', async () => {
        const sql = mockSqlWith([]);
        await upsertSegments(
            sql as never,
            'media',
            [{ type: 'Intro', startTime: 1, endTime: 2 }],
            'plugin',
        );
        expect(sql.mock.calls[0][1]).toBeNull();
    });
});
