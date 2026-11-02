// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Operator-copy guard (admin IA redesign, spec §5/§7/§9).
 *
 * "One vocabulary": raw internal stage/task ids (`tp-gen`, `media-probe-a`, …)
 * must never leak into operator-facing admin text — friendly names only
 * (`$lib/config/pipeline-step-names.ts`, `$lib/utils/admin/task-descriptions.ts`).
 * Raw ids are fine on Developer surfaces (`/admin/developer/**` routes), which
 * are explicitly styled/gated as dev-only (spec §3.7) — this check does not
 * touch them.
 *
 * What it does:
 *   1. Scans every value in `messages/en.json` + `messages/de.json` for a
 *      known offending id (STAGE ids duplicated from `pipeline-step-names.ts`
 *      — keep in sync, same pattern as `STAGE_APPLIES_TO`'s own doc comment —
 *      plus literal legacy offenders named in the design spec §1).
 *   2. For every hit, greps the source tree for the message KEY to find where
 *      it's actually rendered, and only fails the build when at least one
 *      usage site is an OPERATOR admin surface: under `src/routes/admin/**`
 *      or `src/lib/components/admin/**`, excluding anything under a
 *      `/developer/` path segment (spec §3.7's whole area) and a short list
 *      of known dev-tab-only key prefixes (the task Definition tab, the
 *      Developer → Registry page).
 *   3. A hit with NO admin usage (e.g. main-app UI like `/music/map`, which
 *      is explicitly out of scope for this redesign — spec §8) is reported
 *      as informational only and does not fail the check.
 *
 * This is a scoped, string-matching heuristic (not a full static-usage
 * analysis) — it catches the specific "raw id embedded in operator prose"
 * class of bug the spec calls out, not every conceivable wording issue.
 *
 * Run: `node scripts/check-operator-copy.mjs` (wired as `npm run lint:copy`).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

// Duplicated from `src/lib/config/pipeline-step-names.ts`'s `KNOWN_PIPELINE_STEP_IDS`
// (itself a mirror of `STAGE_APPLIES_TO` in `ingest-map.constants.ts`) — keep these
// three lists in sync when a new pipeline stage id is registered.
const STAGE_IDS = [
    'media-probe-a',
    'media-probe-b',
    'tmdb-metadata-sync',
    'series-sync',
    'library-embeddings',
    'discovery-embeddings',
    'image-sync',
    'trickplay-params-sync',
    'trickplay-generation',
    'mdblist-sync',
    'lumastra-intro-analyzer',
    'music-analysis',
    'album-enrichment',
    'artist-enrichment',
    'music-embedding-generation',
    'sonic-embedding-backfill',
    'music-popularity',
    'chapter-sync',
    'fribb-anime-sync',
    'mal-anime-id-enrichment',
    'metadata-update',
    'integrity-file-present',
    // Present in STAGE_APPLIES_TO but absent from this list until now, so a raw
    // provider-artwork id embedded in operator prose went unflagged. They now
    // have friendly names in pipeline-step-names.ts; keep them guarded too.
    'provider-artwork-poster',
    'provider-artwork-backdrop',
    'provider-artwork-logo',
    'provider-artwork-thumb',
    'provider-artwork-season-poster',
];

// Literal legacy offenders named directly in the design spec (§1) that predate/
// sit outside the pipeline-step-names.ts map (e.g. old Metro Map station labels).
const LITERAL_OFFENDERS = ['tp-gen'];

const OFFENDER_IDS = [...new Set([...STAGE_IDS, ...LITERAL_OFFENDERS])];

// Message keys that are legitimately dev-only content co-located inside a file
// that also has operator-facing tabs (e.g. the task DetailPanel's Definition
// tab lives in the same component as its operator Overview/Runs/etc tabs) —
// excluded by key prefix since path-based scoping can't separate them.
const DEV_KEY_PREFIXES = [
    'admin_task_definition',
    'admin_task_notes',
    'admin_registry_',
    'task_def_',
];

const isDevKey = (key) =>
    DEV_KEY_PREFIXES.some((p) => key.startsWith(p)) || key.includes('_developer_');

/** Word-boundary-ish containment check: id must not be glued to more id chars. */
function containsOffenderId(value) {
    const low = value.toLowerCase();
    for (const id of OFFENDER_IDS) {
        let idx = low.indexOf(id);
        while (idx !== -1) {
            const before = idx > 0 ? low[idx - 1] : '';
            const after = idx + id.length < low.length ? low[idx + id.length] : '';
            const glued = (c) => /[a-z0-9_-]/.test(c);
            if (!glued(before) && !glued(after)) return id;
            idx = low.indexOf(id, idx + 1);
        }
    }
    return null;
}

// --- jargon check (§2 "the rename table") --------------------------------
//
// A second class of leak: words that are correct *internally* and meaningless
// to a self-hoster. Same enforcement shape as the raw-id check above — flag a
// message only when it is actually rendered on an operator admin surface —
// with two extra exemptions this rule needs and the id rule does not.
//
// `instead` is the replacement the design spec's rename table prescribes; it
// is printed with the failure so the fix is a lookup, not a debate.
const JARGON_TERMS = [
    {
        re: /\bcoverage\b/i,
        term: 'coverage',
        instead: 'the remainder — "1,243 movies still need artwork"',
    },
    {
        re: /circuit[\s-]?breaker/i,
        term: 'circuit breaker',
        instead: '"Paused after repeated failures"; badge "Paused"',
    },
    { re: /dead[\s-]?letter/i, term: 'dead letter', instead: '"Gave up"' },
    {
        re: /\bsystemic\b/i,
        term: 'systemic',
        instead: 'one Problem card naming the cause and how many tasks it hit',
    },
    {
        re: /\bkillswitch(es)?\b/i,
        term: 'killswitch',
        instead: 'an "Enabled" toggle; state "Turned off"',
    },
    {
        re: /back[\s-]?pressure/i,
        term: 'backpressure',
        instead: '"Slowing down to protect the server"',
    },
    { re: /\breconciler\b/i, term: 'reconciler', instead: 'never shown; if forced, "Self-check"' },
    { re: /\bidempoten\w*/i, term: 'idempoten*', instead: 'never shown' },
    { re: /\benqueue\w*|\benqueued\b/i, term: 'enqueue', instead: '"Queue up" / "Start"' },
    { re: /\binvariants?\b/i, term: 'invariant', instead: '"Consistency check"' },
    { re: /\bthroughput\b/i, term: 'throughput', instead: 'a unit — "about 180 episodes/hour"' },
    {
        re: /leader[\s-]?lock/i,
        term: 'leader lock',
        instead: 'never shown; "This server is in charge of background work"',
    },
    { re: /half[\s_-]?open/i, term: 'half-open', instead: '"Trying again"' },
];

// Surfaces where these words are the *subject*, not the chrome:
//   - the glossary exists to define them;
//   - the help pages exist to teach them ("Developers call this the …");
//   - `admin_task_auto_pause_aka` / `_tooltip` are the rename table's own
//     prescribed pattern — friendly name in the UI, internal term kept as a
//     greyed parenthetical so it stays googleable.
// Nothing else is exempt by prefix; `isDevKey` (above) still applies too.
// admin_nav_kw_*: admin-search synonyms (src/routes/admin/**/search-meta.ts). They are
// matched against what an admin types and never rendered, so they deliberately include
// the words people search with, internal ones too ("coverage" finds the pipeline page).
const JARGON_EXEMPT_KEY_PREFIXES = [
    'admin_glossary_',
    'admin_help_',
    'admin_task_auto_pause',
    'admin_nav_kw_',
];

// Copy that predates this rule and lives in messages this check cannot fix on
// its own — every one of them is real debt with a prescribed replacement in
// the rename table, not a false positive. They are warned about, not failed,
// so the guard is a ratchet: no NEW jargon can land.
//
// DO NOT ADD TO THIS LIST. Fix the copy instead; a rename here is one string.
const KNOWN_JARGON_DEBT = new Set([
    // DRAINED 2026-09-23. All 14 entries were rewritten per the rename table:
    // "enqueue" -> "Queue up"/"Start", "coverage" -> the remainder rather than
    // the ratio, "throughput" -> a plain speed with its unit, "invariant" ->
    // "consistency check", "killswitch" -> an on/off switch. The German copy
    // was rewritten alongside it (and de's "Run now" quote corrected to the
    // actual button label, "Jetzt ausfuehren").
    //
    // Keep this set EMPTY. It exists only so an entry can be parked with a
    // deliberate decision behind it; anything added here stops failing the
    // build, which is the whole reason the list had grown to 14.
]);

const isJargonExemptKey = (key) =>
    isDevKey(key) || JARGON_EXEMPT_KEY_PREFIXES.some((p) => key.startsWith(p));

function containsJargon(value) {
    for (const entry of JARGON_TERMS) {
        if (entry.re.test(value)) return entry;
    }
    return null;
}

function loadMessages(locale) {
    const path = join(ROOT, 'messages', `${locale}.json`);
    return JSON.parse(readFileSync(path, 'utf8'));
}

// --- usage-site lookup (only run for the handful of actual id-hits) ---

function walkFiles(dir, out = []) {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.svelte-kit') continue;
        const abs = join(dir, name);
        const st = statSync(abs);
        if (st.isDirectory()) walkFiles(abs, out);
        // A key named in a test fixture is not a render site — the mocked key
        // lists in `run-error-display.test.ts` would otherwise make every
        // catalogue key look operator-rendered on their own.
        else if (/\.(ts|svelte|js)$/.test(name) && !/\.(test|spec)\.(ts|js)$/.test(name))
            out.push(abs);
    }
    return out;
}

const ADMIN_ROOTS = [
    join(ROOT, 'src/routes/admin'),
    join(ROOT, 'src/lib/components/admin'),
    // Operator copy is not only in routes/components: the curated run-error
    // catalogue (`run-error-display.ts`) picks its own sentences here, and its
    // whole point is that an admin reads them.
    join(ROOT, 'src/lib/utils/admin'),
];
const ALL_ADMIN_FILES = ADMIN_ROOTS.flatMap((r) => walkFiles(r));

/** Files (relative paths) that reference `key` as a Paraglide message id. */
function usageSites(key) {
    const re = new RegExp(`\\b${key}\\b`);
    const hits = [];
    for (const abs of ALL_ADMIN_FILES) {
        const rel = relative(ROOT, abs).split('\\').join('/');
        if (rel.includes('/developer/')) continue; // spec §3.7 — raw ids allowed there
        const code = readFileSync(abs, 'utf8');
        if (re.test(code)) hits.push(rel);
    }
    return hits;
}

// --- run ---

const en = loadMessages('en');
const de = loadMessages('de');

const failures = [];
const infoOnly = [];
const jargonFailures = [];
const jargonDebt = [];

for (const [locale, dict] of [
    ['en', en],
    ['de', de],
]) {
    for (const [key, value] of Object.entries(dict)) {
        if (typeof value !== 'string') continue;

        if (!isDevKey(key)) {
            const offenderId = containsOffenderId(value);
            if (offenderId) {
                const sites = usageSites(key);
                const entry = { locale, key, offenderId, value, sites };
                if (sites.length > 0) failures.push(entry);
                else infoOnly.push(entry);
            }
        }

        if (!isJargonExemptKey(key)) {
            const jargon = containsJargon(value);
            // Same scoping rule as the id check: a string nobody renders on an
            // operator admin surface is not operator copy.
            if (jargon && usageSites(key).length > 0) {
                const entry = { locale, key, jargon, value };
                if (KNOWN_JARGON_DEBT.has(key)) jargonDebt.push(entry);
                else jargonFailures.push(entry);
            }
        }
    }
}

if (infoOnly.length > 0) {
    console.log(
        `check-operator-copy: ${infoOnly.length} id-shaped match(es) outside admin usage (informational, not failing):`,
    );
    for (const f of infoOnly) {
        console.log(`  [${f.locale}] ${f.key} — contains "${f.offenderId}": ${f.value}`);
    }
    console.log('');
}

if (jargonDebt.length > 0) {
    const keys = [...new Set(jargonDebt.map((f) => f.key))];
    console.log(
        `check-operator-copy: ${keys.length} known jargon string(s) awaiting a copy pass ` +
            `(warning, not failing): ${keys.join(', ')}\n`,
    );
}

if (jargonFailures.length > 0) {
    console.error(
        'check-operator-copy: internal jargon found in operator-facing admin copy (spec §2):\n',
    );
    for (const f of jargonFailures) {
        console.error(`  [${f.locale}] ${f.key} — says "${f.jargon.term}"`);
        console.error(`    value: ${f.value}`);
        console.error(`    show instead: ${f.jargon.instead}`);
        console.error('');
    }
    console.error(
        'Fix: reword it. These terms exist to make the engine correct; a self-hoster has no\n' +
            'referent for them. If the word genuinely IS the subject (the glossary defines it, the\n' +
            'help page teaches it, or it is the greyed "(internal name)" parenthetical the rename\n' +
            'table prescribes), add its key prefix to JARGON_EXEMPT_KEY_PREFIXES above.',
    );
}

if (failures.length > 0) {
    console.error(
        'check-operator-copy: raw internal id(s) found in operator-facing admin copy (spec §5/§7):\n',
    );
    for (const f of failures) {
        console.error(`  [${f.locale}] ${f.key} — contains "${f.offenderId}"`);
        console.error(`    value: ${f.value}`);
        console.error(`    used in: ${f.sites.join(', ')}`);
        console.error('');
    }
    console.error(
        'Fix: replace the raw id with a friendly name (pipelineStepName()/taskDescription()) or plain prose.\n' +
            'If this string genuinely belongs to a Developer-only surface, move its usage under an\n' +
            '`/admin/developer/**` route/component, or add its key prefix to DEV_KEY_PREFIXES above.',
    );
}

if (failures.length > 0 || jargonFailures.length > 0) process.exit(1);

console.log(
    `check-operator-copy: OK — no raw internal ids in operator-facing admin copy (${
        Object.keys(en).length
    } en + ${Object.keys(de).length} de keys scanned).`,
);
