// The back office's calls to the API on its own origin (D-065). The session is an HttpOnly cookie on /api, so
// nothing here ever holds it.

export interface ApiResponse {
  status: number;
  body: unknown;
}

export type Api = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => Promise<ApiResponse>;

export const httpApi =
  (fetchFn: typeof fetch = fetch): Api =>
  async (method, path, body) => {
    const res = await fetchFn(path, {
      method,
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  };
