export function applyAgentSelections(args, role, adapter) {
  const out = [...args];

  if (role?.model) {
    if (!adapter?.model_flag) {
      throw new Error(`${adapter?.binary || "agent"} does not expose model selection.`);
    }
    out.push(adapter.model_flag, role.model);
  }

  if (role?.reasoning) {
    if (adapter.effort_mode === "config") {
      if (!adapter.effort_config_key) {
        throw new Error(`${adapter.binary || "agent"} does not declare an effort config key.`);
      }
      out.push("--config", `${adapter.effort_config_key}=${JSON.stringify(role.reasoning)}`);
    } else if (adapter.effort_mode === "model_suffix") {
      if (!adapter.model_flag || !role.model) {
        throw new Error(`${adapter.binary || "agent"} effort requires a selected model.`);
      }
      const i = out.lastIndexOf(adapter.model_flag);
      if (i < 0 || i + 1 >= out.length) {
        throw new Error(`${adapter.binary || "agent"} reasoning requires model selection.`);
      }
      const currentModel = String(out[i + 1]);
      if (!currentModel.includes(`#${role.reasoning}`)) {
        out[i + 1] = `${currentModel}#${role.reasoning}`;
      }
    } else {
      if (!adapter.effort_flag) {
        throw new Error(`${adapter.binary || "agent"} does not expose reasoning/effort selection.`);
      }
      out.push(adapter.effort_flag, role.reasoning);
    }
  }

  if (role?.variant) {
    if (adapter.variant_flag) {
      out.push(adapter.variant_flag, role.variant);
    } else if (adapter.variant_mode === "model_suffix") {
      if (!adapter.model_flag || !role.model) {
        throw new Error(`${adapter.binary || "agent"} variant requires model selection.`);
      }
      const i = out.lastIndexOf(adapter.model_flag);
      if (i < 0 || i + 1 >= out.length) {
        throw new Error(`${adapter.binary || "agent"} variant requires model selection.`);
      }
      const currentModel = String(out[i + 1]).split("#", 1)[0];
      out[i + 1] = `${currentModel}#${role.variant}`;
    } else {
      throw new Error(`${adapter.binary || "agent"} does not expose variant selection.`);
    }
  }

  return out;
}

export function verifyAgentInvocation(args, role, adapter) {
  const errors = [];
  const list = Array.isArray(args) ? args.map(String) : [];

  if (role?.model) {
    const i = adapter?.model_flag ? list.lastIndexOf(String(adapter.model_flag)) : -1;
    if (i < 0 || String(list[i + 1] || "") !== String(role.model)) {
      if (adapter?.variant_mode === "model_suffix" && i >= 0 && String(list[i + 1] || "").startsWith(`${role.model}#`)) {
        // model suffix is an intentional transport for variants/effort.
      } else {
        errors.push(`model '${role.model}' was not present in the final CLI invocation.`);
      }
    }
  }

  if (role?.reasoning) {
    if (adapter?.effort_mode === "config") {
      const expected = `${adapter.effort_config_key}=${JSON.stringify(role.reasoning)}`;
      const index = list.lastIndexOf("--config");
      if (index < 0 || list[index + 1] !== expected) {
        errors.push(`reasoning/effort '${role.reasoning}' was not present in the final CLI config invocation.`);
      }
    } else if (adapter?.effort_mode === "model_suffix") {
      const i = adapter?.model_flag ? list.lastIndexOf(String(adapter.model_flag)) : -1;
      const value = i >= 0 ? String(list[i + 1] || "") : "";
      if (!value.endsWith(`#${role.reasoning}`)) {
        errors.push(`reasoning '${role.reasoning}' was not encoded in the final CLI invocation.`);
      }
    } else {
      const i = adapter?.effort_flag ? list.lastIndexOf(String(adapter.effort_flag)) : -1;
      if (i < 0 || String(list[i + 1] || "") !== String(role.reasoning)) {
        errors.push(`reasoning/effort '${role.reasoning}' was not present in the final CLI invocation.`);
      }
    }
  }

  if (role?.variant) {
    if (adapter?.variant_flag) {
      const i = list.lastIndexOf(String(adapter.variant_flag));
      if (i < 0 || String(list[i + 1] || "") !== String(role.variant)) {
        errors.push(`variant '${role.variant}' was not present in the final CLI invocation.`);
      }
    } else if (adapter?.variant_mode === "model_suffix") {
      const i = adapter?.model_flag ? list.lastIndexOf(String(adapter.model_flag)) : -1;
      const value = i >= 0 ? String(list[i + 1] || "") : "";
      if (!value.endsWith(`#${role.variant}`)) {
        errors.push(`variant '${role.variant}' was not encoded in the final CLI invocation.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
