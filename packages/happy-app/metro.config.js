const { getDefaultConfig } = require("expo/metro-config");
const os = require("os");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// Add support for .wasm files (required by Skia for all platforms)
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/installation/
config.resolver.assetExts.push('wasm');

// Force libsodium to resolve CJS entry on web.
// The ESM build (libsodium.mjs) uses import.meta.url which causes a SyntaxError
// because Metro bundles web as a regular <script>, not <script type="module">.
const path = require("path");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'libsodium') {
    return {
      filePath: path.resolve(__dirname, 'node_modules/libsodium/dist/modules/libsodium.js'),
      type: 'sourceFile',
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Enable inlineRequires for proper Skia and Reanimated loading
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/web/
// Without this, Skia throws "react-native-reanimated is not installed" error
// This is cross-platform compatible (iOS, Android, web)
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true, // Critical for @shopify/react-native-skia
  },
});

// Auto-detect LAN IP so remote devices (Android via adb, browsers on other machines)
// can connect to the Metro dev server's WebSocket without hardcoding localhost.
// This replaces the need for manual REACT_NATIVE_PACKAGER_HOSTNAME or --host flags.
if (!process.env.REACT_NATIVE_PACKAGER_HOSTNAME) {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        process.env.REACT_NATIVE_PACKAGER_HOSTNAME = iface.address;
        break;
      }
    }
    if (process.env.REACT_NATIVE_PACKAGER_HOSTNAME) break;
  }
}

module.exports = config;