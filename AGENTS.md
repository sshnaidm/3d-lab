# AGENTS.md

Project guide for people and AI agents working on 3D Lab. User-facing docs are in README.md.

## Layout

```
lab3d/      Python service and CLI (Starlette + httpx, no other runtime deps besides PyYAML/uvicorn)
  redfish.py          GET-only Redfish client: vendor detection, per-vendor paths and default credentials, retries
  topology.py         fetch_raw(client) + build_topology(): Redfish -> topology schema v1 with stable slot keys
  inventory.py        servers/secrets files (baremetal-mcp format) + ad-hoc hosts; hands out BMCClient per host
  collector.py        refresh jobs: per-host dedup, concurrency limits, timeouts, classified errors
  store.py            JSON store: index, latest topology, lazy raw, history on fingerprint change
  wiring.py           optional switch wiring (CSV/YAML) applied to NIC ports at read time
  app.py              HTTP API + static web UI, auth
  settings.py         config file + VIEWER_* env + CLI overrides
  cli.py              3d-lab [serve] | collect | capture | export | healthcheck
web/                  React 19 + React Three Fiber UI (Vite, Tailwind 4, zustand, vitest)
tests/                pytest; fixtures/ are redacted real Redfish captures
examples/             config.yaml, redfish_servers.yaml, redfish_secrets.yaml, wiring.csv
Containerfile         node build stage + python:3.12-slim runtime; /config (ro) and /data volumes
compose.yaml          podman/docker compose example
```

## Rules

- **Only GET requests to BMCs.** `BMCClient` exposes `get`, `get_optional` and `get_members` only; keep it
  that way.
- **Never log or return credentials or BMC addresses.** `classify_error` strips IPs and URLs from
  messages, and `BMCClient.__repr__` hides credentials.
- **Redact captures.** Tests and `web/public/topology` must contain only redacted captures
  (`3d-lab capture` redacts by default). Use neutral host names (`db-01`, `lab1`, `leaf-sw01`),
  never real ones.
- **Lint:** Python is formatted with `black -l 120` and checked with `flake8` (CI runs both).

## Data flow

1. **Inventory:** `Inventory` reads `servers_file` and `secrets_file`, plus remembered ad-hoc hosts from
   `data/adhoc/`. `inventory.client(host)` returns a cached `BMCClient` that keeps the detected vendor.
2. **Collection:** `Collector.submit(hosts)` starts or joins one task per host.
   - At most `max_concurrent_bmcs` hosts are collected at once.
   - At most `max_requests_per_bmc` requests are in flight per BMC, through the
     `redfish.BMC_REQUEST_LIMIT` context variable.
   - Each host has a timeout of `host_timeout`.
   - A result in which a whole kind of part seen before has vanished (all DIMMs, all drives, …) is rejected
     as `incomplete`, and the previous data is kept. `force` / `--accept-missing` overrides this.
3. **Topology:** `fetch_raw(client)` reads the system (required), manager, chassis, processors, memory,
   storage and drives, PCIe devices and functions, PCIe slots, network adapters and ports, thermal and
   power. `build_topology()` is a pure function that turns this into schema v1 (`web/src/topology/types.ts`):
   - `system` and `chassis`, including `u_height`;
   - `components[]`, each with `id`, `kind`, `slot_key` (`cpu:1`, `dimm:A1`, `pcie:3`, `ocp:1`, `lom:1`,
     `psu:1`, `fan:1`, `bay:4`), `present`, `health`, `name`, `summary` and the trimmed `raw` data.
4. **Store:**
   - `data/index.json` has one row per host: counts, health, fingerprints and `last_error`.
   - `data/hosts/<id>.json` holds the latest topology without raw data; `<id>.raw.json` is loaded lazily.
   - `data/history/<id>/<ts>.json` is written only when the hardware or firmware fingerprint changes.
     Readings (RPM, watts, link state, health) never create history.
   - Writes take an flock, so the service, the CLI and other tools can share one store.
5. **Wiring:** `wiring.py` reads `wiring_files` (globs; reloaded when the files change) and adds a `peer`
   to matching ports when a topology is served. Nothing is stored, so wiring creates no history.
   - Matching tries the MAC first, then the Dell FQDD, then slot and port number. A MAC that is not on the
     host never falls back to slot matching.
   - Observed rows beat planned ones, and the newest observation wins.
6. **API and UI:** `app.py` serves `/api/*`, `/topology/*.json` (static-mode compatibility) and `web/dist`.

## Security model

- **Writes** need `Authorization: Bearer $VIEWER_API_TOKEN` (env only). Without a token, writes are accepted
  only from loopback clients that send `X-Viewer-Request: 1`.
- **Loopback requests** must carry a local Host header (`localhost`, `127.0.0.1`, `::1` or
  `allowed_hosts`). This blocks DNS rebinding.
- **Reads** are open unless `open_reads: false`.
- **Ad-hoc hosts** must be IP literals inside `allowed_bmc_cidrs`. Remembered credentials are written to
  `data/adhoc/secrets.yaml` with mode 0600.
- **Refresh rate limit:** one refresh per host per `refresh_min_interval`, and one bulk job at a time.

## Web UI (`web/`)

- **Routes** are hash based, so the build works from any path:
  - `#/`: the fleet page; filters live in the URL, e.g. `#/?lab=lab1&state=error&q=ConnectX`.
  - `#/host/<id>`: the 3D view of one host.
  - `#/host/<id>/<slot_key>`: the 3D view with one component selected.
- **Data modes** (`src/topology/load.ts`): `api` when served by the service (probes `api/health`);
  otherwise `static`, which reads `public/topology/index.json` and `<id>.json` (for sharing snapshots).
- **Writes** send `X-Viewer-Request: 1`. A 401 opens a token prompt; the token is kept in sessionStorage,
  or in localStorage when "remember" is ticked.
- **3D view chunk:** the 3D view (three.js) is a lazy chunk of about 1.3 MB, so the fleet page loads
  without it.
- **Dev server:** `npm run dev` proxies `/api` to `VIEWER_URL` (default `http://127.0.0.1:8080`).
  `VIEWER_PROXY=0` disables the proxy.

### Layouts

Layouts in `web/src/layouts/` map slot keys to 3D positions for each chassis model:

- **Dell rack servers** are two families with per-model parameters:
  - `dell-1u.ts`: R640, R650 and R660;
  - `dell-2u.ts`: R740, R750, R760 and R7625.
- **Shared Dell pieces** live in `dell.ts`: CPU, DIMM, fan, PSU and network anchors, plus three DIMM
  schemes: `intel-12` (14G), `intel-16` (15G and 16G) and `amd-12` (EPYC).
- **The mezzanine** is labelled rNDC on 14G and OCP 3.0 from 15G.
- **Extra fans:** fans beyond a model's expected count widen the row instead of going unplaced.
- **Everything else** uses `generic.ts`. It arranges what the BMC reports by U height and shows a
  "generic layout" badge.
- **Coordinates are approximate** (`approximate: true`) until they are calibrated.
- **Model matching:** `models.json` maps chassis model patterns to layout ids, most specific first. The
  service reads the same file for `/api/coverage`; the container copies it to `/app/web/models.json`.

**Validation:** `npm test` runs `src/layouts/layouts.test.ts`. It checks every captured topology in
`public/topology/`, plus a fully populated configuration of each Dell model (every DIMM, fan, slot and
drive-cage option). For each one it checks that:

- every slotted part is placed;
- slot keys are unique;
- every part is inside the chassis;
- no two parts occupy the same space.

It also tests the model → layout mapping.

**Adding a layout:**

1. Capture the model with `3d-lab capture <host> -o tests/fixtures/<model>_captured.json`
   (redacted). Then run `3d-lab export --replay tests/fixtures/<model>_captured.json
   <model>-captured -o web/public/topology` so the validation covers it.
2. For a Dell model in an existing family, add a `DellModel` entry to `DELL_1U` or `DELL_2U`. Otherwise,
   write a factory that returns a `Layout`: anchors with `pos` / `size` in millimetres, x to the right seen
   from the front, y up, z from front to rear. Register it in `FACTORIES` in `layouts/index.ts`.
3. Add `{id, match}` to `layouts/models.json`, most specific pattern first.
4. Take positions from the system-board diagram in the model's Installation and Service Manual. Keep
   `approximate: true` until the layout is checked against a real chassis.
5. Run `npm test` and fix any unplaced part, clash or out-of-chassis anchor it reports.

## Tests

- **Python:** `pip install -e '.[test]' && pytest`.
  - `tests/conftest.py` provides `mock_redfish_client(routes)`, a fake HTTP client that only has `get`, and
    `write_inventory()`.
  - `fixtures/dell_r750_captured.json` and `dell_r650_captured.json` are redacted real iDRAC9 captures.
  - `dell_r750.json` and `supermicro_x11.json` are smaller fixtures for the topology builder.
- **UI:** `cd web && npm ci && npm test && npm run build`.
- **Container:** `podman build -t 3d-lab .`.
  - The build stage runs `npm test`.
  - CI also starts the image and checks `/api/health` and the UI.
  - With podman, use `--format docker` to keep the HEALTHCHECK.

## Integration with baremetal-mcp

[baremetal-mcp](https://github.com/sshnaidm/baremetal-mcp) is an MCP server for BMC and switch operations.
3D Lab started inside it and was split out because a fleet web service with its own store, UI
and container is outside the scope of an MCP server. Both read the same `redfish_servers.yaml` and
`redfish_secrets.yaml`, so host ids match. Neither project needs the other. Three ways to connect them:

1. **HTTP (recommended).** baremetal-mcp gets an optional `lab3d_url` setting (plus an
   `LAB3D_API_TOKEN` env var) and a few thin tools that call this API:
   - `lab3d_link(server_id, slot_key?)` returns `<url>/#/host/<id>/<slot_key>`, so the assistant can
     answer "show me slot 6 of db-01" with a link that opens the part in 3D.
   - `lab3d_refresh(server_ids)` calls `POST /api/servers/{id}/refresh` with the token and returns the
     job (or waits for it).
   - `lab3d_search(q)` calls `GET /api/search`, for example "which hosts have a ConnectX-6 in a
     degraded state".

   This is loose coupling: the two run on different machines and release separately, and no Python
   dependency goes either way.
2. **Library.** `pip install 3d-lab` in baremetal-mcp, behind an optional extra.
   - Its `get_hardware_topology` tool calls `lab3d.topology.build_topology(server_id, vendor,
     raw)`. The raw data comes either from its own Redfish helpers or from
     `fetch_raw(adapter)`, where `adapter` provides `host_id`, `vendor`, `resolve_vendor()`,
     `get(path)`, `get_optional(path)` and `get_members(path)` on top of `_redfish_call`.
   - With `lab3d.store.Store(data_dir).save(topology)`, the tool can also write into the
     3D Lab store. On the same machine, hosts asked about in chat then appear in the UI. The store
     takes an flock, so this is safe while the service runs.
   - The cost is that the library becomes a dependency of the MCP server.
3. **Shared files only.** Run both against the same servers and secrets files and link to the UI by
   convention (`<url>/#/host/<server_id>`). This needs no code at all.

Options 1 and 3 work together: start with 3, and add the thin HTTP tools when chat-driven refreshes or
part search are wanted.
