import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import AjvModule from 'ajv';

const Ajv = (AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule;

export function openApiPath(): string {
  return process.env.ICECRAWL_OPENAPI_FILE ?? join(process.cwd(), '.cache', 'v2-openapi.json');
}

export const hasOpenApi = (): boolean => existsSync(openApiPath());

export interface ResponseValidator {
  /** Errors for `body` against the documented response of `method path` with `status`; [] when it conforms. */
  validate(path: string, method: 'get' | 'post' | 'patch' | 'delete', status: number, body: unknown): string[];
}

export function loadResponseValidator(): ResponseValidator {
  const doc = JSON.parse(readFileSync(openApiPath(), 'utf8')) as {
    paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }>>;
  };
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, discriminator: true });
  ajv.addSchema(doc, 'openapi');
  const escape = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
  return {
    validate(path, method, status, body) {
      const response = doc.paths[path]?.[method]?.responses?.[String(status)];
      if (!response) return [`${method.toUpperCase()} ${path} documents no ${status} response`];
      const schema = response.content?.['application/json']?.schema;
      if (!schema) return [];
      const ref = `openapi#/paths/${escape(path)}/${method}/responses/${status}/content/application~1json/schema`;
      const validate = ajv.getSchema(ref) ?? ajv.compile({ $ref: ref });
      return validate(body) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
    },
  };
}
