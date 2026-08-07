---
name: probe
description: A synthetic skill payload, used to test resource serving.
---

# probe

The engine serves a consuming skill's SKILL.md and references/ over MCP, because
most hosts carry neither into the model's context on their own. This payload
exists so that behaviour can be tested without borrowing a real skill's
documentation — webindex ships no SKILL.md of its own, being an engine rather
than a skill.

Body long enough to be a plausible document, so the description extractor has
real prose to pull its first paragraph from rather than a title.
