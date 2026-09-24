---
name: Expo GL performance profiles
description: Performance tradeoffs for the Three.js game renderer inside URL-to-APK WebViews.
---

Use an adaptive low-power profile for Android WebViews when device memory or CPU hints indicate a modest device. Preserve the visual scene and emissive details, but avoid point lights, use a smaller shadow map with cheaper filtering, and stabilize the render loop rather than allowing irregular overloaded frames.

**Why:** In a URL-to-APK WebView, evening/night lighting adds many point lights and shadow work on the device GPU; the server does not render the Three.js scene, so server changes cannot fix this class of lag.

**How to apply:** Keep full-quality lighting on capable devices. For low-power WebViews, retain the same time-of-day palette and visible headlights/windows while reducing only expensive per-frame calculations.