# Watch history integration

`GET /api/v1/integrations/watch-history` gives an external recommender (for example, a chat
bot that suggests what to watch next) one user's watch history: what they watched recently,
their Continue Watching row, their top genres and a few counts. It is read-only.

Interactive reference: `/api-docs` on your server, tag **Integrations**.

## Credential

Only a **service token with the `integrations:read` grant** can read this endpoint. An
administrator creates it under **Admin → Users → API tokens → Service tokens**:

| Field       | Value                                                             |
| ----------- | ----------------------------------------------------------------- |
| Scope       | Integrations (read-only), `integrations:read`                     |
| Allowed IPs | Optional. The exact IPv4/IPv6 address the integration calls from. |

Or through the API, as an administrator:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name": "recommender", "scopes": ["integrations:read"]}' \
  "https://lumastra.example/api/v1/service-tokens"
```

`integrations:read` must be the token's only grant and cannot act as a user. The token works
only for `GET` on three endpoints, this one, `/api/v1/integrations/upcoming` and
`/api/v1/integrations/homepage`, and only while the administrator who created it is still an
administrator. No path binding is needed; allowed path prefixes, if you set them, must each be
one of those three paths and narrow the token further.

Send it as `Authorization: Bearer svc_…`.

Example call:

```bash
curl -s -H "Authorization: Bearer $LUMASTRA_TOKEN" \
  "https://lumastra.example/api/v1/integrations/watch-history?user=alice&limit=30" \
  | jq '.recentlyWatched.items[] | {type, title, year, lastWatchedAt}'
```

### Access rules

The endpoint returns these statuses:

| Caller                                                                                                    | Status                                     |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| No credential                                                                                             | 401                                        |
| An `integrations:read` token whose allowed paths do not cover this path                                   | 403 `Token not permitted on this endpoint` |
| Any session, any personal access token (including an admin's), a `read`, `write` or `admin` service token | 403                                        |
| An `integrations:read` token whose creator is no longer an administrator                                  | 403                                        |
| An `integrations:read` token                                                                              | 200                                        |

The restrictions exist because the response is another person's viewing history. The token
must be created for integrations alone, be revocable on its own, and be useless for anything
else if it leaks: on any other endpoint it gets 403 `Token not permitted on this endpoint`.
Each successful read is logged with the token id and the user whose history was read.

Tokens made the old way (an `admin` service token whose allowed paths were all among these
three endpoints) were converted to `integrations:read` by the update that introduced the grant.
A token bound to the whole `/api/v1/integrations` path was left as it was: create a new
`integrations:read` token for it.

A user reading their **own** history doesn't need this endpoint: the regular user endpoints
(`/api/v1/continue-watching`, …) serve it with their own sign-in.

## Request

```
GET /api/v1/integrations/watch-history?user=<username or UUID>&limit=50&days=180&cursor=<cursor>
```

| Parameter | Default | Meaning                                                                    |
| --------- | ------- | -------------------------------------------------------------------------- |
| `user`    | —       | Lumastra username or user UUID. Required.                                  |
| `limit`   | 50      | Page size of `recentlyWatched`, 1–200.                                     |
| `cursor`  | —       | `recentlyWatched.page.cursor` of the previous response, for the next page. |
| `days`    | 180     | Window for `topGenres` and the windowed counts, 1–3650.                    |

### Which username?

`user` is the **Lumastra** username, shown under **Admin → Users**:

- **Forward auth:** the identity header (`USERHEADER`, for example `X-Authentik-Username`),
  lowercased. The proxy username `Alice` is `alice` here.
- **OIDC sign-in:** the `preferred_username` claim (or the email local part), lowercased,
  with characters outside `a-z 0-9 . _ -` replaced by `-`. If that name was taken, Lumastra
  appends a suffix (for example, `alice-2`), so look up the user once and keep the UUID.

An exact match wins; otherwise the lookup ignores case. These cases return an error:

| Case                                                                  | Status | Body `error`                                                 |
| --------------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| Unknown or deleted user                                               | 404    | `Unknown user`                                               |
| Two accounts differ only in case, and neither matches exactly         | 409    | `Username matches more than one account; pass the user UUID` |
| Missing `user`, bad `limit`/`days`, a cursor not minted by the server | 422    | field-level `details`                                        |

## Response

```jsonc
{
    "generatedAt": "2026-10-02T12:00:00.000Z",
    "user": { "id": "7a00…a001", "username": "alice", "displayName": "Alice" },
    "recentlyWatched": {
        "items": [
            {
                "id": "7a00…0204", // Lumastra media id (deep link: /watch/<id>)
                "type": "episode", // movie | episode | audiobook
                "title": "The Missing Letter",
                "year": 2017, // series year for an episode
                "genres": ["Drama", "Mystery"], // an episode carries its series' genres
                "series": { "id": "7a00…0201", "title": "Harbor Lights", "year": 2017 },
                "seasonNumber": 1,
                "episodeNumber": 2,
                "lastWatchedAt": "2026-10-02T11:00:00.000Z", // null = unknown, see below
                "progressPercent": 50, // 100 when completed, null if runtime unknown
                "completed": false,
            },
        ],
        "page": { "limit": 50, "hasMore": true, "cursor": "eyJ0Ijoi…" },
    },
    "continueWatching": [/* same item shape, max 20, the user's Continue Watching row */],
    "topGenres": { "days": 180, "genres": [{ "name": "Drama", "titles": 7 }] },
    "stats": {
        "moviesWatched": 120,
        "episodesWatched": 940,
        "seriesWatched": 38,
        "audiobooksFinished": 4,
        "inProgress": 6,
        "activeInWindow": 85, // items watched or progressed in the last `days` days
        "undated": 2310, // items whose last watch date is unknown
        "tracksPlayedInWindow": 310, // music plays in the last `days` days
    },
}
```

- `recentlyWatched` holds the movies, episodes and audiobooks the user finished or started
  watching, newest first. Items with an unknown date come last. Page through it with
  `cursor` until `hasMore` is `false`. Music is counted (`tracksPlayedInWindow`), not listed.
- `continueWatching`, `topGenres` and `stats` are the same on every page.
- `topGenres` counts distinct titles: a series counts once, however many episodes. Ties are
  ordered by name.
- The user's library-group access and age limit apply, as in the app. Items whose files were
  later removed from the library can still appear: they are still part of what the user
  watched.
- Not included: file paths, IPs, devices, clients and other users' data.

### Unknown dates (`lastWatchedAt: null`)

A legacy Jellyfin import wrote its own import time as the "last watched" date for much
of the history. Those stamps aren't watch dates, so the endpoint
reports them as `null` and sorts the items after every dated one. They're left out of
`topGenres` and `activeInWindow` and counted in `stats.undated`. Treat them as "watched at
some point." A genuine play inside that window is treated the same way.

## Caching and load

The server caches responses for 60 seconds per user (and per page for `recentlyWatched`), so
polling more often returns the same `generatedAt`. Each replica keeps its own cache. Paging is
best-effort while the user keeps watching: a later page can be built after newer watches than
an earlier, cached one.
