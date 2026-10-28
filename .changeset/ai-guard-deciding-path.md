---
"pi-permission-ai-guard": minor
---

**The reviewer now sees which path decided a bash path ask, and in which direction.** pi-permission-system 41 attaches a `decidingPath` request fact to each bash path ask: the path, its effect (`read`, `write` or `unproven`), and what established that effect (`syntax`, `core`, `declared-global`, `declared-project`, `retracted` or `unproven`). Both lanes now carry it: `- deciding path:` in the chat prompt, and `deciding_path` in the classifier state. The path is redacted like other command text. The fact joins the verdict cache key, because a `commandEffects` config edit can change the effect while the command text stays the same. Older hosts do not send the fact, so the line is absent there and the key holds `null`. The new key field changes every cache key once, so cached verdicts are reviewed again after the update.
