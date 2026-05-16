import type {
  Brief,
  Message,
  Phase,
  RunOptions,
  RunResult,
  RunnerIO,
  SessionMeta,
  SessionState,
  ExecutionMode,
  PhaseTransition,
  ToolDefinition,
  ToolCall,
} from "./types.js";
import type { ToolExecutor } from "./tools/types.js";
import { parseBrief, validateBrief, generateBriefId } from "./brief.js";
import { loadFrameworkDoc } from "./framework.js";
import { runIntake } from "./phases/intake.js";
import { runExecute } from "./phases/execute.js";
import { reportBlocker } from "./phases/blocker.js";
import {
  awaitOperatorYes,
  approvalMessage,
  denialMessage,
} from "./phases/destructive.js";
import { runCompletion } from "./phases/completion.js";
import { createTerminalIO } from "./io.js";
import { writeSession, readSession } from "./state/persist.js";
import { appendTranscript } from "./state/transcript.js";
import { NATIVE_TOOLS } from "./tools/native/index.js";
import { SandboxContext } from "./sandbox/types.js";
import { loadHostAllowlist } from "./sandbox/host-allowlist.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { MCPClient, StdioTransport, loadGlobalMcpConfig, splitCommand } from "./mcp/index.js";

export async function run(opts: RunOptions): Promise<RunResult> {
  if (!opts.briefPath && !opts.briefSource) {
    throw new Error("run() requires either briefPath or briefSource.");
  }
  const briefInput = opts.briefSource ?? opts.briefPath!;
  const brief: Brief = parseBrief(briefInput);

  const validation = validateBrief(brief);
  const errors = validation.issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      `Brief is invalid: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
    );
  }

  const io = opts.io ?? createTerminalIO();
  const adapter = opts.adapter;
  if (!adapter.isConfigured()) {
    throw new Error(
      `Adapter "${adapter.id}" is not configured. Check API key environment variable.`,
    );
  }

  // Compose the system prompt: framework doc verbatim, no inlining.
  const framework = loadFrameworkDoc();
  const system = framework;

  // Resolve / open session.
  const briefId = opts.sessionId ?? brief.frontmatter.brief_id ?? generateBriefId();
  let session: SessionState;
  let isResumed = false;
  if (!opts.ephemeral && opts.resume) {
    const prior = readSession(briefId);
    if (prior) {
      session = prior;
      isResumed = true;
      io.banner(`Resuming session ${briefId} (phase: ${session.meta.phase})`);
    } else {
      session = createSession(brief, briefId);
    }
  } else {
    session = createSession(brief, briefId);
  }

  const persist = () => {
    if (opts.ephemeral) return;
    session.meta.updated_at = new Date().toISOString();
    writeSession(session);
  };

  const recordMessage = (m: Message) => {
    session.messages.push(m);
    if (!opts.ephemeral) appendTranscript(session.meta.brief_id, m);
  };

  const transition = (to: Phase, reason: string) => {
    const t: PhaseTransition = {
      from: session.meta.phase,
      to,
      at: new Date().toISOString(),
      reason,
    };
    session.meta.phase = to;
    session.meta.transitions.push(t);
  };

  // ------------------- Phase 0 -------------------
  let mode: ExecutionMode;
  let historyForExecute: Message[];

  if (!isResumed || session.meta.phase === "intake") {
    transition("intake", "starting");
    persist();
    const intake = await runIntake({ brief, adapter, system, io });
    recordMessage(intake.brief_prompt);
    recordMessage(intake.assistant_message);
    persist();

    if (!intake.accepted) {
      // Operator did not accept. Persist their correction as the next user
      // turn so a future `resume` can pick it up.
      if (intake.operator_reply.trim()) {
        recordMessage({
          role: "user",
          content: intake.operator_reply,
          at: new Date().toISOString(),
          meta: { phase: "intake", step_index: 2 },
        });
      }
      persist();
      io.write(
        "\nConfirmation Summary not accepted. Session paused at Phase 0. Resume with adjustments or restart.\n",
      );
      return {
        session_id: session.meta.brief_id,
        final_phase: "intake",
        completed: false,
        halted: true,
        halt_reason: "intake_not_accepted",
        messages: session.messages,
      };
    }

    mode = await resolveMode(brief, opts, io, intake.operator_reply);
    session.meta.mode = mode;
    historyForExecute = [intake.brief_prompt, intake.assistant_message];
  } else {
    mode = session.meta.mode ?? (await resolveMode(brief, opts, io, ""));
    session.meta.mode = mode;
    historyForExecute = session.messages.slice();
  }

  // ------------------- Set up tools + sandbox + MCP -------------------
  const workdir = opts.workdir ?? brief.frontmatter.workdir ?? process.cwd();
  const httpAllowPath = join(homedir(), ".openwar", "http-allow.json");
  let httpAllowlist;
  try { httpAllowlist = await loadHostAllowlist(httpAllowPath); } catch { httpAllowlist = null; }
  const sandbox = SandboxContext._create({
    workdir,
    defaultTimeoutMs: 30_000,
    defaultMaxOutputBytes: 1_000_000,
    httpAllowlist,
    shellEnabled: !opts.disableShell,
  });

  const toolDefinitions: ToolDefinition[] = [];
  const toolExecutors = new Map<string, ToolExecutor>();
  if (!opts.disableNativeTools) {
    for (const [name, t] of NATIVE_TOOLS.entries()) {
      toolDefinitions.push(t.definition);
      toolExecutors.set(name, t.executor);
    }
  }

  // MCP servers from brief + global + opts.
  const mcpClients: MCPClient[] = [];
  const briefMcp = (brief.frontmatter as { mcp_servers?: { name: string; command: string; cwd?: string }[] }).mcp_servers ?? [];
  const globalMcp = await loadGlobalMcpConfig().catch(() => []);
  const mcpConfigs = [...globalMcp, ...briefMcp, ...(opts.mcpServers ?? [])];
  for (const cfg of mcpConfigs) {
    try {
      const { bin, args } = splitCommand(cfg.command);
      const transport = new StdioTransport({ command: bin, args, ...(cfg.cwd && { cwd: cfg.cwd }) });
      const client = new MCPClient({ transport });
      await client.connect();
      const tools = await client.listTools();
      for (const t of tools) {
        const fqName = `${cfg.name}:${t.name}`;
        toolDefinitions.push({
          name: fqName,
          description: t.description ?? `MCP tool ${fqName}`,
          input_schema: t.inputSchema,
          origin: "mcp",
          mcp_server_name: cfg.name,
          authorization_categories: [`mcp_tool:${cfg.name}:${t.name}`],
        });
        toolExecutors.set(fqName, async (call) => {
          const result = await client.callTool({ name: t.name, arguments: call.arguments as Record<string, unknown> });
          const text = result.content.map(c => c.text ?? "").join("\n");
          return {
            call_id: call.id,
            success: !result.isError,
            content: text,
            ...(result.isError && { error: { code: "MCP_ERROR", message: text } }),
          };
        });
      }
      mcpClients.push(client);
      io.write(`MCP connected: ${cfg.name} (${tools.length} tools)\n`);
    } catch (err) {
      io.warn(`MCP server "${cfg.name}" failed to connect: ${(err as Error).message}`);
    }
  }

  const cleanupMcp = async () => {
    for (const c of mcpClients) await c.disconnect().catch(() => {});
  };

  // ------------------- v0.4 multi-agent branch -------------------
  // When the brief opts into multi-agent (roles: [planner, executor, reviewer, ...]),
  // the coordinator drives the rest of the run. Single-agent mode (roles
  // unset or roles: []) falls through to the v0.3 phase loop below.
  const roleIds = (opts.runtimeRoles ?? brief.frontmatter.roles ?? []).filter(
    (r): r is string => typeof r === "string" && r.length > 0,
  );
  if (roleIds.length > 0) {
    const { runCoordinator, resolveBudgets } = await import("./coordinator/index.js");
    const budgets = { ...resolveBudgets(brief), ...(opts.runtimeBudgets ?? {}) };
    transition("execute", "intake accepted (multi-agent)");
    persist();
    const coordResult = await runCoordinator({
      brief,
      framework: system,
      adapter,
      io,
      roleIds,
      budgets,
      toolDefinitions,
      toolExecutors,
      sandbox,
      sessionApproved: session.meta.session_approved_categories ?? [],
      sessionId: session.meta.brief_id,
      onSnapshot: (snap, events) => {
        // Project coordinator snapshot into SessionMeta (schema v3 fields).
        const metaV3 = session.meta as typeof session.meta & {
          coordinator_state?: typeof snap.state;
          plan?: typeof snap.plan;
          subtask_states?: typeof snap.subtask_states;
          active_roles?: string[];
          budgets?: typeof snap.budgets;
          coordinator_events?: typeof events;
          cost?: { tokens_used: number; wall_clock_ms: number; tool_calls: number; tool_calls_by_subtask: Record<string, number>; started_at: string };
        };
        metaV3.coordinator_state = snap.state;
        metaV3.plan = snap.plan;
        metaV3.subtask_states = snap.subtask_states;
        metaV3.active_roles = snap.active_roles;
        metaV3.budgets = snap.budgets;
        metaV3.coordinator_events = events;
        if (!metaV3.cost) metaV3.cost = { tokens_used: 0, wall_clock_ms: 0, tool_calls: 0, tool_calls_by_subtask: {}, started_at: new Date().toISOString() };
        metaV3.cost.tokens_used = snap.cost.tokens_used;
        metaV3.cost.wall_clock_ms = snap.cost.wall_clock_ms;
        metaV3.cost.tool_calls_by_subtask = { ...snap.cost.tool_calls_by_subtask };
        persist();
      },
      onMessage: (m) => {
        recordMessage(m);
      },
      onApproval: (a) => {
        session.meta.destructive_approvals.push({
          at: new Date().toISOString(),
          action: a.action,
          approved: a.approved,
          ...(a.session_categories ? { session_categories: a.session_categories } : {}),
        });
        if (a.approved && a.session_categories) {
          const existing = session.meta.session_approved_categories ?? [];
          for (const c of a.session_categories) if (!existing.includes(c)) existing.push(c);
          session.meta.session_approved_categories = existing;
        }
        persist();
      },
    });
    transition(coordResult.completed ? "done" : "blocker", `coordinator final_state=${coordResult.final_state}`);
    persist();
    await cleanupMcp();
    return {
      session_id: session.meta.brief_id,
      final_phase: coordResult.final_phase,
      completed: coordResult.completed,
      halted: coordResult.halted,
      ...(coordResult.halt_reason ? { halt_reason: coordResult.halt_reason } : {}),
      messages: session.messages,
    };
  }

  // ------------------- Phase 1 (single-agent, v0.3) -------------------
  transition("execute", "intake accepted");
  persist();
  let executeResult = await runExecute({
    brief,
    adapter,
    system,
    io,
    mode,
    history: historyForExecute,
    toolDefinitions,
    toolExecutors,
    sandbox,
    sessionApproved: session.meta.session_approved_categories ?? [],
    onMessage: (m) => {
      recordMessage(m);
      persist();
    },
  });

  // ------------------- Phase 3 (loop) -------------------
  while (executeResult.outcome === "destructive_denied") {
    transition("destructive", "destructive intent detected");
    persist();

    // Two variants of Phase 3:
    //   (a) Tool-call gate: the runner detected an unauthorized tool call.
    //       Prompt y / Y / n. Y promotes the missing categories session-wide.
    //   (b) Text-based gate: detector matched a destructive verb in the
    //       assistant text. Original v0.2 behavior, one-shot y/n.
    if (executeResult.destructive_tool_call) {
      const call = executeResult.destructive_tool_call;
      const missing = executeResult.destructive_missing_categories ?? [];
      io.banner("Phase 3: Tool authorization required");
      io.write(
        `Tool:        ${call.name}\n` +
        `Arguments:   ${JSON.stringify(call.arguments)}\n` +
        `Categories:  ${missing.join(", ")}\n`,
      );
      io.write(`Approve? y = this call only, Y = approve "${missing.join(", ")}" for the rest of the session, n = deny\n`);
      const reply = (await io.prompt("> ")).trim();
      const approveOnce = reply === "y" || reply === "yes";
      const approveSession = reply === "Y";
      const approved = approveOnce || approveSession;

      session.meta.destructive_approvals.push({
        at: new Date().toISOString(),
        action: `tool:${call.name}`,
        approved,
        ...(approveSession && { session_categories: missing as string[] }),
      });
      if (approveSession) {
        session.meta.session_approved_categories = [
          ...(session.meta.session_approved_categories ?? []),
          ...missing,
        ];
      }
      persist();

      if (!approved) {
        // Inject a synthetic tool result expressing denial, then continue.
        const denialMsg: Message = {
          role: "user",
          content: `[tool_result ${call.id} (denied by operator)]\nThe operator did not approve "${call.name}". Pick a different path or stop.`,
          at: new Date().toISOString(),
          meta: { phase: "execute" },
        };
        recordMessage(denialMsg);
        transition("execute", "tool call denied");
        persist();
        executeResult = await runExecute({
          brief, adapter, system, io, mode,
          history: [...executeResult.history, denialMsg],
          toolDefinitions, toolExecutors, sandbox,
          sessionApproved: session.meta.session_approved_categories ?? [],
          onMessage: (m) => { recordMessage(m); persist(); },
        });
        continue;
      }

      transition("execute", approveSession ? "tool approved (session)" : "tool approved (once)");
      persist();
      executeResult = await runExecute({
        brief, adapter, system, io, mode,
        history: executeResult.history,
        toolDefinitions, toolExecutors, sandbox,
        sessionApproved: session.meta.session_approved_categories ?? [],
        onMessage: (m) => { recordMessage(m); persist(); },
      });
      continue;
    }

    // Variant (b): text-based destructive gate (v0.2 path).
    const last = lastAssistant(executeResult.history);
    const detection = executeResult.blocking_detectors?.destructive;
    if (!detection || !detection.destructive) break;

    const approved = await awaitOperatorYes({
      io,
      detection,
      ...(last ? { lastAssistant: last } : {}),
    });
    session.meta.destructive_approvals.push({
      at: new Date().toISOString(),
      action: detection.action ?? "unspecified",
      approved,
    });
    persist();

    const followUp = approved ? approvalMessage(detection) : denialMessage(detection);
    recordMessage(followUp);
    transition("execute", approved ? "destructive approved" : "destructive denied");
    persist();

    executeResult = await runExecute({
      brief, adapter, system, io, mode,
      history: [...executeResult.history, followUp],
      toolDefinitions, toolExecutors, sandbox,
      sessionApproved: session.meta.session_approved_categories ?? [],
      onMessage: (m) => { recordMessage(m); persist(); },
    });
  }

  // ------------------- Phase 2 -------------------
  if (executeResult.outcome === "blocker") {
    transition("blocker", executeResult.reason ?? "blocker");
    persist();
    reportBlocker({
      io,
      reason: executeResult.reason ?? "unspecified",
      ...(lastAssistant(executeResult.history) ? { lastAssistant: lastAssistant(executeResult.history)! } : {}),
    });
    await cleanupMcp();
    return {
      session_id: session.meta.brief_id,
      final_phase: "blocker",
      completed: false,
      halted: true,
      halt_reason: executeResult.reason ?? "blocker",
      messages: session.messages,
    };
  }

  if (executeResult.outcome === "max_steps") {
    transition("blocker", "max_steps");
    persist();
    io.banner("Phase 2: Blocker (max_steps reached)");
    io.write(`Stopping: ${executeResult.reason}\n`);
    await cleanupMcp();
    return {
      session_id: session.meta.brief_id,
      final_phase: "blocker",
      completed: false,
      halted: true,
      halt_reason: "max_steps",
      messages: session.messages,
    };
  }

  if (executeResult.outcome === "operator_done") {
    transition("completion", "operator ended");
    persist();
    await cleanupMcp();
    return {
      session_id: session.meta.brief_id,
      final_phase: "completion",
      completed: true,
      halted: false,
      messages: session.messages,
    };
  }

  // ------------------- Phase 4 -------------------
  transition("completion", "completion detected");
  persist();
  const finalReport = await runCompletion({
    adapter,
    system,
    io,
    history: executeResult.history,
  });
  recordMessage(finalReport);
  transition("done", "completion report delivered");
  persist();
  await cleanupMcp();

  return {
    session_id: session.meta.brief_id,
    final_phase: "done",
    completed: true,
    halted: false,
    messages: session.messages,
  };
}

function createSession(brief: Brief, briefId: string): SessionState {
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    brief_id: briefId,
    project: brief.frontmatter.project,
    started_at: now,
    updated_at: now,
    phase: "intake",
    mode: null,
    destructive_approvals: [],
    transitions: [],
    schema_version: 2,
    session_approved_categories: [],
    tool_calls: [],
  };
  return { meta, brief, messages: [] };
}

function lastAssistant(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") return m;
  }
  return undefined;
}

async function resolveMode(
  brief: Brief,
  opts: RunOptions,
  io: RunnerIO,
  operatorReply: string,
): Promise<ExecutionMode> {
  // Precedence: CLI override > brief frontmatter > operator-typed > prompt.
  if (opts.mode) return opts.mode;
  if (brief.frontmatter.mode) return brief.frontmatter.mode;
  const reply = operatorReply.toLowerCase();
  if (/\bauto(?:-?pilot)?\b/.test(reply)) return "auto";
  if (/\b(gated|per[-\s]?step|step)\b/.test(reply)) return "gated";
  const picked = await io.prompt('Execution mode? Type "gated" or "auto":');
  return picked.trim().toLowerCase() === "auto" ? "auto" : "gated";
}

