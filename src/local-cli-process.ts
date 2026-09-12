import { spawn } from "node:child_process";

export const LOCAL_CLI_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const LOCAL_CLI_MAX_STDERR_BYTES = 32 * 1024;

export class LocalCliProcessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalCliProcessError";
  }
}

export interface LocalCliProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}

export interface LocalCliProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes?: number;
}

export interface LocalCliProcessTransport {
  run(request: LocalCliProcessRequest): Promise<LocalCliProcessResult>;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export class SpawnLocalCliProcessTransport implements LocalCliProcessTransport {
  constructor(private readonly spawnImpl: typeof spawn = spawn) {}

  async run(request: LocalCliProcessRequest): Promise<LocalCliProcessResult> {
    if (request.signal.aborted) {
      throw request.signal.reason instanceof Error
        ? request.signal.reason
        : new LocalCliProcessError("LOCAL_CLI_CANCELED", "Local CLI process canceled");
    }

    const maxStdoutBytes = request.maxStdoutBytes ?? LOCAL_CLI_MAX_STDOUT_BYTES;

    return await new Promise<LocalCliProcessResult>((resolvePromise, rejectPromise) => {
      let child: any;
      try {
        child = this.spawnImpl(request.command, request.args, {
          cwd: request.cwd,
          env: request.env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false
        });
      } catch (error) {
        rejectPromise(new LocalCliProcessError(
          "LOCAL_CLI_SPAWN_FAILED",
          `Could not start ${request.command}: ${error instanceof Error ? error.message : String(error)}`
        ));
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let forceKill: ReturnType<typeof setTimeout> | null = null;

      const timeout = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill?.("SIGTERM");
        forceKill = setTimeout(() => child.kill?.("SIGKILL"), 1000);
      }, request.timeoutMs);

      const cleanup = (options: { preserveForceKill?: boolean } = {}) => {
        clearTimeout(timeout);
        if (!options.preserveForceKill && forceKill) {
          clearTimeout(forceKill);
          forceKill = null;
        }
        request.signal.removeEventListener("abort", abort);
      };

      const fail = (error: Error, options: { preserveForceKill?: boolean } = {}) => {
        if (settled) return;
        settled = true;
        cleanup(options);
        rejectPromise(error);
      };

      const abort = () => {
        if (settled) return;
        child.kill?.("SIGTERM");
        forceKill = setTimeout(() => child.kill?.("SIGKILL"), 1000);
      };
      request.signal.addEventListener("abort", abort, { once: true });

      child.stdout?.on("data", (chunk: unknown) => {
        stdout += String(chunk);
        if (byteLength(stdout) > maxStdoutBytes && !settled) {
          child.kill?.("SIGTERM");
          forceKill = setTimeout(() => child.kill?.("SIGKILL"), 1000);
          fail(new LocalCliProcessError(
            "LOCAL_CLI_OUTPUT_TOO_LARGE",
            `${request.command} stdout exceeded ${maxStdoutBytes} bytes`
          ), { preserveForceKill: true });
        }
      });

      child.stderr?.on("data", (chunk: unknown) => {
        stderr = (stderr + String(chunk)).slice(-LOCAL_CLI_MAX_STDERR_BYTES);
      });

      child.once?.("error", (error: Error) => {
        fail(new LocalCliProcessError("LOCAL_CLI_PROCESS_ERROR", error.message));
      });

      child.once?.("exit", (code: number | null, processSignal: string | null) => {
        if (forceKill) {
          clearTimeout(forceKill);
          forceKill = null;
        }
        if (settled) return;
        if (request.signal.aborted) {
          fail(request.signal.reason instanceof Error
            ? request.signal.reason
            : new LocalCliProcessError("LOCAL_CLI_CANCELED", "Local CLI process canceled"));
          return;
        }
        if (timedOut) {
          fail(new LocalCliProcessError(
            "LOCAL_CLI_TIMEOUT",
            `${request.command} exceeded its local process deadline`
          ));
          return;
        }
        settled = true;
        cleanup();
        resolvePromise({
          stdout,
          stderr,
          exitCode: code,
          signal: processSignal
        });
      });

      child.stdin?.end(request.stdin);
    });
  }
}
