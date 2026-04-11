# Docker Image Optimization

The original `happy-server:latest` image is ~5.9 GB. The root cause is that the entire monorepo `node_modules` (6 GB, including Expo/React Native/Tauri mobile app dependencies) is copied into the production runner stage.

This document describes two optimized Dockerfile variants that reduce the image size significantly.

## Size Comparison

| Image | Approximate Size | Reduction |
|---|---|---|
| `happy-server:latest` (original) | ~5.9 GB | baseline |
| `happy-server-slim:latest` (Plan 1) | ~1.0-1.2 GB | ~80% |
| `happy-server-standalone:latest` (Plan 2) | ~200-400 MB | ~95% |

## Plan 1: Production-Deps-Only (`Dockerfile.server-slim`)

### What it does

Adds a dedicated `prod-deps` stage that rewrites the root `package.json` to include only the `happy-server` and `happy-wire` workspaces, then runs `yarn install --production`. This eliminates all dependencies from `happy-app`, `happy-cli`, and other workspaces.

### 4-stage build

1. **deps** — full workspace `yarn install` (needed for build tools like `pkgroll`)
2. **builder** — builds `happy-wire` (pkgroll) and type-checks server
3. **prod-deps** — fresh install with trimmed workspace config, `--production` flag
4. **runner** — `node:20-slim` with only production `node_modules` + server source

### Use case

Production deployments with external PostgreSQL and optional Redis. This is a drop-in replacement for the original `Dockerfile.server`.

### Build

```bash
./build-server-slim.sh            # tags as happy-server-slim:latest
./build-server-slim.sh v1.2.3     # tags as happy-server-slim:v1.2.3
```

Or manually:

```bash
docker build -f Dockerfile.server-slim -t happy-server-slim:latest .
```

### Run

Same environment variables as the original image:

```bash
docker run -d \
    -e DATABASE_URL="postgresql://user:pass@host:5432/db" \
    -e REDIS_URL="redis://host:6379" \
    -e HANDY_MASTER_SECRET="your-secret" \
    -p 3000:3000 \
    happy-server-slim:latest
```

### Trade-offs

- Same runtime behavior as the original — it is a fully compatible replacement
- Build time is slightly longer due to the extra `prod-deps` install stage (mitigated by BuildKit cache mounts)
- Does not use `--frozen-lockfile` in the `prod-deps` stage because the workspace config is modified; version pinning still comes from `yarn.lock`

---

## Plan 2: Bun Standalone Binary (`Dockerfile.server-standalone`)

### What it does

Uses `bun build --compile` to produce a single self-contained executable (~100 MB). The runner image needs no Node.js, no `node_modules` — just the binary, PGlite WASM files, and migration SQL files.

### 3-stage build

1. **deps** — full workspace `yarn install`
2. **builder** — installs bun, builds `happy-wire`, compiles `standalone.ts` into a native binary
3. **runner** — `debian:bookworm-slim` with only the binary + PGlite assets

### Use case

Standalone / development deployments where you want a single self-contained server with no external database dependencies. Uses PGlite (embedded PostgreSQL in WASM).

### Build

```bash
./build-server-standalone.sh            # tags as happy-server-standalone:latest
./build-server-standalone.sh v1.2.3     # tags as happy-server-standalone:v1.2.3
```

Or manually:

```bash
docker build -f Dockerfile.server-standalone -t happy-server-standalone:latest .
```

### Run

```bash
docker run -d \
    -e HANDY_MASTER_SECRET="your-secret" \
    -v happy-data:/data \
    -p 3005:3005 \
    happy-server-standalone:latest
```

The container automatically runs migrations on startup, then starts the server.

### Trade-offs

- Uses PGlite (embedded Postgres), not external PostgreSQL
- `sharp` (image processing) may not work in bun-compiled mode — native Node addons are not bundled
- Redis is optional and dynamically loaded (works if `REDIS_URL` is set at runtime)
- Bun runtime has minor behavior differences from Node.js
- Not suitable for production deployments that need external Postgres

---

## Which one to use?

| Scenario | Recommended |
|---|---|
| Production with external Postgres + Redis | **Plan 1** (`Dockerfile.server-slim`) |
| Dev / standalone / single-server deployment | **Plan 2** (`Dockerfile.server-standalone`) |
| Smallest possible image, no external deps | **Plan 2** |
| Drop-in replacement for current image | **Plan 1** |

## Root cause analysis

The original `Dockerfile.server` copies the entire `node_modules/` from the build stage to the runner. Since `yarn install` in a monorepo installs dependencies for **all** workspaces, this includes:

| Package group | Size | Workspace |
|---|---|---|
| Expo / React Native | ~4.6 GB | happy-app (mobile) |
| @tauri-apps | ~38 MB | happy-cli (desktop) |
| @babel | ~17 MB | happy-app (build) |
| devDependencies (vitest, typescript, @types) | ~30 MB | all |

The server's actual production dependencies total ~400-500 MB.
