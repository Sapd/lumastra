// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The base schema (a pg_dump) runs `COMMENT ON EXTENSION <ext> IS '…'` for every extension it
 * creates. COMMENT needs extension OWNERSHIP, so a non-superuser app role failed the first
 * migration on a database whose extensions an operator pre-created as superuser (CloudNativePG,
 * managed Postgres): "must be owner of extension pg_trgm". pgvector is not a trusted extension,
 * so such a role cannot create it itself either.
 *
 * Applied at migration time (like the __EMBEDDING_DIM__ rewrite), so BASE_SCHEMA_SQL — and the
 * base migration's checksum — stay unchanged. The comments are cosmetic; skipping them when the
 * role does not own the extension changes nothing else.
 */

// Plain (pg_trgm) or quoted ("uuid-ossp") extension names, as pg_dump writes them.
const EXTENSION_COMMENT =
    /^COMMENT ON EXTENSION ([a-z_][a-z0-9_]*|"(?:[^"]|"")+") IS ('(?:[^']|'')*');$/gm;

/** pg_dump identifier → the extname stored in pg_extension, as an SQL string literal body. */
function extnameLiteral(identifier: string): string {
    const name = identifier.startsWith('"')
        ? identifier.slice(1, -1).replaceAll('""', '"')
        : identifier;
    return name.replaceAll("'", "''");
}

/** Wrap each top-level COMMENT ON EXTENSION in a DO block that runs it only for the owner. */
export function guardExtensionComments(schemaSql: string): string {
    return schemaSql.replace(EXTENSION_COMMENT, (_statement, extension: string, text: string) =>
        [
            'DO $lumastra_ext_comment$',
            'BEGIN',
            '    IF EXISTS (',
            '        SELECT 1 FROM pg_catalog.pg_extension e',
            `        WHERE e.extname = '${extnameLiteral(extension)}'`,
            "          AND pg_catalog.pg_has_role(e.extowner, 'USAGE')",
            '    ) THEN',
            `        COMMENT ON EXTENSION ${extension} IS ${text};`,
            '    END IF;',
            'END',
            '$lumastra_ext_comment$;',
        ].join('\n'),
    );
}
