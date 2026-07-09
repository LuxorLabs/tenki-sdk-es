# TypeScript Sandbox SDK

- This package is not in root `pnpm-workspace.yaml`; use its local `package-lock.json` and `npm run typecheck|test|build`.
- `tools/scripts/check-sdk-parity.sh` compares committed refs; commit TS parity edits before relying on it locally.
- `hostPortTunnel` lifecycle is observable via `terminated`; use `resilientHostPortTunnel` for auto-reconnect. Treat `engine_draining` as immediate retry with no backoff.
- Custom CA roots must be threaded into both `connect-node` (`nodeOptions.ca`) and SSH `ws` (`ca`); gRPC transport options do not affect WebSocket TLS.
- High-level exec/stream wrappers that do not expose stdin must send `stdinClose`; only low-level run/stream APIs leave stdin open for callers.
- `stdinClose` is not request-stream EOF. Keep the run request stream open for later signal/kill frames; close it only when the run ends/errors.
- `pause()`/`resume()` must clear data-plane endpoint/client/credential state. Background credential renewal stops on `state=PAUSED`; `CREATING`/`RESUMING` stay retryable.
