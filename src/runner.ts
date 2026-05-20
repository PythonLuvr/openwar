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
import { DEFAULT_TIERS, makeAdapter, resolveTier } from "./adapters/index.js";
import type { AdapterId } from "./adapters/index.js";
import type { AdapterConfig, AgentAdapter, RoleAdapterConfig } from "./types.js";
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
import { Tracer } from "./state/trace.js";
import { runtimeVersion } from "./version.js";
import {
  loadLearnedProfile,
  sensitivityMapFromProfile,
  LearnedProfileSchemaError,
  type LearnedProfile,
  type DetectorSensitivityMap,
} from "./state/learned-profile.js";
import { NATIVE_TOOLS } from "./tools/native/index.js";
import { SandboxContext } from "./sandbox/types.js";
import { loadHostAllowlist } from "./sandbox/host-allowlist.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { MCPClient, StdioTransport, loadGlobalMcpConfig, splitCommand } from "./mcp/index.js";
import { renderMemoryForRole } from "./roles/memory-visibility.js";
import { setupCliBridgeMcpForwarding, replayMcpToolLog, CliBridgePermissionSetupError, type CliBridgeMcpSetup } from "./mcp/cli-bridge-wiring.js";
import { CliBridgeAdapter } from "./adapters/cli-bridge.js";
import { ToolCallRegistry, sessionFromRegistry, raceWithCancellation } from "./runtime/cancellation.js";
import { TOOL_CANCELLED_ERROR_CODE, TOOL_CANCELLED_MESSAGE } from "./sandbox/types.js";
import { GrantLedger } from "./runtime/grants.js";

// v0.11.1: how long to wait for an MCP server to honor an abort before
// synthesizing a cancelled result locally. Per the brief's Q7 lean.
const MCP_CANCEL_GRACE_MS = 5000;

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
  // v0.6: if the brief opts into inherit_memory, prepend the project's
  // memory summary (all categories) to the framework for single-agent runs.
  // Multi-agent runs apply role-scoped visibility inside the coordinator.
  let system = framework;
  if (brief.frontmatter.inherit_memory) {
    const memoryBlock = await renderMemoryForRole(brief.frontmatter.project, null);
    if (memoryBlock) {
      system = `${framework}\n\n---\n\n${memoryBlock}`;
    }
  }

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

  // v0.8: structured trace event stream. Disabled on ephemeral runs so tests
  // don't litter the sessions dir. The tracer survives header-write failures
  // (no-op fallback) so an observability bug never breaks the run.
  const tracer = new Tracer({
    briefId: session.meta.brief_id,
    enabled: !opts.ephemeral,
    openwarVersion: runtimeVersion(),
  });

  // v0.10.0: chat-originated runs stamp a chat_session_compiled event so
  // `openwar inspect` can show "this run came from chat session X."
  if (opts.chatId) {
    tracer.emit({
      type: "chat_session_compiled",
      at: new Date().toISOString(),
      chat_id: opts.chatId,
      brief_id: session.meta.brief_id,
    });
  }

  // v0.9.1: optional learned profile. Loaded once at session start. Missing
  // file is a soft warning, not an error: the brief proceeds with default
  // sensitivities + budgets. Schema mismatch surfaces clearly so the
  // operator regenerates rather than silently defaulting.
  let learnedProfile: LearnedProfile | null = null;
  let detectorSensitivities: DetectorSensitivityMap | undefined = undefined;
  if (brief.frontmatter.learned_profile) {
    const slug = brief.frontmatter.learned_profile;
    try {
      learnedProfile = loadLearnedProfile(slug);
    } catch (err) {
      if (err instanceof LearnedProfileSchemaError) {
        io.warn(
          `learned_profile: ${err.message} (path: ${err.path}). Proceeding with defaults.`,
        );
        learnedProfile = null;
      } else {
        throw err;
      }
    }
    if (!learnedProfile) {
      io.warn(
        `learned_profile: "${slug}" set in frontmatter, but no learned.json found. Proceeding with defaults.`,
      );
    } else {
      detectorSensitivities = sensitivityMapFromProfile(learnedProfile);
      const appliedDetectors = Object.values(learnedProfile.detector_overrides).filter(
        (o) => o.sensitivity !== "default",
      ).length;
      const appliedBudgets = Object.keys(learnedProfile.phase_budgets).length;
      const deadTools = Object.values(learnedProfile.tool_usage).filter((t) => t.dead).length;
      tracer.emit({
        type: "learned_profile_applied",
        at: new Date().toISOString(),
        slug: learnedProfile.slug,
        schema_version: learnedProfile.schema_version,
        applied: { detectors: appliedDetectors, phase_budgets: appliedBudgets, tool_callouts: deadTools },
      });
      io.banner(
        `Learned profile loaded: ${slug} (${appliedDetectors} detector overrides, ${appliedBudgets} phase budgets, ${deadTools} dead-tool callouts).`,
      );
    }
  }

  // v0.9.1: resolve the execute-phase tool-call budget. Brief-explicit always
  // wins (single-agent has no brief-level field today, so this is effectively
  // learned-or-default). Multi-agent coordinator uses its own budget
  // primitives; learned phase budgets don't apply there in v0.9.1.
  const learnedExecuteBudget = learnedProfile?.phase_budgets?.execute?.tool_calls;
  // Audit-emit the consultation. source=learned only when the profile carried
  // a budget; otherwise source=default.
  if (learnedProfile) {
    tracer.emit({
      type: "learned_budget_consulted",
      at: new Date().toISOString(),
      phase: "execute",
      recommended: learnedExecuteBudget ?? 0,
      active: learnedExecuteBudget ?? 30, // DEFAULT_MAX_STEPS in execute.ts
      source: learnedExecuteBudget !== undefined ? "learned" : "default",
    });
  }

  // Per-phase entry timestamps so phase_exit events carry duration_ms. Map
  // from phase name to enter epoch-ms. Phases can re-enter (e.g. execute
  // after a Phase 3 prompt), so on re-enter we just overwrite.
  const phaseEnterMs = new Map<Phase, number>();

  const transition = (to: Phase, reason: string) => {
    const from = session.meta.phase;
    const nowMs = Date.now();
    const at = new Date(nowMs).toISOString();
    const t: PhaseTransition = { from, to, at, reason };
    session.meta.phase = to;
    session.meta.transitions.push(t);
    // Emit phase_exit for the prior phase (if we have its enter time) and
    // phase_enter for the new one. "done" is the terminal phase; we still
    // emit its enter event for symmetry and so replay sees end-of-run.
    const enterMs = phaseEnterMs.get(from);
    if (enterMs !== undefined) {
      tracer.emit({ type: "phase_exit", phase: from, duration_ms: nowMs - enterMs, at });
    }
    phaseEnterMs.set(to, nowMs);
    tracer.emit({ type: "phase_enter", phase: to, at });
  };

  // ------------------- Phase 0 cost-tier preview -------------------
  // Surface adapter + tier before Phase 0 so the operator can abort early
  // if they didn't realize they were about to spend money. cli-bridge is
  // a special case: it requires shell_exec in authorized_costs because
  // every invocation shells out a child process.
  //
  // v0.5.1: when the brief declares per-role adapter overrides, build a
  // dedicated adapter per role and surface each in the tier banner. Roles
  // without overrides reuse the default adapter passed to run(). The map is
  // computed once and handed to the coordinator as getAdapter(roleId).
  const hasShellExec =
    brief.frontmatter.authorized_costs.includes("shell_exec") ||
    brief.frontmatter.authorized_costs.includes("*");

  const roleAdapterMap = buildRoleAdapterMap(brief.frontmatter.role_adapters, adapter, opts);
  const usesCliBridgeAtRoot = adapter.id === "cli-bridge";
  const usesCliBridgeAnywhere =
    usesCliBridgeAtRoot ||
    Object.values(roleAdapterMap).some((a) => a.id === "cli-bridge");

  // Default adapter banner (single-agent runs use only this one).
  const defaultTier = adapterTier(adapter);
  io.banner(
    `Adapter: ${adapter.id}  model: ${adapter.model}  tier: ${defaultTier}` +
      (defaultTier === "paid" ? "  (this run may incur API charges)" : "  (no API charges expected)"),
  );

  // Per-role adapter banner (only when overrides are present).
  if (Object.keys(roleAdapterMap).length > 0) {
    const lines: string[] = ["Per-role adapters:"];
    for (const [roleId, a] of Object.entries(roleAdapterMap)) {
      lines.push(`  ${roleId.padEnd(10)} ${a.id}  model: ${a.model}  tier: ${adapterTier(a)}`);
    }
    io.write(lines.join("\n") + "\n");
  }

  // v0.6.2: surface the bridged-CLI permission interaction at run start too,
  // not just at `openwar validate` time. The brief validator catches it for
  // briefs that pin cli-bridge per-role; the runtime catches the top-level
  // case (`--adapter cli-bridge`) where the brief itself doesn't know.
  if (usesCliBridgeAnywhere) {
    const sideEffectAuthed = brief.frontmatter.authorized_costs.some((c) =>
      ["filesystem_write", "filesystem_delete", "shell_exec", "http_fetch", "git_write", "git_push", "deploy", "external_message", "paid_api_call", "*"].includes(c),
    );
    if (sideEffectAuthed) {
      io.warn(
        "cli-bridge in use with side-effecting authorized_costs. The bridged CLI " +
          "runs as its own subprocess with its own permission system (Claude Code's " +
          "permissions, etc); OpenWar's authorized_costs apply to OpenWar tool calls only. " +
          "v0.7.2+ auto-authorizes the openwar MCP tools in Claude Code's settings before " +
          "spawn. Other permission categories (filesystem paths the bridged CLI's own tools " +
          "touch, shell commands it runs internally) remain the operator's responsibility.",
      );
    }
  }

  if (usesCliBridgeAnywhere && !hasShellExec) {
    io.write(
      "\nopenwar: cli-bridge requires `shell_exec` in the brief's authorized_costs.\n" +
        "Add it under frontmatter:\n\n" +
        "authorized_costs:\n  - shell_exec\n\n" +
        "Aborting before Phase 0.\n",
    );
    return {
      session_id: session.meta.brief_id,
      final_phase: session.meta.phase,
      completed: false,
      halted: true,
      halt_reason: "cli_bridge_requires_shell_exec",
      messages: session.messages,
    };
  }

  // ------------------- v0.7 cli-bridge MCP-server-mode wiring -------------------
  // When the active adapter is cli-bridge AND the brief did not opt out via
  // cli.mcp_forward: false, stand up an MCP config + tool log so the bridged
  // CLI can call OpenWar's native tools. The setup is a no-op for non-
  // cli-bridge runs and for opted-out briefs.
  let mcpSetup: CliBridgeMcpSetup | null = null;
  if (usesCliBridgeAtRoot && adapter instanceof CliBridgeAdapter) {
    const workdirForMcp = opts.workdir ?? brief.frontmatter.workdir ?? process.cwd();
    try {
      mcpSetup = await setupCliBridgeMcpForwarding({
        brief,
        adapter,
        io,
        workdir: workdirForMcp,
        briefId: session.meta.brief_id,
        tracer,
      });
    } catch (err) {
      // v0.7.2: pre-spawn permission auto-setup failed. Halt cleanly into
      // Phase 2 with the remediation message rather than spawning the
      // bridged CLI with broken permissions (operator would hit the gate
      // mid-run and not know why).
      if (err instanceof CliBridgePermissionSetupError) {
        transition("blocker", `cli_bridge_permission_setup_failed (${err.code})`);
        persist();
        io.write(
          `\nopenwar: Claude Code permission auto-setup failed.\n` +
            `  ${err.message}\n` +
            `Remediation: fix the settings file at ${err.path}, or set ` +
            `cli.skip_permission_setup: true in the brief to opt out of ` +
            `auto-setup and manage permissions manually.\n`,
        );
        return {
          session_id: session.meta.brief_id,
          final_phase: session.meta.phase,
          completed: false,
          halted: true,
          halt_reason: `cli_bridge_permission_setup_failed_${err.code.toLowerCase()}`,
          messages: session.messages,
        };
      }
      throw err;
    }
  }

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
  // v0.12.0: per-session GrantLedger. Seeded with persistent grants from
  // the per-project store at construction time. `persistent` requests
  // fall back to `this_session` when project_slug is unset.
  const grantLedger = new GrantLedger(
    brief.frontmatter.project ? { project_slug: brief.frontmatter.project } : {},
  );

  const sandbox = SandboxContext._create({
    workdir,
    defaultTimeoutMs: 30_000,
    defaultMaxOutputBytes: 1_000_000,
    httpAllowlist,
    shellEnabled: !opts.disableShell,
    project_slug: brief.frontmatter.project,
    brief_id: session.meta.brief_id,
    io,
    grantLedger,
    tracer: { emit: (ev) => tracer.emit(ev as Parameters<typeof tracer.emit>[0]) },
  });

  // v0.11.1: per-session cancellation registry. Every tool dispatch registers
  // its AbortController here so chat REPL ctrl-c, programmatic
  // Session.cancelCurrentToolCall(), and RunOptions.signal can all converge
  // on the same cancel path. The Session handle is offered to the optional
  // onSession callback so external callers can drive cancellation without
  // touching the registry directly.
  const cancellationRegistry = new ToolCallRegistry();
  // v0.12.0: Session also exposes the grant ledger so chat REPL `/grants`
  // and `/revoke` slash commands can drive the ledger without reaching
  // into runner internals.
  const liveSession = {
    cancelCurrentToolCall: () => cancellationRegistry.cancel("operator_signal"),
    listActiveGrants: () => grantLedger.listActive(),
    revokeGrant: (grant_id: string) => {
      const ok = grantLedger.revokeGrant(grant_id);
      if (ok) {
        tracer.emit({
          type: "permission_revoked",
          grant_id,
          revoked_at: new Date().toISOString(),
        });
      }
      return ok;
    },
  };
  opts.onSession?.(liveSession);
  if (opts.signal) {
    const onParentAbort = () => {
      // Best-effort: fire cancel if a call is active. If none, the next
      // dispatched call will check ctx.signal at entry (registry creates
      // a fresh ac per call; the parent signal cascades on each begin via
      // the listener we install below).
      void cancellationRegistry.cancel("operator_signal");
    };
    if (opts.signal.aborted) onParentAbort();
    else opts.signal.addEventListener("abort", onParentAbort, { once: true });
  }

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
        toolExecutors.set(fqName, async (call, ctx) => {
          // v0.11.1: MCP servers do not necessarily honor AbortSignal.
          // Fire the signal, give the server `MCP_CANCEL_GRACE_MS` to
          // settle naturally, then synthesize a local cancelled result
          // and let the phase machine continue. The orphaned MCP call
          // may still complete in the background; that's the server's
          // bug (the runtime cannot kill a downstream child it doesn't
          // own).
          const startMs = Date.now();
          const callPromise = client.callTool({ name: t.name, arguments: call.arguments as Record<string, unknown> });
          const translate = (mcpResult: Awaited<typeof callPromise>): import("./tools/types.js").ToolResult => {
            const text = mcpResult.content.map(c => c.text ?? "").join("\n");
            return {
              call_id: call.id,
              success: !mcpResult.isError,
              content: text,
              ...(mcpResult.isError && { error: { code: "MCP_ERROR", message: text } }),
            };
          };
          const synthCancelled = (): import("./tools/types.js").ToolResult => ({
            call_id: call.id,
            success: false,
            content: `${TOOL_CANCELLED_MESSAGE} (MCP server did not respond within ${MCP_CANCEL_GRACE_MS}ms grace; downstream call may still complete in background.)`,
            error: { code: TOOL_CANCELLED_ERROR_CODE, message: TOOL_CANCELLED_MESSAGE },
            meta: { duration_ms: Date.now() - startMs, bytes: 0 },
          });
          if (!ctx.signal) {
            const r = await callPromise;
            return translate(r);
          }
          type Winner =
            | { tag: "result"; r: Awaited<typeof callPromise> }
            | { tag: "cancelled" };
          const winner = await raceWithCancellation<Winner>(
            callPromise.then((r): Winner => ({ tag: "result", r })),
            ctx.signal,
            MCP_CANCEL_GRACE_MS,
            (): Winner => ({ tag: "cancelled" }),
          );
          return winner.tag === "cancelled" ? synthCancelled() : translate(winner.r);
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
    // v0.8: index of the next coordinator event we haven't yet projected
    // into the trace. Coordinator events are append-only, so a counter is
    // enough to know what's new each onSnapshot tick.
    let traceCoordCursor = 0;
    transition("execute", "intake accepted (multi-agent)");
    // v0.5.1: persist which adapter each role resolved to so `inspect` can
    // surface the run shape and resume rebuilds adapters from this map without
    // re-reading the brief. Optional field; older sessions stay readable.
    if (Object.keys(roleAdapterMap).length > 0) {
      const adapterIdsMeta = session.meta as typeof session.meta & {
        role_adapter_ids?: Record<string, { id: string; model: string }>;
      };
      adapterIdsMeta.role_adapter_ids = {};
      for (const [roleId, a] of Object.entries(roleAdapterMap)) {
        adapterIdsMeta.role_adapter_ids[roleId] = { id: a.id, model: a.model };
      }
    }
    persist();
    const coordResult = await runCoordinator({
      brief,
      framework: system,
      getAdapter: (roleId) => roleAdapterMap[roleId] ?? adapter,
      io,
      roleIds,
      budgets,
      toolDefinitions,
      toolExecutors,
      sandbox,
      sessionApproved: session.meta.session_approved_categories ?? [],
      sessionId: session.meta.brief_id,
      cancellationRegistry,
      tracer,
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
        // v0.8: project any new coordinator events into the trace.
        for (let i = traceCoordCursor; i < events.length; i++) {
          const ev = events[i]!;
          const at = ("at" in ev && typeof ev.at === "string") ? ev.at : new Date().toISOString();
          if (ev.type === "state_enter") {
            tracer.emit({ type: "coordinator_state", state: ev.state, at });
          } else if (ev.type === "role_invoked") {
            // role_invoke trace event needs token + duration data, which the
            // coordinator event itself doesn't carry. We emit a minimal
            // signal here; full token accounting lands when adapters
            // forward usage reports (planned: same patch series).
            tracer.emit({
              type: "role_invoke",
              role: ev.role,
              tokens_in: 0,
              tokens_out: 0,
              tokens_source: "estimated",
              duration_ms: 0,
              at,
            });
          } else if (ev.type === "subtask_result") {
            tracer.emit({ type: "subtask_status", subtask_id: ev.subtask_id, status: ev.status, at });
          } else if (ev.type === "budget_warn") {
            tracer.emit({ type: "budget_warn", metric: ev.metric, used: ev.used, limit: ev.limit, at });
          } else if (ev.type === "budget_halt") {
            tracer.emit({ type: "budget_halt", metric: ev.metric, used: ev.used, limit: ev.limit, at });
          }
        }
        traceCoordCursor = events.length;
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
    await foldMcpToolLog(mcpSetup, session, tracer);
    persist();
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
    tracer,
    cancellationRegistry,
    ...(detectorSensitivities ? { detectorSensitivities } : {}),
    ...(learnedExecuteBudget !== undefined ? { maxSteps: learnedExecuteBudget } : {}),
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
      tracer.emit({
        type: "auth_prompt",
        categories: missing as string[],
        response: approveSession ? "Y" : approveOnce ? "y" : "n",
        at: new Date().toISOString(),
      });

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
          cancellationRegistry,
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
        cancellationRegistry,
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
      tracer,
      cancellationRegistry,
      ...(detectorSensitivities ? { detectorSensitivities } : {}),
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
  await foldMcpToolLog(mcpSetup, session, tracer);
  persist();

  return {
    session_id: session.meta.brief_id,
    final_phase: "done",
    completed: true,
    halted: false,
    messages: session.messages,
  };
}

// v0.7: fold MCP-mediated tool calls from the per-session JSONL log into the
// session's tool_calls record. Called once per run, after the bridged CLI's
// last call. No-op when MCP forwarding wasn't enabled or when the log file
// doesn't exist (e.g. the bridged CLI never called an OpenWar tool).
//
// v0.8: the tracer arg receives synthesized mcp_call_dispatched +
// mcp_call_completed events per log entry so `inspect --mcp` surfaces the
// full lifecycle, and emits mcp_server_shutdown when this session ends.
async function foldMcpToolLog(setup: CliBridgeMcpSetup | null, session: SessionState, tracer?: Tracer): Promise<void> {
  if (!setup || !setup.enabled) return;
  const records = await replayMcpToolLog(setup, tracer);
  if (tracer) {
    tracer.emit({
      type: "mcp_server_shutdown",
      reason: "session_end",
      at: new Date().toISOString(),
    });
  }
  if (records.length === 0) return;
  const existing = session.meta.tool_calls ?? [];
  session.meta.tool_calls = [...existing, ...records];
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

// v0.5.1: tier resolution that prefers the adapter's own `tier` property
// (cli-bridge attaches one at construction) and falls back to DEFAULT_TIERS.
function adapterTier(adapter: AgentAdapter): "free" | "paid" {
  const fromAdapter = (adapter as unknown as { tier?: "free" | "paid" }).tier;
  if (fromAdapter === "free" || fromAdapter === "paid") return fromAdapter;
  return DEFAULT_TIERS[adapter.id as AdapterId] ?? "paid";
}

// v0.5.1: build the per-role adapter map from the brief's role_adapters
// frontmatter. Roles without an override get omitted; the coordinator falls
// back to the runtime default. Construction failures (unknown adapter id,
// missing API key) throw at this point, before Phase 0, so the operator
// sees the problem before any agent call goes out.
function buildRoleAdapterMap(
  spec: Record<string, RoleAdapterConfig> | undefined,
  defaultAdapter: AgentAdapter,
  opts: RunOptions,
): Record<string, AgentAdapter> {
  void opts;
  void defaultAdapter;
  const map: Record<string, AgentAdapter> = {};
  if (!spec) return map;
  for (const [roleId, cfg] of Object.entries(spec)) {
    if (!cfg.adapter) continue;
    const adapterConfig: AdapterConfig = { id: cfg.adapter };
    if (cfg.model) adapterConfig.model = cfg.model;
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (k === "adapter" || k === "model") continue;
      extra[k] = v;
    }
    if (Object.keys(extra).length > 0) adapterConfig.extra = extra;
    const built = makeAdapter(adapterConfig);
    if (!built.isConfigured()) {
      throw new Error(
        `Role "${roleId}" is pinned to adapter "${cfg.adapter}" but it is not configured. ` +
          `Set the adapter's API key env var, or change role_adapters.${roleId}.adapter.`,
      );
    }
    // Attach resolved tier so adapterTier() reports correctly for adapters
    // that don't carry a `tier` field of their own (everything except
    // cli-bridge today). resolveTier() reads extra.tier if present.
    (built as unknown as { tier?: "free" | "paid" }).tier = resolveTier(adapterConfig);
    map[roleId] = built;
  }
  return map;
}

