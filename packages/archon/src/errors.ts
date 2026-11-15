/**
 * Archon's refusals: `{detail, code, params}` with a 4xx status, e.g. 400
 * `tournament.wrong_state` with `{expected, current}`, or 403 for a token used on another
 * tournament. Network failures and 5xx are `retryable`.
 */
export class ArchonError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly params: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ArchonError';
  }

  /** Worth trying again later: Archon was unreachable or failed, not a refusal. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  static async from(res: Response): Promise<ArchonError> {
    const text = await res.text();
    let body: { detail?: unknown; code?: unknown; params?: unknown; error?: unknown } = {};
    try {
      body = JSON.parse(text);
    } catch {}
    const detail =
      typeof body.detail === 'string' ? body.detail : text.slice(0, 200) || res.statusText;
    const code =
      typeof body.code === 'string'
        ? body.code
        : typeof body.error === 'string'
          ? body.error
          : `http_${res.status}`;
    const params =
      body.params && typeof body.params === 'object' ? (body.params as Record<string, string>) : {};
    return new ArchonError(res.status, code, detail, params);
  }
}
