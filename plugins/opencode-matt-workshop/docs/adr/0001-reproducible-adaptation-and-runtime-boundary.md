---
status: accepted
superseded-in-part-by: 0002-standalone-native-workshop.md
---

# Separate reproducible adaptation inputs from the runtime distribution

The Workshop will keep the complete pinned upstream release as an Upstream Source Snapshot in the repository and mechanically apply tracked OpenCode adaptation rules to produce committed adapted skills from its Promoted Skills. Development Knowledge Assets such as ADRs, domain context, AI guidance, and lessons learned remain in the same repository so every development machine receives them, while an explicit distribution allowlist excludes those assets and the upstream snapshot from the Runtime Distribution. This increases repository size and requires a synchronization and packaging toolchain, but makes development reproducible without an upstream download, preserves the upstream manifest and release history, avoids the current mixed-version drift, keeps installations independent of upstream availability, and prevents development-only material from leaking into the installed product.
