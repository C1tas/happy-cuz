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
APP_ENV=prod-cuz npx expo prebuild --platform android --clean

# 2. 构建 release APK（仅 arm64，跳过 x86 模拟器架构）
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

### 使用 yarn 脚本

```bash
export ANDROID_HOME=/opt/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk

# 先 prebuild（首次或包名切换后必须）
APP_ENV=prod-cuz npx expo prebuild --platform android --clean

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
APP_ENV=prod-cuz npx expo prebuild --platform android --clean

# 从 prod-cuz 切回 dev
APP_ENV=development npx expo prebuild --platform android --clean
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
- `package.json` — `android:prod-cuz` 脚本
- `google-services.json` — `com.c1tas.happycuz` 的 Firebase client 条目
