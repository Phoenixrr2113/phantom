# Contributing to Phantom

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/Phoenixrr2113/phantom.git
cd phantom
npm install
npm run build
npm test
```

## Project Structure

```
src/
├── plugin.ts              # Main unplugin entry (Vite/Webpack/Rspack)
├── analyzer.ts            # Module parser (OXC + eslint-scope)
├── classify/              # Segment classification (taint, purity, lazy detection)
├── extract/               # Code generation (stubs, chunk modules, lazy transforms)
├── runtime/               # Browser runtime ($p lazy loader)
├── types.ts               # Shared TypeScript types
└── cli.ts                 # CLI entry point

test/
├── *.unit.ts              # Unit and integration tests (vitest)
├── fixtures/              # Test fixture components

integration-test/          # Vite integration test
integration-test-webpack/  # Webpack integration test
integration-test-rsbuild/  # Rsbuild integration test
benchmarks/                # shadcn-admin benchmark suite
```

## Running Tests

```bash
# Full suite (253 tests)
npm test

# Single file
npx vitest run test/extract.unit.ts

# Watch mode
npx vitest test/extract.unit.ts
```

## Running Benchmarks

```bash
# Route-level JS comparison
npm run build
node benchmarks/compare-routes.mjs

# Lighthouse A/B comparison (requires Chrome)
node benchmarks/lighthouse-compare.mjs --runs=3
```

## Pull Request Guidelines

1. **Fork and branch** — Create a feature branch from `main`
2. **Test** — All 253+ tests must pass (`npm test`)
3. **Build** — `npm run build` must succeed
4. **Scope** — Keep PRs focused on a single change
5. **Describe** — Explain *what* changed and *why* in the PR description

## What We're Looking For

- Bug fixes with a regression test
- Performance improvements with benchmark evidence
- New bundler integrations (Farm, Turbopack, etc.)
- Documentation improvements
- Classification accuracy improvements (with test cases)

## Code Style

- TypeScript strict mode
- No external runtime dependencies (zero-dep for end users)
- Comments explain *why*, not *what*

## Reporting Issues

Please include:
- Phantom version (`npm ls phantom-build`)
- Bundler and version (Vite/Webpack/Rsbuild)
- Minimal reproduction (ideally a repo or code snippet)
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
