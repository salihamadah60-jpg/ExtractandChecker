import { QueryClient, QueryFunction } from "@tanstack/react-query";

function getWorkspaceKey(): string {
  return localStorage.getItem("workspace_key") ?? "";
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (data) headers["Content-Type"] = "application/json";
  const key = getWorkspaceKey();
  if (key) headers["X-Workspace-Key"] = key;

  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const key = getWorkspaceKey();
    const headers: Record<string, string> = {};
    if (key) headers["X-Workspace-Key"] = key;

    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
      headers,
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

/**
 * Retry policy for background polling queries.
 * Retries on network errors and 5xx responses, not on 4xx (client errors).
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  const msg = error instanceof Error ? error.message : String(error);
  if (/^4[0-9][0-9]:/.test(msg)) return false;
  return true;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: shouldRetry,
      retryDelay: (attemptIndex) => Math.min(2000 * 2 ** attemptIndex, 15_000),
    },
    mutations: {
      retry: false,
    },
  },
});
