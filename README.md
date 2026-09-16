# Sorobuild API

Owner-protected persistent workspaces, bounded ZIP import, isolated Rust jobs and a server-configured AI assistant. Runtime: `start.js` / `app.js`. Existing edits to legacy `server.js` are preserved; npm and Docker no longer start it.

## Local setup

Use Node.js 22.14+, Docker Engine/Desktop and sufficient memory for two 4 GiB worker sandboxes.

```sh
npm ci
npm run runner:build
npm start
```

Preserve existing `.env` values when configuring from `.env.example`. By default the API binds `127.0.0.1:3000`, allows frontend port 5173 on localhost/127.0.0.1, and stores projects in `./data`. `GET /api/health` reports service availability. The frontend's API origin must point here, not to the legacy service.

| Variable | Purpose |
| --- | --- |
| `PORT`, `HOST` | Listen address; default 3000 / 127.0.0.1 |
| `ALLOWED_ORIGINS` | Exact comma-separated frontend origins; mandatory in production |
| `DB_URI` | MongoDB URI including database name; takes precedence over file storage |
| `STORAGE_DRIVER=file` | Explicit production opt-in to single-process file storage |
| `DATA_DIR` | Persistent file-store location |
| `JOBS_DIR` | Temporary job source directory; identical absolute path on host and API container |
| `SOROBUILD_RUNNER_IMAGE` | Default `sorobuild-runner:25` |
| `AI_MODEL`, `AI_URL` | Ollama model and chat URL; default URL is localhost:11434/api/chat |

AI remains unavailable until a model is configured. Install/pull the chosen model separately and verify structured JSON output. Selected source and diagnostics leave the browser for this provider; changes always require review. Provider URLs are controlled by the operator, never the request payload.

## Compiler boundary

The runner uses Rust 1.90 and cached SDK 25.1.0 dependencies. Each job has a fresh directory and disposable non-root Docker container: no network, read-only root/input, dropped capabilities, no-new-privileges, 256 processes, 2 CPUs, 4 GiB memory/tmpfs, 8 MiB output and a 10-minute deadline. Jobs receive no API credentials or Docker socket. Custom Cargo configuration/toolchains are rejected. Build scripts and tests execute inside this boundary. To support other dependencies, review and prefetch them when rebuilding the image; user jobs cannot download packages.

The API controls Docker and therefore has significant host privileges. Use a dedicated compiler host without unrelated workloads/secrets. Containers share the host kernel; higher-assurance hostile multi-tenant deployments need a stronger worker isolation boundary and independent review. Never expose Docker's daemon publicly.

## Deployment

Build the runner first. Create `data` and the absolute `JOBS_DIR` on the host with ownership matching `API_UID:API_GID` (Compose defaults 1000:1000). Set `DOCKER_GID` to the host socket's group, set HTTPS `ALLOWED_ORIGINS`, and configure storage. Then:

```sh
docker compose config --quiet
docker compose up -d --build
```

Compose exposes the API only on host loopback. Put HTTPS in a reverse proxy. Example locations inside a TLS Nginx server serving frontend `dist`:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3000;
    client_max_body_size 9m;
    proxy_read_timeout 660s;
    proxy_send_timeout 660s;
    proxy_buffering off;
    proxy_set_header Host $host;
}
location / {
    try_files $uri $uri/ /index.html;
}
```

Run one API process: compiler admission, locks and IP rate limits are process-local, and file storage requires one writer. MongoDB provides atomic revisions but does not make admission distributed. Horizontal scaling needs shared job/rate-limit infrastructure. The API does not blindly trust forwarded IP headers; behind a proxy, enforce per-client rate limits at the edge. Add storage/admission quotas before opening anonymous creation publicly. Monitor disk/job capacity, configure backups and test restoration. The repository does not provision HTTPS, credentials, monitoring or public-service quotas.

`setup-systemd.sh` only installs a service for an already configured Compose checkout; it does not pull code, prune Docker, build images or start services. Review and explicitly start it after installation.

## API contract

`POST /api/projects` accepts JSON `{files}` and returns `projectId`, `projectToken`, `revision`. `/api/projects/upload-zip` accepts multipart `file` instead. Source must be a path-to-text map, at most 500 files / 4 MiB. ZIP uploads are capped at 8 MiB compressed with streaming expansion limits, traversal/symlink and file/folder conflict checks.

All other project routes require `Authorization: Bearer <projectToken>`:

| Method/route | Behavior |
| --- | --- |
| `GET /api/projects/:id` | Source and revision |
| `GET /api/projects/:id/load` | ZIP and revision header |
| `PUT /api/projects/:id` | JSON source save |
| `PUT /api/projects/upload-zip/:id` | Multipart source save |
| `POST /api/projects/:id/build`, `/test`, `/format` | JSON `{files,manifest}` or multipart `file` + `manifest` |
| `POST /api/projects/:id/assistant` | JSON prompt, selected files and optional diagnostics |
| `POST /api/projects/:id/delete` | Delete owned source |

Save/build/test/format/delete require `X-Project-Revision`. Missing revisions return 428; conflicts return 409; job failures return 422; overload returns 429. Build/test/format never overwrite saved source. Format returns JSON source for JSON clients and a ZIP for multipart clients. Owner tokens are random; only SHA-256 hashes are persisted. No login, role management or ownership recovery service is included.

## Existing data

New Mongo projects use `ideWorkspaces`. Legacy `projects` and GridFS `projectZips` remain untouched. Back up the database before explicitly running:

```sh
node lib/migrate-legacy.js /secure/private/project-access-tokens.json
```

The migration reads `DB_URI`, validates source, preserves project IDs and writes new owner tokens to a new mode-0600 file before insertion. It refuses to overwrite that file. Deliver links privately to verified owners; the old project ID alone is insufficient proof of ownership. Oversized/invalid projects need manual review. Migration never runs automatically.

## Checks

```sh
npm run lint
npm test
node tests/runner.integration.js
```

Integration checks build real WASM, run Rust tests, format, build two workspace members and reject broken source without stale artifacts. Unit/API tests cover ownership, revisions, persistence, concurrency and malicious archives. Target-environment MongoDB migration/restore, AI provider, Freighter, TLS and host isolation still require deployment validation.

### Rust IntelliSense

The frontend requests authenticated, read-only analysis at `POST /api/projects/:id/language`. The API runs rust-analyzer in the Soroban runner with its cached SDK dependencies, Rust sources, no network, and the same resource isolation as compilation. Rebuild `sorobuild-runner:25` after updating `runner.Dockerfile`. Two language sessions can run concurrently; idle sessions are removed after five minutes. Cargo manifests and non-Rust changes restart indexing; Rust edits are synchronized through LSP without changing saved project files. First indexing can take about a minute. Dependencies must be available in the runner cache, as with builds.


## Local Sandbox

Selecting Local Sandbox in the IDE requires a separate local Stellar network; the build runner and API do not provide one. Start the network using Stellar Quickstart:

```sh
docker run -d --name sorobuild-sandbox -p 127.0.0.1:8000:8000 stellar/quickstart:latest --local
```

Wait for RPC health before funding or deploying:

```sh
curl -s http://localhost:8000/rpc -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

The response should report `healthy`. The IDE uses `/rpc` and `/friendbot` on localhost:8000 with the standalone network passphrase. Use `docker start sorobuild-sandbox` to restart the existing container and `docker logs --tail 80 sorobuild-sandbox` to diagnose startup. Removing/recreating an ephemeral sandbox can reset its ledger; fund accounts again on that network. Testnet accounts and contracts are separate from the local network. Select Testnet in the IDE if you want to use a hosted development network without running Quickstart.

Quickstart documentation: https://developers.stellar.org/docs/tools/quickstart/getting-started

The optional local transaction explorer is at `http://localhost:8000/lab/transactions-explorer`. For an existing container, start it with `docker exec sorobuild-sandbox supervisorctl start stellar-lab`. The bundled explorer currently fails to render transaction details in verification, so the IDE does not offer Local Sandbox explorer links. Public-network transactions link to their corresponding hosted explorers.

Runner updates must be deployed separately from the API: run `npm run runner:build` before `docker compose up -d --build --force-recreate api`. Restarting the API clears existing analyzer sessions so they use the new dependency cache. The runner also caches `assert_unordered` for the atomic multiswap example. Missing cached dependencies are reported in the editor analysis status.
