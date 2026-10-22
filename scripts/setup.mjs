#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnAgentSync } from "./agent-process.mjs";
import { adapterDriver } from "./adapter-drivers.mjs";
import { resolveAdapterTransport } from "./adapter-transport.mjs";
import readline from "node:readline";
import {
  discoverModelCatalog,
  loadDocumentedCatalog,
  loadDocumentedEffort,
  discoverCapabilities,
  canonicalModelId
} from "./model-discovery.mjs";
import { discoverAgentContract } from "./agent-contract.mjs";
import { buildDiscoveryCaches } from "./setup-discovery.mjs";
import {
  loadAndMigrateConfig
} from "./config-migration.mjs";
import {
  validateConfigForSave,
  validateExecutionConfig,
  validateNewConfig,
} from "./config-validation.mjs";
import {toNewLayoutConfig, ROLE_NAMES} from "./config-layout.mjs";
import {schemaReferenceFor} from "./config-schema-ref.mjs";
import {
  detectRuntimeModeCapabilities,
  RUNTIME_MODE_IDS
} from "./runtime-mode-capabilities.mjs";
import {
  isRoleOnlyScope,
  preserveExecutionForRoleScope,
  resolveRuntimeExecution,
  formatRuntimeModeLabel
} from "./runtime-mode-selection.mjs";
import { detect as detectSpecKit } from "../adapters/speckit.mjs";
import { detect as detectGsd } from "../adapters/gsd.mjs";
import { detectTestCommand, resolveGatesCommands } from "./detect-test-command.mjs";
import { discoverPlaywrightRuntime } from "./playwright-runtime.mjs";
import { formatPlaywrightStatusBlock } from "./playwright-status-block.mjs";
import { detectPlatformCapabilities, formatExecutionEnvironmentBlock } from "./platform-capabilities.mjs";
import {
  addFallback,
  applyFallbacks,
  formatFallbackEntry,
  moveFallback,
  normalizeFallbackList,
  removeFallbackAt,
  reviewerIndependenceWarning
} from "./role-fallback-edit.mjs";
import { normalizeEscalationModel, ESCALATION_ROLES } from "./escalation-model.mjs";
import {isHaikuOnReadOnlyClaudeRole, planModeModelNote} from "./plan-mode-model-note.mjs";
import { networkIsolationPrefix } from "./shell-guard.mjs";
import { installAgentCommands } from "./agent-command-registry.mjs";
import { fileURLToPath } from "node:url";
import { PER_TASK_MAX_TURNS_DEFAULT, PER_TASK_MAX_TOKENS_DEFAULT, CONTINUATION_ALLOWANCE_DEFAULT, HANDOFF_MAX_CHARS_DEFAULT, HANDOFF_NOTE_MAX_CHARS_DEFAULT, HANDOFF_WRAPUP_TOKENS_DEFAULT, NO_PROGRESS_GENERATIONS_DEFAULT, BACKSTOP_RAW_TOKENS_DEFAULT, mergeRoleCaps } from "./per-task-budget.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// .autopilot/ holds per-run scratch (sandboxed reviewers' throwaway CLI
// caches/snapshots, kept for audit per README) alongside config.json/
// state.json. None of that is meant to be tracked, and leaving it untracked
// but un-ignored is actively harmful: every sandboxed role's own `git`
// calls (status/diff/check-ignore) then have to walk the accumulated
// scratch of every prior run in the same repo, which only grows over time.
// Best-effort and idempotent: only touches a real git repo, only appends
// when `.autopilot/` (or `.autopilot`) isn't already covered by an existing
// line, and never rewrites or reorders the user's existing .gitignore.
function ensureAutopilotGitignored(repo) {
  try {
    if (!fs.existsSync(path.join(repo, ".git"))) return;
    const file = path.join(repo, ".gitignore");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (/^\.autopilot\/?\s*$/m.test(existing)) return;
    const needsNewline = existing.length > 0 && !existing.endsWith("\n");
    fs.writeFileSync(file, `${existing}${needsNewline ? "\n" : ""}.autopilot/\n`);
    console.log(`\nAdded .autopilot/ to ${file} (sandboxed-role scratch should never be tracked or left visible to git).`);
  } catch {
    // Best-effort only: setup must never fail because .gitignore couldn't be touched.
  }
}

const args = process.argv;

const repoArg = args.includes("--repo")
  ? args[args.indexOf("--repo") + 1]
  : ".";

const repo = path.resolve(repoArg || ".");
const playwrightRuntime = discoverPlaywrightRuntime({repository: repo, skillRoot});
const editMode = args.includes("--edit");
const wizardMode = args.includes("--wizard");
const showMode = args.includes("--show");

const roleArg = args.includes("--role")
  ? args[args.indexOf("--role") + 1]
  : "";

const validRoleArg =
  !roleArg || ROLE_NAMES.includes(roleArg);

if (!validRoleArg) {
  console.error(
    `Unknown role: ${roleArg}. Choose one of ${ROLE_NAMES.join(", ")}.`
  );
  process.exit(2);
}


const agents = JSON.parse(fs.readFileSync(path.join(skillRoot, "adapters", "agents.json"), "utf8")).adapters;

const configPath = path.join(
  repo,
  ".autopilot",
  "config.json"
);

// Backlog #1 (mission 096 Phase 4 task 4.1): setup writes the full v4 layout
// with "$schema" first and schema_version "4.0".
const CONFIG_WRITE_SCHEMA = "4.0";

// Backlog #1(d): load + migrate IN MEMORY only. Migration must not touch
// config.json until the whole flow has validated and is about to save; a run
// that ends with a failed final validation (or that the operator aborts) must
// leave the on-disk config byte-identical. The original file is backed up at
// the single save point below, when the migration actually changed something.
const existingResult = loadAndMigrateConfig(
  configPath,
  { persist: false }
);

const existing = existingResult.config;

const probe = id => {
  const t = resolveAdapterTransport({
    driver: adapterDriver(id),
    profile: agents[id]?.provider_egress?.default_profile || null,
    request: {binary: agents[id].binary, args: [...(agents[id].probe || ["--version"])]}
  });
  if (!t.available) return false;
  return spawnAgentSync(t.invocation.binary, t.invocation.args, {
    cwd: repo,
    stdio: "ignore"
  }).status === 0;
};

const forceInteractive = process.env.AUTOPILOT_SETUP_FORCE_INTERACTIVE === "1";
let inputLines = [];
let inputIndex = 0;

if (forceInteractive) {
  const stdinContent = fs.readFileSync(0, "utf8");
  inputLines = stdinContent.split("\n");
}

const rl = forceInteractive ? null : readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let setupDone = false;

const inputEnded = () => {
  console.error(
    "ap setup: input ended before setup finished — run ap setup in an interactive terminal. Configuration not saved."
  );
  process.exit(1);
};

if (rl) {
  rl.on("close", () => {
    if (!setupDone) inputEnded();
  });
}

const ask = q =>
  new Promise(resolve => {
    if (forceInteractive) {
      const line = inputIndex < inputLines.length ? inputLines[inputIndex++] : "";
      resolve(line.trim());
    } else {
      try {
        rl.question(q, a => resolve(a.trim()));
      } catch (e) {
        if (e?.code === "ERR_USE_AFTER_CLOSE") inputEnded();
        throw e;
      }
    }
  });

const choose = async (
  label,
  options,
  fallbackIndex = 0
) => {
  console.log(`\n${label}`);

  options.forEach((x, i) =>
    console.log(`${i + 1}) ${x}`)
  );

  const raw = await ask(
    `Choose [${fallbackIndex + 1}]: `
  );

  const n = Number(raw);

  return Number.isInteger(n) &&
    n >= 1 &&
    n <= options.length
    ? options[n - 1]
    : options[fallbackIndex];
};

const continuePrompt = async (label = "Press Enter to continue") => {
  await ask(`\n${label} `);
};

const yesNo = async (
  label,
  def = true
) => {
  const raw = (
    await ask(
      `${label} [${def ? "Y/n" : "y/N"}]: `
    )
  ).toLowerCase();

  if (!raw) return def;

  return ["y", "yes"].includes(raw);
};

const value = async (
  label,
  def = ""
) => {
  const raw = await ask(
    `${label}${def ? ` [${def}]` : ""}: `
  );

  return raw || def;
};

const valueOrDefault = async (
  label,
  def = ""
) => {
  const raw = await ask(
    `${label}${def ? ` [${def}]` : ""}: `
  );

  return raw;
};

async function pickModelAndCapabilities(
  label,
  meta,
  current,
  adapterId,
  contractCache = null
) {
  if (!meta.model_flag) {
    return {
      model: current?.model || "",
      effortModelIds: null,
      reasoningOptions: [],
      variantOptions: [],
      modelSource:
        current?.model_source || "default"
    };
  }

  const discovery = contractCache || await discoverAgentContract(adapterId, meta);
  const catalog = discovery.models.status === "reported" ? discovery.models.items : [];

  if (catalog.length) {
    const options = [
      {
        id: "",
        label: "Use CLI default",
        reasoning: [],
        variants: []
      },
      ...catalog
    ];

    const currentIndex = current
      ? options.findIndex(x =>
        x.id === current.model ||
        (x.effortModelIds && Object.values(x.effortModelIds).includes(current.model))
      )
      : -1;

    const curIndex = currentIndex >= 0 ? currentIndex : 0;

    const picked = await choose(
      `${label} model (live discovery from ${meta.binary})`,
      options.map(
        x => x.label || x.id
      ),
      curIndex
    );

    const item =
      options.find(
        x => (x.label || x.id) === picked
      ) || options[0];

    // Live discovery succeeded for the model list itself, but this specific
    // model's own entry reported no reasoning/effort levels (the live CLI
    // response simply didn't include any). Distinct from the model-level
    // documented fallback above/below: that one only runs when live
    // discovery fails entirely. This one fills a narrower, per-model gap in
    // an otherwise-live result, so it is never used for "Use CLI default"
    // (item.id is empty there — there is no selected model to look up).
    let reasoningOptions = item.reasoning || [];
    if (item.id && !reasoningOptions.length && meta.effort_flag === "--variant" && Array.isArray(item.variants) && item.variants.length) {
      // OpenCode has no separate reasoning field in its own model output —
      // its --help text names --variant itself as "provider-specific
      // reasoning effort" (e.g. high, max, minimal), so for the one adapter
      // that declares effort_flag "--variant", the live-discovered variants
      // ARE the live reasoning levels, not a distinct dimension.
      reasoningOptions = item.variants;
    } else if (item.id && !reasoningOptions.length) {
      const documentedEffort = loadDocumentedEffort(adapterId);
      if (documentedEffort) {
        console.log(
          `\n${label}: documented reasoning/effort levels (not live-verified for ${item.label || item.id})`
        );
        console.log(
          `Source: ${documentedEffort.source} | verified: ${documentedEffort.last_verified}`
        );
        reasoningOptions = documentedEffort.levels;
      }
    }

    return {
      // Backlog #1(b): persist the CLI's canonical live id, never a
      // case-variant or display casing the operator typed/picked.
      model: canonicalModelId(item.id || "", catalog),
      effortModelIds: item.effortModelIds || null,
      reasoningOptions,
      variantOptions:
        item.variants || [],
      modelSource:
        item.id ? "live" : "default"
    };
  }

  const documented = discovery.models.status === "aliases"
    ? {
      source: discovery.models.source,
      last_verified: discovery.models.verified,
      models: discovery.models.items
    }
    : loadDocumentedCatalog(adapterId);

  if (documented) {
    console.log(
      `\n${label}: documented model aliases (not live-verified)`
    );
    console.log(
      `Source: ${documented.source} | verified: ${documented.last_verified}`
    );

    const options = [
      {
        id: "",
        label: "Use CLI default",
        reasoning: []
      },
      ...documented.models,
      {
        id: "__manual__",
        label: "Type a model name manually",
        reasoning: []
      }
    ];

    const curIndex =
      current &&
        options.findIndex(
          x => x.id === current.model
        ) >= 0
        ? options.findIndex(
          x => x.id === current.model
        )
        : 0;

    const picked = await choose(
      `${label} model (documented options for ${adapterId})`,
      options.map(
        x => x.label || x.id
      ),
      curIndex
    );

    const item =
      options.find(
        x => (x.label || x.id) === picked
      ) || options[0];

    if (item.id === "__manual__") {
      return {
        // Backlog #1(b): a typed id is canonicalised against the documented
        // catalog (case-insensitive) so the display casing is never saved.
        model: canonicalModelId(
          await valueOrDefault(
            `${label} model (blank = let ${meta.binary} choose its default)`,
            current?.model || ""
          ),
          documented.models
        ),
        effortModelIds: null,
        reasoningOptions: [],
        variantOptions: [],
        modelSource: "manual"
      };
    }

    return {
      model: canonicalModelId(item.id || "", documented.models),
      reasoningOptions:
        item.reasoning || [],
      variantOptions:
        item.variants || [],
      modelSource:
        item.id
          ? "documented"
          : "default"
    };
  }

  console.log(
    `\n${label}: ${meta.binary} does not expose a supported machine-readable model list; ` +
    `Autopilot will not invent a catalog.`
  );

  return {
    model: await valueOrDefault(
      `${label} model (blank = let ${meta.binary} choose its default)`,
      current?.model || ""
    ),
    effortModelIds: null,
    reasoningOptions: [],
    variantOptions: [],
    modelSource: "manual"
  };
}

// Ask for reasoning/effort and (when supported) variant for an already
// picked model. Shared by the main-role flow and the per-role fallback
// add flows so both use identical prompts and options. May swap
// modelInfo.model when the model maps effort levels to exact ids.
// Adapters without an effort flag are not asked and yield "".
async function pickReasoningAndVariant(label, effectiveMeta, modelInfo, prior) {
  let reasoning = "";

  if (effectiveMeta.effort_flag) {
    if (modelInfo.effortModelIds && modelInfo.reasoningOptions.length) {
      const opts = [...modelInfo.reasoningOptions];
      const priorReasoning = prior.reasoning || "";
      const fallback = Math.max(0, opts.indexOf(priorReasoning));
      reasoning = await choose(
        `${label} reasoning/effort (for selected model)`,
        opts,
        fallback >= 0 ? fallback : 0
      );
    } else if (modelInfo.reasoningOptions.length) {
      const opts = [
        "Use CLI default",
        ...modelInfo.reasoningOptions
      ];

      const priorReasoning =
        prior.reasoning || "";

      const fallback = Math.max(
        0,
        opts.indexOf(priorReasoning)
      );

      reasoning = await choose(
        `${label} reasoning/effort (for selected model)`,
        opts,
        fallback
      );

      if (
        reasoning === "Use CLI default"
      ) {
        reasoning = "";
      }
    } else {
      reasoning = await value(
        `${label} reasoning/effort`,
        prior.reasoning || ""
      );
    }
  }

  // Backlog #1(c): the reasoning menu only ever offered the selected model's
  // live variants — but a carried-forward value (e.g. a fallback copying the
  // role's reasoning) could name a level THIS model does not support. When
  // the model's variants are known, drop an unsupported inherited value
  // instead of saving something the final validation will reject.
  if (reasoning && modelInfo.reasoningOptions.length && !modelInfo.reasoningOptions.includes(reasoning)) {
    reasoning = "";
  }

  if (modelInfo.effortModelIds && reasoning) {
    const exactModel = modelInfo.effortModelIds[reasoning];
    if (exactModel) modelInfo.model = exactModel;
  } else if (modelInfo.effortModelIds && !reasoning) {
    const preferred = modelInfo.effortModelIds.medium || modelInfo.effortModelIds.high || modelInfo.effortModelIds.low;
    if (preferred) modelInfo.model = preferred;
  }

  let variant = "";

  if (effectiveMeta.variant_flag || (effectiveMeta.variant_mode === "model_suffix" && modelInfo.variantOptions.length)) {
    if (modelInfo.variantOptions.length) {
      const opts = [
        "Use CLI default",
        ...modelInfo.variantOptions
      ];

      const fallback = Math.max(
        0,
        opts.indexOf(
          prior.variant || ""
        )
      );

      variant = await choose(
        `${label} variant (for selected model)`,
        opts,
        fallback
      );

      if (
        variant === "Use CLI default"
      ) {
        variant = "";
      }
    } else {
      variant = await value(
        `${label} variant`,
        prior.variant || ""
      );
    }
  }
  // Same re-check for a carried-forward variant.
  if (variant && modelInfo.variantOptions.length && !modelInfo.variantOptions.includes(variant)) {
    variant = "";
  }
  return { reasoning, variant };
}

async function roleConfig(  label,
  available,
  preferred,
  current = {},
  capabilityCache = new Map(),
  contractCache = new Map(),
  defaultResume = true
) {
  const preferredAdapter =
    current.adapter || preferred;

  const idx = Math.max(
    0,
    available.indexOf(preferredAdapter)
  );

  const adapter = await choose(
    `${label} CLI`,
    available,
    idx >= 0 ? idx : 0
  );

  const meta = agents[adapter];

  const runtimeCaps =
    capabilityCache.get(adapter) || await discoverCapabilities(meta);

  console.log(
    `  capabilities: ` +
    `model=${runtimeCaps.model ? runtimeCaps.model_flag : "no"}, ` +
    `effort=${runtimeCaps.effort ? runtimeCaps.effort_flag : "no"}, ` +
    `variant=${runtimeCaps.variant ? runtimeCaps.variant_flag : (meta.variant_mode === "model_suffix" ? "model#variant" : "no")}, ` +
    `resume=${runtimeCaps.resume ? "yes" : "no"}`
  );

  const effectiveMeta = {
    ...meta,
    model_flag:
      runtimeCaps.model
        ? runtimeCaps.model_flag
        : null,
    effort_flag:
      runtimeCaps.effort
        ? runtimeCaps.effort_flag
        : null,
    variant_flag:
      runtimeCaps.variant
        ? runtimeCaps.variant_flag
        : null,
    variant_mode: meta.variant_mode || null
  };

  const prior =
    adapter === current.adapter
      ? current
      : {
        model: "",
        reasoning: "",
        variant: "",
        resume: defaultResume
      };

  const modelInfo =
    await pickModelAndCapabilities(
      label,
      effectiveMeta,
      prior,
      adapter
    );

  const { reasoning, variant } = await pickReasoningAndVariant(
    label,
    effectiveMeta,
    modelInfo,
    prior
  );

  // Resume is an internal orchestration decision, not a setup choice.
  const resume = runtimeCaps.resume
    ? (prior.resume !== false)
    : false;

  return {
    adapter,
    model: modelInfo.model,
    reasoning,
    variant,
    resume,
    model_source:
      modelInfo.modelSource,
    model_verified_at:
      modelInfo.modelSource === "live"
        ? new Date().toISOString()
        : null,
    capabilities_verified_at:
      new Date().toISOString()
  };
}

// Live variants/reasoning levels a catalog item supports, or null when the
// item is unknown or exposes no model-specific data.
function supportedLevelsForModel(items, model) {
  const item = (items || []).find(
    candidate => candidate?.id === model || Object.values(candidate?.effortModelIds || {}).includes(model)
  );
  if (!item) return null;
  if (item.reasoning?.length) return item.reasoning;
  if (item.variants?.length) return item.variants;
  return null;
}

// Backlog #1(a): a configured model (primary, fallback, or escalation) that
// the CLI's live catalog no longer reports must not abort the whole setup —
// list the affected role/entry with the currently available models and offer
// an in-place replacement (or a drop) right here. Returns true when `roles`
// was changed, so the caller can re-validate and continue.
async function repairOneMissingModel({entry, roles, agents, roleLabels, contractCache}) {
  const role = roles?.[entry.role];
  if (!role) return false;
  const roleLabel = roleLabels?.[entry.role] || entry.role;
  const targetLabel = entry.kind === "fallback"
    ? `${roleLabel} fallback ${entry.index + 1}`
    : entry.kind === "escalation"
      ? `${roleLabel} escalation model`
      : roleLabel;
  const adapterId = entry.adapter;
  const adapter = agents?.[adapterId];
  const binary = adapter?.binary || adapterId;
  let items = [];
  try {
    const contract = contractCache?.get(adapterId) || await discoverAgentContract(adapterId, adapter);
    items = contract?.models?.status === "reported" ? contract.models.items : [];
  } catch { items = []; }
  const ids = [];
  for (const item of items) {
    if (item?.id && !ids.includes(item.id)) ids.push(item.id);
    if (item?.effortModelIds) {
      for (const value of Object.values(item.effortModelIds)) {
        if (value && !ids.includes(value)) ids.push(value);
      }
    }
  }

  console.log(`\nModel no longer available: ${targetLabel} uses '${entry.model}', which ${binary} no longer lists.`);
  console.log(ids.length
    ? `${binary} currently lists: ${ids.join(", ")}`
    : `${binary} currently reports no machine-readable model list.`);

  const dropLabel = entry.kind === "fallback"
    ? "Drop this fallback"
    : entry.kind === "escalation"
      ? "Turn off the escalation model"
      : "Use CLI default (clear the model)";
  const options = [...ids];
  if (!ids.length) options.push("Type a model id");
  options.push(dropLabel);
  const picked = await choose(`${targetLabel}: pick a replacement, or drop it`, options, 0);

  if (picked === dropLabel) {
    if (entry.kind === "fallback") {
      const next = removeFallbackAt(normalizeFallbackList(role.fallbacks), entry.index);
      roles[entry.role] = applyFallbacks(role, next);
    } else if (entry.kind === "escalation") {
      delete role.escalation_model;
    } else {
      role.model = "";
      role.model_source = "default";
      role.model_verified_at = null;
    }
    console.log(`  ${targetLabel}: dropped.`);
    return true;
  }

  let model = picked === "Type a model id"
    ? await valueOrDefault(`${targetLabel} model id`, "")
    : picked;
  model = canonicalModelId(model, items);
  if (!model) return false;

  // Keep the entry's own reasoning/variant only when the replacement model
  // still supports it — swapping in a model with a narrower variant set must
  // not leave behind a now-invalid value (backlog #1(c)).
  const supported = supportedLevelsForModel(items, model);
  const keepLevel = value => (supported && supported.includes(value) ? value : "");

  if (entry.kind === "fallback") {
    const list = normalizeFallbackList(role.fallbacks);
    const target = list[entry.index];
    if (!target) return false;
    target.model = model;
    target.reasoning = keepLevel(target.reasoning || "");
    target.variant = keepLevel(target.variant || "");
    roles[entry.role] = applyFallbacks(role, list);
  } else if (entry.kind === "escalation") {
    const em = role.escalation_model || {};
    role.escalation_model = {
      ...em,
      model,
      reasoning: keepLevel(em.reasoning || ""),
      variant: keepLevel(em.variant || "")
    };
  } else {
    role.model = model;
    role.reasoning = keepLevel(role.reasoning || "");
    role.variant = keepLevel(role.variant || "");
    role.model_source = "live";
    role.model_verified_at = new Date().toISOString();
  }
  console.log(`  ${targetLabel}: set to ${model}.`);
  return true;
}

function printCurrentSummary(current) {
  if (!current?.roles) return;

  console.log(
    "\nCurrent configuration:"
  );

  const roles = ROLE_NAMES;
  roles.forEach((role) => {
    const r = current.roles[role] || {};

    const describe = (x, alwaysEffort = false) =>
      `${x.adapter || "(unset)"}` +
      `${x.model ? ` / ${x.model}` : " / default"}` +
      `${x.reasoning ? ` / effort=${x.reasoning}` : alwaysEffort ? " / effort=default" : ""}` +
      `${x.variant ? ` / variant=${x.variant}` : ""}`;

    console.log(`✓ ${role}: ${describe(r)}`);

    (Array.isArray(r.fallbacks) ? r.fallbacks : []).forEach((fb, i) => {
      console.log(`    fallback ${i + 1}: ${describe(fb || {}, true)}`);
    });
    if (r.escalation_model) {
      console.log(`    escalation (one round when stuck): ${describe(r.escalation_model, true)}`);
    }
  });

  if (current.project?.planning_framework) {
    console.log(
      `✓ planning: ${current.project.planning_framework}`
    );
  }

  if (current.execution?.runtime_mode) {
    console.log(
      `✓ runtime: ${current.execution.runtime_mode}` +
      `${current.execution.wsl_distro ? ` via distro '${current.execution.wsl_distro}'` : ""}`
    );
  }

  // Print-only: displays install commands, must never execute the command it displays.
  console.log(formatPlaywrightStatusBlock(playwrightRuntime));
}

function planningFrameworkOptions(
  currentFramework = ""
) {
  const options = [
    {
      id: "speckit",
      label: "SpecKit"
    },
    {
      id: "gsd",
      label: "GSD"
    }
  ];

  if (
    currentFramework &&
    options.some(
      x => x.id === currentFramework
    )
  ) {
    return options;
  }

  return options;
}

// The "Planning framework" choices, shared by the first-run wizard and the
// reconfigure path (both must offer the same list). Standalone is always
// selectable, even when SpecKit/GSD is detected: a project may carry a
// framework's files and still want Autopilot's own plan-per-mission flow.
// Detected frameworks stay first, so the default pick is unchanged.
function frameworkChoicesFor(currentFramework, detectedFrameworks) {
  const choices = planningFrameworkOptions(currentFramework)
    .filter(x => detectedFrameworks.includes(x.id));
  choices.push({
    id: "standalone",
    label: choices.length
      ? "Standalone (ignore the detected framework)"
      : "Continue without a planning framework"
  });
  return choices;
}

function detectPlanningFrameworks(repo) {
  const detected = [];

  try {
    if (detectSpecKit(repo)) {
      detected.push("speckit");
    }
  } catch { }

  try {
    if (detectGsd(repo)) {
      detected.push("gsd");
    }
  } catch { }

  return detected;
}

async function networkSetting(current) {
  let networkIsolation =
    current?.gates?.network_isolation ??
    true;

  const isolationAvailable = !!networkIsolationPrefix();

  if (!isolationAvailable) {
    const platformLabel =
      process.platform === "win32"
        ? "Windows"
        : process.platform === "darwin"
          ? "macOS"
          : process.platform;

    console.log(
      `\n⚠  ${platformLabel}: Linux network namespace isolation is unavailable.`
    );

    console.log(
      `   Secure default: gates.network_isolation=true; ` +
      `verify/gates that require isolation will refuse to run.`
    );
    console.log(
      `   This opt-out affects verify/gate commands only. Read-only reviewer/verifier` +
      ` filesystem containment (WSL/Linux bubblewrap) is checked separately at run time.`
    );

    networkIsolation = !(
      await yesNo(
        "Allow verify/gates execution without network isolation?",
        !networkIsolation
      )
    );
  }

  return networkIsolation;
}

async function printExecutionEnvironmentBlock() {
  console.log(formatExecutionEnvironmentBlock(await detectPlatformCapabilities()));
}



(async () => {
  try {
    const current = existing;

    if (showMode) {
      const {configShowCommand} = await import("./config-show.mjs");
      const output = await configShowCommand(configPath, {
        format: "text",
        showOnly: args.includes("--path") ? args[args.indexOf("--path") + 1] : null
      });
      console.log(output);
      return;
    }

    if (editMode && !current) {
      console.log("\nProject Autopilot — configuration\n");
      console.log("No Autopilot configuration found.");
      console.log("Run `ap setup` first, then use `ap config` to modify it.\n");
      return;
    }

    if (!editMode && !wizardMode && current) {
      console.log(
        `Existing configuration found at ${configPath}. ` +
        `Use 'ap config' to edit it.`
      );

      return;
    }

    console.log(
      editMode
        ? "\nProject Autopilot — reconfigure\n"
        : "\nProject Autopilot — setup\n"
    );

    const available =
      Object.keys(agents)
        .filter(id => probe(id));

    if (wizardMode) {
      console.log("CLI availability:");
      for (const id of Object.keys(agents)) {
        console.log(
          `${available.includes(id)
            ? "✓"
            : "·"
          } ${id} (${agents[id].binary})`
        );
      }
    }

    if (!available.length) {
      console.error(
        "\nNo supported agent CLI detected."
      );
      process.exitCode = 3;
      return;
    }

    // Probe each available CLI once per setup invocation.
    // The capability result is reused for every role, while model/variant
    // selection is still presented independently each time the CLI is chosen.
    const { capabilityCache, contractCache } =
      await buildDiscoveryCaches(available, agents);

    // Interactive once, reused by the role-fallback loop below and the gates
    // question further down: a non-interactive stdin keeps defaults.
    const interactive =
      forceInteractive || !!process.stdin.isTTY;

    let detectedFrameworks = [];
    let frameworkChoices = [];

    if (wizardMode) {
      detectedFrameworks = detectPlanningFrameworks(repo);

      console.log("\nFramework availability:");
      console.log(
        `✓ SpecKit: ${detectedFrameworks.includes("speckit") ? "available" : "not detected"}`
      );
      console.log(
        `· GSD: ${detectedFrameworks.includes("gsd") ? "available" : "not detected"}`
      );
      // Print-only: displays install commands, must never execute the command it displays.
      console.log(formatPlaywrightStatusBlock(playwrightRuntime));
      await printExecutionEnvironmentBlock();

      printCurrentSummary(current);

      frameworkChoices = frameworkChoicesFor("", detectedFrameworks);

      await continuePrompt("Press Enter to continue to role configuration...");
    }

    const SCOPE = {
      ALL: "all",
      ROLE: "role",
      FRAMEWORK: "framework"
    };

    let scope;

    if (wizardMode) {
      scope = SCOPE.ALL;
    } else if (roleArg) {
      scope =
        `${SCOPE.ROLE}:${roleArg}`;
    } else if (editMode) {
      printCurrentSummary(current);
      const selected =
        await choose(
          "Configuration scope:",
          [
            "All configuration",
            "One role",
            "Framework / safety"
          ],
          0
        );

      const scopeMap = {
        "All configuration":
          SCOPE.ALL,

        "One role":
          SCOPE.ROLE,

        "Framework / safety":
          SCOPE.FRAMEWORK
      };

      scope =
        scopeMap[selected] ||
        SCOPE.ALL;
    } else {
      scope = SCOPE.ALL;
    }

    let framework =
      current?.project
        ?.planning_framework ||
      "";

    if (
      !wizardMode &&
      (scope === SCOPE.ALL ||
        scope === SCOPE.FRAMEWORK)
    ) {
      detectedFrameworks = detectPlanningFrameworks(repo);

      console.log("\nFramework availability:");
      console.log(
        `✓ SpecKit: ${detectedFrameworks.includes("speckit") ? "available" : "not detected"}`
      );
      console.log(
        `· GSD: ${detectedFrameworks.includes("gsd") ? "available" : "not detected"}`
      );
      // Print-only: displays install commands, must never execute the command it displays.
      console.log(formatPlaywrightStatusBlock(playwrightRuntime));
      await printExecutionEnvironmentBlock();

      frameworkChoices = frameworkChoicesFor(framework, detectedFrameworks);

      const labels = frameworkChoices.map(x => x.label);
      const currentIndex = frameworkChoices.findIndex(x => x.id === framework);
      const fallback = currentIndex >= 0 ? currentIndex : 0;
      const picked = await choose(
        "Planning framework",
        labels,
        fallback
      );
      framework =
        frameworkChoices.find(x => x.label === picked)?.id ||
        frameworkChoices[fallback].id;
    }

    let roles = {
      ...(current?.roles || {})
    };

    const roleLabels = {
      planner: "Planner",
      plan_reviewer:
        "Plan Reviewer",
      implementer:
        "Implementer",
      code_reviewer:
        "Code Reviewer",
      verifier:
        "Verifier"
    };

    const preferred = {
      planner: "claude",
      plan_reviewer:
        available.includes(
          "opencode"
        )
          ? "opencode"
          : "claude",
      implementer:
        available.includes("codex")
          ? "codex"
          : "claude",
      code_reviewer:
        "claude",
      verifier:
        "claude"
    };

    let chosenRole = null;
    const escalationAskRoles = new Set();

    if (scope === SCOPE.ROLE) {
      const picked =
        await choose(
          "Role to reconfigure",
          ROLE_NAMES.map(
            x =>
              `${x} — ${roleLabels[x]}`
          ),
          0
        );

      chosenRole =
        picked.split(" — ")[0];
    }

    if (
      scope === SCOPE.ALL ||
      scope === SCOPE.ROLE
    ) {
      const targets =
        chosenRole
          ? [chosenRole]
          : ROLE_NAMES;

      for (const r of targets) {
        // Migration normalizes persisted fallback entries with empty
        // reasoning/variant strings; strip those empties so a carried-forward
        // list keeps its declared {adapter, model} shape (non-empty values
        // are preserved).
        const stripEmptyFallbackFields = entry => {
          const out = { ...entry };
          if (out.reasoning === "") delete out.reasoning;
          if (out.variant === "") delete out.variant;
          return out;
        };
        const priorFallbacks = normalizeFallbackList(
          current?.roles?.[r]?.fallbacks
        ).map(stripEmptyFallbackFields);

        roles[r] =
          await roleConfig(
            roleLabels[r],
            available,
            preferred[r],
            roles[r],
            capabilityCache,
            contractCache,
            r !== "implementer"
          );
        if (isHaikuOnReadOnlyClaudeRole(r, roles[r]?.adapter, roles[r]?.model)) {
          console.log(`\n${planModeModelNote(r)}`);
        }

        // Pending #22: roleConfig() rebuilds the role, so carry a configured
        // escalation_model forward; the optional question below may change it.
        {
          const priorEscalation = normalizeEscalationModel(current?.roles?.[r]?.escalation_model);
          if (priorEscalation && roles[r]) roles[r] = { ...roles[r], escalation_model: priorEscalation };
          if (ESCALATION_ROLES.includes(r)) escalationAskRoles.add(r);
        }

        // Optional per-role fallbacks: the wizard add loop below is gated
        // on wizardMode; edit mode (ap config) edits the carried-forward
        // list through a Keep/Add/Remove/Reorder menu instead. Whenever no
        // edit is made (non-interactive stdin, Keep answer, or not edit
        // mode with wizardMode off) the prior list is copied forward so a
        // run that does not edit fallbacks leaves them untouched. An emptied
        // list removes the roles.<role>.fallbacks key via applyFallbacks.
        // choose() defaults to option 1 ("Keep current fallbacks"), so ''
        // and '1' both keep the list unchanged with no further prompts.
        if (!wizardMode) {
          if (editMode && interactive) {
            let fallbacks = [...priorFallbacks];
            const describeList = () =>
              fallbacks.length
                ? fallbacks.map(formatFallbackEntry).join(", ")
                : "(none)";
            console.log(
              `\nCurrent fallbacks for ${roleLabels[r]}: ${describeList()}`
            );
            const action = await choose(
              `Edit fallbacks for ${roleLabels[r]}? Current fallbacks: ${describeList()}`,
              [
                "Keep current fallbacks",
                "Add a fallback",
                "Remove a fallback",
                "Reorder fallbacks"
              ],
              0
            );
            if (action === "Add a fallback" && available.length) {
              const fallbackAdapter = await choose(
                `${roleLabels[r]} fallback CLI`,
                available,
                0
              );
              const fallbackMeta = agents[fallbackAdapter];
              const fallbackCaps =
                capabilityCache.get(fallbackAdapter) ||
                await discoverCapabilities(fallbackMeta);
              const fallbackEffectiveMeta = {
                ...fallbackMeta,
                model_flag: fallbackCaps.model ? fallbackCaps.model_flag : null,
                effort_flag: fallbackCaps.effort ? fallbackCaps.effort_flag : null,
                variant_flag: fallbackCaps.variant ? fallbackCaps.variant_flag : null,
                variant_mode: fallbackMeta.variant_mode || null
              };
              const fallbackModelInfo = await pickModelAndCapabilities(
                `${roleLabels[r]} fallback`,
                fallbackEffectiveMeta,
                null,
                fallbackAdapter
              );
              const fallbackExtras = await pickReasoningAndVariant(
                `${roleLabels[r]} fallback`,
                fallbackEffectiveMeta,
                fallbackModelInfo,
                { reasoning: roles[r]?.reasoning || "", variant: "" }
              );
              const candidate = {
                adapter: fallbackAdapter,
                model: fallbackModelInfo.model || "",
                reasoning: fallbackExtras.reasoning,
                variant: fallbackExtras.variant
              };
              if (isHaikuOnReadOnlyClaudeRole(r, candidate.adapter, candidate.model)) {
                console.log(`\n${planModeModelNote(r)}`);
              }
              if (!probe(fallbackAdapter)) {
                console.log(
                  `\nWarning: fallback CLI ${fallbackAdapter} probe failed; saving anyway.`
                );
              }
              try {
                const contract =
                  contractCache.get(fallbackAdapter) ||
                  await discoverAgentContract(fallbackAdapter, fallbackMeta);
                const items = contract?.models?.items;
                if (Array.isArray(items) && items.length && candidate.model) {
                  const ids = new Set();
                  for (const item of items) {
                    if (item?.id) ids.add(item.id);
                    if (item?.effortModelIds && typeof item.effortModelIds === "object") {
                      for (const v of Object.values(item.effortModelIds)) ids.add(v);
                    }
                  }
                  if (!ids.has(candidate.model)) {
                    console.log(
                      `\nWarning: fallback model ${candidate.model} not in ${fallbackAdapter} catalog; saving anyway.`
                    );
                  }
                }
              } catch {
                // Discovery failure never blocks saving the fallback.
              }
              const independenceWarning = reviewerIndependenceWarning({
                role: r,
                candidate,
                roles
              });
              if (independenceWarning) {
                console.log(`\n${independenceWarning}`);
              }
              console.log(
                `  fallback: ${formatFallbackEntry(candidate)}`
              );
              fallbacks = addFallback(fallbacks, candidate);
            } else if (action === "Remove a fallback" && fallbacks.length) {
              const picked = await choose(
                `Remove which fallback for ${roleLabels[r]}?`,
                fallbacks.map(formatFallbackEntry),
                0
              );
              const index = fallbacks.map(formatFallbackEntry).indexOf(picked);
              if (index >= 0) {
                fallbacks = removeFallbackAt(fallbacks, index);
              }
            } else if (action === "Reorder fallbacks" && fallbacks.length > 1) {
              const picked = await choose(
                `Move which fallback for ${roleLabels[r]}?`,
                fallbacks.map(formatFallbackEntry),
                0
              );
              const from = fallbacks.map(formatFallbackEntry).indexOf(picked);
              if (from >= 0) {
                const position = await choose(
                  `Move ${formatFallbackEntry(fallbacks[from])} to position:`,
                  fallbacks.map((_, i) => `Position ${i + 1}`),
                  from
                );
                const to = Number(position.replace("Position ", "")) - 1;
                if (Number.isInteger(to) && to >= 0 && to < fallbacks.length) {
                  fallbacks = moveFallback(fallbacks, from, to);
                }
              }
            }
            roles[r] = applyFallbacks(roles[r], fallbacks);
          } else if (priorFallbacks.length) {
            roles[r] = applyFallbacks(roles[r], priorFallbacks);
          } else if (roles[r] && "fallbacks" in roles[r]) {
            delete roles[r].fallbacks;
          }
          continue;
        }

        let fallbacks = [...priorFallbacks];
        const currentListText = () =>
          fallbacks.length
            ? ` Current fallbacks: ${fallbacks.map(formatFallbackEntry).join(", ")}.`
            : "";

        let want = false;
        if (interactive) {
          const picked = await choose(
            `Add a fallback for ${roleLabels[r]}?${currentListText()} (reviewer independence: a reviewer fallback must use a different adapter/model; claude uses Claude plan quota, other models may be paid)`,
            ["No", "Yes"],
            0
          );
          want = picked === "Yes";
        }

        while (want) {
          const fallbackAdapter = await choose(
            `${roleLabels[r]} fallback CLI`,
            available,
            0
          );
          const fallbackMeta = agents[fallbackAdapter];
          const fallbackCaps =
            capabilityCache.get(fallbackAdapter) ||
            await discoverCapabilities(fallbackMeta);
          const fallbackEffectiveMeta = {
            ...fallbackMeta,
            model_flag: fallbackCaps.model ? fallbackCaps.model_flag : null,
            effort_flag: fallbackCaps.effort ? fallbackCaps.effort_flag : null,
            variant_flag: fallbackCaps.variant ? fallbackCaps.variant_flag : null,
            variant_mode: fallbackMeta.variant_mode || null
          };
          const fallbackModelInfo = await pickModelAndCapabilities(
            `${roleLabels[r]} fallback`,
            fallbackEffectiveMeta,
            null,
            fallbackAdapter
          );
          const fallbackExtras = await pickReasoningAndVariant(
            `${roleLabels[r]} fallback`,
            fallbackEffectiveMeta,
            fallbackModelInfo,
            { reasoning: roles[r]?.reasoning || "", variant: "" }
          );
          const candidate = {
            adapter: fallbackAdapter,
            model: fallbackModelInfo.model || "",
            reasoning: fallbackExtras.reasoning,
            variant: fallbackExtras.variant
          };
          if (isHaikuOnReadOnlyClaudeRole(r, candidate.adapter, candidate.model)) {
            console.log(`\n${planModeModelNote(r)}`);
          }

          // Warn-never-block per-pick checks: CLI probe plus model
          // membership against the cached/live contract catalog.
          if (!probe(fallbackAdapter)) {
            console.log(
              `\nWarning: fallback CLI ${fallbackAdapter} probe failed; saving anyway.`
            );
          }
          try {
            const contract =
              contractCache.get(fallbackAdapter) ||
              await discoverAgentContract(fallbackAdapter, fallbackMeta);
            const items = contract?.models?.items;
            if (Array.isArray(items) && items.length && candidate.model) {
              const ids = new Set();
              for (const item of items) {
                if (item?.id) ids.add(item.id);
                if (item?.effortModelIds && typeof item.effortModelIds === "object") {
                  for (const v of Object.values(item.effortModelIds)) ids.add(v);
                }
              }
              if (!ids.has(candidate.model)) {
                console.log(
                  `\nWarning: fallback model ${candidate.model} not in ${fallbackAdapter} catalog; saving anyway.`
                );
              }
            }
          } catch {
            // Discovery failure never blocks saving the fallback.
          }

          const independenceWarning = reviewerIndependenceWarning({
            role: r,
            candidate,
            roles
          });
          if (independenceWarning) {
            console.log(`\n${independenceWarning}`);
          }
          console.log(
            `  fallback: ${formatFallbackEntry(candidate)}`
          );

          fallbacks = addFallback(fallbacks, candidate);

          if (!interactive) break;
          const more = await choose(
            `Add another fallback for ${roleLabels[r]}? Current fallbacks: ${fallbacks.map(formatFallbackEntry).join(", ")}.`,
            ["No", "Yes"],
            0
          );
          want = more === "Yes";
        }

        if (fallbacks.length) {
          roles[r] = applyFallbacks(roles[r], fallbacks);
        } else if (roles[r] && "fallbacks" in roles[r]) {
          delete roles[r].fallbacks;
        }
      }
    }

    if (wizardMode && scope === SCOPE.ALL) {
      const labels = frameworkChoices.map(x => x.label);
      const currentIndex = frameworkChoices.findIndex(x => x.id === framework);
      const fallback = currentIndex >= 0 ? currentIndex : 0;
      const picked = await choose(
        "Planning framework",
        labels,
        fallback
      );
      framework =
        frameworkChoices.find(x => x.label === picked)?.id ||
        frameworkChoices[fallback].id;
    }

    if (!framework) {
      framework = frameworkChoices[0]?.id || "standalone";
    }

    const gsd =
      framework === "gsd";

    // gates.commands is the human-configured gate command (backlog #37):
    // detect the project's test command and PROPOSE it here, in the scopes
    // that configure the project itself (wizard, full scope, framework/safety
    // — the scope that already owns gates.network_isolation). Enter accepts
    // the proposal, a typed answer is stored verbatim as ONE full shell
    // command, "-" keeps []. An existing non-empty value is never re-asked,
    // and nothing is ever written without an answer: a non-interactive stdin
    // keeps what is there and prints how to set it by hand.
    const gatesInScope =
      wizardMode ||
      scope === SCOPE.ALL ||
      scope === SCOPE.FRAMEWORK;

    const existingGateCommands = Array.isArray(current?.gates?.commands)
      ? current.gates.commands
      : [];

    const detectedGateCommand = gatesInScope
      ? detectTestCommand(repo)
      : null;

    let gateAnswer = null;

    if (
      gatesInScope &&
      !existingGateCommands.length &&
      interactive
    ) {
      console.log(
        detectedGateCommand
          ? `\nProposed gate test command: ${detectedGateCommand}`
          : "\nNo test command detected for this project."
      );

      const gatePrompt = detectedGateCommand
        ? `Gate test command [${detectedGateCommand}] — Enter to accept, type a different command, or '-' to keep empty: `
        : `Gate test command — type a full command, or Enter/'-' to keep empty: `;

      // ask() renders its question only through readline; the forced
      // interactive path answers preloaded stdin lines without printing
      // anything, so the operator (or a scripted run) must see it here.
      if (forceInteractive) {
        console.log(gatePrompt);
      }

      gateAnswer = await ask(gatePrompt);
    }

    const gatesResolution = gatesInScope
      ? resolveGatesCommands({
        existing: existingGateCommands,
        detected: detectedGateCommand,
        answer: gateAnswer,
        interactive
      })
      : {
        commands: existingGateCommands,
        warn: false,
        hint: false
      };

    if (gatesResolution.warn) {
      console.log(
        "\nWarning: gate runs with network isolation; tests requiring network access must be excluded or mocked"
      );
    }

    if (gatesResolution.hint) {
      console.log(
        `\nNon-interactive setup: keeping gates.commands as ${JSON.stringify(gatesResolution.commands)}.`
      );
      console.log(
        `Set it by hand: edit .autopilot/config.json "gates": {"commands": ["<full command>"]}`
      );
    }

    let execution = current?.execution;
    if (isRoleOnlyScope(scope)) {
      execution = preserveExecutionForRoleScope(current?.execution);
    } else {
      const runtimeCapabilities = await detectRuntimeModeCapabilities();
      const savedExecution = current?.execution;
      let resolution = resolveRuntimeExecution({
        capabilities: runtimeCapabilities,
        framework,
        savedExecution
      });
      if (resolution.messages?.length) {
        console.log("");
        for (const message of resolution.messages) {
          console.log(message);
        }
      }
      if (resolution.status === "error") {
        console.error(`\n${resolution.error}`);
        process.exitCode = 4;
        return;
      }
      if (resolution.status === "need-choice") {
        const selectable = resolution.selectable || [];
        if (selectable.length > 1) {
          const labels = selectable.map(mode => formatRuntimeModeLabel(mode, runtimeCapabilities));
          let fallback = 0;
          const recommended = runtimeCapabilities.recommendedMode;
          const recommendedIndex = selectable.findIndex(mode => mode.id === recommended);
          if (recommendedIndex >= 0) fallback = recommendedIndex;
          console.log("\nRuntime execution mode:");
          console.log("1) WSL2 Strong (Recommended) — OS-enforced bubblewrap containment.");
          console.log("   Store the discovered usable WSL distro.");
          console.log("2) Windows Compatibility — SpecKit-and-standalone disposable-copy isolation.");
          console.log("   This is not OS-enforced containment.");
          const picked = await choose("Runtime execution mode — choose one", labels, fallback);
          const pickedMode =
            selectable.find(mode => formatRuntimeModeLabel(mode, runtimeCapabilities) === picked) ||
            selectable[fallback];
          const chosen = resolveRuntimeExecution({
            capabilities: runtimeCapabilities,
            framework,
            savedExecution,
            userChoiceId: pickedMode.id
          });
          if (chosen.status === "error") {
            console.error(`\n${chosen.error}`);
            process.exitCode = 4;
            return;
          }
          if (chosen.messages?.length) {
            console.log("");
            for (const message of chosen.messages) {
              console.log(message);
            }
          }
          if (chosen.execution?.runtime_mode === RUNTIME_MODE_IDS.windowsCompatibility) {
            console.log("Windows Compatibility is weaker, SpecKit-and-standalone only, and not OS-enforced containment.");
            const confirmed = await yesNo("Save Windows Compatibility execution mode?", false);
            if (!confirmed) {
              console.log("Configuration not saved.");
              return;
            }
          }
          execution = chosen.execution;
        } else if (selectable.length === 1) {
          const only = selectable[0];
          if (only.id === RUNTIME_MODE_IDS.windowsCompatibility) {
            console.log("Windows Compatibility is weaker, SpecKit-and-standalone only, and not OS-enforced containment.");
            const confirmed = await yesNo("Save Windows Compatibility execution mode?", false);
            if (!confirmed) {
              console.log("Configuration not saved.");
              return;
            }
            const chosen = resolveRuntimeExecution({
              capabilities: runtimeCapabilities,
              framework,
              savedExecution,
              userChoiceId: only.id
            });
            if (chosen.status === "error") {
              console.error(`\n${chosen.error}`);
              process.exitCode = 4;
              return;
            }
            if (chosen.messages?.length) {
              console.log("");
              for (const message of chosen.messages) {
                console.log(message);
              }
            }
            execution = chosen.execution;
          } else {
            const confirmed = await yesNo(
              `Save ${only.id} execution mode (OS-enforced bubblewrap containment)?`,
              false
            );
            if (!confirmed) {
              console.log("Configuration not saved.");
              return;
            }
            const chosen = resolveRuntimeExecution({
              capabilities: runtimeCapabilities,
              framework,
              savedExecution,
              userChoiceId: only.id
            });
            if (chosen.status === "error") {
              console.error(`\n${chosen.error}`);
              process.exitCode = 4;
              return;
            }
            if (chosen.messages?.length) {
              console.log("");
              for (const message of chosen.messages) {
                console.log(message);
              }
            }
            execution = chosen.execution;
          }
        } else {
          console.error("\nNo runtime mode is available. Configuration not saved.");
          process.exitCode = 4;
          return;
        }
      } else {
        execution = resolution.execution;
      }
      if (execution !== undefined) {
        const executionCheck = validateExecutionConfig(execution, framework);
        if (!executionCheck.valid) {
          console.error("\nConfiguration validation failed:");
          executionCheck.errors.forEach(e => console.error(`  ✖ ${e}`));
          process.exitCode = 4;
          return;
        }
      }
    }

    const networkIsolation =
      (
        scope === SCOPE.FRAMEWORK ||
        scope === SCOPE.ALL ||
        !editMode
      )
        ? await networkSetting(
          current
        )
        : (
          current?.gates
            ?.network_isolation ??
          true
        );

    const config = {
      ...(current || {}),

      schema_version:
        CONFIG_WRITE_SCHEMA,

      project: {
        ...(current?.project || {}),
        repo: ".",
        planning_framework:
          framework,
        state_file:
          ".autopilot/state.json",
        runs_dir:
          ".autopilot/runs"
      },

      roles,

      execution,

      workflow: {
        specReview: true,
        planReview: true,
        gsdPlanningReview:
          gsd,
        analysisAfterTasks:
          true,
        implementationReview:
          true,
        finalReview:
          true,
        autoApproveSpec:
          false,
        autoApprovePlan:
          false,
        parallelIndependentTasks:
          gsd,

        relaySafety: {
          block_git_commit_push:
            true,
          verify_read_only_by_snapshot:
            true,
          capture_touched_files:
            true,
          persist_role_sessions:
            true
        },

        ...(current?.workflow ||
          {})
      },

      gates: {
        env_allowlist: [],
        require_reviewer:
          true,
        network_isolation:
          networkIsolation,

        ...(current?.gates ||
          {}),

        // Last key on purpose: the resolved value must win over whatever
        // gates.commands the config already held (an existing [] used to
        // overwrite the proposal, so "detect + ask" could never land).
        commands: gatesResolution.commands
      },

      policy: (() => {
        const basePolicy = {
          max_plan_revisions: 8,
          per_task_max_turns: PER_TASK_MAX_TURNS_DEFAULT,
          per_task_max_tokens: PER_TASK_MAX_TOKENS_DEFAULT,
          continuation_allowance: CONTINUATION_ALLOWANCE_DEFAULT,
          handoff_max_chars: HANDOFF_MAX_CHARS_DEFAULT,
          handoff_note_max_chars: HANDOFF_NOTE_MAX_CHARS_DEFAULT,
          handoff_wrapup_tokens: HANDOFF_WRAPUP_TOKENS_DEFAULT,
          no_progress_generations: NO_PROGRESS_GENERATIONS_DEFAULT,
          backstop_raw_tokens: BACKSTOP_RAW_TOKENS_DEFAULT,
          failure_budgets: {
            implementationFailureBudget: 4,
            verificationFailureBudget: 4,
            adapterRetryBudget: 3,
            infrastructureRetryBudget: 3
          },
          checkpoint_after_task: true,
          checkpoint_after_phase: true,
          require_human_commit: true,
          fail_closed_on_relay_violation: true
        };
        const mergedPolicy = {
          ...basePolicy,
          ...(current?.policy || {})
        };
        mergedPolicy.caps = mergeRoleCaps(mergedPolicy.caps || {});
        return mergedPolicy;
      })(),

      capabilities: {
        project_defaults: [],
        role_requirements: {},
        safety_denied: [],
        legacy_text_inference: false,
        verification: {
          browser: "native",
          require_browser: "when-task-requires"
        },
        ...(current?.capabilities || {})
      },

      safety: {
        allow_git_commit:
          false,
        allow_git_push:
          false,
        allow_destructive_operations:
          false,

        ...(current?.safety ||
          {})
      },

      planning: {
        speckit: {
          workflow_file:
            ".specify/workflows/speckit/workflow.yml",

          task_candidates: [
            ".specify/tasks.md",
            "specs/*/tasks.md",
            "specs/*/tasks/*.md"
          ]
        },

        gsd: {
          phase_root:
            ".planning/phases",

          run_plan_verify:
            true,

          run_state_validate:
            true,

          write_summary_artifacts:
            true,

          write_verification_artifacts:
            true,

          write_uat_artifact:
            true,

          use_gsd_tools_when_available:
            true,

          planning_review: {
            enabled: gsd,
            review_after_each_stage:
              true,

            stages: [
              "discuss",
              "research",
              "plan",
              "plan-check"
            ],

            max_revisions:
              3,

            read_only_reviewer:
              true
          },

          parallelization: {
            enabled: gsd,
            plan_level: gsd,
            task_level: false,
            max_concurrent_agents:
              3,

            min_plans_for_parallel:
              2
          }
        }
      }
    };

    const revalidate = () =>
      validateConfigForSave({
        roles,
        agents,
        capabilities: config.capabilities,
        execution: config.execution,
        framework,
        policy: config.policy
      });

    // Backlog #1(a): a vanished model must not abort setup. While the only
    // remaining blocker is configured models missing from the CLI's live list,
    // offer a re-pick/drop for each and re-validate, then continue. A cap
    // (nothing else can be repaired, but never loop forever) bounds the pass.
    const repairMissingModels = async startingValidation => {
      let current = startingValidation;
      let rounds = 0;
      while (current.missingModels?.length && interactive && rounds < 20) {
        rounds++;
        const changed = await repairOneMissingModel({
          entry: current.missingModels[0],
          roles,
          agents,
          roleLabels,
          contractCache
        });
        if (!changed) break;
        current = await revalidate();
      }
      return current;
    };

    let validation = await repairMissingModels(await validateConfigForSave({
      roles,
      agents,
      capabilities: config.capabilities,
      execution: config.execution,
      framework,
      policy: config.policy
    }));

    if (validation.warnings.length) {
      console.log(
        "\nValidation warnings:"
      );

      validation.warnings.forEach(
        w =>
          console.log(
            `  ⚠ ${w}`
          )
      );

      const unverified =
        validation.warnings.some(
          w =>
            /not be live-verified|outside the documented catalog|manual selection is unverified|model-unverified/i.test(
              w
            )
        );

      if (
        unverified &&
        !(
          await yesNo(
            "Some model selections could not be live-verified. Save anyway?",
            false
          )
        )
      ) {
        console.log(
          "Configuration not saved."
        );

        return;
      }
    }

    if (!validation.valid) {
      console.error(
        "\nConfiguration validation failed:"
      );

      validation.errors.forEach(
        e =>
          console.error(
            `  ✖ ${e}`
          )
      );

      process.exitCode = 4;
      return;
    }

    // Pending #22: optional "stronger model for one round when stuck" for the
    // two roles that fix things. Asked LAST (after validation and its confirmation), only
    // for roles configured in this run, only when interactive; default = keep
    // the current value (off when none). Skip/Enter never forces a model.
    if (interactive) {
      for (const r of escalationAskRoles) {
        if (!roles[r]) continue;
        const prior = normalizeEscalationModel(roles[r].escalation_model);
        const options = prior
          ? [`Keep current (${formatFallbackEntry(prior)})`, "Choose a different model", "Turn off"]
          : ["Skip (off)", "Choose a model"];
        const action = await choose(
          `Stronger model to use for one round when ${roleLabels[r]} is stuck on the same finding? (skip = off)`,
          options,
          0
        );
        if (action === "Turn off") {
          delete roles[r].escalation_model;
        } else if (action === "Choose a model" || action === "Choose a different model") {
          const escAdapter = await choose(`${roleLabels[r]} escalation CLI`, available, 0);
          const escMeta = agents[escAdapter];
          const escCaps = capabilityCache.get(escAdapter) || await discoverCapabilities(escMeta);
          const escEffectiveMeta = {
            ...escMeta,
            model_flag: escCaps.model ? escCaps.model_flag : null,
            effort_flag: escCaps.effort ? escCaps.effort_flag : null,
            variant_flag: escCaps.variant ? escCaps.variant_flag : null,
            variant_mode: escMeta.variant_mode || null
          };
          const escModelInfo = await pickModelAndCapabilities(
            `${roleLabels[r]} escalation`,
            escEffectiveMeta,
            null,
            escAdapter
          );
          const escExtras = await pickReasoningAndVariant(
            `${roleLabels[r]} escalation`,
            escEffectiveMeta,
            escModelInfo,
            { reasoning: roles[r]?.reasoning || "", variant: "" }
          );
          const candidate = normalizeEscalationModel({
            adapter: escAdapter,
            model: escModelInfo.model || "",
            reasoning: escExtras.reasoning,
            variant: escExtras.variant
          });
          if (candidate) {
            roles[r] = { ...roles[r], escalation_model: candidate };
            console.log(`  escalation model: ${formatFallbackEntry(candidate)}`);
          } else {
            if (prior) {
              console.log("  No model picked; keeping the current escalation model.");
            } else {
              console.log("  No model picked; escalation stays off.");
              delete roles[r].escalation_model;
            }
          }
        }
      }
    }

    // The escalation answers above can add/replace a model too: re-validate
    // the whole config (including the same in-place missing-model repair) so a
    // vanished escalation model is offered a re-pick/drop instead of aborting.
    validation = await repairMissingModels(await revalidate());
    if (!validation.valid) {
      console.error("\nConfiguration validation failed:");
      validation.errors.forEach(e => console.error(`  ✖ ${e}`));
      process.exitCode = 4;
      return;
    }

    for (const r of ROLE_NAMES) {
      if (roles[r]) {
        roles[r].capabilities_verified_at =
          validation.verifiedAt;
      }
    }

    config.roles = roles;

    // config_metadata is machine-written; it belongs in config.meta.json, not the user's config.json.
    delete config.config_metadata;

    const out = path.join(
      repo,
      ".autopilot",
      "config.json"
    );

    // Build the v4 layout to persist; `$schema` resolves from the file's
    // directory, not the repo root.
    const v4Layout = toNewLayoutConfig(config, schemaReferenceFor(out));
    // A config migrated from the legacy shape may carry operator-added keys on
    // purpose; warn about them instead of refusing the save.
    const v4Validation = validateNewConfig(v4Layout, {migrated: Boolean(existingResult && existingResult.changed)});
    if (!v4Validation.valid) {
      console.error("\nConfiguration validation failed (v4 layout):");
      v4Validation.errors.forEach(e => console.error(`  ✖ ${e}`));
      process.exitCode = 4;
      return;
    }
    if (v4Validation.warnings.length) {
      console.log("Configuration warnings (v4 layout):");
      v4Validation.warnings.forEach(w => console.log(`  ⚠ ${w}`));
    }

    fs.mkdirSync(
      path.dirname(out),
      {
        recursive: true
      }
    );

    // Backlog #1(d): migration no longer writes config.json on load, so the
    // original file is still on disk here. Back it up exactly once, at the
    // save point, when the in-memory migration changed something — the same
    // guarantee the old persist-on-load path gave, now only after every
    // validation has passed.
    if (existingResult.changed && fs.existsSync(out)) {
      existingResult.backupPath = `${out}.bak-${Date.now()}`;
      fs.copyFileSync(out, existingResult.backupPath);
    }

    const tmp =
      `${out}.tmp-${process.pid}`;

    fs.writeFileSync(
      tmp,
      JSON.stringify(
        v4Layout,
        null,
        2
      ) + "\n"
    );

    fs.renameSync(
      tmp,
      out
    );

    console.log(
      `\nSaved ${out}`
    );

    ensureAutopilotGitignored(repo);

    // Mission 090 task 2.3: every setup run (fresh and re-run) writes or
    // refreshes agent slash-command files for PATH-detected agents only.
    // Best-effort like ensureAutopilotGitignored above: setup must never
    // fail because command files couldn't be written.
    try {
      const installed = installAgentCommands(repo);
      if (installed.written.length) {
        console.log(
          `\nInstalled ${installed.written.length} agent command file(s) for ${installed.detected.join(", ")}.`
        );
      }
    } catch {
      // Best-effort only: command files are auxiliary to the saved config.
    }

    console.log(
      `Schema: ${CONFIG_WRITE_SCHEMA}`
    );

    console.log("\nNo certification step is required. `ap run` checks each configured CLI (present, --version/--help works, configured flags supported) automatically on every run.");

    if (
      existingResult.changed &&
      existingResult.backupPath
    ) {
      console.log(
        `Migrated existing config; backup: ${existingResult.backupPath}`
      );
    }
  } finally {
    if (!forceInteractive) {
      setupDone = true;
      rl.close();
    }
  }
})().catch(e => {
  console.error(
    e?.stack || e
  );

  process.exit(2);
});
