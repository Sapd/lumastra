// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Copy-pasteable remedies built from the REAL numbers this instance reported.
 *
 * The entire value of the permission diagnostic is that it stops saying
 * "check your permissions" and starts saying "run this". A generic
 * `chown -R 1000:1000 /media` is another forum post; `chown -R 1001:1001
 * /srv/media/movies`, with the uid this process actually runs as and the path
 * that actually failed, is a fix.
 *
 * Both DIRECTIONS are offered on purpose, because which one is correct depends
 * on facts this page cannot know (is the media shared with other services? is
 * the container's uid pinned by something else?):
 *   - move the FOLDER to the process   → chown / chmod
 *   - move the PROCESS to the folder   → Compose `user:`
 * Presenting only the first has a real failure mode: an operator chowns a share
 * that another service also writes to and breaks that instead.
 *
 * Pure string builders, no I/O — so the shell text that reaches an operator's
 * root prompt is unit-testable.
 */

/** Shell-quote a path for a copy-pasteable command. */
/**
 * Every command below ends its options with `--`, so a path that begins with
 * `-` is read as a path, not as a flag (GNU and BSD tools both honour it).
 */
export function quotePath(path: string): string {
    // Only quote when needed, so the common case stays readable, and use single
    // quotes (no expansion) with the standard '\'' escape for embedded quotes.
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path;
    return `'${path.replaceAll("'", `'\\''`)}'`;
}

export interface OwnershipFacts {
    /** uid this server process runs as, or null when unknown (Windows). */
    processUid: number | null;
    processGid: number | null;
    /** uid that owns the directory, or null when it could not be stat'ed. */
    ownerUid: number | null;
    ownerGid: number | null;
    path: string;
}

/**
 * "Give the folder to the process." Emitted only when both uids are known —
 * a `chown` with a guessed uid is worse than no command at all.
 */
export function buildChownCommand(facts: OwnershipFacts): string | null {
    if (facts.processUid === null || facts.processGid === null) return null;
    return `sudo chown -R -- ${facts.processUid}:${facts.processGid} ${quotePath(facts.path)}`;
}

/**
 * "Let everyone read it." The `a+rX` capital X sets the execute (traverse) bit
 * on DIRECTORIES ONLY — a lowercase `x` would mark every video file executable.
 */
export function buildChmodCommand(facts: OwnershipFacts): string {
    return `sudo chmod -R -- a+rX ${quotePath(facts.path)}`;
}

/**
 * "Give the process to the folder." Docker Compose fragment using the folder's
 * REAL owner, so the operator does not have to look it up. Null when the
 * directory could not be stat'ed — there is no honest number to put here.
 */
export function buildComposeUserFragment(
    facts: OwnershipFacts,
    serviceName = 'lumastra',
): string | null {
    if (facts.ownerUid === null || facts.ownerGid === null) return null;
    return [
        'services:',
        `    ${serviceName}:`,
        `        user: "${facts.ownerUid}:${facts.ownerGid}"`,
    ].join('\n');
}

/** `ls -ld` on the failing path — what the operator will be asked for anyway. */
export function buildInspectCommand(path: string): string {
    return `ls -ld -- ${quotePath(path)}`;
}

/** Render stat mode bits as the 4-digit octal string a chmod would take. */
export function formatMode(mode: number): string {
    return (mode & 0o7777).toString(8).padStart(4, '0');
}
