#!/usr/bin/env node
// Phase 4 task 4.1: validate config.example.json against the schema and validateNewConfig
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { validateNewConfig } from "./config-validation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }

const schemaRaw = readFileSync(join(ROOT, "config.schema.json"), "utf8");
const exampleRaw = readFileSync(join(ROOT, "config.example.json"), "utf8");

let schema, example;
try {
  schema = JSON.parse(schemaRaw);
} catch (err) {
  fail(`config.schema.json is not valid JSON: ${err.message}`);
}
try {
  example = JSON.parse(exampleRaw);
} catch (err) {
  fail(`config.example.json is not valid JSON: ${err.message}`);
}

// ---------------------------------------------------------------------------
// 1. $schema reference resolves from the repo root
// ---------------------------------------------------------------------------
assert(example.$schema === "./config.schema.json", `config.example.json \$schema must be "./config.schema.json", got ${JSON.stringify(example.$schema)}`);
const resolvedSchemaPath = resolve(ROOT, example.$schema);
assert(resolvedSchemaPath === join(ROOT, "config.schema.json"), `\$schema reference must resolve to config.schema.json from repo root`);
assert(existsSync(resolvedSchemaPath), `Referenced schema file must exist at ${resolvedSchemaPath}`);

// ---------------------------------------------------------------------------
// 2. schema_version is 4.0
// ---------------------------------------------------------------------------
assert(example.schema_version === "4.0", `config.example.json schema_version must be "4.0", got ${JSON.stringify(example.schema_version)}`);

// ---------------------------------------------------------------------------
// 3. Every schema property that has a default has an example value
// ---------------------------------------------------------------------------
function getDefaults(obj, path = "") {
  const defaults = {};
  if (obj.default !== undefined) {
    defaults[path] = obj.default;
  }
  if (obj.properties) {
    for (const [k, v] of Object.entries(obj.properties)) {
      const newPath = path ? `${path}.${k}` : k;
      Object.assign(defaults, getDefaults(v, newPath));
    }
  }
  if (obj.items && obj.items.properties) {
    Object.assign(defaults, getDefaults(obj.items, path + "[]"));
  }
  return defaults;
}

const schemaDefaults = getDefaults(schema);

function hasValue(obj, path) {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (part.endsWith("[]")) {
      const key = part.slice(0, -2);
      if (!Array.isArray(current[key])) return false;
      if (current[key].length === 0) return true;
      current = current[key][0];
    } else {
      if (current === undefined || current === null) return false;
      if (!Object.prototype.hasOwnProperty.call(current, part)) return false;
      current = current[part];
    }
  }
  return current !== undefined;
}

let missing = [];
for (const path of Object.keys(schemaDefaults)) {
  if (!hasValue(example, path)) {
    missing.push(path);
  }
}
assert(missing.length === 0, `config.example.json is missing values for schema properties with defaults:\n${missing.map(m => `  - ${m}`).join("\n")}`);

// ---------------------------------------------------------------------------
// 4. escalation_model is absent (not null) from all roles
// ---------------------------------------------------------------------------
const rolesWithEscalation = ["planner", "implementer"];
for (const role of rolesWithEscalation) {
  assert(!("escalation_model" in example.roles[role]),
    `config.example.json roles.${role} must not have escalation_model (it is optional with no default)`);
}
// Also verify it's not in other roles (they shouldn't have it in schema either)
for (const role of ["plan_reviewer", "code_reviewer", "verifier"]) {
  assert(!("escalation_model" in example.roles[role]),
    `config.example.json roles.${role} must not have escalation_model`);
}

// ---------------------------------------------------------------------------
// 5. Structural schema validation: types, enums, required, additionalProperties
// ---------------------------------------------------------------------------
function validateAgainstSchema(data, schemaNode, path = "") {
  const errors = [];
  
  // Handle type (can be array or string) - for union types, value must match at least one
  const types = Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type];
  
  // Check if value matches any of the allowed types
  let typeMatches = false;
  for (const type of types) {
    if (type === "object") {
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        typeMatches = true;
        break;
      }
    } else if (type === "array") {
      if (Array.isArray(data)) {
        typeMatches = true;
        break;
      }
    } else if (type === "string") {
      if (typeof data === "string") {
        typeMatches = true;
        break;
      }
    } else if (type === "number") {
      if (typeof data === "number" && Number.isFinite(data)) {
        typeMatches = true;
        break;
      }
    } else if (type === "integer") {
      if (Number.isInteger(data)) {
        typeMatches = true;
        break;
      }
    } else if (type === "boolean") {
      if (typeof data === "boolean") {
        typeMatches = true;
        break;
      }
    } else if (type === "null") {
      if (data === null) {
        typeMatches = true;
        break;
      }
    }
  }
  
  if (!typeMatches) {
    errors.push(`${path}: expected one of [${types.join(", ")}], got ${data === null ? "null" : typeof data}`);
    return errors;
  }
  
  // Determine which type in the union actually matches the data
  let matchedType = null;
  for (const type of types) {
    if (type === "object" && data !== null && typeof data === "object" && !Array.isArray(data)) {
      matchedType = "object";
      break;
    } else if (type === "array" && Array.isArray(data)) {
      matchedType = "array";
      break;
    } else if (type === "string" && typeof data === "string") {
      matchedType = "string";
      break;
    } else if (type === "number" && typeof data === "number" && Number.isFinite(data)) {
      matchedType = "number";
      break;
    } else if (type === "integer" && Number.isInteger(data)) {
      matchedType = "integer";
      break;
    } else if (type === "boolean" && typeof data === "boolean") {
      matchedType = "boolean";
      break;
    } else if (type === "null" && data === null) {
      matchedType = "null";
      break;
    }
  }
  
  // Check type-specific constraints only for the matched type
  if (matchedType === "object") {
    // Check required properties
    if (schemaNode.required && Array.isArray(schemaNode.required)) {
      for (const req of schemaNode.required) {
        if (!(req in data)) {
          errors.push(`${path}.${req}: required property is missing`);
        }
      }
    }
    // Check properties
    if (schemaNode.properties) {
      for (const [key, propSchema] of Object.entries(schemaNode.properties)) {
        if (key in data) {
          errors.push(...validateAgainstSchema(data[key], propSchema, path ? `${path}.${key}` : key));
        }
      }
    }
    // Check additionalProperties (must be false for strict objects)
    if (schemaNode.additionalProperties === false) {
      const allowedKeys = new Set([
        ...Object.keys(schemaNode.properties || {}),
        ...Object.keys(schemaNode.patternProperties || {})
      ]);
      // Pattern properties with "^_" allow any key starting with "_"
      const hasUnderscorePattern = Object.keys(schemaNode.patternProperties || {}).some(p => p.startsWith("^_"));
      for (const key of Object.keys(data)) {
        if (hasUnderscorePattern && key.startsWith("_")) continue;
        if (!allowedKeys.has(key)) {
          errors.push(`${path}.${key}: unknown property (additionalProperties is false)`);
        }
      }
    }
    // Check patternProperties (only "^_" pattern is supported)
    if (schemaNode.patternProperties) {
      for (const [pattern, patternSchema] of Object.entries(schemaNode.patternProperties)) {
        if (pattern === "^_") {
          for (const key of Object.keys(data)) {
            if (key.startsWith("_")) {
              errors.push(...validateAgainstSchema(data[key], patternSchema, `${path}.${key}`));
            }
          }
        }
      }
    }
  } else if (matchedType === "array") {
    if (schemaNode.items) {
      for (let i = 0; i < data.length; i++) {
        errors.push(...validateAgainstSchema(data[i], schemaNode.items, `${path}[${i}]`));
      }
    }
  } else if (matchedType === "string") {
    if (schemaNode.enum && Array.isArray(schemaNode.enum)) {
      if (!schemaNode.enum.includes(data)) {
        errors.push(`${path}: value ${JSON.stringify(data)} not in enum [${schemaNode.enum.map(e => JSON.stringify(e)).join(", ")}]`);
      }
    }
    if (schemaNode.const !== undefined && data !== schemaNode.const) {
      errors.push(`${path}: must be ${JSON.stringify(schemaNode.const)} (const)`);
    }
  } else if (matchedType === "number" || matchedType === "integer") {
    if (schemaNode.minimum !== undefined && data < schemaNode.minimum) {
      errors.push(`${path}: must be >= ${schemaNode.minimum} (got ${data})`);
    }
  }
  // null and boolean have no additional constraints
  
  return errors;
}

// Run structural validation
const schemaErrors = validateAgainstSchema(example, schema);
assert(schemaErrors.length === 0, `config.example.json failed structural schema validation:\n${schemaErrors.map(e => `  - ${e}`).join("\n")}`);

// ---------------------------------------------------------------------------
// 6. Validate against validateNewConfig (runtime role checks)
// ---------------------------------------------------------------------------
const validation = validateNewConfig(example);
assert(validation.valid, `config.example.json failed validateNewConfig:\n${validation.errors.map(e => `  - ${e}`).join("\n")}`);
// Warnings are acceptable but we log them
if (validation.warnings.length > 0) {
  console.log("Warnings from validateNewConfig:");
  for (const w of validation.warnings) console.log(`  - ${w}`);
}

// ---------------------------------------------------------------------------
// 7. All v4 top-level sections present
// ---------------------------------------------------------------------------
const v4Sections = [
  "project", "roles", "caps", "retries", "time_limits",
  "workflow", "tests", "safety", "runtime", "frameworks", "advanced"
];
for (const section of v4Sections) {
  assert(section in example, `config.example.json must have section '${section}'`);
}

// ---------------------------------------------------------------------------
// 8. Roles structure is complete
// ---------------------------------------------------------------------------
for (const role of ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"]) {
  assert(role in example.roles, `config.example.json roles must have '${role}'`);
  const r = example.roles[role];
  for (const key of ["cli", "model", "reasoning", "variant", "resume_session", "fallbacks"]) {
    assert(key in r, `config.example.json roles.${role} must have '${key}'`);
  }
}
assert("free_models" in example.roles, "config.example.json roles must have free_models");
assert("auto_fallback" in example.roles.free_models, "config.example.json roles.free_models must have auto_fallback");
assert("max_turns" in example.roles.free_models, "config.example.json roles.free_models must have max_turns");

// ---------------------------------------------------------------------------
// 9. Caps structure is complete
// ---------------------------------------------------------------------------
assert("task_size_target_turns" in example.caps, "config.example.json caps must have task_size_target_turns");
assert("mission_token_backstop" in example.caps, "config.example.json caps must have mission_token_backstop");
for (const role of ["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"]) {
  assert(role in example.caps, `config.example.json caps must have '${role}'`);
  for (const key of ["max_turns", "max_tokens", "extra_sessions", "wrap_up_at_tokens"]) {
    assert(key in example.caps[role], `config.example.json caps.${role} must have '${key}'`);
  }
}

// ---------------------------------------------------------------------------
// 10. Other section structures
// ---------------------------------------------------------------------------
const retriesKeys = ["plan_revisions", "implementation", "verification", "final_review_fix_rounds", "cli_errors", "infrastructure", "no_progress_sessions", "extra_sessions_per_task", "escalate_after_not_fixed"];
for (const key of retriesKeys) {
  assert(key in example.retries, `config.example.json retries must have '${key}'`);
}

const timeLimitsKeys = ["role_timeout_minutes", "call_backstop_minutes", "role_timeout_floor_minutes", "silent_run_minutes", "no_first_output_minutes", "read_only_max_silence_minutes", "retry_wait_seconds"];
for (const key of timeLimitsKeys) {
  assert(key in example.time_limits, `config.example.json time_limits must have '${key}'`);
}
assert("default" in example.time_limits.role_timeout_minutes, "config.example.json time_limits.role_timeout_minutes must have default");
assert("verifier" in example.time_limits.role_timeout_minutes, "config.example.json time_limits.role_timeout_minutes must have verifier");

// ---------------------------------------------------------------------------
// 11. Plan approval default shipped in the example
// ---------------------------------------------------------------------------
assert(example.workflow.pause_for_plan_approval === false,
  `config.example.json workflow.pause_for_plan_approval must be false, got ${JSON.stringify(example.workflow.pause_for_plan_approval)}`);
assert(!("approve_plan_myself" in example.workflow),
  "config.example.json must not contain the removed workflow.approve_plan_myself");

console.log("config.example.json validation passed (all schema defaults present, escalation_model absent, \$schema resolves, validateNewConfig passes)");
