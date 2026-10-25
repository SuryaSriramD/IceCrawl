import type { SearchProvider, SearchQuery, SearchResults } from '@icecrawl/engines';

/** A search provider that returns a fixed result set and records the queries it was asked. */
export function fakeSearch(fixture: Partial<SearchResults> = {}): SearchProvider & { calls: SearchQuery[] } {
  const calls: SearchQuery[] = [];
  return {
    name: 'fake-search',
    calls,
    async search(q) {
      calls.push(q);
      return { web: [], images: [], news: [], warnings: [], ...fixture };
    },
  };
}

export const webHit = (url: string, title = 'A title', description = 'A description') => ({ url, title, description });
