// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AGPL-core registry for the redacted GitHub-report builder of Jellyfin-client
 * diagnostics. The builder lives in the proprietary jellyfin-compat tree; the
 * core never imports it (license boundary, `scripts/check-license-boundary.mjs`).
 * The proprietary licensing init registers it here; without one registered the
 * admin endpoint answers 404 "not available in this build".
 */

export interface GithubReport {
    markdown: string;
    issueUrl: string;
    report: Record<string, unknown>;
}

export interface GithubReportInput {
    serverVersion: string;
    secret: string;
    kind: string;
    platform: string;
    appVersion: string | null;
    occurredAt: string;
    payload: Record<string, unknown>;
    logText?: string | null;
    /** The server's own host names (public origin, Host header): scrubbed from free text. */
    serverHosts?: string[];
}

export type JellyfinReportBuilder = (input: GithubReportInput) => GithubReport;

/** Only /j-sourced diagnostics may be reported (compat incidents, Jellyfin ClientLog uploads). */
export function isJellyfinReportable(row: {
    kind: string;
    payload: Record<string, unknown>;
}): boolean {
    return (
        row.kind === 'compat_incident' ||
        (row.kind === 'log_bundle' && row.payload?.source === 'jellyfin')
    );
}

let builder: JellyfinReportBuilder | null = null;

export function registerJellyfinReportBuilder(fn: JellyfinReportBuilder): void {
    builder = fn;
}

export function getJellyfinReportBuilder(): JellyfinReportBuilder | null {
    return builder;
}

export function __resetJellyfinReportBuilderForTests(): void {
    builder = null;
}
