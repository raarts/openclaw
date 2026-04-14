import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessSession } from "./bash-process-registry.js";
import type { ExecProcessHandle } from "./bash-tools.exec-runtime.js";

// Mock runExecProcess to capture the env it receives without spawning real processes.
const runExecProcessMock = vi.hoisted(() => vi.fn());

vi.mock("./bash-tools.exec-runtime.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./bash-tools.exec-runtime.js")>();
  return { ...mod, runExecProcess: runExecProcessMock };
});

// Avoid slow login-shell probes in the test environment.
vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...mod,
    getShellPathFromLoginShell: () => null,
    resolveShellEnvFallbackTimeoutMs: () => 100,
  };
});

function makeHandle(): ExecProcessHandle {
  const session: ProcessSession = {
    id: "test-session",
    command: "echo ok",
    startedAt: Date.now(),
    maxOutputChars: 10_000,
    pendingMaxOutputChars: 10_000,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: "ok",
    tail: "ok",
    exited: true,
    backgrounded: false,
    truncated: false,
    cursorKeyMode: "normal",
  };
  return {
    session,
    startedAt: Date.now(),
    promise: Promise.resolve({
      status: "completed" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 1,
      aggregated: "ok",
      timedOut: false as const,
    }),
    kill: () => {},
    disableUpdates: () => {},
  };
}

let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;

const TEST_CWD = path.join(os.tmpdir(), "openclaw-agent-env-test");

describe("exec agent env injection", () => {
  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec.js"));
  });

  beforeEach(() => {
    runExecProcessMock.mockReset();
    runExecProcessMock.mockResolvedValue(makeHandle());
  });

  function capturedEnv(): Record<string, string> {
    const call = runExecProcessMock.mock.calls[0] as [{ env: Record<string, string> }];
    return call[0].env;
  }

  describe("BASH_ENV", () => {
    it("injects .bash_env by default", async () => {
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: TEST_CWD,
      });
      await tool.execute("c1", { command: "echo ok", yieldMs: 120_000 });
      expect(capturedEnv().BASH_ENV).toBe(".bash_env");
    });

    it("uses a custom bashEnv path when configured", async () => {
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: TEST_CWD,
        bashEnv: "scripts/.agent_init",
      });
      await tool.execute("c2", { command: "echo ok", yieldMs: 120_000 });
      expect(capturedEnv().BASH_ENV).toBe("scripts/.agent_init");
    });

    it("does not inject BASH_ENV when bashEnv is empty string", async () => {
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: TEST_CWD,
        bashEnv: "",
      });
      await tool.execute("c3", { command: "echo ok", yieldMs: 120_000 });
      expect(capturedEnv().BASH_ENV).toBeUndefined();
    });

    it("does not overwrite a pre-existing BASH_ENV already in the environment", async () => {
      // BASH_ENV is blocked from inheritance by the security policy, so pre-existing values
      // cannot arrive via the sanitized base env. This guard tests the sandbox path where env
      // is built independently via sandbox.env and may already carry the key.
      const tool = createExecTool({
        host: "sandbox",
        security: "full",
        ask: "off",
        cwd: TEST_CWD,
        sandbox: {
          containerName: "test",
          workspaceDir: TEST_CWD,
          containerWorkdir: "/workspace",
          env: { BASH_ENV: "pre-existing" },
          buildExecSpec: async (_params) => ({
            argv: ["docker", "exec", "test", "echo", "ok"],
            env: process.env as Record<string, string>,
            stdinMode: "pipe-closed" as const,
          }),
        },
      });
      await tool.execute("c4", { command: "echo ok", yieldMs: 120_000 });
      // The sandbox env sets BASH_ENV=pre-existing; our injection must not overwrite it.
      expect(capturedEnv().BASH_ENV).toBe("pre-existing");
    });
  });

  describe("OPENCLAW_WORKSPACE", () => {
    it("injects the configured workspace root as OPENCLAW_WORKSPACE", async () => {
      const workspace = path.join(os.tmpdir(), "openclaw-ws-inject");
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: workspace,
      });
      await tool.execute("c5", { command: "echo ok", yieldMs: 120_000 });
      expect(capturedEnv().OPENCLAW_WORKSPACE).toBe(workspace);
    });

    it("does not inject OPENCLAW_WORKSPACE when no cwd is configured", async () => {
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
      });
      await tool.execute("c6", { command: "echo ok", yieldMs: 120_000 });
      expect(capturedEnv().OPENCLAW_WORKSPACE).toBeUndefined();
    });
  });

  describe("OPENCLAW_AGENT", () => {
    it("injects the agentId as OPENCLAW_AGENT", async () => {
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: TEST_CWD,
        agentId: "main",
      });
      await tool.execute("c7", { command: "echo ok", yieldMs: 120_000 });
      expect(capturedEnv().OPENCLAW_AGENT).toBe("main");
    });

    it("does not inject OPENCLAW_AGENT when no agentId is configured", async () => {
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: TEST_CWD,
      });
      await tool.execute("c8", { command: "echo ok", yieldMs: 120_000 });
      expect(capturedEnv().OPENCLAW_AGENT).toBeUndefined();
    });
  });

  it("all three vars are present together with full defaults", async () => {
    const workspace = path.join(os.tmpdir(), "openclaw-ws-full");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      cwd: workspace,
      agentId: "research",
    });
    await tool.execute("c9", { command: "echo ok", yieldMs: 120_000 });
    const env = capturedEnv();
    expect(env.BASH_ENV).toBe(".bash_env");
    expect(env.OPENCLAW_WORKSPACE).toBe(workspace);
    expect(env.OPENCLAW_AGENT).toBe("research");
  });
});
