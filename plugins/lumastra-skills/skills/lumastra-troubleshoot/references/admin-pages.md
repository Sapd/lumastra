# Admin pages, tasks and client reports

These pages need an admin sign-in, so the person usually opens them and tells you
what they show. Ask for the text or a screenshot of the relevant part.

## Background tasks

Scanning, metadata, artwork, trickplay, music analysis and the other background work
run as tasks. A new library takes a while to process; slow progress at first is
normal. Guides: https://lumastra.org/guides/task-basics/,
https://lumastra.org/guides/task-monitoring/ and, with shell access,
https://lumastra.org/guides/task-troubleshooting/.

| Page                                           | Use it for                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| **Tasks → Overview** (`/admin/tasks`)          | Task health, failures grouped by error, backlog, schedules and settings       |
| **Tasks → Runs** (`/admin/tasks/runs`)         | Single runs with their logs and errors; cancel a run here                     |
| **Tasks → Pipeline** (`/admin/tasks/pipeline`) | Per-item processing stages and the stuck-items panel                          |
| **System → Health** (`/admin/system/health`)   | Worker liveness, components, findings; the Cluster tab on multi-node installs |
| **System → Cost** (`/admin/system/cost`)       | External API spend and task CPU time                                          |
| `/admin/help/tasks`                            | The field reference for the installed version                                 |

What to look for:

- A **circuit auto-pause** follows repeated failures and retries after 1, 5, 30 and
  120 minutes. A **schedule pause** is a setting someone turned on. They are
  independent.
- Many failures with the same error: fix the cause first, then use the task's
  **Retry pending** action.
- Backlog that doesn't drain and no recent completions: check worker liveness on
  the Health page. In a split setup the worker container must be running.
- The stuck-items panel lists runs active for more than 15 minutes, items with 3 or
  more attempts, and stages with pending items but no completions for 30 minutes.

The task-troubleshooting guide has recipes that use `psql` and `valkey-cli` and some
that change data. Treat each one as a change: show the person the commands and wait
for a yes. Never run `FLUSHDB` on Valkey and don't edit `task_history` by hand
unless a recipe says so for a known stuck row.

## Client problems (apps and browser)

The iPhone, iPad, Apple TV and web apps report crashes, hangs, JavaScript errors,
failed API calls and playback problems to the person's own server. Admins read them in
**Admin → Users → Client diagnostics** (`/admin/users/client-diagnostics`), filtered
by kind, platform, user, device, app version and time.

- In the Apple apps, the user opens **Settings → Send Diagnostics**. It uploads the
  app's log and shows a reference like `1557-17C4`.
- Error pages in the apps and the browser show a line starting with `REFERENCE:`.
- The search box on the Client diagnostics page finds a row by that reference or by
  the note the user wrote. The detail view shows the report; a log bundle can be
  downloaded.

So for a client problem: ask the user to reproduce it, then send diagnostics or note
the reference, and ask the admin to search for it. The reports are redacted on the
server before they are stored, but they can still name users, devices and media;
let the person decide what to share with you.

If a Send Diagnostics upload fails behind nginx, the proxy's body limit is below
3 MiB; see [reverse-proxy.md](reverse-proxy.md).

Server errors (HTTP 5xx) show a generic message in the UI on purpose. The details
are in `docker compose logs lumastra`, near the time of the report.

Playback-specific pages: **Admin → System → Transcode failures**
(`/admin/system/transcode-failures`) and **Admin → Fix → Playback keeps transcoding when it shouldn't**
(`/admin/fix/why-transcode`).

## Export diagnostics for a bug report

**Admin → System → Export diagnostics** (`/admin/system/diagnostics`) builds one
redacted report: version, environment, counts, configured providers, health findings,
FFmpeg and GPU capabilities, migrations, changed settings and recent failures. It can
be copied or downloaded as Markdown for an issue at
https://github.com/Sapd/lumastra/issues.

## Known limitations

When something looks broken, also check https://lumastra.org/reference/known-limitations/.
Points that often look like bugs:

- Lumastra is at v0.1. The Apple apps' version numbers (1.0.1) say nothing about
  maturity.
- `:edge` images are amd64 only; `:stable` is multi-arch.
- Browsing a large library is slow: poster requests, genre rows and A-Z browsing do
  more database work than they should. Timeouts are worth reporting; slowness alone
  is known.
- Several web replicas need playback requests for one session to reach the same
  replica. Round-robin load balancing breaks playback with `503` responses.
- Seeking far ahead in a slow (CPU or HDR-to-SDR on AMD) transcode can take
  10 to 20 seconds or fail.
- No Live TV recording. Watch Together can't be joined from iPhone or iPad.
- Media on S3 or other object storage is not picked up by the file watcher.
- An `uncaughtException` in the log leaves the process running; restart the
  container.
