// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * External ID Subquery Builder Tests
 *
 * Unit tests verifying template fragments work correctly with postgres.js.
 */

import { describe, it, expect } from 'vitest';
import postgres from 'postgres';
import {
    buildExternalIdSubquery,
    buildExternalIdSubqueries,
    prebuiltExternalIdSubqueries,
    buildExternalIdExistsChecks,
    prebuiltExternalIdExistsChecks,
    buildExternalIdExclusions,
    prebuiltExternalIdExclusions,
} from './external-id-subquery.builder.js';

// Mock SQL client for testing template fragments
const sql = postgres('postgres://localhost');

describe('External ID Subquery Builder', () => {
    describe('buildExternalIdSubquery', () => {
        it('should build a subquery without cast', () => {
            const result = buildExternalIdSubquery(sql, sql`mi.id`, 'imdb');
            expect(result).toBeDefined();
            expect(result).toHaveProperty('strings');
            expect(result).toHaveProperty('values');
        });

        it('should build a subquery with integer cast', () => {
            const result = buildExternalIdSubquery(sql, sql`mi.id`, 'tmdb', true);
            expect(result).toBeDefined();
            expect(result).toHaveProperty('strings');
            expect(result).toHaveProperty('values');
        });

        it('should accept different media ID expressions', () => {
            const result = buildExternalIdSubquery(sql, sql`ur.media_id`, 'jellyfin');
            expect(result).toBeDefined();
        });
    });

    describe('buildExternalIdSubqueries', () => {
        it('should build all subqueries', () => {
            const result = buildExternalIdSubqueries(sql, sql`mi.id`);
            expect(result).toHaveProperty('primaryExtId');
            expect(result).toHaveProperty('primaryExtIdNullable');
            expect(result).toHaveProperty('imdbId');
            expect(result).toHaveProperty('jellyfinId');
            expect(result).toHaveProperty('jellyseerrId');
        });

        it('should return template fragments for all providers', () => {
            const result = buildExternalIdSubqueries(sql, sql`mi.id`);
            expect(result.primaryExtId).toHaveProperty('strings');
            expect(result.imdbId).toHaveProperty('strings');
            expect(result.jellyfinId).toHaveProperty('strings');
        });
    });

    describe('prebuiltExternalIdSubqueries', () => {
        it('should create prebuilt subqueries for mi.id', () => {
            const result = prebuiltExternalIdSubqueries(sql);
            expect(result).toHaveProperty('primaryExtId');
            expect(result).toHaveProperty('imdbId');
            expect(result).toHaveProperty('jellyfinId');
        });
    });

    describe('buildExternalIdExistsChecks', () => {
        it('should build EXISTS checks', () => {
            const result = buildExternalIdExistsChecks(sql, sql`mi.id`);
            expect(result).toHaveProperty('hasTmdb');
            expect(result).toHaveProperty('notHasTmdb');
            expect(result).toHaveProperty('hasImdb');
            expect(result).toHaveProperty('notHasImdb');
            expect(result).toHaveProperty('hasJellyfin');
            expect(result).toHaveProperty('notHasJellyfin');
        });

        it('should build EXISTS checks as template fragments', () => {
            const result = buildExternalIdExistsChecks(sql, sql`mi.id`);
            expect(result.hasTmdb).toHaveProperty('strings');
            expect(result.notHasTmdb).toHaveProperty('strings');
        });

        it('should have forProvider helper', () => {
            const result = buildExternalIdExistsChecks(sql, sql`mi.id`);
            expect(result.forProvider).toBeInstanceOf(Function);
            const check = result.forProvider('tvdb', true);
            expect(check).toHaveProperty('strings');
        });
    });

    describe('prebuiltExternalIdExistsChecks', () => {
        it('should create prebuilt EXISTS checks for mi.id', () => {
            const result = prebuiltExternalIdExistsChecks(sql);
            expect(result).toHaveProperty('hasTmdb');
            expect(result).toHaveProperty('notHasJellyfin');
        });
    });

    describe('buildExternalIdExclusions', () => {
        it('should build exclusion filters', () => {
            const result = buildExternalIdExclusions(sql, sql`mi.id`);
            expect(result).toHaveProperty('tmdbNotIn');
            expect(result).toHaveProperty('providerNotIn');
            expect(result).toHaveProperty('tmdbIn');
            expect(result).toHaveProperty('providerIn');
        });

        it('should build tmdbNotIn filter as function returning template', () => {
            const result = buildExternalIdExclusions(sql, sql`mi.id`);
            expect(result.tmdbNotIn).toBeInstanceOf(Function);
            const filter = result.tmdbNotIn([550, 1399]);
            expect(filter).toHaveProperty('strings');
            expect(filter).toHaveProperty('values');
        });

        it('should build tmdbIn filter as function returning template', () => {
            const result = buildExternalIdExclusions(sql, sql`mi.id`);
            expect(result.tmdbIn).toBeInstanceOf(Function);
            const filter = result.tmdbIn([550, 1399]);
            expect(filter).toHaveProperty('strings');
        });

        it('should build providerNotIn filter', () => {
            const result = buildExternalIdExclusions(sql, sql`mi.id`);
            const filter = result.providerNotIn('imdb', ['tt0137523', 'tt0133093']);
            expect(filter).toHaveProperty('strings');
        });

        it('should build providerIn filter', () => {
            const result = buildExternalIdExclusions(sql, sql`mi.id`);
            const filter = result.providerIn('jellyfin', ['abc123', 'def456']);
            expect(filter).toHaveProperty('strings');
        });
    });

    describe('prebuiltExternalIdExclusions', () => {
        it('should create prebuilt exclusions for mi.id', () => {
            const result = prebuiltExternalIdExclusions(sql);
            expect(result).toHaveProperty('tmdbNotIn');
            expect(result).toHaveProperty('tmdbIn');
        });
    });

    describe('Template fragment composability', () => {
        it('should compose subquery into SELECT', () => {
            const extIds = buildExternalIdSubqueries(sql, sql`mi.id`);
            // This should not throw - template fragments compose correctly
            const query = sql`SELECT ${extIds.primaryExtId} as primary_ext_id FROM media_items mi LIMIT 0`;
            expect(query).toBeDefined();
        });

        it('should compose EXISTS check into WHERE', () => {
            const checks = buildExternalIdExistsChecks(sql, sql`mi.id`);
            // This should not throw
            const query = sql`SELECT 1 FROM media_items mi WHERE ${checks.hasJellyfin} LIMIT 0`;
            expect(query).toBeDefined();
        });

        it('should compose exclusion filter into WHERE', () => {
            const exclusions = buildExternalIdExclusions(sql, sql`mi.id`);
            const filter = exclusions.tmdbNotIn([550]);
            // This should not throw
            const query = sql`SELECT 1 FROM media_items mi WHERE ${filter} LIMIT 0`;
            expect(query).toBeDefined();
        });
    });
});
