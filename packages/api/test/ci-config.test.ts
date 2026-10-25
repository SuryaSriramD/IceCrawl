import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const dir = join(root, '.github', 'workflows');
const rootScripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

interface Workflow {
  on?: unknown;
  jobs?: Record<string, { 'runs-on'?: string; steps?: Array<{ run?: string; uses?: string }> }>;
}

const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
// pnpm sub-commands that are not scripts of the root package.json
const BUILTIN = new Set(['install', 'add', 'exec', 'run', 'publish', 'tsx', 'dlx', 'pack']);

describe('GitHub workflows', () => {
  it('has a ci and a release workflow', () => {
    expect(files.sort()).toEqual(['ci.yml', 'release.yml']);
  });

  describe.each(files)('%s', (file) => {
    const wf = parse(readFileSync(join(dir, file), 'utf8')) as Workflow;
    const runs = Object.values(wf.jobs ?? {}).flatMap((j) => (j.steps ?? []).flatMap((s) => (s.run ? [s.run] : [])));

    it('is a workflow with jobs that have a runner and steps', () => {
      expect(wf.on).toBeTruthy();
      const jobs = Object.values(wf.jobs ?? {});
      expect(jobs.length).toBeGreaterThan(0);
      for (const j of jobs) {
        expect(j['runs-on']).toBeTruthy();
        expect((j.steps ?? []).length).toBeGreaterThan(0);
      }
    });

    it('only calls pnpm scripts that exist in the root package.json', () => {
      for (const run of runs) {
        for (const m of run.matchAll(/pnpm\s+(?!-)([\w:.-]+)/g)) {
          if (BUILTIN.has(m[1])) continue;
          expect(rootScripts[m[1]], `${file}: "pnpm ${m[1]}" is not a root script`).toBeTruthy();
        }
      }
    });

    it('only runs files that exist', () => {
      for (const run of runs) {
        for (const m of run.matchAll(/(?:node|python|tsx)\s+((?:scripts|packages)\/[\w./-]+)/g)) {
          expect(existsSync(join(root, m[1])), `${file}: ${m[1]} does not exist`).toBe(true);
        }
      }
    });
  });

  it('never publishes from the ci workflow, and publishes from release only on request', () => {
    const ci = readFileSync(join(dir, 'ci.yml'), 'utf8');
    const release = readFileSync(join(dir, 'release.yml'), 'utf8');
    expect(ci).not.toMatch(/publish/i);
    expect(release).toContain('workflow_dispatch');
    expect(release).toContain('if: ${{ inputs.publish }}');
    expect(release).toContain('--dry-run');
  });
});
