# Contributing

## Set up

```bash
pnpm install
pnpm db:up                                   # Postgres + Redis (docker compose)
pnpm --filter @icecrawl/engines exec playwright-core install chromium   # browser tests
node scripts/fetch-openapi.mjs               # Firecrawl's OpenAPI, for the conformance tests (not stored in the repo)
```

Run everything with the services up so nothing is skipped:

```bash
DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl REDIS_URL=redis://localhost:6379 pnpm test
pnpm typecheck
```

Other checks: `pnpm bench:verdicts` (verdict and injection-scan benchmark report), `node scripts/pack-smoke.mjs` (build the publishable packages, install the tarballs in an empty project and use them), `python scripts/sdk-check/check_python.py` against `pnpm tsx packages/api/test/support/conformance-server.ts` (official Python SDK).

## Ground rules

- **Clean room.** IceCrawl implements Firecrawl's public API contract and its own design. Do not copy code from Firecrawl's repository (AGPL-3.0). The API description used for conformance tests is downloaded, never committed.
- **Honest failure.** A page that is not trustworthy must not come back as content. Changes to the classifier need a corpus entry in `packages/fixtures/src/corpus.ts`; if the change fixes a known gap, remove its `knownGap` marker.
- **Tests first, and no weakened assertions.** A failing test means the code or the test is wrong: decide which, and say so in the commit message.
- **Anything added to a receipt must be replayable** by `icecrawl verify`.
- Line endings follow the `core.autocrlf` setting of your checkout; do not reformat files you do not change.

## How work is planned

Larger work is specified in `docs/superpowers/specs/` and broken into phase plans in `docs/superpowers/plans/`, each executed task by task with the full test suite run after every task. Small fixes need no plan.
