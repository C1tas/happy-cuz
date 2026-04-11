# Happy Dev Android 编译 & 测试设备配置指南

## 一、编译 Dev APK

### 前置条件

- Node.js 20+
- Yarn 1.x
- JDK 17 (推荐)
- Android SDK (通过 Android Studio 或 command-line tools)
- ANDROID_HOME 环境变量已设置

### 1. 安装依赖

```bash
cd /home/administrator/happy
yarn install
```

### 2. 生成 Android 原生目录（如需重新生成）

```bash
cd packages/happy-app
APP_ENV=development yarn prebuild
```

> `prebuild` 会删除 `android/` 和 `ios/` 后重新生成。
> 当前已生成的 `android/` 是 development 变体 (包名: `com.slopus.happy.dev`)。
> 切换变体需重新 prebuild: `APP_ENV=preview yarn prebuild`

### 3. 编译 Debug APK

**方式 A: 直接 Gradle 编译（最快）**

```bash
cd packages/happy-app/android
./gradlew assembleDebug
```

输出: `android/app/build/outputs/apk/debug/app-debug.apk`

**方式 B: 仅编译 arm64（减少编译时间）**

```bash
./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a
```

**方式 C: 通过 Expo CLI（会先 bundle JS 再编译，适合完整流程测试）**

```bash
cd packages/happy-app
APP_ENV=development yarn android:dev
```

### 4. 编译 Release APK（仍使用 debug 签名）

```bash
cd packages/happy-app/android
./gradlew assembleRelease
```

输出: `android/app/build/outputs/apk/release/app-release.apk`

> 注意: release 构建仍使用 `debug.keystore` 签名，不可用于 Play Store 上架。

### 5. 安装到设备

```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

> 如果已安装正式版（`com.ex3ndr.happy`），dev 版（`com.slopus.happy.dev`）可共存，不会冲突。

### 变体对照表

| APP_ENV | 应用名 | 包名 | 用途 |
|---------|--------|------|------|
| `development` | Happy (dev) | `com.slopus.happy.dev` | 开发调试 |
| `preview` | Happy (preview) | `com.slopus.happy.preview` | 预发布测试 |
| `production` | Happy | `com.ex3ndr.happy` | 正式发布 |

---

## 二、测试手机账号配置（使用密钥恢复）

你的账号密钥: `IHKS3-K2NSI-HHWB6-YTKE4-YJIXY-MGAL4-YQIOM-SDWH4-XHAEV-GM4KF-4A`

### 步骤 1: 安装 Dev APK

将编译好的 `app-debug.apk` 安装到测试手机:
```bash
adb install app-debug.apk
```

### 步骤 2: 配置自定义服务器

1. 打开 Happy (dev) 应用
2. 在登录界面（或设置页面），找到 **Server Configuration**
   - 路径: Settings → Server Configuration
   - 也可在登录前的初始界面找到
3. 输入服务器地址: `https://happy.sg.c1tas.pw`
4. 点击 Save/验证

> 服务器会验证返回 "Welcome to Happy Server!" 才算配置成功。

### 步骤 3: 使用密钥恢复账号

1. 在登录界面，选择 **Restore Account** / **手动恢复**
   - 路径: 登录页面 → Restore → Manual Key Entry
2. 在输入框中粘贴你的密钥:
   ```
   IHKS3-K2NSI-HHWB6-YTKE4-YJIXY-MGAL4-YQIOM-SDWH4-XHAEV-GM4KF-4A
   ```
3. 点击 **Restore Account**
4. 系统会:
   - 将 Base32 格式密钥转换为 32 字节原始密钥
   - 通过 challenge-response 认证获取 bearer token
   - 保存凭证到设备安全存储 (Android EncryptedSharedPreferences)
   - 自动触发数据同步

### 步骤 4: 验证连接

恢复成功后，你应该能看到:
- 所有已有的 Sessions 列表
- 已注册的 Machines（CLI 守护进程）
- 点击任意 Session 可查看消息历史

---

## 三、多设备共用 Session 的原理

### 认证架构

```
账号 Secret Key (32字节)
    ↓ crypto_sign_seed_keypair
签名密钥对 (publicKey + privateKey)
    ↓ challenge-response
Bearer Token (每次认证生成新的)
```

- 同一个 Secret Key 可以在任意数量设备上获取 Token
- Session 属于 Account（通过 accountId），不属于特定设备
- 所有设备共享同一账号下的 Sessions

### 加密体系

- 每个 Session 有独立的 `dataEncryptionKey`，用账号公钥加密存储
- 任何持有账号 Secret Key 的设备都能解密 Session 数据
- 消息内容端到端加密，密钥在本地派生

### 实时同步

- WebSocket 连接: `user-scoped` (移动端) / `session-scoped` (CLI)
- 所有设备实时接收新消息推送
- 一台设备发送的消息，其他设备通过 WebSocket 同步接收

### 多设备操作流程

```
[电脑] happy daemon start (连接 happy.sg.c1tas.pw)
  ↓ 创建 Session
  ↓ WebSocket 推送 new-session
[手机A] 正式版 APP (同一账号) → 看到 Session
[手机B] Dev 版 APP (同一账号) → 看到 Session → 测试懒加载
```

---

## 四、CLI 侧配置（确保连接同一服务器）

在运行 daemon 的电脑上:

```bash
# 登录时指定服务器
HAPPY_SERVER_URL=https://happy.sg.c1tas.pw happy auth login

# 或设置环境变量后启动 daemon
export HAPPY_SERVER_URL=https://happy.sg.c1tas.pw
happy daemon start

# 验证连接状态
happy auth status
```

---

## 五、常见问题

### Q: Dev 版和正式版能同时安装吗？
**能**。包名不同 (`com.slopus.happy.dev` vs `com.ex3ndr.happy`)，可共存。

### Q: 同一账号在两台手机上同时在线？
**可以**。服务器通过 WebSocket 向所有 `user-scoped` 连接推送更新。

### Q: 密钥恢复失败怎么办？
- 确认服务器地址配置正确 (`https://happy.sg.c1tas.pw`)
- 确认密钥输入完整（11 组，用 `-` 分隔）
- 字符自动纠正: `0→O`, `1→I`, `8→B`, `9→G`

### Q: 如何查看 Dev 版日志？
```bash
adb logcat | grep -i happy
```

### Q: 编译报错 ANDROID_HOME 未设置？
```bash
export ANDROID_HOME=$HOME/Android/Sdk  # 或你的 SDK 路径
export PATH=$PATH:$ANDROID_HOME/platform-tools
```
