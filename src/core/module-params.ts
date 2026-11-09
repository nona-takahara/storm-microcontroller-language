// Module parameter environments (issue #109): `module m(name=default)` declares parameters, `@name`
// references them from inst attribute values and use arguments, and `use m id (name=value)` overrides the
// defaults. Every flattener builds one environment per module instance and substitutes references away
// before anything downstream (XML export, comparison) sees the attributes.
import { type SwNetAssignment, type SwNetExpression, type SwNetModule } from "./parsers/sw-net.js";

/** Resolved parameter values for one module instance, keyed by parameter name. Values never hold `paramRef`. */
export type ModuleParamEnv = ReadonlyMap<string, SwNetExpression>;

/** Environment of the entry module (nothing passes arguments to it, so every parameter keeps its default). */
export function buildEntryParamEnv(module: SwNetModule): ModuleParamEnv {
  return buildChildParamEnv(module, [], new Map());
}

/**
 * Environment of a child module instantiated by a `use` statement: its own defaults, overridden by the
 * statement's arguments after resolving `@parent` references against the parent's environment.
 * Arguments naming undeclared parameters are ignored here; validation reports them.
 */
export function buildChildParamEnv(
  child: SwNetModule,
  args: readonly SwNetAssignment[],
  parentEnv: ModuleParamEnv,
): ModuleParamEnv {
  const env = new Map<string, SwNetExpression>();

  for (const param of child.params) {
    const resolved = substituteParamRefs(param.value, new Map());
    if (resolved) {
      env.set(param.key, resolved);
    }
  }

  for (const arg of args) {
    if (!env.has(arg.key)) {
      continue;
    }

    const resolved = substituteParamRefs(arg.value, parentEnv);
    if (resolved) {
      env.set(arg.key, resolved);
    }
  }

  return env;
}

/**
 * Replace every `@name` in an attribute list with its value from the environment. A reference the
 * environment cannot resolve drops the attribute so the gate's own default applies; validation has
 * already reported it as an error.
 */
export function substituteAttributeParams(
  attributes: readonly SwNetAssignment[],
  env: ModuleParamEnv,
): SwNetAssignment[] {
  return attributes.flatMap((attribute): SwNetAssignment[] => {
    const value = substituteParamRefs(attribute.value, env);
    return value ? [{ key: attribute.key, value }] : [];
  });
}

/** Resolve `@name` inside one expression (recursing into list entries); `undefined` when unresolvable. */
export function substituteParamRefs(
  expression: SwNetExpression,
  env: ModuleParamEnv,
): SwNetExpression | undefined {
  if (expression.kind === "paramRef") {
    const value = env.get(expression.name);
    return value ? cloneExpression(value) : undefined;
  }

  if (expression.kind === "list") {
    return { kind: "list", entries: substituteAttributeParams(expression.entries, env) };
  }

  return { ...expression };
}

/** Every `@name` inside one expression, including those nested in list entries. */
export function collectParamRefNames(expression: SwNetExpression): string[] {
  if (expression.kind === "paramRef") {
    return [expression.name];
  }

  return expression.kind === "list" ? expression.entries.flatMap((entry) => collectParamRefNames(entry.value)) : [];
}

function cloneExpression(expression: SwNetExpression): SwNetExpression {
  return expression.kind === "list"
    ? { kind: "list", entries: expression.entries.map((entry) => ({ key: entry.key, value: cloneExpression(entry.value) })) }
    : { ...expression };
}
