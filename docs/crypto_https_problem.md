# Web Crypto API 在非安全上下文中不可用

## 问题

浏览器的 Web Crypto API 中有多个接口仅在 **Secure Context**（安全上下文）中可用：

- `crypto.subtle` — 所有对称/非对称加密操作
- `crypto.randomUUID()` — UUID v4 生成

**安全上下文** 仅限于：
- `https://` 来源
- `http://localhost` / `http://127.0.0.1`

开发环境常见的 `http://192.168.x.x:8081` 等局域网地址 **不是** 安全上下文，上述 API 会直接抛出异常。

而 `crypto.getRandomValues()` 是例外——它在所有上下文中均可用。

## 受影响的依赖

| 依赖 | 调用的 API | 失败表现 |
|------|-----------|---------|
| `rn-encryption` → `web-secure-encryption` | `crypto.subtle.encrypt/decrypt` | AES-GCM 加解密失败，session 数据无法解密 |
| `expo-crypto` → `randomUUID()` | `crypto.randomUUID()` | `getCrypto(...).randomUUID is not a function`，无法发送消息或生成加密标识 |

## 解决方案：`.web.ts` 平台覆盖

利用 Metro bundler 的平台文件解析机制（自动优先加载 `.web.ts` 后缀），为受影响的模块提供不依赖安全上下文 API 的纯 JS 实现。

### 已修复的模块

#### 1. AES-GCM 加解密

- **原始文件**: `sources/encryption/aes.ts` — 调用 `rn-encryption`（底层用 `crypto.subtle`）
- **Web 覆盖**: `sources/encryption/aes.web.ts` — 使用 `@noble/ciphers/aes.js`（纯 JS 实现）
- **关键点**: wire format 保持一致 `base64(IV[12字节] + ciphertext + auth_tag)`

#### 2. UUID 生成

- **原始文件**: `sources/utils/uuid.ts` — re-export `expo-crypto` 的 `randomUUID`
- **Web 覆盖**: `sources/utils/uuid.web.ts` — 使用 `crypto.getRandomValues()` 手动构建 UUID v4
- **影响范围**: `sync/sync.ts`、`sync/encryption/encryption.ts` 中所有 `randomUUID()` 调用

### 不受影响的模块

| 模块 | 原因 |
|------|------|
| `encryption/libsodium.lib.web.ts` | 使用 `libsodium-wrappers`（纯 JS），不依赖 Web Crypto |
| `encryption/hmac_sha512.web.ts` | 使用 `@noble/hashes`（纯 JS），不依赖 Web Crypto |
| `encryption/base64.ts` | 使用 `atob`/`btoa`，所有上下文可用 |
| `encryption/text.ts` | 使用 `TextEncoder`/`TextDecoder`，所有上下文可用 |

## 添加新加密功能时的检查清单

1. **不要直接使用 `crypto.subtle`** — 使用已有的 `.web.ts` 封装
2. **不要直接使用 `crypto.randomUUID()`** — 使用 `@/utils/uuid`
3. **`crypto.getRandomValues()` 可以直接使用** — 这是唯一在所有上下文中可用的 Crypto API
4. **新增 `expo-crypto` 的 import 时务必检查** — 其 web 实现可能依赖安全上下文 API
5. **纯 JS 库可安全使用** — `@noble/ciphers`、`@noble/hashes`、`libsodium-wrappers` 均不依赖 Web Crypto

## 参考

- [MDN: Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
- [MDN: crypto.subtle 兼容性说明](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/subtle)
- [Expo: Platform-specific extensions](https://docs.expo.dev/router/advanced/platform-specific-modules/)
