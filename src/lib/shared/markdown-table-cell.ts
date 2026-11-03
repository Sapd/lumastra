// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Escape the column separator of a GitHub-flavoured Markdown table cell.
 *
 * A bare `|` -> `\|` replace is not enough: in `a\|b` it yields `a\\|b`, where
 * the backslash is itself escaped and the pipe is live again, so the row splits.
 * Every run of backslashes directly before a pipe is therefore doubled first,
 * which leaves the final `\|` as the only unescaped pair. Backslashes that do
 * not precede a pipe are left alone (Windows paths stay readable).
 */
export function escapeTablePipes(text: string): string {
    return text.replace(/(\\*)\|/g, '$1$1\\|');
}
