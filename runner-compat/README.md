# Offline dependency fixtures

The runner fetches these dependencies while building its image. User builds and tests remain offline.

- `sdk22`: compatibility dependencies for SDK 22 projects.
- `bls`: the SDK 25.1 BLS example manifest and its complete lockfile, including the older rand 0.7 test dependency tree. The library here is only a stub for dependency fetching; it is not the example implementation.

Keep each manifest and lockfile together. Fetch with `--locked` so an image rebuild cannot silently replace the versions required by an imported example. When adding a fixture, add its fetch command to `runner.Dockerfile`, rebuild with `npm run runner:build`, and verify the original example using the isolated build/test runner. A successful fetch alone does not verify compilation.
