// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { BASE_SCHEMA_SQL } from './base-schema-sql.js';
import { guardExtensionComments } from './base-schema-extension-comments.js';

const BARE_COMMENT = /^COMMENT ON EXTENSION /m;

describe('guardExtensionComments', () => {
    it('wraps every top-level COMMENT ON EXTENSION of the base schema in an ownership guard', () => {
        expect(BASE_SCHEMA_SQL.match(/^COMMENT ON EXTENSION /gm)).toHaveLength(4);

        const guarded = guardExtensionComments(BASE_SCHEMA_SQL);

        expect(guarded).not.toMatch(BARE_COMMENT);
        for (const ext of ['pg_trgm', 'pgcrypto', 'unaccent', 'vector']) {
            expect(guarded).toContain(`WHERE e.extname = '${ext}'`);
            expect(guarded).toMatch(
                new RegExp(`\\n {8}COMMENT ON EXTENSION ${ext} IS '[^']+';\\n`),
            );
        }
        expect(guarded.match(/pg_catalog\.pg_has_role\(e\.extowner, 'USAGE'\)/g)).toHaveLength(4);
    });

    it('leaves everything else byte-identical', () => {
        const guarded = guardExtensionComments(BASE_SCHEMA_SQL);
        const strip = (sql: string): string =>
            sql
                .replace(/^COMMENT ON EXTENSION [^\n]*\n/gm, '')
                .replace(/^DO \$lumastra_ext_comment\$[\s\S]*?^\$lumastra_ext_comment\$;\n/gm, '');
        expect(strip(guarded)).toBe(strip(BASE_SCHEMA_SQL));
        expect(guarded).toContain('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;');
    });

    it('keeps doubled quotes inside the comment text intact', () => {
        const sql = "COMMENT ON EXTENSION demo IS 'it''s a demo';\n";
        expect(guardExtensionComments(sql)).toContain(
            "COMMENT ON EXTENSION demo IS 'it''s a demo';",
        );
    });

    it('guards quoted extension names (pg_dump quotes names like uuid-ossp)', () => {
        const guarded = guardExtensionComments(
            'COMMENT ON EXTENSION "uuid-ossp" IS \'generate universally unique identifiers\';\n',
        );
        expect(guarded).not.toMatch(BARE_COMMENT);
        expect(guarded).toContain("WHERE e.extname = 'uuid-ossp'");
        expect(guarded).toContain('COMMENT ON EXTENSION "uuid-ossp" IS');
    });
});
