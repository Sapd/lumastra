// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Redaction + GitHub-issue formatting for transcode failure events.
 *
 * Lives in $lib/shared — NOT in the Svelte page — so the copy buttons and these
 * tests execute the same code. Formatting logic inside a .svelte file is
 * unreachable from vitest and invisible to tsgo, so a redaction regression there
 * would ship green.
 *
 * Two passes, deliberately separate:
 *   • stripSecrets   — WRITE time. Protects the database, not just the clipboard.
 *   • redactPaths    — COPY time. Protects a public GitHub issue.
 */

/**
 * Query-parameter names whose VALUE is a credential. Matched case-insensitively.
 *
 * `username` is here because an Xtream Codes playlist URL is
 * `…/get.php?username=<u>&password=<p>` — the username half is a paid
 * subscriber identity, and leaving it while redacting the password still hands
 * a reader half the credential pair (security review 2026-09-12, C14).
 */
const SECRET_PARAMS = [
    'api_key',
    'apikey',
    'token',
    'x-emby-token',
    'x-mediabrowser-token',
    'stream_token',
    'grant',
    'password',
    'username',
];

const SECRET_RE = new RegExp(`\\b(${SECRET_PARAMS.join('|')})=([^&'"\\s]+)`, 'gi');

/**
 * Header names whose VALUE is a credential, matched in `name: value` form — this is
 * how ffmpeg's `-headers` argument (and any echoed request line) carries them, as
 * opposed to the `name=value` query-parameter form `SECRET_RE` handles. Includes
 * `authorization`, which is a header-only name (not a query parameter).
 */
const SECRET_HEADERS = [...SECRET_PARAMS, 'authorization'];
const SECRET_HEADER_RE = new RegExp(
    `\\b(${SECRET_HEADERS.join('|')})\\s*:\\s*([^\\r\\n'"]+)`,
    'gi',
);

/** A JWT-shaped token (base64url header.payload.signature) wherever it appears —
 *  including a bearer token embedded as a URL PATH segment rather than a query
 *  parameter or header, which neither `SECRET_RE` nor `SECRET_HEADER_RE` can catch. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/**
 * `scheme://user:pass@host` — a credential carried as URL USERINFO.
 *
 * Neither `SECRET_RE` (query parameters) nor `SECRET_HEADER_RE` (headers) can
 * see this shape: the parameter name is positional, not spelled out. It reaches
 * output for real — an `*URL` setting configured as
 * `http://admin:hunter2@10.0.0.5:8989` is echoed verbatim by ffmpeg into its
 * stderr, and appears in any config dump. The userinfo is replaced wholesale
 * (username included) because the username half is identity.
 */
// Scheme bounded ({0,31}) so a long alnum run without `://` is not rescanned from every
// start position (quadratic; a 200k-char log line stalled the event loop for ~20 s).
const URL_USERINFO_RE = /([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/)[^/@\s'"]+@/g;

/**
 * Xtream Codes stream URLs carry the subscriber's username and password as PATH
 * SEGMENTS — `http://host/live/<user>/<pass>/<streamId>.ts` (also `movie`,
 * `series`, `timeshift`). The name is positional, so `SECRET_RE` (query
 * parameters), `SECRET_HEADER_RE` (headers) and `URL_USERINFO_RE` (userinfo) all
 * miss it, and FFmpeg echoes its input URL verbatim into stderr — which is
 * exactly what a Live TV failure event stores. Security review 2026-09-12, C14.
 *
 * The lookahead requires a further `/`, so only the two segments that precede the
 * stream id are replaced. A filesystem path that happens to contain a `/movie/`
 * or `/series/` directory loses two of its segments in raw mode; that is cosmetic
 * and deliberately preferred over leaking a live subscription.
 */
const XTREAM_PATH_RE = /\/(live|movie|series|timeshift)\/[^/\s'"]+\/[^/\s'"]+(?=\/)/gi;

/** Replace credential query-parameter values, header values, URL userinfo,
 *  Xtream path-form credentials, and JWT-shaped tokens wherever they appear in
 *  free text. */
export function stripSecrets(text: string): string {
    return text
        .replace(SECRET_RE, (_m, key: string) => `${key}=<redacted>`)
        .replace(SECRET_HEADER_RE, (_m, key: string) => `${key}: <redacted>`)
        .replace(URL_USERINFO_RE, (_m, scheme: string) => `${scheme}<redacted>@`)
        .replace(XTREAM_PATH_RE, (_m, kind: string) => `/${kind}/<redacted>/<redacted>`)
        .replace(JWT_RE, '<redacted>');
}

/**
 * OBJECT-KEY credential names, matched structurally rather than by text shape.
 *
 * `stripSecrets` is regex-over-text and only understands ffmpeg's two wire
 * shapes: `name=value` (query parameter) and `name: value` (unquoted header).
 * `JSON.stringify` emits `"name": "value"` — which matches NEITHER, because the
 * quote before the colon breaks the header pattern and the closing quote is
 * excluded from its value class. So a credential sitting in a serialized object
 * (e.g. a plugin's `.passthrough()` task input) survives `stripSecrets`
 * completely and rides into a report that promises redaction.
 *
 * Matching is on a NORMALIZED key (lowercased, non-alphanumerics dropped) so
 * `apiKey`, `api_key`, `API-KEY` and `x-emby-token` all collapse onto the same
 * needles. Substring matching catches the camelCase compounds plugin authors
 * actually write (`webhookSecret`, `accessToken`, `clientSecret`).
 *
 * `auth` is deliberately NOT a needle — it would swallow `author`/`authorized`,
 * which are ordinary metadata fields.
 */
const SECRET_KEY_NEEDLES = [
    'apikey',
    'token',
    'secret',
    'password',
    'passwd',
    'passphrase',
    'authorization',
    'credential',
    'privatekey',
    'accesskey',
];

/** True when an object key's NAME implies its value is a credential. */
export function isSecretKey(key: string): boolean {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return SECRET_KEY_NEEDLES.some((needle) => normalized.includes(needle));
}

/**
 * Deep-copy `value`, replacing every property whose KEY looks like a credential
 * with `<redacted>`. Applied BEFORE `JSON.stringify`, because after
 * serialization the credential is just quoted text that `stripSecrets` cannot
 * recognise (see {@link SECRET_KEY_NEEDLES}).
 *
 * Non-plain objects (Date, Map, class instances) are returned untouched —
 * walking their entries would flatten a `Date` into `{}` and corrupt the report.
 * A cycle is returned by reference on revisit, so the caller's
 * `JSON.stringify` still throws on it exactly as it did on the original.
 */
export function redactSecretKeys(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (Array.isArray(value)) {
        if (seen.has(value)) return value;
        seen.add(value);
        return value.map((entry) => redactSecretKeys(entry, seen));
    }
    if (typeof value !== 'object' || value === null) return value;
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    if (seen.has(value)) return value;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = isSecretKey(key) ? '<redacted>' : redactSecretKeys(entry, seen);
    }
    return out;
}

/** Element-wise {@link stripSecrets}; never adds or drops argv elements. */
export function stripSecretsFromArgv(argv: string[]): string[] {
    return argv.map((a) => stripSecrets(a));
}

export interface RedactOptions {
    /** Configured media library roots, e.g. ['/data/movies', '/data/series']. */
    libraryRoots: string[];
    /** Transcode working directory root, e.g. '/tmp/transcode'. */
    transcodeRoot?: string;
    /**
     * The input is unquoted free text (e.g. a DB-sourced error message) rather
     * than ffmpeg's quoted `Opening '…'` diagnostic shape. When set, a match
     * runs through embedded `'`/`"` characters instead of stopping at them —
     * without this, a real filename containing an apostrophe (very common in
     * artist/album/movie titles, e.g. "Guns N' Roses") truncates the match
     * early and leaks the remainder of the path verbatim.
     */
    unquoted?: boolean;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace absolute paths under any library root or the transcode root.
 *
 * Deliberately root-based rather than "the input path": concat-demuxer sessions
 * pass a LIST file as the input, and FFmpeg then prints `Opening '<member>'` for
 * every real media file behind it. Those members are neither the input path nor
 * the output dir, so a single-path rule leaks them.
 *
 * A match runs to the next quote OR THE END OF THE LINE. Paths may contain
 * spaces, so whitespace cannot terminate the match — but a newline can never be
 * part of one, and stopping there keeps an UNQUOTED path (the common shape in
 * DB-sourced free text, as opposed to ffmpeg's quoted `Opening '…'`) from
 * swallowing every following line into a single `<media>/<redacted>` blob.
 */
/**
 * Title metadata FFmpeg echoes from the container, redacted for github mode.
 *
 * `redactPaths` only removes the file PATH — but ffmpeg's `-i` dump reprints the
 * container's own metadata, and those titles carry identity the path redaction
 * promised to remove:
 *   Chapter #0:0: start 0.000000, end 15.000000
 *     Metadata:
 *       title           : Kapitel 01          ← chapter names (often plot spoilers)
 *   Stream #0:0: Video: av1 ...
 *     Metadata:
 *       title           : WOTT                ← release-group / scene tag
 * Chapter titles in particular are frequently episode- or scene-descriptive, so a
 * "redacted" report could still identify the exact release. Only the VALUE is
 * replaced — the surrounding structure stays intact so the dump is still readable
 * and the stream/chapter layout (the part that matters for triage) survives.
 *
 * Deliberately narrow: matches ffmpeg's indented `key : value` metadata shape for
 * title-ish keys only, so codec/resolution/bitrate lines are untouched.
 */
const METADATA_TITLE_RE =
    /^(\s*)(title|comment|description|synopsis|album|artist|show|episode_id)(\s*:\s*).+(?:\n\s*:.*)*$/gim;

export function redactTitleMetadata(text: string): string {
    // The trailing `(?:\n\s*:.*)*` swallows CONTINUATION lines. ffmpeg prints an
    // embedded newline as a keyless `<indent>: <rest>` line, so a key-anchored match
    // alone redacts only the FIRST line and ships the remainder verbatim:
    //     description     : <redacted>
    //                     : ...and the rest of the plot synopsis, in the clear
    // That is precisely the leak this function exists to prevent, on the values
    // (plot summaries, release notes) most likely to be long enough to wrap.
    return text.replace(
        METADATA_TITLE_RE,
        (_m, indent: string, key: string, sep: string) => `${indent}${key}${sep}<redacted>`,
    );
}

export function redactPaths(text: string, opts: RedactOptions): string {
    let out = text;
    const stopClass = opts.unquoted ? `[^\\r\\n]*` : `[^'"\\r\\n]*`;

    for (const root of opts.libraryRoots) {
        const re = new RegExp(`${escapeRe(root)}${stopClass}`, 'g');
        out = out.replace(re, (match) => {
            const dot = match.lastIndexOf('.');
            const ext = dot > match.lastIndexOf('/') ? match.slice(dot) : '';
            return `<media>/<redacted>${ext}`;
        });
    }

    if (opts.transcodeRoot) {
        const re = new RegExp(`${escapeRe(opts.transcodeRoot)}${stopClass}`, 'g');
        out = out.replace(re, '<outdir>');
    }

    return out;
}

export interface FailureReportInput {
    category: string;
    summary: string;
    outcome: 'retried' | 'bridged' | 'learned' | 'failed' | 'killed' | 'spawn_failed';
    exitCode: number | null;
    encoder: string | null;
    hwaccel: string | null;
    argv: string[];
    stderrTail: string;
    source: Record<string, unknown>;
    decision: Record<string, unknown>;
    env: Record<string, unknown>;
    probeDump?: string | null;
    username?: string | null;
    ipAddress?: string | null;
    roots: RedactOptions;
}

function fence(lang: string, body: string): string {
    return `\`\`\`${lang}\n${body}\n\`\`\``;
}

/**
 * Render a failure as Markdown ready to paste into a GitHub issue.
 *
 * `github` mode redacts both credentials and paths (identity). `raw` keeps paths for the
 * operator's own use, but still redacts credentials everywhere (they are removed from
 * storage at write-time, so this is a defensive layer to ensure they never reach output).
 * Username and IP are dropped only in github mode.
 */
export function formatFailureReport(input: FailureReportInput, mode: 'github' | 'raw'): string {
    // Two-pass redaction: always strip secrets first (both modes), then redact paths if github.
    const sanitizeText = (t: string): string => {
        const noSecrets = stripSecrets(t);
        // github mode additionally drops identity: the path AND the container's own
        // title metadata (chapter names, release tags) that ffmpeg reprints verbatim.
        return mode === 'github'
            ? redactTitleMetadata(redactPaths(noSecrets, input.roots))
            : noSecrets;
    };

    // Redact argv element-wise before joining to prevent regex from crossing element boundaries.
    const cleanArgv = stripSecretsFromArgv(input.argv);
    const redactedArgv = cleanArgv.map((elem) =>
        mode === 'github' ? redactPaths(elem, input.roots) : elem,
    );
    const argvBlock = input.argv.length === 0 ? '(args unavailable)' : redactedArgv.join(' ');

    const sections = [
        `### Transcode failure — \`${input.category}\``,
        '',
        `**Summary:** ${sanitizeText(input.summary)}`,
        '',
        `| | |`,
        `|---|---|`,
        `| Outcome | \`${input.outcome}\` |`,
        `| Exit code | \`${input.exitCode ?? 'n/a'}\` |`,
        `| Encoder | \`${input.encoder ?? 'n/a'}\` |`,
        `| Hwaccel | \`${input.hwaccel ?? 'n/a'}\` |`,
        '',
        '**FFmpeg command**',
        fence('bash', argvBlock),
        '',
        '**FFmpeg stderr**',
        fence('', sanitizeText(input.stderrTail)),
        '',
        '**Source stream**',
        fence('json', sanitizeText(JSON.stringify(input.source, null, 2))),
        '',
        '**Transcode decision**',
        fence('json', sanitizeText(JSON.stringify(input.decision, null, 2))),
        '',
        '**Environment**',
        fence('json', sanitizeText(JSON.stringify(input.env, null, 2))),
    ];

    if (input.probeDump) {
        sections.push('', '**ffmpeg -i (source)**', fence('', sanitizeText(input.probeDump)));
    }

    if (mode === 'raw' && (input.username || input.ipAddress)) {
        sections.push('', `_session: ${input.username ?? '?'} @ ${input.ipAddress ?? '?'}_`);
    }

    return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Page-level export: the incident table, or one expanded incident
// ---------------------------------------------------------------------------

/** Flatten to one line and neutralize the column separator so a noisy value
 *  cannot shred the Markdown table it lives in. */
function tableCell(text: string): string {
    return text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\|/g, '\\|');
}

export interface TranscodeIncidentsReportInput {
    /** Which tab the operator is on — the incident rows carry no outcome themselves. */
    outcome: 'failed' | 'recovered';
    /** Active `?encoder=` filter, so a filtered copy says it is one. */
    encoderFilter?: string | null;
    /** The rows currently on screen (already encoder-filtered). */
    incidents: TranscodeIncidentRow[];
    /**
     * The expanded incident, with whatever the page has loaded for it so far:
     * its per-session breakdown and, when a session drawer is open, that
     * session's attempt chain. When set, the report is about THIS incident
     * rather than the table.
     */
    selected?: {
        incident: TranscodeIncidentRow;
        sessions: TranscodeIncidentSessionRow[];
        attempts: TranscodeFailureAttemptRow[];
    } | null;
    roots: RedactOptions;
}

/** Structural mirrors of the `$lib/schemas/api-transcode-failures` DTOs —
 *  declared here so this module stays free of a schema import, exactly like
 *  {@link FailureReportInput} above. */
export interface TranscodeIncidentRow {
    category: string;
    encoder: string | null;
    occurrences: number;
    distinctFiles: number;
    distinctSessions: number;
    firstSeen: string;
    lastSeen: string;
}

export interface TranscodeIncidentSessionRow {
    attemptCount: number;
    firstSeen: string;
    lastSeen: string;
    terminalOutcome: FailureReportInput['outcome'] | null;
}

export interface TranscodeFailureAttemptRow {
    category: string;
    summary: string | null;
    outcome: FailureReportInput['outcome'];
    exitCode: number | null;
    encoder: string | null;
    hwaccel: string | null;
    argv: string[];
    stderrTail: string | null;
    source: Record<string, unknown> | null;
    decision: Record<string, unknown> | null;
    env: Record<string, unknown> | null;
    probeDump: string | null;
}

/**
 * Render the transcode-failures PAGE for a GitHub issue: the visible incident
 * table, or — when an incident is expanded — that incident's counts, its
 * session breakdown and, if a session drawer is open, the full FFmpeg detail
 * of that session via {@link formatFailureReport} in github mode.
 *
 * github mode only: this is the page's "Copy for GitHub" button. Media
 * titles, file ids and play-session ids from the session list are omitted
 * (they are identity), and every free-text field of the attempt chain goes
 * through the same credential + path + title-metadata redaction as the
 * drawer's own button.
 */
export function formatTranscodeIncidentsReport(input: TranscodeIncidentsReportInput): string {
    const scope = `${input.outcome} tab${
        input.encoderFilter ? `, encoder \`${tableCell(input.encoderFilter)}\`` : ''
    }`;
    const banner = `_Copied from Admin → System → Transcode failures (${scope}). Credentials, filesystem paths and media identity are redacted — intended to be pasted into a public issue._`;

    const selected = input.selected ?? null;
    if (selected === null) {
        const n = input.incidents.length;
        const lines = [
            `### Transcode failures — ${input.outcome} (${n} incident${n === 1 ? '' : 's'})`,
            '',
            banner,
            '',
        ];
        if (n === 0) {
            lines.push('_No incidents recorded._');
            return lines.join('\n');
        }
        lines.push(
            '| Category | Encoder | Occurrences | Distinct files | Distinct sessions | First seen | Last seen |',
            '| --- | --- | --- | --- | --- | --- | --- |',
            ...input.incidents.map(
                (i) =>
                    `| \`${tableCell(i.category)}\` | \`${tableCell(i.encoder ?? 'software')}\` | ${i.occurrences} | ${i.distinctFiles} | ${i.distinctSessions} | ${tableCell(i.firstSeen)} | ${tableCell(i.lastSeen)} |`,
            ),
        );
        return lines.join('\n');
    }

    const { incident, sessions, attempts } = selected;
    const lines = [
        `### Transcode failure — \`${tableCell(incident.category)}\` on \`${tableCell(incident.encoder ?? 'software')}\` (${input.outcome})`,
        '',
        banner,
        '',
        '| Field | Value |',
        '| --- | --- |',
        `| Occurrences | ${incident.occurrences} |`,
        `| Distinct files | ${incident.distinctFiles} |`,
        `| Distinct sessions | ${incident.distinctSessions} |`,
        `| First seen | ${tableCell(incident.firstSeen)} |`,
        `| Last seen | ${tableCell(incident.lastSeen)} |`,
    ];

    if (sessions.length > 0) {
        lines.push(
            '',
            `**Sessions (${sessions.length})** — media titles and ids omitted`,
            '',
            '| # | Attempts in incident | Terminal outcome | First seen | Last seen |',
            '| --- | --- | --- | --- | --- |',
            ...sessions.map(
                (s, idx) =>
                    `| ${idx + 1} | ${s.attemptCount} | ${
                        s.terminalOutcome
                            ? `\`${s.terminalOutcome}\``
                            : '_(none — chain ends on a retry)_'
                    } | ${tableCell(s.firstSeen)} | ${tableCell(s.lastSeen)} |`,
            ),
        );
    }

    if (attempts.length > 0) {
        lines.push(
            '',
            `**FFmpeg detail** — one session, ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`,
            '',
            attempts
                .map((a) =>
                    formatFailureReport(
                        {
                            category: a.category,
                            summary: a.summary ?? '(no summary)',
                            outcome: a.outcome,
                            exitCode: a.exitCode,
                            encoder: a.encoder,
                            hwaccel: a.hwaccel,
                            argv: a.argv,
                            stderrTail: a.stderrTail ?? '',
                            source: a.source ?? {},
                            decision: a.decision ?? {},
                            env: a.env ?? {},
                            probeDump: a.probeDump,
                            roots: input.roots,
                        },
                        'github',
                    ),
                )
                .join('\n\n---\n\n'),
        );
    } else {
        lines.push(
            '',
            '_Open one of the sessions on the page before copying to include its FFmpeg command, stderr and source probe._',
        );
    }

    return lines.join('\n');
}
