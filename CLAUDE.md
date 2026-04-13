# CLAUDE

# git rebase rule

ignore any text change about `aboutFooter: 'This is a cuz version, just cuz.'` inside packages/happy-app/sources/text/

# Expo Health Check Standards

After any dependency change in `packages/happy-app` (adding/removing/updating packages), run these two checks from project root:

```bash
npx expo-doctor@latest          # 17 checks: duplicates, peer deps, SDK compat, etc.
npx expo install --check        # patch version alignment with current Expo SDK
```

Both must pass clean (0 failures) before committing dependency changes.

## Monorepo Dependency Rules (nohoist)

Root `package.json` must have **NO** `dependencies` or `devDependencies`. All packages belong in their respective workspace `package.json`. This is critical because:

- `nohoist` includes `**/react`, `**/react-native`, `**/react-native/**` — any root-level package that transitively depends on these creates nested duplicate copies (e.g. `node_modules/expo/node_modules/react`)
- `expo-router` is hoisted from the workspace automatically by yarn and resolves correctly at root (including `_ctx-shared.js`) without being declared in root deps
- Adding packages to root "to fix module resolution" is always wrong in this repo — investigate the real hoisting issue instead

If `expo-doctor` reports duplicates:
1. Check root `package.json` has no `dependencies`/`devDependencies` (except `devDependencies` like `playwright` if needed at root level)
2. Run `rm -rf node_modules packages/*/node_modules && yarn install`
3. Re-run `npx expo-doctor@latest` to confirm 17/17

If `expo install --check` reports version mismatches:
1. Update the version in `packages/happy-app/package.json` directly (not root)
2. For workspace packages, use `yarn workspace happy-app add <pkg>@<version>` — never `yarn add` at root without `-W`

## Standard Update & Deploy Flow

Full update cycle: deploy server, build APK, install on device.

### Step 1: Deploy Server (remote + local)

```bash
# From project root. "slim" = production deps only (~1GB image)
./deploy-server.sh slim
```

7-step flow:
1. Build Docker image locally (`build-server-slim.sh`)
2. `docker save` to `/tmp/happy.tar`
3. `scp` tar to jump host (`192.168.58.120:/root/share/`)
4. SSH to `qc-sgp`, `wget` tar from jump host HTTP
5. `docker load` on remote
6. `docker compose up -d` + verify image hash match
7. `local_update.sh` — rebuild CLI/agent, restart daemon locally

If SSH to `qc-sgp` times out at step 4, retry — the tar is already on the jump host.

### Step 2: Build prod-cuz Release APK

```bash
# Prebuild Android native directory for prod-cuz variant
cd packages/happy-app
APP_ENV=prod-cuz yarn expo prebuild --platform android --clean

# Build release APK (arm64 only, ~107MB)
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Or use the shorthand (runs both steps, but uses expo run which starts the app):
```bash
yarn workspace happy-app android:prod-cuz
```

APK output: `packages/happy-app/android/app/build/outputs/apk/release/app-release.apk`

### Step 3: Install via ADB

```bash
# Verify device connected
adb devices

# Install (replace existing)
adb install -r packages/happy-app/android/app/build/outputs/apk/release/app-release.apk
```

### Notes

- Steps 1 and 2 are independent and can run in parallel
- `prod-cuz` variant: bundle ID `com.c1tas.happycuz`, app name `HappyCUZ`, EAS project `06d51150-40e0-40fc-872b-edcefa4284c2`
- Release APK uses debug keystore (not production signing)
- For variant switching, always re-run `expo prebuild --clean` — native directory is variant-specific
- ADB can be wireless (`adb connect <ip>:5555`) or USB
