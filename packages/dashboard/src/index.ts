import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the dashboard's static files live. They are plain ES modules and CSS: there is no build step. */
export const dashboardDir = fileURLToPath(new URL('../public/', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export interface DashboardFile {
  body: Buffer;
  type: string;
}

/**
 * Reads the whole dashboard into memory, keyed by URL path below /dashboard ("" is the index page). Only files found here
 * are ever served, so a request path can never reach anything else on disk.
 */
export function loadDashboard(dir: string = dashboardDir): Map<string, DashboardFile> {
  const files = new Map<string, DashboardFile>();
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (TYPES[extname(entry.name)]) files.set(path === 'index.html' ? '' : path, { body: readFileSync(join(dir, path)), type: TYPES[extname(entry.name)] });
    }
  };
  walk('');
  return files;
}

/**
 * The dashboard handles an API key and shows text written by third parties, so it runs under a policy that allows
 * only its own scripts and styles and talks only to its own origin.
 */
export const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
