# HappyCUZ Android 构建指南

## 概述

`prod-cuz` 是独立的构建变体，生成包名为 `com.c1tas.happycuz`、应用名为 `HappyCUZ` 的 release APK，可与 dev/preview/production 版本共存安装。

## 环境要求

```bash
# SDK 和 JDK（WSL2 环境）
export ANDROID_HOME=/opt/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk

# 已安装组件
# - platforms;android-35
# - build-tools;35.0.0
# - ndk;27.1.12297006
# - JDK 17
```

Gradle 镜像配置在 `~/.gradle/init.gradle`（阿里云 Maven 镜像）。

## 构建步骤

### 一键构建（需先 prebuild）

```bash
export ANDROID_HOME=/opt/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk

# 1. Prebuild — 生成 android 目录（会清除现有 android 目录）
cd packages/happy-app
APP_ENV=prod-cuz yarn expo prebuild --platform android --clean

# 2. 构建 release APK（仅 arm64，跳过 x86 模拟器架构）
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

> **重要**: 使用 `yarn expo prebuild` 而非 `npx expo prebuild`。在 monorepo 中 `npx` 无法正确解析 expo 可执行文件，会报 `Missing script "expo"` 错误。

### 使用 yarn 脚本

```bash
export ANDROID_HOME=/opt/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk

# 先 prebuild（首次或包名切换后必须）
APP_ENV=prod-cuz yarn expo prebuild --platform android --clean

# 构建并运行到已连接设备
yarn workspace happy-app android:prod-cuz
```

### 产物位置

```
packages/happy-app/android/app/build/outputs/apk/release/app-release.apk
```

## 构建变体对比

| 变体 | APP_ENV | 包名 | 应用名 | 脚本 |
|------|---------|------|--------|------|
| dev | `development` | `com.slopus.happy.dev` | Happy (dev) | `android:dev` |
| preview | `preview` | `com.slopus.happy.preview` | Happy (preview) | `android:preview` |
| production | `production` | `com.ex3ndr.happy` | Happy | `android:production` |
| **prod-cuz** | **`prod-cuz`** | **`com.c1tas.happycuz`** | **HappyCUZ** | **`android:prod-cuz`** |

## 切换变体注意事项

不同变体的包名不同，android 目录中的 namespace/applicationId 由 `expo prebuild` 生成。**切换变体时必须重新 prebuild**：

```bash
# 从 dev 切到 prod-cuz
APP_ENV=prod-cuz yarn expo prebuild --platform android --clean

# 从 prod-cuz 切回 dev
APP_ENV=development yarn expo prebuild --platform android --clean
```

`--clean` 会删除并重新生成整个 android 目录。不加 `--clean` 可能导致残留旧包名配置。

## 签名

当前 release 构建使用 debug keystore（`android/app/debug.keystore`），足以本地安装和测试。如需正式发布到 Play Store，需在 `android/app/build.gradle` 的 `signingConfigs` 中配置正式 keystore。

## 架构选择

| 参数 | 目标 | 用途 |
|------|------|------|
| `-PreactNativeArchitectures=arm64-v8a` | 64-bit ARM | 真机（推荐） |
| `-PreactNativeArchitectures=armeabi-v7a,arm64-v8a` | 32+64-bit ARM | 兼容旧设备 |
| 不指定 | 全部（含 x86/x86_64） | 含模拟器支持，构建慢 |

x86_64 架构在 WSL2 环境下 CMake 编译可能失败，生产 APK 建议只构建 ARM。

## 安装到设备

```bash
# USB 连接
adb install android/app/build/outputs/apk/release/app-release.apk

# 无线连接（先配对）
adb connect <device-ip>:5555
adb install android/app/build/outputs/apk/release/app-release.apk
```

## 涉及的配置文件

- `app.config.js` — `prod-cuz` 变体的 name/bundleId/功能开关
  - 第 20-22 行: `prod-cuz` 使用 `./google-services-cuz.json`（独立 Firebase 项目）
  - 第 192-195 行: Expo project ID `06d51150-40e0-40fc-872b-edcefa4284c2`
- `package.json` — `android:prod-cuz` 脚本
- `google-services-cuz.json` — `com.c1tas.happycuz` 的 Firebase 配置（项目 `happy-cuz`，project_number `394007028285`）
- `google-services.json` — 其他变体的 Firebase 配置（项目 `happy-coder-9fe36`）

### Firebase 项目隔离

| 变体 | Firebase 项目 | 配置文件 | Expo 项目 |
|------|-------------|----------|-----------|
| dev / preview / production | `happy-coder-9fe36` (902947412706) | `google-services.json` | 默认 |
| **prod-cuz** | **`happy-cuz`** (394007028285) | **`google-services-cuz.json`** | `06d51150-40e0-40fc-872b-edcefa4284c2` |

### 构建后验证

Prebuild 后检查 android 目录中的 Firebase 配置是否正确：

```bash
python3 -c "
import json
with open('android/app/google-services.json') as f:
    d = json.load(f)
print(f'project: {d[\"project_info\"][\"project_id\"]}')
for c in d['client']:
    pkg = c['client_info']['android_client_info']['package_name']
    app_id = c['client_info']['mobilesdk_app_id']
    print(f'  {pkg} -> {app_id}')
"
```

预期输出（prod-cuz）：
```
project: happy-cuz
  com.c1tas.happycuz -> 1:394007028285:android:60e144e90b688882eac054
```

## Gradle 构建故障排除

### 问题 1: `Cannot list files in .gradle/buildOutputCleanup`

**症状**: 多个任务报 `java.io.IOException: Cannot list files in .../android/.gradle/buildOutputCleanup`，16+ 个任务同时失败。

**根因**: `./gradlew clean` 清理编译产物但留下损坏的 `.gradle` 元数据缓存。

**解决**:
```bash
rm -rf android/.gradle
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

**预防**: 不要单独执行 `./gradlew clean`。需要彻底清理时，直接重新 prebuild：
```bash
APP_ENV=prod-cuz yarn expo prebuild --platform android --clean
```

### 问题 2: Kotlin 并行编译竞争

**症状**: `expo-modules-core:compileReleaseKotlin` 或类似模块报 `Compilation error`，但单独编译该模块成功。

**根因**: Gradle 并行构建时多模块同时写入共享缓存导致竞争条件。首次全量构建偶发。

**解决**: 直接重试即可。第一次构建已填充编译缓存，重试时大部分任务 UP-TO-DATE：
```bash
# 重试（通常 < 1 分钟完成）
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

### 问题 3: `npx expo prebuild` 在 monorepo 中失败

**症状**: `npm error Missing script: "expo"` 或 `npx: command not found`。

**根因**: monorepo 中 `npx` 无法解析 workspace 依赖的 expo 可执行文件。

**解决**: 始终使用 `yarn expo prebuild` 代替 `npx expo prebuild`。

### 构建性能参考

| 阶段 | 首次 | 增量（缓存命中） |
|------|------|------------------|
| Prebuild | ~35s | N/A（`--clean` 总是全新） |
| Gradle assembleRelease | ~17 min | ~53s |
| APK 大小 | 108 MB (arm64 only) | — |
