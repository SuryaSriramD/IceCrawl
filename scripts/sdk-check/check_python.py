"""Runs the official Firecrawl Python SDK against the IceCrawl conformance server.

Usage: ICECRAWL_API_URL=http://127.0.0.1:3010 python scripts/sdk-check/check_python.py
(start the server first: pnpm tsx packages/api/test/support/conformance-server.ts)
"""
import os
import sys

from firecrawl import Firecrawl

URL = os.environ.get("ICECRAWL_API_URL", "http://127.0.0.1:3010")
KEY = os.environ.get("ICECRAWL_API_KEY", "ic-jobs")
E = "https://example.com"
app = Firecrawl(api_key=KEY, api_url=URL)
failures = []


def check(name, fn):
    try:
        fn()
        print(f"ok    {name}")
    except Exception as err:  # noqa: BLE001 - report every failure, then exit non-zero
        failures.append(name)
        print(f"FAIL  {name}: {type(err).__name__}: {err}")


def scrape():
    doc = app.scrape(f"{E}/a", formats=["markdown", "links"])
    assert "Real readable sentence" in doc.markdown, "markdown missing"
    assert doc.metadata.source_url == f"{E}/a", f"sourceURL was {doc.metadata.source_url}"


def scrape_untrustworthy():
    try:
        app.scrape(f"{E}/walled")
    except Exception as err:  # noqa: BLE001
        assert "captcha" in str(err).lower(), f"error did not say captcha: {err}"
        return
    raise AssertionError("a captcha page was returned as content")


def map_site():
    result = app.map(f"{E}/")
    urls = [l.url for l in result.links]
    assert f"{E}/a" in urls, urls


def crawl():
    job = app.crawl(f"{E}/", limit=5, sitemap="skip", poll_interval=1, timeout=30)
    assert job.status == "completed", job.status
    assert len(job.data) == 3, len(job.data)


def batch():
    job = app.batch_scrape([f"{E}/a", f"{E}/b"], formats=["markdown"], poll_interval=1, wait_timeout=30)
    assert job.status == "completed", job.status
    assert len(job.data) == 2, len(job.data)


def search():
    result = app.search("anything", limit=3)
    assert result.web and result.web[0].url == f"{E}/a", result


def extract():
    result = app.extract(
        urls=[f"{E}/a"],
        prompt="Find a fact",
        schema={"type": "object", "properties": {"fact": {"type": "string"}}},
        poll_interval=1,
        timeout=30,
    )
    assert result.status == "completed", result.status
    assert result.data == {"fact": "Real readable sentence about a real topic"}, result.data


for name, fn in [
    ("scrape", scrape),
    ("scrape of a captcha page raises", scrape_untrustworthy),
    ("map", map_site),
    ("crawl", crawl),
    ("batch_scrape", batch),
    ("search", search),
    ("extract", extract),
]:
    check(name, fn)

if failures:
    print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
    sys.exit(1)
print("all checks passed")
