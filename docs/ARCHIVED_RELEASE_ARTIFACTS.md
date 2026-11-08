# Historical Android APK artifacts

These **obsolete debug APKs were removed from the current Git tree** during the 2026-11-09 repository cleanup. They are not the current Android release and should not be installed over the v1.8.17 app. The retained Git history and original dated release reports make previous evidence auditable. Current APKs should be rebuilt from source or published as dedicated, clearly labelled GitHub Release assets, not committed to the source tree.

| Historical APK | SHA-256 | Last tracked change commit |
| --- | --- | --- |
| `sme105-dcl-studio-1.8.0-debug.apk` | `7326c1a1ccc81e639be6eb8c89bffd360a6d44b3d669289d7ec5b607ba752ca9` | [`a53c80eac7`](https://github.com/0Maxbon0/sme105-dcl-studio/commit/a53c80eac77306fb9ffdaeadb527277bfb6a5ccc) |
| `sme105-dcl-studio-1.8.1-debug.apk` | `b6bd6462d2fb5729a68a85cae5e71535f0d22bdfab6657e345d18bd7815f8c1c` | [`4fc368cfee`](https://github.com/0Maxbon0/sme105-dcl-studio/commit/4fc368cfeeba0c6259ade4db67cf5913d74c873c) |
| `sme105-dcl-studio-1.8.2-debug.apk` | `4e373d549d4e454344442bf91bd24f8af98a28a38b517a76f73f961cc7e99626` | [`fbdfb9d432`](https://github.com/0Maxbon0/sme105-dcl-studio/commit/fbdfb9d432e2b5a254b6a23ae50362c1b9dbaed3) |
| `sme105-dcl-studio-1.8.3-debug.apk` | `4c9bfed753a8f7039ff093fe4457e74573c2cb0436e1a70792dc2f357caa6e2c` | [`da73cb7a2d`](https://github.com/0Maxbon0/sme105-dcl-studio/commit/da73cb7a2dd0b38387ad42ca88926746fa9cfc1b) |
| `sme105-dcl-studio-1.8.4-debug.apk` | `9988253faee8e8bf43294fe74f88c1a2fc7baf78d62b57660a6fa6808aa571fa` | [`d437bfb5b0`](https://github.com/0Maxbon0/sme105-dcl-studio/commit/d437bfb5b048e9e3b3763e6d76aeac9ba39508c5) |
| `sme105-dcl-studio-1.8.6-debug.apk` | `67c9cd52571dc14ea22060ac420f9dea4d152159ad7c9931c19bfaf86143f902` | [`e6e822fd01`](https://github.com/0Maxbon0/sme105-dcl-studio/commit/e6e822fd012fe4ca8c1ce1e4e22c2e28abd03559) |
| `sme105-dcl-studio-1.8.7-debug.apk` | `68a5b768542a56ce8284934ea6e437f2045dc608aa3989054d0c6328f6d92e57` | [`bf6c2a1a49`](https://github.com/0Maxbon0/sme105-dcl-studio/commit/bf6c2a1a49b4b8e4f17d9ea8c1df79d65006570b) |
| `sme105-dcl-studio-1.8.8-debug.apk` | `81e3be54e133b41b17ed9185860fb3b8781419de6e682cf4cb3ee27115082d04` | [`5bf04b2db2`](https://github.com/0Maxbon0/sme105-dcl-studio/commit/5bf04b2db2fd1501f906052e3925352969ad1757) |
| `sme105-dcl-studio-1.8.9-debug.apk` | `49d1d5c25655fb2045c961ee15eac7c555d4513381cb8ff5b60fd562b1d5c30b` | [`5013838c57`](https://github.com/0Maxbon0/sme105-dcl-studio/commit/5013838c571a1bf86d1383b51f9ebb2738aaa5e0) |

To recover one for historical analysis from its recorded commit (trusted local workstation only):

```bash
git show <commit-sha>:artifacts/android/<historical-name>.apk > /private/path/recovered-debug.apk
sha256sum /private/path/recovered-debug.apk
```

The historic JSON verification records and their published hashes are retained, but their `apkPath` values identify **historical paths**, not files in the current checkout. Never discard Android app/IndexedDB data to trial an obsolete debug APK.
