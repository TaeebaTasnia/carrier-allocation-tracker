# Carrier Allocation & Utilization backend

FastAPI + SQLAlchemy on **PostgreSQL only** (driver psycopg 3), in every mode: production, local
development, the CLI, Alembic and the tests. There is no default database: `DATABASE_URL` is always
required and must be a PostgreSQL URL, otherwise the process refuses to start. The production schema comes
from Alembic migrations and its tables start empty.

## Install

From `E:\c&a-newww\backend` (do not activate the venv; the `&` in the path breaks it):

```
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt     # runtime + pytest
```

`requirements.txt` holds the pinned runtime dependencies (no pandas; psycopg 3 is the Postgres driver;
defusedxml makes openpyxl refuse XML entity tricks; Authlib + httpx + itsdangerous are for sign-in).

## Run locally (dev)

You need a PostgreSQL 16 server. With Docker, a local one (data kept in the named volume `ca-pg-dev-data`
until you remove it):

```
docker run -d --name ca-pg-dev -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=ca_dev -e POSTGRES_INITDB_ARGS=--locale=C.UTF-8 -v ca-pg-dev-data:/var/lib/postgresql/data -p 127.0.0.1:55440:5432 postgres:16
```

`APP_ENV` defaults to `production`, which also needs the sign-in settings. With the :5500 page server set
`APP_ENV=dev` and `APP_AUTH=off` (no sign-in: every request acts as a dev admin; the :5500 pages and the
:8002 API are two origins, and the session cookie is not sent across them) (PowerShell):

```
$env:DATABASE_URL = "postgresql+psycopg://postgres:dev@127.0.0.1:55440/ca_dev"
$env:APP_ENV = "dev"; $env:APP_AUTH = "off"
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8002
```

Dev mode creates missing tables (`create_all`, including the empty `users` table) in that database, seeds
the 14 suppliers if the table is empty, serves `/docs`, and allows CORS from the :5500 pages. Production
does none of that (schema: `alembic upgrade head`; suppliers: `python -m app.cli seed-suppliers`).
With `APP_AUTH` on (the default) and no OIDC settings, dev starts but fails closed: every data route answers
401 and sign-in reports `auth_error=unavailable`.

Without `DATABASE_URL`, or with a URL that is not PostgreSQL, the app (any `APP_ENV`), the CLI and Alembic
stop at once with `DATABASE_URL (or APP_DB_URL) is required ...` / `... must be a PostgreSQL URL ...`.
Stop the dev database with `docker stop ca-pg-dev`; delete it and its data with
`docker rm -f ca-pg-dev` and `docker volume rm ca-pg-dev-data`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `APP_ENV` | `production` | `production` or `dev` |
| `DATABASE_URL` (alias `APP_DB_URL`) | none: **required** in every `APP_ENV` | a PostgreSQL URL, e.g. `postgresql+psycopg://user:pass@host:5432/ca` (`postgres://` / `postgresql://` are rewritten to psycopg 3; any other database or driver is refused at startup) |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` / `DB_POOL_RECYCLE` | 5 / 5 / 1800 | Postgres connection pool per worker |
| `DB_LOCK_TIMEOUT_MS` | 30000 | Postgres `lock_timeout`; a write that waits longer for its lock gets HTTP 503 "try again" |
| `APP_CORS_ORIGINS` | production: none; dev: `http://127.0.0.1:5500,http://localhost:5500` | comma-separated allowed origins |
| `LOG_LEVEL` | `INFO` | app log level (stdout; every write is logged with its request id and the user's email) |
| `APP_AUTH` | `on` | `off` = no sign-in, every request is a dev admin. Only accepted with `APP_ENV=dev` (production refuses to start) |
| `SESSION_SECRET` | production: **required**, >= 32 random characters, not a value written in this repository; dev: random per process | signs the session cookie. Generate: `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `PUBLIC_URL` | production: **required**, https | the bare origin users open, e.g. `https://ca.example.com`. The callback URL registered at the identity provider is `PUBLIC_URL + /api/auth/callback` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | production: **required** | the company identity provider (generic OpenID Connect; see "Sign-in") |
| `OIDC_PROVIDER_NAME` | from the issuer: `Microsoft` / `Google` / `SSO` | label of the sign-in button |
| `OIDC_GOOGLE_HD` | required with Google | comma-separated Google Workspace domains accepted in the `hd` claim |
| `APP_ADMIN_EMAILS` | none | comma-separated emails that become admins on their FIRST sign-in when they have no `users` row yet (bootstrap); after that the CLI is the only source of truth |

## Database migrations (Alembic)

The production schema is created and changed only by migrations (`migrations/versions`: baseline `0001`,
`0002` users; head `0002`). Alembic reads `DATABASE_URL` and refuses to run without it or with a database
other than PostgreSQL:

```
$env:DATABASE_URL = "postgresql+psycopg://user:pass@host:5432/ca"
.venv\Scripts\python.exe -m alembic upgrade head      # create / update the schema
.venv\Scripts\python.exe -m alembic current           # the revision the database is at
.venv\Scripts\python.exe -m alembic check             # models and database agree (no drift)
```

A dev database that was filled by `create_all` (APP_ENV=dev) has no `alembic_version` table; run Alembic
only against databases that were created by it.

After changing `app/models.py`: `alembic revision --autogenerate -m "what changed"` against an up-to-date
database, review the file, commit it. Use the Postgres image with `POSTGRES_INITDB_ARGS=--locale=C.UTF-8`.

## Health

`GET /health` (liveness, no database) and `GET /health/ready` (`SELECT 1`; 503 when the database is down).
Both are public (no sign-in).

## Authentication contract (frozen; the pages code against this)

In production pages and API share ONE origin; the browser reaches the API under `/api` (the proxy strips
the prefix, uvicorn runs with `--root-path /api`). Paths below are what the browser uses. Fetch with the
default `credentials: 'same-origin'`; the session cookie is HttpOnly, so scripts never see it.

| Request | Answer |
|---|---|
| `GET /api/auth/config` (public) | `200 {"auth": "oidc", "provider": "entra", "provider_name": "Microsoft"}`. `provider` is `"entra"`, `"google"`, `"generic"` or `null` (dev without an identity provider); `provider_name` is the button label (`OIDC_PROVIDER_NAME`, else `Microsoft` / `Google` / `SSO`, `null` when not configured: say just "Sign in"). Dev with `APP_AUTH=off`: `{"auth": "off", "provider": null, "provider_name": null}`: skip sign-in, `/auth/me` answers the dev admin. |
| `GET /api/auth/me` | `200 {"email": "alice@example.com", "name": "Alice Planner", "role": "admin"}` (`role` is `"admin"` or `"user"`; `name` may be `""`). `401 {"detail": "Not authenticated"}`. `403 {"detail": "Your account has been deactivated. Ask an administrator."}` |
| `GET /api/auth/login?next=<path>` | a NAVIGATION (`location.href = '/api/auth/login'`), not a fetch: `302` to the identity provider. After sign-in the browser lands on `PUBLIC_URL + next`, by default `/index.html#enter`. `next` (optional) must be a same-origin path: one leading `/`, URL characters only (no spaces/backslashes), not under `/api`, at most 512 characters; anything else is silently replaced by `/index.html#enter`. |
| `GET /api/auth/callback` | called by the identity provider, never by the pages. Success: `302` to `next`. Failure: `302` to `/index.html?auth_error=<code>` (codes below). |
| `POST /api/auth/logout` | fetch, no body. Always `200 {"status": "signed_out"}`; the cookie is cleared and EVERY session of that user (all browsers/devices) ends. Then go to `index.html`. It does not sign the user out of the company identity provider. |
| any data route (`/api/forecast/...`, `/api/weekly/...`, ...) without a valid session | `401 {"detail": "Not authenticated"}`: JSON, never a redirect. |
| admin-only: `PUT /api/config`, `POST /api/suppliers/{code}`, `DELETE /api/suppliers/{code}`, `POST /api/suppliers/upload` by a `user` | `403 {"detail": "Only an administrator can do this."}` (show the detail; the controls are not hidden). Everything else is open to every active user. |
| any route, account deactivated meanwhile | `403 {"detail": "Your account has been deactivated. Ask an administrator."}`; the cookie is cleared, so the next call is 401. |
| a POST/PUT/DELETE whose `Origin` is not the site (or `Sec-Fetch-Site: cross-site`/`same-site`) | `403 {"detail": "Cross-site request refused."}` |

`auth_error` codes (a fixed set; no identity-provider text is ever passed through):

| Code | Meaning (suggested text) |
|---|---|
| `not_allowed` | "This account is not allowed to use the tracker. Ask an administrator." (not on the allow-list; email not verified; wrong tenant / Workspace domain; guest account; or the email is already bound to a different account at the provider) |
| `inactive` | "Your account has been deactivated. Ask an administrator." |
| `cancelled` | "Sign-in was cancelled." |
| `failed` | "Sign-in could not be completed. Please try again." (expired, replayed or tampered sign-in, token checks failed) |
| `unavailable` | "Sign-in is not available right now." (identity provider unreachable or not configured) |

Session cookie: `__Host-ca_session` (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`), plain
`ca_session` without `Secure` over http in dev. It lasts 12 hours from sign-in (not sliding): after that the
API answers 401 and the user signs in again. Suggested page handling: 401 on a page load -> go to
`index.html`; 401 on a save -> keep the typed data and ask to sign in again in a new tab; 403 -> show
`detail`.

## Sign-in (operator)

The company identity provider is **Microsoft Entra ID**. Nothing about it is in this repository; the values
go into the deployment's environment (`.env`) only.

What the reviewer must provide for Entra:
- the **tenant id** (directory id) -> `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`
- the **application (client) id** of the app registration -> `OIDC_CLIENT_ID=<client-id>`
- a **client secret** of that registration -> `OIDC_CLIENT_SECRET=<client-secret>`
- the **redirect URI** registered on it (platform "Web"): `https://<domain>/api/auth/callback`
  (and `PUBLIC_URL=https://<domain>`)
- the **first admin's email** -> `APP_ADMIN_EMAILS=<admin-email>` (no default), or add them with
  `python -m app.cli add-user <admin-email> --role admin` before the first sign-in
- the app registration must be **single-tenant** ("Accounts in this organizational directory only");
  scopes `openid email profile`; the optional `email` claim is useful but not required
  (`preferred_username` is used when it is missing)

Generic OpenID Connect (authorization code flow with PKCE S256, `state`, `nonce`, `response_mode=query`,
client secret sent with HTTP Basic), implemented with Authlib in `app/auth.py`. Register the app at the
identity provider with redirect URI `https://<domain>/api/auth/callback` and scopes `openid email profile`.
The provider's rules are chosen by the HOST of `OIDC_ISSUER`:

| Issuer host | Rules |
|---|---|
| `login.microsoftonline.com` (Entra) | `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0` (single tenant; `common`/`organizations` refused at startup). `tid` must be that tenant; guest and personal accounts (an `idp` claim other than the issuer or `https://sts.windows.net/<tenant-id>/`) are refused; email = `email`, else `preferred_username`; an explicit `email_verified: false` is refused (Entra normally sends none). The user is bound by `oid` on the first sign-in. |
| `accounts.google.com` | `OIDC_ISSUER=https://accounts.google.com` and `OIDC_GOOGLE_HD` required. `email_verified` must be true and `hd` one of `OIDC_GOOGLE_HD` (personal Google accounts are refused). Bound by `sub`. |
| anything else (generic) | `email` present and `email_verified` true (`true` or `"true"`). Bound by `sub`. |

Always: the ID token signature (provider JWKS), `aud`, `exp`, `nonce` and `iss` are verified, and the
discovery document's `issuer` must equal `OIDC_ISSUER`. Emails are compared lowercased. ALLOW-LIST ONLY:
a person signs in when their email has an active `users` row that is not bound to another account, or when
it is listed in `APP_ADMIN_EMAILS` and has no row yet (then an admin row is created). Nobody else is ever
created. A deactivated user, a sign-out (`session_epoch` + 1) or `unbind` invalidates the session cookies
already issued; the user row is read on every request.

Users are managed with the CLI only (needs `DATABASE_URL`, a PostgreSQL URL, like the app; the schema
must be migrated):

```
.venv\Scripts\python.exe -m app.cli add-user alice@example.com --role admin --name "Alice"   # or --role user; existing user: changes role/name
.venv\Scripts\python.exe -m app.cli deactivate alice@example.com   # refuse sign-in, end sessions now
.venv\Scripts\python.exe -m app.cli activate alice@example.com
.venv\Scripts\python.exe -m app.cli unbind alice@example.com       # account re-created at the provider: bind again on next sign-in
.venv\Scripts\python.exe -m app.cli list
.venv\Scripts\python.exe -m app.cli seed-suppliers                 # the 14 MGH suppliers, only when the table is empty
```

Roles: `admin` may change Settings (`PUT /config`) and the supplier list; `user` may do everything else.
To give everyone full rights, add everyone with `--role admin`.

Startup refusals (the process exits): production with `APP_AUTH=off`, a missing/short/non-random
`SESSION_SECRET` or one written in this repository (`deploy/dev.env`, the tests, the `.env.example`
placeholder: `app.auth.PUBLISHED_SECRETS`), a `<...>` placeholder (a value with `<` or `>`) left in
`SESSION_SECRET`/`PUBLIC_URL`/`OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`, a missing
`PUBLIC_URL`/`OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`, an http `PUBLIC_URL` or issuer; in any
mode partial OIDC settings, an Entra issuer without a tenant id, Google without `OIDC_GOOGLE_HD`. The
messages name the variable, never its value.

Cross-site writes: every POST/PUT/DELETE must come with an `Origin` equal to `PUBLIC_URL` (in dev also the
CORS origins) or, without `Origin`, a `Sec-Fetch-Site` of `same-origin`/`none`; requests with neither
header (curl, scripts) pass. This is on top of `SameSite=Lax`.

## Tests

The tests need a THROWAWAY PostgreSQL database whose name contains `test` (the harness drops and
truncates its tables), given in `TEST_DATABASE_URL`. Start one, run, remove it (PowerShell):

```
docker run -d --name ca-pg-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=ca_test -e POSTGRES_INITDB_ARGS=--locale=C.UTF-8 -p 127.0.0.1:55432:5432 postgres:16
$env:TEST_DATABASE_URL = "postgresql+psycopg://postgres:test@127.0.0.1:55432/ca_test"
$env:REQUIRE_GOLDEN = "1"
.venv\Scripts\python.exe -m pytest tests -q -rs
docker rm -f -v ca-pg-test
```

- Database: without `TEST_DATABASE_URL` (or with a URL that is not PostgreSQL, or a database name without
  `test`) the run stops at once with exit code 4 and the commands above; nothing is skipped silently and
  the suite never falls back to another database. `DATABASE_URL` is ignored by the tests. The schema is
  built once per run from the models; before each test one `TRUNCATE ... RESTART IDENTITY` empties every
  table and the 14 suppliers are seeded again. Tests that need an empty database (Alembic, CLI, dev
  startup) create a new one next to it (`<name>_fresh`) and drop it afterwards; the Alembic test checks
  that `alembic upgrade head` gives exactly the models (`alembic check`). The concurrency tests
  (`tests/test_concurrency.py`) use real parallel connections.
- Golden workbook: `GOLDEN_WORKBOOK` or `<repo>/forecast-report/CAREER FORECAST 45-47.xlsx`. With
  `REQUIRE_GOLDEN=1` (CI) a missing workbook fails the run instead of skipping the golden tests.
- Sign-in: the shared `client` fixture is signed in as an admin through the `app_overrides` fixture.
  `tests/test_auth.py` overrides it with `{}` and drives the real flow against `tests/mock_idp.py`, an
  offline OpenID Connect provider (discovery, JWKS, PKCE, RS256 ID tokens) reached through
  `create_app(..., oidc_transport=httpx.ASGITransport(app=idp.app))`. The same mock runs under uvicorn for a
  manual smoke test: `MOCK_IDP_ISSUER=http://127.0.0.1:8101 MOCK_IDP_CLIENT_ID=.. MOCK_IDP_CLIENT_SECRET=..
  python -m uvicorn --factory tests.mock_idp:create_smoke_app --port 8101`.

## Uploads

`POST /forecast/upload`, `/stuffing/upload`, `/suppliers/upload`: `.xlsx` only (name + ZIP signature), at
most 25 MB (250 MB unpacked) and 100,000 non-empty rows per sheet; the hard request-size cap belongs in the
reverse proxy. A sheet that makes the reader go past 1,100,000 rows in all, empty ones included (only a
crafted file can: Excel ends at row 1,048,576), is refused; a sheet that declares a range wider than 256
columns (IV) is read only up to column IV (`app/parsers/common.py`: MAX_SCANNED_ROWS, MAX_COLS). Supplier
rows follow the single-supplier limits: code <= 50, name <= 200, CW code <= 50 characters, else the upload
is refused with the row number. A file problem answers 400 with a readable `detail`; the technical error is only logged.
Spreadsheet numbers that are not finite or beyond +-1e12 count as missing; dates outside 2000-2100 are
unreadable. API numbers must be finite and within +-1e12, years 2000-2100, text without NUL characters
(otherwise 422).

## Rules (all values stored unrounded; JSON stays exact)

- The two .xlsx reports write TEU cells as whole numbers rounded UP (`teu_up` in `app/services/reports.py`: ceil(x - 1e-6), away from zero for negatives, deficit/surplus within 0.5 shows 0, never -0). CBM cells and percentages stay exact. The frontend uses the same rule for what it shows. `POST /suppliers/upload` still exists, but no page uses it (the supplier list is fixed; new suppliers are added in Settings).

- CBM+30% = exp.Vol cbm x (1 + uplift/100); TEU = CBM+30% / cbm_per_teu (33); split MAERSK 30 / HAPAG 25 / HELLMAN 20 / ONE 25.
- FML is separate (default 10 TEU/week, overridable per week). Weekly forecast excludes FML.
- Left = total confirmed (5 carriers) - total utilized; To be arrived = max(0, sum daily forecast TEU - sum actual TEU);
  Deficit/Surplus = Left - To be arrived (deficit < -0.5, surplus > 0.5, else balanced).
- Shipping lines: explicit `line_map` entries win; otherwise a line starting with `FML` + hyphen/space/slash (e.g. `FML-MAERSK`) maps to FML (FML is the main for those bookings). `FMLX`/`FM` do not match.
- Actual CBM per day comes from the DAILY STUFFING report, in priority order: (1) a typed adjustment for that date (`PUT /daily/{date}`, 0 is valid, null clears it) -> that value, source `entered`; (2) else, if the day has stuffing rows, the sum over its rows of (the row's CBM if the report has one, else the row's TEUs x cbm_per_teu = TEU x 33) -> source `stuffing_cbm` (every row had a CBM), `stuffing_teu` (none had one) or `stuffing_mixed`; (3) else 0, source `none`. Actual TEU = actual CBM / cbm_per_teu. Unmapped shipping lines still count as arrived (they are only left out of the carriers' utilized). In the daily JSON, `actual_cbm_override` is the typed adjustment (null = none) and `actual_cbm_source` is the source. Utilized stays the stuffed TEUs per carrier; confirmed TEUs are what the carrier gave.
- Optional CBM column in the stuffing file (header, case/space-insensitive): `CBM`, `Total CBM`, `CBM Total`, `Volume`, `Vol`, `Volume CBM`, `Vol CBM`, `M3`, `Cube`. Blank or non-numeric = no CBM for that row. The TEUs and Qty columns are never read as CBM. Stored in `daily_stuffing.cbm` (part of the Alembic baseline).
- Weeks are keyed by (ISO year, ISO week) of the Rfi date.

## Endpoints

Every endpoint below needs a signed-in, active user (401/403 as in "Authentication contract"); the ones
marked (admin) need `role: admin`. Public: `/health`, `/health/ready`, `/auth/config`, `/auth/login`,
`/auth/callback`, `/auth/logout`.

- `POST /suppliers/upload` (`?replace=true`) (admin), `GET /suppliers`, `POST /suppliers/{code}` (admin), `DELETE /suppliers/{code}` (admin)
- `POST /forecast/upload`, `GET /forecast/weeks/{year}/{week}`
- `POST /stuffing/upload?report_date=YYYY-MM-DD` (date only needed if the file has no date column; the response adds `cbm_column_found`, `carrier_cbm` and `cbm_by_date`)
- Typed daily stuffing (the browser day editor; no Excel file). Rows are stored exactly like uploaded rows (same `daily_stuffing` table; vessel dates as `YYYY-MM-DD` text; `carrier` = the shipping line mapped through the config `line_map` + the `FML-` prefix rule at save time). Figures (`/daily`, `/weekly`, `/reports/*`, the .xlsx exports) read the same rows, so typed and uploaded days behave identically.
  - `GET /stuffing/dates?year=&week=` (ISO week, 422 if invalid) -> `{"year":2026,"week":45,"days":[{"date":"2026-11-02","rows":2,"teus":8.0}, ... 7 days Mon-Sun, rows 0 / teus 0 when empty]}`. Declared before `/stuffing/{date}`.
  - `GET /stuffing/{date}` (YYYY-MM-DD, otherwise 422) -> `{"date","rows":[{"id","shipping_line","qty","teus","feeder_vessel","fvsl_etd","fvsl_eta","mother_vessel","mvsl_etd","mvsl_eta","cbm","carrier","mapped"}],"total_teus","unmapped_lines":[{"shipping_line","teus"}]}`. Rows ordered by id; an empty day is 200 with `rows: []`. `carrier`/`mapped` are computed now from the current `line_map` (explicit entry wins, then `FML-`/`FML ` prefix -> FML), so a Settings change shows immediately.
  - `PUT /stuffing/{date}` body `{"rows":[{"shipping_line":"MAERSK","qty":3,"teus":6,"feeder_vessel":"FEEDER","fvsl_etd":"2026-11-05","fvsl_eta":"2026-11-08","mother_vessel":"MOTHER","mvsl_etd":"2026-11-10","mvsl_eta":"2026-12-01","cbm":120.5}]}` REPLACES all rows of that date in one transaction (an empty list clears the day) and returns the same JSON as GET. Validation (422): `shipping_line` required, trimmed, 1-100 chars; `teus` required, finite number >= 0 (TEUs is authoritative; a 40' HC is 2 TEU, the browser may pre-fill 2 x Qty); `qty`/`cbm` optional numbers >= 0; the four vessel dates optional ISO `YYYY-MM-DD` (null or "" = none); vessel names optional, max 100; at most 500 rows. A rejected save changes nothing.
  - `DELETE /stuffing/{date}` -> `{"date":"2026-11-04","deleted":2}` (0 is fine).
- `GET|PUT /weekly/{year}/{week}` (PUT body: `{"confirmed": {"MAERSK":20,...,"FML":0}, "fml_forecast": null}`). Confirmed TEUs and `fml_forecast` must be finite numbers >= 0 (a negative FML forecast is refused with 422; before the go-live changes it was stored).
- `GET /daily?year=&week=`, `GET|PUT /daily/{date}` (PUT body: `{"actual_cbm": 66}` = typed adjustment of that day's actual CBM; 0 is valid; null clears it and the computed value returns)
- `GET /reports/weekly-summary?year=&from_week=&to_week=` and `/reports/weekly-summary/download` (.xlsx)
- `GET /reports/allocation-vs-utilization?year=&week=` and `/reports/allocation-vs-utilization/download` (.xlsx)
- `GET|PUT /config` (PUT: admin) (uplift_pct, cbm_per_teu, split totalling 100, fml_default, line_map). Limits (422 otherwise): `uplift_pct` > -100 and <= 1000; `cbm_per_teu` 0.01 to 1000; `fml_default` >= 0; split values >= 0 and totalling 100; `line_map` at most 500 entries, each name at most 100 characters.
- `GET /auth/config`, `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`, `GET /auth/me` (see above)
