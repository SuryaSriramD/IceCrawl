# Releasing

The release workflow (`.github/workflows/release.yml`) only publishes when started by hand with "publish" ticked; the default is a dry run. Nothing in this repository publishes by itself.

## Decide once, before the first release

These cannot be guessed by the code and must be set by the owner:

1. **Repository URL.** Done: the packages and the crawler's user agent point at https://github.com/SuryaSriramD/IceCrawl. Change them if the repository moves.
2. **npm scope.** The packages are named `@icecrawl/sdk`, `@icecrawl/mcp` and `@icecrawl/cli`. The `@icecrawl` scope must exist on npm and be owned by you. If it is taken, rename the three packages (and the README snippets) before publishing.
3. **Secrets.** Create the GitHub environment `npm` and the secret `NPM_TOKEN` (automation token). `--provenance` needs the repository to be public or the account to support private provenance.
4. **Security contact.** Enable private vulnerability reporting on the repository (SECURITY.md points to it).

## Each release

1. Update `CHANGELOG.md`; set the version in `packages/sdk`, `packages/mcp` and `packages/cli` (keep them equal).
2. Run the full local gate with the services up:
   ```bash
   DATABASE_URL=postgres://icecrawl:icecrawl@localhost:5432/icecrawl REDIS_URL=redis://localhost:6379 pnpm release:check
   ```
   It runs the type check, every test (including conformance, the verdict benchmark and the official Node SDK), builds the packages and installs the tarballs in an empty project.
3. Push a tag or the branch, wait for the `ci` workflow (it also runs the official Python SDK and the Docker build).
4. Start the `release` workflow with "publish" off and read the dry-run output (file lists, versions).
5. Start it again with "publish" on.
6. Create the GitHub release from the changelog entry.

## What gets published

- `@icecrawl/sdk` (`.` and `./verify`), `@icecrawl/mcp` (`icecrawl-mcp` binary and the server factory), `@icecrawl/cli` (`icecrawl verify`). Workspace packages are bundled into them; their third-party dependencies are listed in each `package.json`.
- The API server is not published to npm: run it from the repository or the Docker image (`docker build .`).
- `pnpm pack`/`pnpm publish` apply each package's `publishConfig` (the `dist/` exports); plain `npm pack` does not. Always use pnpm.
