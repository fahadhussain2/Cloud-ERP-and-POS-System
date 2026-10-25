// The counter's calls to the API. A network failure is an OfflineError, so callers can tell "no internet" from a
// refusal; the status and JSON body of every answer go back as they are.

export class OfflineError extends Error {
  override name = 'OfflineError';
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export type Api = (
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  opts?: { body?: unknown; token?: string },
) => Promise<ApiResponse>;

export const httpApi =
  (fetchFn: typeof fetch = fetch, base = ''): Api =>
  async (method, path, opts = {}) => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    // The device token's scheme (platform spec §2).
    if (opts.token) headers['authorization'] = `Device ${opts.token}`;
    let res: Response;
    try {
      res = await fetchFn(base + path, {
        method,
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    } catch {
      throw new OfflineError('the API cannot be reached');
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };
