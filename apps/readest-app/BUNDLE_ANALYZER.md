# Bundle Analyzer Guide

## Running Bundle Analysis

The app uses `@next/bundle-analyzer` to visualize bundle sizes and dependencies. By default, analysis is **disabled**. To run it:

```bash
cd apps/readest-app
NEXT_SKIP_TURBOPACK=1 NEXT_WEBPACK_USE_LEGACY=true ANALYZE=true NODE_OPTIONS="--max-old-space-size=8192" pnpm exec next build --webpack
```

### Why all those flags?

- `NEXT_SKIP_TURBOPACK=1` + `--webpack`: Forces Webpack builder (analyzer only works with Webpack, not Turbopack)
- `NEXT_WEBPACK_USE_LEGACY=true`: Ensures legacy Webpack compatibility
- `ANALYZE=true`: Enables the analyzer plugin (set in `next.config.mjs`)
- `NODE_OPTIONS="--max-old-space-size=8192"`: Increases Node heap size to avoid OOM during large builds

## Viewing Reports

After the build completes, open the interactive reports in your browser:

- **Client bundle**: `.next/analyze/client.html`

These show:
- Bundle sizes for each page/chunk
- Which dependencies are included where
- Tree-shaking and code-splitting opportunities

## Important Notes

- This build uses **Webpack**, but production (`pnpm preview/deploy`) runs **Turbopack**. Bundle compositions may differ slightly between the two.
- For accurate production analysis, check the actual Turbopack output or use `pnpm build-web` (which uses Turbopack) and compare visually.
- The Cloudflare Worker deployment currently forces Webpack via `patch-build-webpack` script in package.json.

## Troubleshooting

**Error: "This build is using Turbopack, with a webpack config and no turbopack config"**
- You're still running Turbopack. Make sure you included all flags above, especially `NEXT_SKIP_TURBOPACK=1 --webpack`.
- Check the build output banner: it should say `Next.js … (webpack)`, not `(Turbopack)`.

**Build runs out of memory**
- The `NODE_OPTIONS` flag is already set to 8192 MB. If it still fails, try 16384:
  ```bash
  NODE_OPTIONS="--max-old-space-size=16384" NEXT_SKIP_TURBOPACK=1 ...
  ```

**No `.next/analyze` directory after build**
- Verify `ANALYZE=true` was set and the build completed successfully.
- Check that the analyzer plugin is enabled in `next.config.mjs`: `enabled: process.env.ANALYZE === 'true'`
