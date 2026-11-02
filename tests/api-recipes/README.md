# Public API recipes

These are real third-party client journeys against the running preprod server. They import
only the public OpenAPI-generated `paths`, `openapi-fetch`, Vitest, and harness code here.
There are no application imports or app setup files. The spec's `servers` URL is an origin;
its paths already contain `/api/v1`, so the client base URL is the origin alone.

From the app directory:

```sh
npm install --save-dev openapi-fetch --legacy-peer-deps --package-lock-only --ignore-scripts
lumastra-remote --pull tests/api-recipes/generated/api-v1.d.ts 'npm run api-recipes:types'
lumastra-remote 'RECIPES_FORWARD_USER=sweepuser RECIPES_FORWARD_GROUPS=Users npm run test:api-recipes'
```

`RECIPES_BASE_URL` defaults to `http://127.0.0.1:3000`. Only loopback and
`preprod.warp10.cc` are permitted. The runner is on the same host as preprod. Never point
this suite at production. `RECIPES_TOKEN` can supply an existing bearer token; its owner
manages its lifetime. With no token, `RECIPES_FORWARD_USER` enables globalSetup login and
PAT revocation in teardown. Only `sweepuser` and `safetynet-admin` may mint harness PATs.
This is **test-harness login, a real third-party client uses the OAuth device flow**.
The internal token endpoint is the only non-spec operation. Tokens never go to logs or files.

Files run one at a time, with one worker and no concurrent tests. Discovery paginates series
and checks `hasFile` on episodes. Only an empty content discovery permits a skip; request
failures stay red. Recipe 05 repeats 04's flow so running it alone checks the same progress
contract without relying on file order. Progress cleanup uses the public continue-watching
DELETE. These test accounts are dedicated: playback/listening can change their history.

Live TV starts at most one channel. The start, manifest and keepalive share a 25-second
budget, with a separate 4-second leave request in `finally`, armed before start. A failed
leave is a test failure and needs operator attention; rerun only after confirming release.
The suite reads only the manifest, never its media segments.

Every recipe header names its rework owner. **A package that changes this area updates this
recipe in the same commit.** Regenerate types from the changed public YAML, update the
requests and assertions to the intended recipe, and run it remotely. Never import a server
schema or web-client helper to make a test pass. Real API failures stay red and belong in
the package's findings. `todayHandBuiltUrl()` is the single explicitly marked transitional
URL builder for music/audiobook delivery; packages 2/14 and 5/8 must replace it with response
URLs. Video reads the selected delivery URL from playback info after session start.

Current execution evidence and remaining blockers are in [../api-snapshots/VERIFICATION.md](../api-snapshots/VERIFICATION.md).
