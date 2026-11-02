# Implementation verification — 2026-10-16

Live verification is **blocked**, not passed. No request reached preprod and no PAT was minted.
No production requests, application-source edits, direct Git commands or OpenAPI regeneration
were performed. `lumastra-remote` itself uses a private Git-object snapshot internally;
that failed before SSH in this restricted worktree.

Commands and results:

| Command                                                                                                                         | Actual result                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install --save-dev openapi-fetch --legacy-peer-deps --package-lock-only --ignore-scripts`                                  | Failed: `ENOTFOUND registry.npmjs.org`.                                                                                                                                                         |
| Same install with `--offline`                                                                                                   | Failed: `ENOTCACHED`; this dependency is absent from the cache.                                                                                                                                 |
| `lumastra-remote --pull tests/api-recipes/generated/api-v1.d.ts 'npm run api-recipes:types'`                                    | Blocked at local sync: `unable to create temporary file: Operation not permitted`, failed to insert/index a file into the object database.                                                      |
| Existing main checkout's `node_modules/.bin/openapi-typescript docs/api/api-v1.yaml -o tests/api-recipes/generated/api-v1.d.ts` | Passed, openapi-typescript 7.13.0; generated from the public YAML only.                                                                                                                         |
| `lumastra-remote 'RECIPES_FORWARD_USER=sweepuser RECIPES_FORWARD_GROUPS=Users npm run test:api-recipes'`                        | Blocked by the same sync/object-database permission error, exit 128.                                                                                                                            |
| `lumastra-remote --pull tests/api-snapshots/data 'npm run api-snapshots:capture'`                                               | Blocked before server access, exit 128.                                                                                                                                                         |
| `lumastra-remote --pull tests/api-snapshots/data/compare-report.json 'npm run api-snapshots:compare'`                           | Blocked before server access, exit 128.                                                                                                                                                         |
| Single-process TypeScript parser over the 19 authored TS files                                                                  | Passed, zero syntax errors; this is not a typecheck.                                                                                                                                            |
| YAML operation inventory against authored `client.GET/POST/PUT/DELETE` calls                                                    | Passed: all 34 calls exist in the public spec, no `src/` or `$lib` imports.                                                                                                                     |
| Small Node assertion fixtures for redaction and semantic comparison                                                             | Passed: tokens, emails, usernames, IPv4/IPv6, filesystem paths; public URL preservation; prod target rejection; removed/added keys, reordered/empty arrays, media references and URL filtering. |
| `rg -n 'pat_                                                                                                                    | svc_                                                                                                                                                                                            | @   | api_key | denis' tests/api-snapshots/data` | Could not inspect live captures: data directory does not exist because capture never ran. Fixture redaction checks passed. |

`package.json` declares `openapi-fetch` and all five scripts. **The dependency lockfile update
is still pending** because the required install could not reach the registry. Do not use
`npm ci` expecting this new dependency to be locked until the install command succeeds.
No lockfile resolution/integrity or live snapshot data has been invented.

Recipe results:

| Recipe                  | Pass/fail/skip                |
| ----------------------- | ----------------------------- |
| 01 connect              | NOT RUN — remote sync blocked |
| 02 home                 | NOT RUN — remote sync blocked |
| 03 series/episode/image | NOT RUN — remote sync blocked |
| 04 episode playback     | NOT RUN — remote sync blocked |
| 05 resume               | NOT RUN — remote sync blocked |
| 06 album playback       | NOT RUN — remote sync blocked |
| 07 audiobook playback   | NOT RUN — remote sync blocked |
| 08 Live TV              | NOT RUN — remote sync blocked |
| 09 private watch party  | NOT RUN — remote sync blocked |

Static findings (not claims about live responses):

1. The spec's server URL is an origin while operation paths include `/api/v1`. Adding that
   prefix again to `createClient` would create invalid double-prefixed requests.
2. Video session start returns `{session_id, stream_token}`, with no delivery URL. Recipe 04
   obtains the selected response URL through playback info. Packages 8/5 own the additional
   round trip/start-result gap. It does not construct a video URL.
3. Music album tracks and session start expose no stream URL. Recipe 06 currently needs the
   single marked `todayHandBuiltUrl('track', id)` helper (packages 2/14/5).
4. Audiobook start returns track `ino`/codec metadata and a token, with no delivery URL.
   Recipe 07 currently needs `todayHandBuiltUrl('audiobook', id, ino)` (packages 5/8). A future
   transcode-only response lacking a usable URL will remain red rather than inventing a URL.
5. System health, client diagnostics list and API conformance have no public-spec GET in this
   YAML. They are explicit coverage gaps in the capture index, not undocumented internal calls.
6. API.md's high-level route tables and the YAML are not identical (for example watch-party
   teardown is documented as DELETE on the collection, but the YAML exposes event disband).
   Recipes follow the public YAML operations, including event-based disband.

No live API failure, response mismatch, or all-OK comparison can be claimed yet. After registry
and runner access are restored, run the README commands, inspect captures/redaction, fix harness
bugs, keep real API failures red, and replace this blocked evidence with actual results.
