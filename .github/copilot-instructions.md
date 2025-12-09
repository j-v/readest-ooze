<!-- Auto-generated guidance for AI coding agents working on Readest -->
# Readest — Copilot Instructions

This file contains concise, actionable guidance for AI coding agents working in the Readest monorepo. Focus on discoverable, repository-specific conventions, workflows, and examples.

**Big Picture:**
- **Monorepo layout:** `apps/readest-app` (Next.js UI + Tauri), `packages/foliate-js` (reader engine), `packages/simplecc-wasm` (Chinese conversion), `packages/tauri/` (patched Tauri), `packages/tauri-plugins/` (custom plugins).
- **Frontend + Native:** Single Next.js app deployed as web, desktop (macOS/Windows/Linux), and mobile (iOS/Android) via Tauri. All platforms share the same React codebase; platform-specific logic branches on `isTauriAppPlatform()`, `isWebAppPlatform()`, or `hasCli()` env checks in `src/services/environment.ts`.
- **Why this structure:** Next.js provides the unified UI, Tauri/Rust handles desktop/mobile packaging and platform integration. The local Tauri copy under `packages/tauri/` (patched in `Cargo.toml` workspace) allows custom Tauri behavior; modify sparingly and only when needed for platform-specific fixes.

**Frontend architecture & state management:**
- **Context Providers** (in `src/context/`): `AuthContext` (user/token), `EnvContext` (platform detection + AppService), `SyncContext` (sync client), `PHContext` (PostHog analytics). All providers are composed in `src/components/Providers.tsx` and must wrap the app.
- **Zustand stores** (in `src/store/`): `readerStore`, `bookDataStore`, `settingsStore`, `themeStore`, `libraryStore`, `sidebarStore`, `notebookStore`, `parallelViewStore` (for dual-view reading), and others. Access via custom hooks: `useReaderStore()`, `useBookDataStore()`, etc. Stores persist to localStorage when relevant.
- **Platform-specific branching:** Use `useEnv().envConfig.getAppService()` to get `NativeAppService` (Tauri) or `WebAppService` (web). Check platform via `isTauriAppPlatform()`, `isWebAppPlatform()`, `hasCli()`, or `isPWA()` from `src/services/environment.ts`.
- **Foliate integration:** Book rendering is delegated to `foliate-js` (`packages/foliate-js/`). `readerStore` manages `FoliateView` instances. Transformers (highlight, dictionary, text-to-speech) are chained in `src/services/transformers/` and applied to rendered content.

**Key workflows & commands (reproducible):**
- Install deps (root):
  - `pnpm install` (run at repository root)
  - `git submodule update --init --recursive` (required by README)
  - **CRITICAL:** `pnpm --filter @readest/readest-app setup-vendors` — copies PDF.js and simplecc-wasm artifacts. **Must run before `pnpm dev-web` or builds will fail.**
- Run web dev server:
  - From root: `pnpm dev-web` (delegates to `@readest/readest-app`)
  - Or enter app and run: `pnpm --filter @readest/readest-app dev-web` or `cd apps/readest-app && pnpm dev-web`
- Run Tauri desktop dev:
  - `pnpm tauri` (root helper) or `cd apps/readest-app && pnpm tauri dev`
  - Mobile: `pnpm tauri ios dev` / `pnpm tauri android dev` (there are `init` helpers documented in README)
- Build production artifacts:
  - Web: `pnpm --filter @readest/readest-app build-web` or `pnpm build-web` from the app
  - Desktop: `pnpm tauri build` (the app has many platform-targeted build scripts in `apps/readest-app/package.json`)
- Testing & validation:
  - Run tests (app): `cd apps/readest-app && pnpm test`
  - Linting: `pnpm lint` (at root, lints all packages)
  - Build checks: `pnpm --filter @readest/readest-app check:all` (validates translations and regex compatibility)

**Environment conventions:**
- Many scripts use `dotenv-cli` and expect environment files: `.env.tauri`, `.env.web`, plus environment-specific `*.local` files (`.env.tauri.local`, `.env.apple-appstore.local`, etc.). Always check `apps/readest-app/package.json` scripts to see which `.env` file is used.
- The repo uses `pnpm` and workspace packages (e.g., `foliate-js` is a workspace dependency). Use `pnpm` to install and run scripts.

**Project-specific patterns to follow / watch out for:**
- Vendor/setup steps before web dev or CI: `pnpm --filter @readest/readest-app setup-vendors` copies `pdfjs` and `simplecc-wasm` artifacts into `apps/readest-app/public/vendor` — missing these will break PDF/CC features.
- Build-time checks: `check:translations` and `check:lookbehind-regex` in `apps/readest-app/package.json` validate generated output for i18n and JS compatibility; include these when validating builds.
- `patch-build-webpack`/`restore-build-original` scripts temporarily mutate `package.json` to add `--webpack` to `next build` when deploying to OpenNext — avoid committing unintended `package.json` changes from running these locally.
- Tauri is patched into the Cargo workspace (`Cargo.toml` uses `patch.crates-io`) — when changing native/tauri code, be mindful of workspace-level patches.

**Where to look for examples / authoritative config:**
- App scripts & env usage: `apps/readest-app/package.json` (many useful scripts and examples).
- Tauri integration & appstore config: `apps/readest-app/src-tauri/` (tauri config JSON files, appstore config files).
- Local Tauri source and customization: `packages/tauri/` (if you need to trace Tauri behavior or modify it locally).
- WASM and vendor setup: `packages/simplecc-wasm/` and `packages/foliate-js/` (see their `README.md` and `package.json` for build steps).
- Monorepo workspace config: top-level `pnpm-workspace.yaml` and `Cargo.toml` (Rust workspace, `patch.crates-io` entries).

**Testing & CI notes:**
- Frontend tests use `vitest` (app `test` script uses `vitest`). Run from the app with `pnpm test` inside `apps/readest-app`.
- No monorepo-level test runner is configured — run tests in the package where they live.

**Platform-specific build caveats:**
- Windows: Tauri desktop builds require Visual Studio Build Tools with the C++ workload and `clang` on PATH. See top-level `README.md` Windows section.
- macOS/iOS: Several scripts rely on `.env.apple-*` files and Xcode signing configs in `apps/readest-app/src-tauri`.

**Integrations to be aware of:**
- Cloud: `@opennextjs/cloudflare`, `wrangler` scripts and `wrangler.toml` indicate Cloudflare Workers/OpenNext usage.
- Auth/Storage: `@supabase/*` packages, `@aws-sdk/*` usage, and various platform-specific deploy scripts (Google Play/App Store) — avoid exposing secrets; follow existing `.env.*` patterns.

**Examples for common tasks (copyable):**
- Start full local web dev: `pnpm install; pnpm --filter @readest/readest-app setup-vendors; pnpm dev-web`
- Start Tauri dev (desktop): `pnpm install; pnpm --filter @readest/readest-app setup-vendors; pnpm tauri dev` (run from root or app)

**When editing code:**
- Follow the project's lint/formatting: `eslint`, `prettier`, TypeScript. There's a top-level `prettier` and `eslint` config referenced in packages.
- If changing Tauri behavior, check `packages/tauri/` and update workspace `Cargo.toml` if adding new crate dependencies.

If anything in this file is unclear or you'd like more examples (e.g., exact `.env` keys, CI steps, or an explanation of a particular script), tell me which area to expand and I'll iterate.