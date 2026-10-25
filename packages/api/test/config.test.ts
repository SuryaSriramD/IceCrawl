import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig injection mode', () => {
  it('defaults to flag', () => expect(loadConfig({}).injection).toBe('flag'));
  it.each(['off', 'flag', 'quarantine'] as const)('accepts %s', (mode) => expect(loadConfig({ ICECRAWL_INJECTION: mode }).injection).toBe(mode));
  it('rejects unknown values so a typo cannot silently disable protection', () => {
    expect(() => loadConfig({ ICECRAWL_INJECTION: 'quarantene' })).toThrow(/ICECRAWL_INJECTION/);
  });
});

describe('loadConfig language model and search', () => {
  it('has no model or search provider unless configured', () => {
    const c = loadConfig({});
    expect(c.llm).toBeNull();
    expect(c.searxngUrl).toBeUndefined();
    expect(c).toMatchObject({ llmMaxInputChars: 100_000, llmMaxOutputTokens: 4096, searchMaxScrape: 20, extractMaxPages: 20 });
  });

  it('reads a hosted model', () => {
    const c = loadConfig({ ICECRAWL_LLM_PROVIDER: 'openai', ICECRAWL_LLM_MODEL: 'gpt-x', ICECRAWL_LLM_API_KEY: 'sk-1' });
    expect(c.llm).toEqual({ provider: 'openai', model: 'gpt-x', apiKey: 'sk-1', timeoutMs: 120_000 });
    const a = loadConfig({ ICECRAWL_LLM_PROVIDER: 'anthropic', ICECRAWL_LLM_MODEL: 'claude-x', ICECRAWL_LLM_API_KEY: 'k', ICECRAWL_LLM_BASE_URL: 'https://proxy.test' });
    expect(a.llm).toMatchObject({ provider: 'anthropic', baseUrl: 'https://proxy.test' });
  });

  it('lets a local OpenAI-compatible server run without a key', () => {
    const c = loadConfig({ ICECRAWL_LLM_PROVIDER: 'openai', ICECRAWL_LLM_MODEL: 'llama3', ICECRAWL_LLM_BASE_URL: 'http://localhost:11434/v1' });
    expect(c.llm).toMatchObject({ provider: 'openai', model: 'llama3', baseUrl: 'http://localhost:11434/v1' });
    expect(c.llm?.apiKey).toBeUndefined();
  });

  it('refuses incomplete or unknown model settings so a typo cannot silently disable extraction', () => {
    expect(() => loadConfig({ ICECRAWL_LLM_PROVIDER: 'openai', ICECRAWL_LLM_API_KEY: 'k' })).toThrow(/ICECRAWL_LLM_MODEL/);
    expect(() => loadConfig({ ICECRAWL_LLM_PROVIDER: 'openai', ICECRAWL_LLM_MODEL: 'm' })).toThrow(/ICECRAWL_LLM_API_KEY/);
    expect(() => loadConfig({ ICECRAWL_LLM_PROVIDER: 'anthropic', ICECRAWL_LLM_MODEL: 'm', ICECRAWL_LLM_BASE_URL: 'http://x' })).toThrow(/ICECRAWL_LLM_API_KEY/);
    expect(() => loadConfig({ ICECRAWL_LLM_PROVIDER: 'gemini', ICECRAWL_LLM_MODEL: 'm', ICECRAWL_LLM_API_KEY: 'k' })).toThrow(/ICECRAWL_LLM_PROVIDER/);
  });

  it('validates the numeric limits', () => {
    expect(loadConfig({ ICECRAWL_LLM_MAX_INPUT_CHARS: '5000', ICECRAWL_EXTRACT_MAX_PAGES: '3' })).toMatchObject({ llmMaxInputChars: 5000, extractMaxPages: 3 });
    expect(() => loadConfig({ ICECRAWL_LLM_MAX_INPUT_CHARS: 'lots' })).toThrow(/ICECRAWL_LLM_MAX_INPUT_CHARS/);
    expect(() => loadConfig({ ICECRAWL_SEARCH_MAX_SCRAPE: '0' })).toThrow(/ICECRAWL_SEARCH_MAX_SCRAPE/);
  });

  it('reads and validates the SearXNG URL', () => {
    expect(loadConfig({ ICECRAWL_SEARXNG_URL: 'http://localhost:8080' }).searxngUrl).toBe('http://localhost:8080');
    expect(() => loadConfig({ ICECRAWL_SEARXNG_URL: 'localhost:8080' })).toThrow(/ICECRAWL_SEARXNG_URL/);
  });
});

describe('loadConfig rate limit', () => {
  it('is off by default and validated when set', () => {
    expect(loadConfig({}).rateLimitPerMinute).toBe(0);
    expect(loadConfig({ ICECRAWL_RATE_LIMIT_PER_MINUTE: '120' }).rateLimitPerMinute).toBe(120);
    expect(() => loadConfig({ ICECRAWL_RATE_LIMIT_PER_MINUTE: '-1' })).toThrow(/ICECRAWL_RATE_LIMIT_PER_MINUTE/);
    expect(() => loadConfig({ ICECRAWL_RATE_LIMIT_PER_MINUTE: 'many' })).toThrow(/ICECRAWL_RATE_LIMIT_PER_MINUTE/);
  });
});

describe('loadConfig operations settings', () => {
  it('has sensible defaults: six hours of runtime, info logs', () => {
    expect(loadConfig({})).toMatchObject({ jobMaxRuntimeHours: 6, logLevel: 'info' });
  });

  it('reads and validates them', () => {
    expect(loadConfig({ ICECRAWL_JOB_MAX_RUNTIME_HOURS: '2', ICECRAWL_LOG_LEVEL: 'warn' })).toMatchObject({ jobMaxRuntimeHours: 2, logLevel: 'warn' });
    expect(() => loadConfig({ ICECRAWL_JOB_MAX_RUNTIME_HOURS: '0' })).toThrow(/ICECRAWL_JOB_MAX_RUNTIME_HOURS/);
    expect(loadConfig({ ICECRAWL_LOG_LEVEL: '' }).logLevel).toBe('info');
    expect(() => loadConfig({ ICECRAWL_LOG_LEVEL: 'loud' })).toThrow(/ICECRAWL_LOG_LEVEL/);
  });
});

describe('loadConfig dashboard', () => {
  it('is on unless turned off', () => {
    expect(loadConfig({}).dashboard).toBe(true);
    expect(loadConfig({ ICECRAWL_DASHBOARD: 'false' }).dashboard).toBe(false);
  });
});

describe('loadConfig index providers', () => {
  it('has no providers file unless configured', () => {
    expect(loadConfig({}).providersFile).toBeUndefined();
    expect(loadConfig({ ICECRAWL_PROVIDERS_FILE: './providers.json' }).providersFile).toBe('./providers.json');
  });
});

describe('loadConfig monitors', () => {
  it('has a 15 minute floor and 50 pages per check by default, and rejects bad values', () => {
    const c = loadConfig({});
    expect(c.monitorMinIntervalMinutes).toBe(15);
    expect(c.monitorMaxPages).toBe(50);
    expect(loadConfig({ ICECRAWL_MONITOR_MIN_INTERVAL_MINUTES: '5' }).monitorMinIntervalMinutes).toBe(5);
    expect(() => loadConfig({ ICECRAWL_MONITOR_MAX_PAGES: '0' })).toThrow(/ICECRAWL_MONITOR_MAX_PAGES/);
  });
});

describe('loadConfig files and proxies', () => {
  it('has no proxies and a 50 MiB upload limit by default', () => {
    const c = loadConfig({});
    expect(c.proxiesEnhanced).toEqual([]);
    expect(c.proxiesStealth).toEqual([]);
    expect(c.maxUploadBytes).toBe(50 * 1024 * 1024);
    expect(c.proxyDomainIntervalMs).toBe(1000);
  });
  it('reads proxy pools and rejects bad entries without echoing credentials', () => {
    const c = loadConfig({ ICECRAWL_PROXIES_STEALTH: 'http://u:p@proxy.example:8080,http://p2.example:80', ICECRAWL_PROXY_DOMAIN_INTERVAL_MS: '0' });
    expect(c.proxiesStealth).toHaveLength(2);
    expect(c.proxyDomainIntervalMs).toBe(0);
    expect(() => loadConfig({ ICECRAWL_PROXIES_ENHANCED: 'socks5://u:hunter2@h:1' })).toThrow(/ICECRAWL_PROXIES_ENHANCED entry 1/);
    expect(() => loadConfig({ ICECRAWL_PROXIES_ENHANCED: 'http://10.0.0.1:3128' })).toThrow(/private/);
  });
});
