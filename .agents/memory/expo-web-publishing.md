---
name: Expo web publishing
description: Publishing the browser version of an Expo mobile artifact requires a web export and static server, not an Expo Go landing page.
---

For this project, the browser URL must serve the output of `expo export --platform web`; an Expo Go bundle/QR landing page is not the same as a playable web app.

**Why:** The original mobile artifact production flow built iOS/Android Expo Go bundles, so publishing could succeed without producing a browser game. Metro also cannot assume port 8081 because the mockup preview may already use it.

**How to apply:** Keep native-only modules behind `.native` platform files, build the web export into the production static directory, serve `index.html` with SPA fallback, and select a free Metro port during native/web build steps.