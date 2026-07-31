/**
 * `__APP_VERSION__` is injected by `vite.config.ts` (`define`). Declaring it here rather than in a
 * shared ambient file keeps the register self-contained; the constant is the client version sent on
 * every sync push and compared against the server's `min_client_version`.
 */
declare const __APP_VERSION__: string;
