export const ERROR_STATUS = {
  VALIDATION: 400,
  UNSUPPORTED_OPTION: 400,
  SSRF_BLOCKED: 400,
  UNAUTHORIZED: 401,
  ROBOTS_DISALLOWED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TIMEOUT: 408,
  NO_ENGINE: 422,
  ACTION_FAILED: 422,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
  DNS: 502,
  SSL: 502,
  RESPONSE_TOO_LARGE: 502,
  BLOCKED: 502,
  CAPTCHA: 502,
  LOGIN_WALL: 502,
  EMPTY_CONTENT: 502,
  SOFT_404: 502,
  TRUNCATED: 502,
  UNCERTAIN: 502,
  TARGET_ERROR: 502,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class IceCrawlError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'IceCrawlError';
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}
