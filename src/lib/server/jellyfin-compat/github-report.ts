// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds the redacted GitHub report for a /j-sourced diagnostic. Allowlist
 * projection: only the fields named below leave the server's admin UI, ids are
 * replaced by per-server HMAC tags, free text is scrubbed of tokens, emails,
 * IPs, URL hosts, `host:port` tokens and the server's own host names. Titles,
 * user names and paths inside a log excerpt are NOT reliably removed — the admin
 * reviews the excerpt before posting. Nothing is sent anywhere — the admin's browser opens the
 * prefilled issue and the admin attaches the downloaded file.
 */
import { createHmac } from 'node:crypto';
import { scrubText } from '$lib/server/services/client-diagnostics/redact';
import {
    isJellyfinReportable,
    type GithubReport,
    type GithubReportInput,
} from '$lib/server/compat/jellyfin-report-provider';

export type { GithubReport };

export const GITHUB_REPO_URL = 'https://github.com/Sapd/lumastra';
export const ISSUE_URL_MAX = 8000;
const LOG_LINES = 200;

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Full 8-group form, or a compressed form containing `::` (::1, fe80::1, ...).
// Group counts are explicitly bounded so a long colon run cannot backtrack
// quadratically; plain `12:34:56` timestamps have neither form and survive.
const H = '[0-9a-f]{1,4}';
const IPV6_FULL = new RegExp(`(?<![\\w:])(?:${H}:){7}${H}(?![\\w:])`, 'gi');
const IPV6_COMPRESSED = new RegExp(
    `(?<![\\w:])(?:${H}(?::${H}){0,6})?::(?:${H}(?::${H}){0,6})?(?![\\w:])`,
    'gi',
);
// Any scheme (http, https, ws, wss, ...): keep the scheme, drop the host.
const URL_HOST = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s@]*@)?(?:\[[^\]\s]*\]|[^/\s:'"?#]+)/gi;
// Jellyfin/Emby auth header parameter list: MediaBrowser Client="..", Device="..", Token=".."
const AUTH_PARAM_LIST =
    /\b(MediaBrowser|Emby)\s+(?:[A-Za-z]+\s*=\s*(?:"[^"]*"|[^,\s]*)\s*,?\s*)+/gi;
const SENSITIVE_PAIR =
    /\b(Token|DeviceId|Device|UserId|User|ApiKey|Pw|Password)\s*=\s*(?:"[^"]*"|[^,\s&]+)/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32}\b/gi;
const LINE_CAP = 2000;
// `<host>:<port>` without a scheme (`media.example.org:8096`, `localhost:8096`). Not
// after `(`, `.` or `/` and not a source-file "extension", so stack frames such as
// `(PlaybackController.kt:412)` survive. No bare-domain rule: it would eat Java
// package names (`org.jellyfin.sdk.api.client`).
const HOST_PORT =
    /(?<![\w.(/@-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z][a-z0-9-]{0,62})|localhost):(\d{2,5})\b/gi;
const SOURCE_EXT = new Set([
    'kt',
    'kts',
    'java',
    'js',
    'mjs',
    'ts',
    'swift',
    'c',
    'cc',
    'cpp',
    'h',
    'hpp',
    'm',
    'mm',
    'py',
    'rs',
    'go',
    'scala',
    'groovy',
    'dart',
    'cs',
    'xml',
    'json',
]);
// OkHttp / Java net messages: `failed to connect to jf.example.org/203.0.113.4 (port 8096)`,
// `Unable to resolve host "jf.example.org"`.
// Only when an address follows the slash (InetAddress.toString()), so prose like
// "go to settings/playback" survives.
const TO_HOST_SLASH =
    /(\bto\s+)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\/(?=\d{1,3}\.\d|\[?[0-9a-f]{0,4}:)/gi;
const RESOLVE_HOST = /(\bresolve host\s+")[^"\s]+"/gi;

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The server's own host names (public origin, Host header), anywhere in the text. */
function scrubOwnHosts(text: string, hosts: readonly string[]): string {
    let out = text;
    for (const raw of hosts) {
        const host = raw.trim().replace(/^\[|\]$/g, '');
        if (host.length < 4) continue;
        out = out.replace(
            new RegExp(`(?<![\\w.-])${escapeRe(host)}(?![\\w-]|\\.[\\w-])`, 'gi'),
            '[host]',
        );
    }
    return out;
}

export function idTag(secret: string, id: string): string {
    return createHmac('sha256', secret).update(id.toLowerCase()).digest('hex').slice(0, 8);
}

/**
 * `secret` turns raw item/user/device ids into the same HMAC tags used elsewhere in the
 * report; `hosts` are the server's own host names, removed wherever they appear.
 */
export function scrubForPublic(text: string, secret = '', hosts: readonly string[] = []): string {
    return scrubOwnHosts(
        scrubText(
            text.replace(AUTH_PARAM_LIST, '$1 [redacted]').replace(SENSITIVE_PAIR, '$1=[redacted]'),
        ),
        hosts,
    )
        .replace(URL_HOST, '$1[host]')
        .replace(HOST_PORT, (m, _host: string, tld: string | undefined, port: string) =>
            tld && SOURCE_EXT.has(tld.toLowerCase()) ? m : `[host]:${port}`,
        )
        .replace(TO_HOST_SLASH, '$1[host]/')
        .replace(RESOLVE_HOST, '$1[host]"')
        .replace(UUID, (id) => (secret ? idTag(secret, id) : '[id]'))
        .replace(IPV4, '[ip]')
        .replace(IPV6_FULL, '[ip]')
        .replace(IPV6_COMPRESSED, '[ip]');
}

/**
 * The log goes into a `render: text` field, i.e. a fenced block on a PUBLIC issue.
 * A run of backticks would close the fence and an `@name` would ping someone, so
 * both are replaced with look-alikes.
 */
function neutraliseForCodeBlock(text: string): string {
    return text.replace(/`{3,}/g, 'ʼʼʼ').replace(/@/g, '＠');
}

export const isReportable = isJellyfinReportable;

/** Cap, scrub and character-allowlist a client-supplied string (it ends up in a public issue). */
function makeStr(secret: string, hosts: readonly string[]) {
    return (v: unknown, max = 64): string | null =>
        typeof v === 'string'
            ? scrubForPublic(v.slice(0, max), secret, hosts).replace(/[^\w .+()\-/]/g, '_')
            : null;
}

function projectMisses(secret: string, hosts: readonly string[], misses: unknown): unknown[] {
    const str = makeStr(secret, hosts);
    if (!Array.isArray(misses)) return [];
    return misses.slice(0, 5).map((m) => {
        const r = (m ?? {}) as Record<string, unknown>;
        const shape = (r.shape ?? {}) as Record<string, unknown>;
        const streams = Array.isArray(shape.streams) ? shape.streams.slice(0, 24) : [];
        const violations = Array.isArray(r.violations) ? r.violations.slice(0, 10) : [];
        return {
            item: typeof r.itemId === 'string' ? idTag(secret, r.itemId) : null,
            container: str(shape.container, 24),
            streams: streams.map((s) => {
                const x = (s ?? {}) as Record<string, unknown>;
                return {
                    type: str(x.type, 16),
                    codec: str(x.codec, 24),
                    external: x.external === true,
                    text: x.text === true,
                };
            }),
            violations: violations.map((v) => {
                const x = (v ?? {}) as Record<string, unknown>;
                return {
                    pointer: str(x.pointer, 160),
                    property: str(x.property, 64),
                    kind: str(x.kind, 16),
                    versions: Array.isArray(x.versions)
                        ? x.versions
                              .slice(0, 8)
                              .map((s) => str(s, 16))
                              .filter((s): s is string => s !== null)
                        : [],
                };
            }),
        };
    });
}

export function buildGithubReport(input: GithubReportInput): GithubReport {
    const p = input.payload;
    const hosts = input.serverHosts ?? [];
    const str = makeStr(input.secret, hosts);
    const client = {
        name: str(p.clientName) ?? 'unknown',
        version: str(p.clientVersion) ?? str(input.appVersion, 32) ?? 'unknown',
    };
    const misses = projectMisses(input.secret, hosts, p.misses);
    const logExcerpt = input.logText
        ? neutraliseForCodeBlock(
              scrubForPublic(
                  input.logText
                      .split('\n', LOG_LINES)
                      .map((l) => (l.length > LINE_CAP ? `${l.slice(0, LINE_CAP)}…` : l))
                      .join('\n'),
                  input.secret,
                  hosts,
              ),
          )
        : null;
    const report: Record<string, unknown> = {
        serverVersion: input.serverVersion,
        kind: input.kind,
        reason: str(p.reason, 32),
        occurredAt: input.occurredAt,
        client,
        misses,
        ...(logExcerpt ? { logExcerpt } : {}),
    };
    const violationLines = (
        misses as {
            violations: { pointer: string; property: string; kind: string; versions: string[] }[];
        }[]
    )
        .flatMap((m) => m.violations)
        .map((v) => `- \`${v.pointer}\` ${v.kind} (SDK ${v.versions.join(', ')})`);
    const what =
        input.kind === 'compat_incident'
            ? `Lumastra answered PlaybackInfo, but the client never requested a stream (${misses.length} time(s)).`
            : 'The client uploaded a crash log (attached).';
    const markdown = [
        `**Client:** ${client.name} ${client.version}`,
        `**Lumastra:** ${input.serverVersion}`,
        `**What happened:** ${what}`,
        violationLines.length
            ? `**Spec violations found in our response:**\n${violationLines.join('\n')}`
            : '',
        '_Full redacted report attached as JSON._',
    ]
        .filter(Boolean)
        .join('\n\n');

    const base = new URL(`${GITHUB_REPO_URL}/issues/new`);
    base.searchParams.set('template', 'jellyfin-client.yml');
    base.searchParams.set(
        'title',
        `[/j] ${client.name} ${client.version}: ${input.kind === 'compat_incident' ? 'playback never starts' : 'crash'}`,
    );
    base.searchParams.set('version', input.serverVersion);
    base.searchParams.set('client', `${client.name} ${client.version}`);
    base.searchParams.set('what', what);
    base.searchParams.set('violations', violationLines.join('\n'));
    let logs = logExcerpt ?? '';
    const withLogs = (): string => {
        const u = new URL(base);
        if (logs) u.searchParams.set('logs', logs);
        return u.toString();
    };
    let issueUrl = withLogs();
    while (issueUrl.length > ISSUE_URL_MAX && logs.length > 0) {
        logs = logs.slice(0, Math.floor(logs.length * 0.7));
        issueUrl = withLogs();
    }
    if (issueUrl.length > ISSUE_URL_MAX) {
        base.searchParams.set('violations', violationLines.slice(0, 5).join('\n'));
        issueUrl = base.toString();
    }
    return { markdown, issueUrl, report };
}
