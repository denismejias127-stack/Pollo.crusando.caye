---
name: Audio background lifecycle
description: Background music must pause when the Expo app or its web container loses focus and resume only after returning.
---

For apps using expo-audio, treat native AppState changes and web document visibility/window focus changes as the same audio lifecycle. Keep a ref marking audio as suspended so a loaded-player auto-start effect cannot restart music while the page is hidden.

**Why:** URL-to-APK wrappers run the Expo web bundle inside a WebView, where native AppState alone does not cover browser-style navigation, tab visibility, minimize, or WebView focus changes.

**How to apply:** Pause looping music and ambience on background, visibility hidden, blur, and pagehide; resume only on active/visible/focus, respecting the user's mute setting and current game state.