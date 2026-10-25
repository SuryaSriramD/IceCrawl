# Agent

`POST /v2/agent` runs a research agent: it searches, reads pages and answers your prompt, optionally as JSON that matches your schema. It needs a language model (`ICECRAWL_LLM_*`); searching also needs SearXNG (`ICECRAWL_SEARXNG_URL`).

```bash
ID=$(curl -s -X POST localhost:3002/v2/agent -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"prompt":"Which license does the project use?","urls":["https://github.com/icecrawl/icecrawl"],"effort":"low"}' | jq -r .id)
curl -s localhost:3002/v2/agent/$ID -H "Authorization: Bearer $KEY"          # processing | completed | failed
curl -s localhost:3002/v2/agent/$ID/trace -H "Authorization: Bearer $KEY"    # every step, while it runs and after
```

- Routes: `POST/GET /v2/agent`, `GET/DELETE /v2/agent/{id}`, `GET /v2/agent/{id}/trace`, `GET /v2/agent/{id}/snapshots/{snapshotId}` (the final answer as stored). A cancelled run reads as `failed` with code `cancelled`.
- Options: `prompt` (required), `urls`, `schema`, `strictConstrainToURLs` (read only the listed URLs, no search), `effort` (`low` 4, `medium` 8, `high` 14 turns). `model`, `maxCredits`, `webhook`, `threadId`, `mode`, `exchange` and the other Firecrawl options are accepted and named in `warning`; IceCrawl has no credits, model choice (the configured model is used) or paid providers.
- Every page the agent reads goes through the normal scrape pipeline: it gets a verdict, a signed receipt and the injection scan. Blocked, captcha, login-wall and quarantined pages are never shown to the model; it is only told that the page could not be read. The completed result lists the `sources` (URL and receipt id) the agent read.
- The trace follows Firecrawl's event format (`run.started`, `tool_call.started/finished`, `reasoning.summary`, `run.finished`, ...). Reasoning summaries are the model's own one-line notes; page text is never copied into the trace.
- The agent can only search, read pages and answer, so nothing it does changes anything on the web and there is no approval step. It cannot use interact sessions (they live in the API process; the agent runs in a worker).

## Safety limits

- The model is told that page and search text is untrusted data and must not be followed, and each page is wrapped in a block with a random boundary. That lowers the risk of prompt injection; it does not remove it. A hostile page could still steer which URL the agent reads next, so use `strictConstrainToURLs` when you can list the pages.
- Page text shown to the model is cut at 20 000 characters per page; a run is bounded by its turn limit.
- Extracted values are not grounded the way `/extract` results are; for facts you rely on, follow the `sources` receipts or use `/extract`.
