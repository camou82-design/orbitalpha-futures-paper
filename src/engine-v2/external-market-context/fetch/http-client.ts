export type FetchWithTimeoutResult = Readonly<{
    ok: boolean;
    status: number;
    body: string;
    elapsedMs: number;
    error?: string;
}>;

export async function fetchWithTimeout(
    url: string,
    timeoutMs: number,
    init?: RequestInit
): Promise<FetchWithTimeoutResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
    try {
        const res = await fetch(url, {
            ...init,
            signal: controller.signal,
            headers: {
                Accept: "application/json,text/plain,*/*",
                "User-Agent": "OrbitalphaExternalContext/1.0",
                ...(init?.headers ?? {})
            }
        });
        const body = await res.text();
        return {
            ok: res.ok,
            status: res.status,
            body,
            elapsedMs: Date.now() - started
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            status: 0,
            body: "",
            elapsedMs: Date.now() - started,
            error: message
        };
    } finally {
        clearTimeout(timer);
    }
}
