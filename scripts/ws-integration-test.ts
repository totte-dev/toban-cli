#!/usr/bin/env tsx
/**
 * WebSocket Integration Test
 *
 * Tests the stdout/stderr streaming pipeline:
 *   docker.ts spawnAgentInDocker → child.stdout.on → WsChatServer.broadcastStdout → WS client
 *
 * This test:
 * 1. Starts a WsChatServer on a random port
 * 2. Connects a WS client
 * 3. Spawns a Docker container that produces stdout/stderr
 * 4. Verifies the WS client receives the streamed output
 *
 * Requires: Docker running, toban/agent:latest image built
 */

import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { WsChatServer } from "../src/ws-server.js";

const TEST_API_KEY = "test-integration-key";
let pass = 0;
let fail = 0;

function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
  pass++;
}
function ng(msg: string) {
  console.log(`  ✗ ${msg}`);
  fail++;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=== WebSocket Integration Test ===\n");

  // 1. Start WsChatServer
  console.log("1. WsChatServer startup");
  const server = new WsChatServer({
    port: 0,
    apiKey: TEST_API_KEY,
    apiUrl: "http://localhost:9999", // dummy - won't be called
    onMessage: async (msg) => `echo: ${msg}`,
  });

  let port: number;
  try {
    port = await server.start();
    ok(`Server started on port ${port}`);
  } catch (err) {
    ng(`Server failed to start: ${err}`);
    process.exit(1);
  }

  // 2. Connect WS client
  console.log("2. WebSocket client connection");
  const received: Array<{ type: string; content?: string; agent_name?: string }> = [];

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${TEST_API_KEY}`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WS connect timeout")), 5000);
    ws.on("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
  ok("Client connected");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      received.push(msg);
    } catch {
      // skip
    }
  });

  // Wait for welcome message
  await sleep(200);
  const welcome = received.find((m) => m.type === "status" && m.content === "connected");
  if (welcome) {
    ok("Welcome message received");
  } else {
    ng("No welcome message");
  }

  // 3. Simulate docker.ts stdout streaming via broadcastStdout
  console.log("3. broadcastStdout simulation");
  received.length = 0;

  server.broadcastStdout("test-agent", ["line 1", "line 2", "line 3"], "stdout");
  await sleep(200);

  const stdoutMsgs = received.filter((m) => m.type === "stdout");
  if (stdoutMsgs.length === 1 && stdoutMsgs[0].content?.includes("line 1")) {
    ok("stdout broadcast received by client");
  } else {
    ng(`stdout broadcast not received (got ${stdoutMsgs.length} messages)`);
  }

  if (stdoutMsgs[0]?.agent_name === "test-agent") {
    ok("agent_name field present in stdout message");
  } else {
    ng("agent_name field missing");
  }

  // 4. Test stderr broadcast
  console.log("4. stderr broadcast");
  received.length = 0;

  server.broadcastStdout("test-agent", ["error: something failed"], "stderr");
  await sleep(200);

  const stderrMsgs = received.filter((m) => m.type === "stderr");
  if (stderrMsgs.length === 1 && stderrMsgs[0].content?.includes("error:")) {
    ok("stderr broadcast received by client");
  } else {
    ng(`stderr broadcast not received (got ${stderrMsgs.length} messages)`);
  }

  // 5. Test real Docker container stdout → broadcastStdout pipeline
  console.log("5. Docker → broadcastStdout pipeline");
  received.length = 0;

  try {
    const child = spawn("docker", [
      "run", "--rm", "toban/agent:latest",
      "bash", "-c",
      'echo "DOCKER_WS_TEST_1" && echo "DOCKER_WS_TEST_2" && echo "DOCKER_WS_DONE"',
    ], { stdio: ["ignore", "pipe", "pipe"] });

    // Simulate what runner.ts does: pipe child stdout → broadcastStdout
    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      if (lines.length > 0) {
        server.broadcastStdout("docker-agent", lines, "stdout");
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      if (lines.length > 0) {
        server.broadcastStdout("docker-agent", lines, "stderr");
      }
    });

    // Wait for container to finish
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      setTimeout(resolve, 15000); // timeout
    });

    await sleep(500);

    const dockerMsgs = received.filter((m) => m.type === "stdout" && m.agent_name === "docker-agent");
    const allContent = dockerMsgs.map((m) => m.content).join("\n");

    if (allContent.includes("DOCKER_WS_TEST_1") && allContent.includes("DOCKER_WS_DONE")) {
      ok("Docker stdout piped through WS to client");
    } else {
      ng(`Docker stdout not received via WS. Got: ${allContent}`);
    }
  } catch (err) {
    ng(`Docker pipeline test failed: ${err}`);
  }

  // 6. Test client count tracking
  console.log("6. Client tracking");
  if (server.clientCount === 1) {
    ok(`Client count correct (${server.clientCount})`);
  } else {
    ng(`Client count wrong: ${server.clientCount}`);
  }

  // Cleanup
  ws.close();
  await sleep(200);
  await server.stop();

  // Summary
  console.log("\n=== Results ===");
  console.log(`  Passed: ${pass}`);
  console.log(`  Failed: ${fail}`);

  if (fail > 0) {
    console.log("\nWS INTEGRATION TEST FAILED");
    process.exit(1);
  } else {
    console.log("\nWS INTEGRATION TEST PASSED");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
