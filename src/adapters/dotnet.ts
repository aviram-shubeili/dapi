/** .NET debug adapter — vsdbg (supports .NET Framework + .NET Core).
 *
 * vsdbg communicates over stdio (stdin/stdout) using the standard DAP
 * Content-Length framing. This adapter spawns vsdbg in interpreter mode
 * and uses DAPClient's stdio transport.
 *
 * Supports:
 *   - Attach by PID to .NET Framework processes (type: "clr")
 *   - Attach by PID to .NET Core/.NET 5+ processes (type: "coreclr")
 *
 * Configuration via environment variables:
 *   VSDBG_PATH         — Full path to vsdbg.exe (auto-detected from VS Code extensions)
 *   DOTNET_SYMBOL_PATH  — Additional PDB search path(s), semicolon-separated
 *   DOTNET_SOURCE_PATH  — Source file search path(s), semicolon-separated
 *   DOTNET_RUNTIME       — "clr" (Framework, default) or "coreclr" (.NET Core)
 */

import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DAPClient } from "../dap-client.js";
import type { StackFrame, Variable } from "../dap-types.js";
import type { CommandResult } from "../protocol.js";
import type {
  AdapterConfig,
  SpawnResult,
  LaunchOpts,
  InitFlowOpts,
  AttachFlowOpts,
} from "./base.js";

export class DotnetAdapter implements AdapterConfig {
  name = "dotnet";

  /** Resolve the vsdbg executable path. */
  private findVsdbg(runtimePath?: string): string | null {
    // 1. Explicit override
    if (runtimePath && existsSync(runtimePath)) return runtimePath;
    if (process.env.VSDBG_PATH && existsSync(process.env.VSDBG_PATH)) return process.env.VSDBG_PATH;

    // 2. Auto-discover from VS Code / VS Code Insiders extensions
    const homes = [
      join(homedir(), ".vscode-insiders", "extensions"),
      join(homedir(), ".vscode", "extensions"),
    ];

    for (const extDir of homes) {
      if (!existsSync(extDir)) continue;
      try {
        const dirs = readdirSync(extDir)
          .filter((d) => d.startsWith("ms-dotnettools.csharp-"))
          .sort()
          .reverse(); // Latest version first

        for (const d of dirs) {
          // vsdbg can be in .debugger/ directly or in .debugger/<arch>/
          const candidates = [
            join(extDir, d, ".debugger", "vsdbg.exe"),
            join(extDir, d, ".debugger", "x86_64", "vsdbg.exe"),
            join(extDir, d, ".debugger", "win7-x64", "vsdbg.exe"),
          ];
          for (const vsdbg of candidates) {
            if (existsSync(vsdbg)) return vsdbg;
          }
        }
      } catch {
        // Permission errors, etc.
      }
    }

    return null;
  }

  /** Get the .NET runtime type to debug. */
  private getDotnetType(): "clr" | "coreclr" {
    const runtime = process.env.DOTNET_RUNTIME?.toLowerCase();
    if (runtime === "coreclr") return "coreclr";
    return "clr"; // Default to .NET Framework
  }

  async checkInstalled(runtimePath?: string): Promise<string | null> {
    const vsdbg = this.findVsdbg(runtimePath);
    if (!vsdbg) {
      return [
        "vsdbg not found. Options:",
        "  1. Install the C# extension in VS Code (ms-dotnettools.csharp)",
        "  2. Set VSDBG_PATH environment variable to the vsdbg.exe path",
        "  3. Use --runtime <path-to-vsdbg.exe>",
      ].join("\n");
    }
    return null;
  }

  /** Spawn vsdbg in interpreter mode (stdio transport). */
  private spawnVsdbg(runtimePath?: string): ChildProcess {
    const vsdbg = this.findVsdbg(runtimePath);
    if (!vsdbg) throw new Error("vsdbg not found");

    return cpSpawn(vsdbg, ["--interpreter=vscode"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  /** spawn() is required by AdapterConfig but .NET only supports attach (not launch of scripts). */
  async spawn(_opts: LaunchOpts): Promise<SpawnResult> {
    throw new Error(
      "Direct script launch not supported for .NET. Use 'dapi attach --pid <PID> --language dotnet' instead."
    );
  }

  /** Spawn vsdbg for attach mode. Called by session.ts before attachFlow. */
  async spawnForAttach(
    _pid: number,
    opts?: { runtimePath?: string }
  ): Promise<{ process: ChildProcess; useStdio: boolean }> {
    const proc = this.spawnVsdbg(opts?.runtimePath);
    return { process: proc, useStdio: true };
  }

  initializeArgs(): Record<string, unknown> {
    return {
      clientID: "dapi",
      clientName: "dapi",
      adapterID: "coreclr",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
      supportsProgressReporting: false,
    };
  }

  /** Not used for .NET (attach-only). */
  launchArgs(_opts: LaunchOpts): Record<string, unknown> {
    return {};
  }

  /** Not used for .NET (attach-only). */
  async initFlow(_client: DAPClient, _opts: InitFlowOpts): Promise<CommandResult> {
    return {
      error: "Direct launch not supported for .NET. Use 'dapi attach --pid <PID> --language dotnet'.",
    };
  }

  /**
   * Attach flow for vsdbg.
   *
   * Sequence: initialize → attach (async) → wait initialized → setBreakpoints
   *           → setExceptionBreakpoints → configurationDone → attach response
   */
  async attachFlow(client: DAPClient, opts: AttachFlowOpts): Promise<CommandResult> {
    if (!opts.pid) {
      return { error: "PID is required for .NET attach. Use --pid <PID>." };
    }

    // 1. Initialize
    const initResp = await client.request("initialize", this.initializeArgs());
    if (!initResp.success) {
      return { error: `Initialize failed: ${initResp.message || "unknown"}` };
    }

    // 2. Build attach arguments
    const dotnetType = this.getDotnetType();
    const attachArgs: Record<string, unknown> = {
      type: dotnetType,
      request: "attach",
      processId: opts.pid,
      justMyCode: true,
      logging: {
        engineLogging: false,
        moduleLoad: false,
      },
    };

    // Add symbol search paths if configured
    const symbolPath = process.env.DOTNET_SYMBOL_PATH;
    if (symbolPath) {
      attachArgs.symbolOptions = {
        searchPaths: symbolPath.split(";").filter(Boolean),
        searchMicrosoftSymbolServer: false,
      };
    }

    // Add source path mapping if configured.
    // Maps each path to itself — allows vsdbg to find sources when PDB paths differ.
    const sourcePath = process.env.DOTNET_SOURCE_PATH;
    if (sourcePath) {
      const map: Record<string, string> = {};
      for (const p of sourcePath.split(";").filter(Boolean)) {
        map[p] = p;
      }
      attachArgs.sourceFileMap = map;
    }

    // 3. Send attach request (async — response deferred until configurationDone)
    const attachSeq = client.requestAsync("attach", attachArgs);

    // 4. Wait for initialized event
    //    vsdbg emits this after successfully attaching to the process
    const initialized = await client.waitForEvent("initialized", 30000);
    if (!initialized) {
      return {
        error: `Timeout waiting for vsdbg to attach to PID ${opts.pid}. ` +
          `Ensure the process is a ${dotnetType === "clr" ? ".NET Framework" : ".NET Core"} process. ` +
          `Tip: set DOTNET_RUNTIME=coreclr if targeting .NET Core.`,
      };
    }

    // 5. Set breakpoints
    const bpResults: Array<{ file: string; line: number; verified: boolean }> = [];
    if (opts.breakpoints?.length) {
      for (const bp of opts.breakpoints) {
        const bpArgs: Record<string, unknown> = {
          source: { path: bp.file },
          breakpoints: bp.lines.map((line, i) => {
            const entry: Record<string, unknown> = { line };
            if (bp.conditions?.[i]) entry.condition = bp.conditions[i];
            return entry;
          }),
        };
        const resp = await client.request("setBreakpoints", bpArgs);
        if (resp.success && resp.body) {
          const bps = (
            resp.body as {
              breakpoints?: Array<{ line?: number; verified?: boolean; message?: string }>;
            }
          ).breakpoints;
          if (bps) {
            for (const b of bps) {
              bpResults.push({
                file: bp.file,
                line: b.line ?? 0,
                verified: b.verified ?? false,
              });
            }
          }
        }
      }
    }

    // 6. Exception breakpoints
    await client.request("setExceptionBreakpoints", {
      filters: opts.exceptionFilters ?? [],
    });

    // 7. configurationDone — signals vsdbg that initial configuration is complete
    await client.request("configurationDone");

    // 8. Wait for the deferred attach response
    const attachResp = await client.waitForResponse(attachSeq, 30000);
    if (!attachResp.success) {
      const msg = attachResp.message || "unknown";
      if (msg.includes("Access is denied")) {
        return {
          error: `Access denied attaching to PID ${opts.pid}. ` +
            `Run dapi as Administrator (elevated terminal).`,
        };
      }
      return { error: `Attach failed: ${msg}` };
    }

    // Process is already running — don't wait for stopped event.
    return { status: "running", breakpoints: bpResults };
  }

  /** Filter out .NET runtime internals from stack frames. */
  isInternalFrame(frame: StackFrame): boolean {
    const path = frame.source?.path || "";
    const name = frame.name || "";

    // No source file — runtime internal
    if (!path && !frame.source?.sourceReference) {
      return true;
    }

    // Common .NET runtime / framework namespaces
    return (
      name.startsWith("[") || // [External Code], [Native Frame]
      name.includes("System.Runtime") ||
      name.includes("System.Threading") ||
      name.includes("Microsoft.AspNetCore") ||
      path.includes("/_/src/") // Reference source
    );
  }

  /** Filter out compiler-generated and special variables. */
  isInternalVariable(v: Variable): boolean {
    return (
      v.name.startsWith("$") || // Debugger pseudo-variables
      v.name === "this" || // Keep 'this' — actually useful, don't filter
      false
    );
  }
}
