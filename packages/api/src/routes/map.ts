import type { FastifyInstance } from 'fastify';
import { IceCrawlError, normalizeMapRequest } from '@icecrawl/core';
import { assertUrlAllowed, type Engine } from '@icecrawl/engines';
import type { ScraperConfig } from '@icecrawl/scraper';
import { mapSite, type MapDeps } from '../jobs/map';

export interface MapRouteDeps {
  engines: readonly Engine[];
  scraper: ScraperConfig;
  map?: Pick<MapDeps, 'fetcher'>;
}

export function registerMapRoute(v2: FastifyInstance, deps: MapRouteDeps): void {
  v2.post('/map', async (req) => {
    if (!deps.map) throw new IceCrawlError('NOT_IMPLEMENTED', 'Map is not configured on this server.');
    const { request, warnings } = normalizeMapRequest(req.body);
    assertUrlAllowed(request.url, deps.scraper.allowPrivateNetworks);
    const links = await mapSite({ engines: deps.engines, scraper: deps.scraper, fetcher: deps.map.fetcher }, request);
    return { success: true, links, ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}) };
  });
}
