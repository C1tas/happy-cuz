# Local Build & Global Link Guide

## Workspace Architecture

This project uses **Yarn 1 (Classic) workspaces** (`yarn@1.22.22`) as a monorepo. The root `package.json` defines 6 packages:

```
monorepo (private)
├── packages/happy-app        # React Native + Expo mobile/web client (private)
├── packages/happy-cli        # CLI tool — wraps Claude Code for remote control
├── packages/happy-agent      # CLI client for controlling Happy agents remotely
├── packages/happy-server     # Fastify backend server (private)
├── packages/happy-wire       # Shared wire types & Zod schemas (@slopus/happy-wire)
└── packages/happy-app-logs   # Log viewer server (private)
```

### Key Dependencies

`happy-cli` depends on `@slopus/happy-wire`, which must be built first. The build toolchain is:

- **TypeScript** (`tsc --noEmit`) — type checking only, no emit
- **pkgroll** — zero-config bundler that produces `dist/` with CJS/ESM dual output
- **shx** — cross-platform `rm -rf dist`

## Build happy-cli

### 1. Build the dependency: happy-wire

```bash
yarn workspace @slopus/happy-wire build
```

This runs: `shx rm -rf dist && tsc --noEmit && pkgroll`

### 2. Build happy-cli

```bash
yarn workspace happy build
```

This runs: `shx rm -rf dist && tsc --noEmit && pkgroll`

Output artifacts in `packages/happy-cli/dist/`:

```
dist/
├── index.cjs          # CJS entry
├── index.mjs          # ESM entry
├── index.d.cts        # CJS types
├── index.d.mts        # ESM types
├── lib.cjs / lib.mjs  # Library sub-export
└── codex/             # MCP stdio bridge sub-export
    └── happyMcpStdioBridge.cjs / .mjs
```

### 3. (Optional) Run tests

```bash
yarn workspace happy test
```

Note: `test` script builds first, so this is equivalent to build + test.

## Link Globally

### Important: `yarn link` does NOT create global bin commands

**Yarn 1 的 `yarn link` 只会将包注册到 link store（`~/.local/share/yarn/link/`），供其他项目通过 `yarn link <name>` 引用，但不会创建全局 bin 命令。**

要全局使用 `happy` 命令，必须使用 `npm link`。

Additionally, running `yarn link` from the monorepo root registers the **root package** (`name: "monorepo"`, no `bin` field) — not `happy-cli`.

### Option A: `npm link` (recommended — creates global bin)

```bash
cd packages/happy-cli
npm link
```

This reads the `bin` field from `package.json` and creates global symlinks for both `happy` and `happy-mcp` commands.

```bash
# Verify
happy --version
```

To undo:

```bash
cd packages/happy-cli
npm unlink
```

### Option B: `link:dev` script (separate dev command, keeps stable `happy`)

This project includes a built-in script that creates a **separate `happy-dev` command**, keeping the stable `happy` from npm intact:

```bash
yarn workspace happy link:dev
```

What it does:
1. Finds the global npm bin directory
2. Creates a symlink: `<global-bin>/happy-dev` → `packages/happy-cli/bin/happy-dev.mjs`
3. Sets `HAPPY_HOME_DIR=~/.happy-dev` and `HAPPY_VARIANT=dev` automatically

Result:
- `happy` → stable npm version (unchanged)
- `happy-dev` → your local development build

To undo:

```bash
yarn workspace happy unlink:dev
```

### Option C: Manual symlink

```bash
# Find your global bin dir
npm bin -g

# Create symlink manually (adjust paths as needed)
ln -s /absolute/path/to/happy/packages/happy-cli/bin/happy.mjs /usr/local/bin/happy

# To remove
rm /usr/local/bin/happy
```

## Quick Reference

| What | Command |
|------|---------|
| Install all workspace deps | `yarn` |
| Build happy-wire | `yarn workspace @slopus/happy-wire build` |
| Build happy-cli | `yarn workspace happy build` |
| Build + test happy-cli | `yarn workspace happy test` |
| Type check only | `yarn workspace happy typecheck` |
| Run CLI in dev mode (no build) | `yarn workspace happy dev` |
| Run CLI from root | `yarn cli` |
| Link `happy-dev` globally | `yarn workspace happy link:dev` |
| Unlink `happy-dev` | `yarn workspace happy unlink:dev` |
| Link globally (npm link) | `cd packages/happy-cli && npm link` |
| Unlink globally | `cd packages/happy-cli && npm unlink` |

## Troubleshooting

### Build fails with missing `@slopus/happy-wire`

Make sure `happy-wire` is built first: `yarn workspace @slopus/happy-wire build`

### `yarn link` warning: "already a package called 'happy' registered"

This means a previous `yarn link` left a stale registration in the Yarn link store. Yarn 1 的 `yarn link` 不会创建全局 bin 命令，应改用 `npm link`：

```bash
# 清理旧注册
rm ~/.local/share/yarn/link/happy

# 用 npm link 替代
cd packages/happy-cli && npm link
```

### `yarn link` only registered "monorepo", not "happy"

You ran `yarn link` from the project root. The root `package.json` has `name: "monorepo"` and no `bin` field, so no CLI commands are registered. You must `cd packages/happy-cli && npm link` instead.

### `npm link` permission denied

On macOS/Linux, the global bin directory may require `sudo`:
```bash
sudo npm link
```

### `link:dev` script permission denied

The script detects this and suggests `sudo yarn workspace happy link:dev`.

### `happy` command not found after linking

Verify the symlink exists and points to the correct path:
```bash
which happy
ls -la $(which happy)
```

### Stale build after code changes

Rebuild and the symlinked CLI will pick up changes automatically (it reads from `dist/`):
```bash
yarn workspace happy build
```
