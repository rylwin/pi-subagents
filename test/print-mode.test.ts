import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
  };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function makePi(sendMessage = vi.fn(() => {
  throw new Error("stale extension context");
})) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage,
    } as any,
    tools,
    handlers,
  };
}

const textOf = (result: any): string => result.content[0].text;

const completedRun = () => ({
  responseText: "done",
  session: { dispose: vi.fn() } as any,
  aborted: false,
  steered: false,
});

async function advanceCompletionNudgeWindow() {
  await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce
  await vi.advanceTimersByTimeAsync(200); // notification hold window
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

async function spawnBackground(tools: Map<string, any>) {
  const result = await tools.get("Agent").execute(
    "tool-call-1",
    {
      prompt: "reply done",
      description: "tiny child",
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    undefined,
    undefined,
    makeHeadlessCtx(),
  );

  const id = textOf(result).match(/Agent ID: (\S+)/)?.[1];
  expect(id, "background spawn should return an agent id").toBeTruthy();
  return id!;
}

describe("print mode background notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ignores stale-context errors from delayed completion nudges", async () => {
    vi.mocked(runAgent).mockResolvedValue(completedRun());

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    await spawnBackground(tools);

    await advanceCompletionNudgeWindow();

    expect(pi.sendMessage).toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });

  it("lets same-turn get_subagent_result consume a completion before it becomes a follow-up", async () => {
    vi.useFakeTimers();
    const child = deferred<any>();
    vi.mocked(runAgent).mockReturnValue(child.promise);
    const sendMessage = vi.fn();
    const { pi, tools, handlers } = makePi(sendMessage);
    subagentsExtension(pi);
    await handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 }, makeHeadlessCtx());

    const id = await spawnBackground(tools);
    child.resolve(completedRun());
    await advanceCompletionNudgeWindow();
    expect(sendMessage).not.toHaveBeenCalled();

    const result = await tools.get("get_subagent_result").execute(
      "get-result-tool-call",
      { agent_id: id, wait: true },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );
    expect(textOf(result)).toContain("done");

    await handlers.get("turn_end")?.({ type: "turn_end", turnIndex: 0, message: {} }, makeHeadlessCtx());
    await vi.advanceTimersByTimeAsync(200);

    expect(sendMessage).not.toHaveBeenCalled();
    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });

  it("still sends an active-turn completion nudge after turn end if the result was not consumed", async () => {
    vi.useFakeTimers();
    const child = deferred<any>();
    vi.mocked(runAgent).mockReturnValue(child.promise);
    const sendMessage = vi.fn();
    const { pi, tools, handlers } = makePi(sendMessage);
    subagentsExtension(pi);
    await handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 }, makeHeadlessCtx());

    await spawnBackground(tools);
    child.resolve(completedRun());
    await advanceCompletionNudgeWindow();
    expect(sendMessage).not.toHaveBeenCalled();

    await handlers.get("turn_end")?.({ type: "turn_end", turnIndex: 0, message: {} }, makeHeadlessCtx());
    await vi.advanceTimersByTimeAsync(200);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].content).toContain("done");
    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });
});
