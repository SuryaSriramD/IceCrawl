# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use the repository's "Report a vulnerability" button (GitHub private security advisories). Include what you found, how to reproduce it and the version. You will get an answer within a week.

## What IceCrawl defends against, and what it does not

IceCrawl fetches untrusted web pages on behalf of its users and, through MCP, hands the result to language models. The defences are:

- **SSRF:** requests to private, loopback and link-local addresses are refused after DNS resolution and on every redirect; the browser engine is forced through a proxy that applies the same rule at connect time. `ICECRAWL_ALLOW_PRIVATE_NETWORKS=true` switches this off: use it only for local testing. For defence in depth run the server in a container with restricted egress.
- **Prompt injection:** pages and search snippets are scanned (hidden text, instruction-like phrases, invisible characters, encoded payloads). The scanner is heuristic: it lowers risk, it does not remove it. MCP output wraps page text in untrusted-content markers and never includes page text in error results. `ICECRAWL_INJECTION=quarantine` withholds high-severity pages.
- **Dishonest scrapes:** blocked, captcha, login-wall, empty, soft-404 and truncated pages are reported as failures, and every result has a signed receipt that can be verified offline.
- **Credentials:** API keys are stored as hashes; the language-model key is only sent to the configured endpoint and is redacted from errors; the Authorization header is redacted from logs.
- **Webhooks:** targets are SSRF-checked and deliveries are HMAC-signed.

Not covered: a compromised host, a malicious operator (the operator sees all scraped content and can read the signing key), model behaviour (an extraction model that is talked into emitting text that really is on a page passes the grounding check), and denial of service beyond the optional per-key rate limit, body-size limits and job runtime limit.

## Operating safely

- Keep `ICECRAWL_USE_AUTH=true` (the default) on anything reachable from a network. Create keys with `pnpm --filter @icecrawl/api keys:create <name>`.
- Back up the signing key file: without it you cannot rotate keys cleanly; with it an attacker can forge receipts.
- Do not expose the SearXNG service from `docker-compose.yml` publicly; it is bound to 127.0.0.1.
- Run the MCP HTTP transport only with `ICECRAWL_MCP_TOKEN` set.
