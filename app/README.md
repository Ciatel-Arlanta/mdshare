# mdshare app

The phone side of mdshare: an Expo (React Native) markdown reader built with gluestack-ui v5.

- `src/app/`: screens (Expo Router)
- `src/lib/`: pairing, discovery, the laptop client, sources, offline cache, state
- `src/components/`: the reader, file tree, and bottom sheets; `ui/` holds the gluestack components
- `reader/`: the HTML page that renders markdown inside a WebView (markdown-it, highlight.js, KaTeX, Mermaid). `npm run build:reader` builds it into `reader/dist`, and a config plugin copies that into the Android assets.

## Build an APK

Requirements: Node, the Android SDK, and a JDK. Android Studio's bundled JBR works.

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
npm install
npm run prebuild          # builds the reader, generates android/
cd android
.\gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

The APK is written to `android/app/build/outputs/apk/release/app-release.apk`. It's signed with the debug key, which is fine for installing on your own phone with `adb install`.

## Develop

```powershell
npx expo run:android      # dev build on a connected phone or emulator
npm run typecheck
npm run lint
```

mDNS discovery and the camera need a real device. The Android emulator doesn't pass multicast through.
