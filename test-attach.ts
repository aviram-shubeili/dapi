/**
 * Direct test: spawn vsdbg and attach to a .NET Framework process, bypassing the daemon.
 * Usage: bun run test-attach.ts <PID>
 */
import { DotnetAdapter } from "./src/adapters/dotnet.js";
import { DAPClient } from "./src/dap-client.js";

const pid = parseInt(process.argv[2] ?? "0", 10);
if (!pid) { console.error("Usage: bun run test-attach.ts <PID>"); process.exit(1); }

console.log(`[test] Attaching to PID ${pid}...`);
console.log(`[test] DOTNET_SYMBOL_PATH = ${process.env.DOTNET_SYMBOL_PATH ?? "(not set)"}`);
console.log(`[test] DOTNET_SOURCE_PATH = ${process.env.DOTNET_SOURCE_PATH ?? "(not set)"}`);

const adapter = new DotnetAdapter();
const check = await adapter.checkInstalled();
if (check) { console.error(check); process.exit(1); }

console.log("[test] Spawning vsdbg...");
const { process: vsdbgProc, useStdio } = await adapter.spawnForAttach(pid);
console.log(`[test] vsdbg spawned (PID ${vsdbgProc.pid}), useStdio=${useStdio}`);

// Capture stderr for diagnostics
vsdbgProc.stderr?.on("data", (chunk: Buffer) => {
  console.error(`[vsdbg stderr] ${chunk.toString().trim()}`);
});

vsdbgProc.on("exit", (code: number | null) => {
  console.log(`[vsdbg] exited with code ${code}`);
});

const client = new DAPClient();
console.log("[test] Connecting stdio...");
client.connectStdio(vsdbgProc);
console.log("[test] Stdio connected");

// Run the attach flow with progress logging
console.log("[test] Sending initialize...");
const initResp = await client.request("initialize", adapter.initializeArgs());
console.log(`[test] Initialize: success=${initResp.success}, message=${initResp.message ?? "ok"}`);

if (!initResp.success) {
  console.error("[test] Initialize failed, exiting");
  process.exit(1);
}

const dotnetType = process.env.DOTNET_RUNTIME?.toLowerCase() === "coreclr" ? "coreclr" : "clr";
const attachArgs: Record<string, unknown> = {
  type: dotnetType,
  request: "attach",
  processId: pid,
  justMyCode: true,
  logging: { engineLogging: false, moduleLoad: false },
};

const symbolPath = process.env.DOTNET_SYMBOL_PATH;
if (symbolPath) {
  attachArgs.symbolOptions = {
    searchPaths: symbolPath.split(";").filter(Boolean),
    searchMicrosoftSymbolServer: false,
  };
}

console.log(`[test] Sending attach (type=${dotnetType}, pid=${pid})...`);
const attachSeq = client.requestAsync("attach", attachArgs);
console.log(`[test] Attach sent (seq=${attachSeq}), waiting for initialized event...`);

const initialized = await client.waitForEvent("initialized", 30000);
if (!initialized) {
  console.error("[test] TIMEOUT waiting for initialized event (30s)");
  console.log("[test] This means vsdbg could not attach. Possible reasons:");
  console.log("  - Process is not a .NET Framework process");
  console.log("  - Access denied (need admin)");
  console.log("  - PID is wrong or process exited");
  vsdbgProc.kill();
  process.exit(1);
}

console.log("[test] Got initialized event!");

console.log("[test] Sending setExceptionBreakpoints...");
await client.request("setExceptionBreakpoints", { filters: [] });

console.log("[test] Sending configurationDone...");
await client.request("configurationDone");

console.log("[test] Waiting for attach response...");
const attachResp = await client.waitForResponse(attachSeq, 30000);
console.log(`[test] Attach response: success=${attachResp.success}, message=${attachResp.message ?? "ok"}`);

if (!attachResp.success) {
  const msg = attachResp.message || "unknown";
  if (msg.includes("Access is denied")) {
    console.error("[test] ACCESS DENIED — need admin terminal");
  } else {
    console.error(`[test] Attach failed: ${msg}`);
  }
  vsdbgProc.kill();
  process.exit(1);
}

console.log("\n✅ Successfully attached to PID " + pid + "!");
console.log("   Runtime: " + dotnetType);
console.log("   State: running (process not paused)");

// Get thread list
console.log("\n[test] Getting threads...");
const threadsResp = await client.request("threads");
if (threadsResp.success && threadsResp.body) {
  const threads = (threadsResp.body as { threads: Array<{ id: number; name: string }> }).threads;
  console.log(`   ${threads.length} threads:`);
  for (const t of threads.slice(0, 10)) {
    console.log(`     Thread ${t.id}: ${t.name}`);
  }
  if (threads.length > 10) console.log(`     ... and ${threads.length - 10} more`);
}

console.log("\n[test] Detaching...");
await client.request("disconnect", { terminateDebuggee: false });
console.log("[test] Done — target process continues running.");
process.exit(0);
