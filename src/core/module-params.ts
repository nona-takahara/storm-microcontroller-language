// Module parameter environments (issue #109): `module m(name=default)` declares parameters, `@name`
// references them from inst attribute values and use arguments, and `use m id (name=value)` overrides the
// defaults. Every flattener builds one environment per module instance and substitutes references away
// before anything downstream (XML export, comparison) sees the attributes.
import { type SwNetAssignment, type SwNetExpression, type SwNetModule } from "./parsers/sw-net.js";

/**
 * Where a parameter's value is controlled, so sync can write a changed value back to the source.
 * - `use-arg`: the `name=value` argument of one `use` statement (added when the use relies on the default).
 * - `entry-default`: the entry module's own header default; nothing passes arguments to it.
 */
export type ParamOrigin =
  | { kind: "use-arg"; documentPath: string; moduleId: string; useInstanceId: string; argName: string }
  | { kind: "entry-default"; documentPath: string; moduleId: string; paramName: string };

/** One parameter's resolved value (never a `paramRef`) and the place that controls it. */
export interface ParamBinding {
  value: SwNetExpression;
  origin: ParamOrigin;
}

/** Resolved parameters for one module instance, keyed by parameter name. */
export type ModuleParamEnv = ReadonlyMap<string, ParamBinding>;

/** The `use` statement that instantiates a module, identifying where its arguments live. */
export interface ParamUseSite {
  documentPath: string;
  moduleId: string;
  instanceId: string;
}

/** Environment of the entry module (nothing passes arguments to it, so every parameter keeps its default). */
export function buildEntryParamEnv(module: SwNetModule, documentPath: string): ModuleParamEnv {
  const env = new Map<string, ParamBinding>();

  for (const param of module.params) {
    const value = substituteParamRefs(param.value, new Map());
    if (value) {
      env.set(param.key, {
        value,
        origin: { kind: "entry-default", documentPath, moduleId: module.id, paramName: param.key },
      });
    }
  }

  return env;
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
  site: ParamUseSite,
): ModuleParamEnv {
  const env = new Map<string, ParamBinding>();

  for (const param of child.params) {
    const origin: ParamOrigin = {
      kind: "use-arg",
      documentPath: site.documentPath,
      moduleId: site.moduleId,
      useInstanceId: site.instanceId,
      argName: param.key,
    };
    const value = substituteParamRefs(param.value, new Map());
    if (value) {
      env.set(param.key, { value, origin });
    }
  }

  for (const arg of args) {
    if (!env.has(arg.key)) {
      continue;
    }

    // A forwarded `@parent` stays controlled by the parent's origin; a literal is controlled by this argument.
    if (arg.value.kind === "paramRef") {
      const forwarded = parentEnv.get(arg.value.name);
      if (forwarded) {
        env.set(arg.key, { value: cloneExpression(forwarded.value), origin: forwarded.origin });
      }
      continue;
    }

    const value = substituteParamRefs(arg.value, parentEnv);
    if (value) {
      env.set(arg.key, { value, origin: env.get(arg.key)!.origin });
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

/**
 * For attributes written as a bare `@name`, the origin that controls the value. A `@name` nested inside a
 * list literal has no single owner, so it is reported as `undefined` to let callers refuse to write it back.
 */
export function resolveAttributeParamOrigins(
  attributes: readonly SwNetAssignment[],
  env: ModuleParamEnv,
): Record<string, ParamOrigin | undefined> {
  const origins: Record<string, ParamOrigin | undefined> = {};

  for (const attribute of attributes) {
    if (attribute.value.kind === "paramRef") {
      const binding = env.get(attribute.value.name);
      if (binding) {
        origins[attribute.key] = binding.origin;
      }
    } else if (collectParamRefNames(attribute.value).length > 0) {
      origins[attribute.key] = undefined;
    }
  }

  return origins;
}

/** Resolve `@name` inside one expression (recursing into list entries); `undefined` when unresolvable. */
export function substituteParamRefs(
  expression: SwNetExpression,
  env: ModuleParamEnv,
): SwNetExpression | undefined {
  if (expression.kind === "paramRef") {
    const binding = env.get(expression.name);
    return binding ? cloneExpression(binding.value) : undefined;
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
