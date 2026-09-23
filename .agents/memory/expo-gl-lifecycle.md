---
name: Expo GL lifecycle
description: WebGL screen transitions need explicit renderer and animation cleanup when switching between the game, shop, and previews.
---

When an Expo GL screen is replaced by a shop, achievement panel, or character preview, cancel its animation frame, dispose its renderer, clear scene references, and mount only one GL context at a time. On native, leave a short gap before mounting the replacement GLView and give it a new key; on web wrappers, prefer switching scenes inside one persistent canvas.

**Why:** Leaving the prior render loop and scene alive can leave native controls visible over a black framebuffer after returning from an overlay; replacing GLViews in the same render pass can also produce a black framebuffer on Android.

**How to apply:** Treat every GLView transition as a lifecycle boundary; rebuild the scene on the next context and preserve only gameplay state such as position, score, and death status. A web shop preview should share the game renderer rather than mount a second GLView.