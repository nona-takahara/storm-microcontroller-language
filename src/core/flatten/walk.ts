// The single implementation of "walk a resolved `use` tree and inline it into one flat instance list".
// dsl2xml (src/core/exporters/xml-tree.ts) and compare-dsl (src/core/compare/project-flattener.ts) both
// lower `use` through this walk, so a fix to per-instance namespacing, port-binding substitution, or
// expression rewriting reaches both (issue #60). Callers differ only in how they name flattened
// instances/nets (FlattenNaming) and in what they do with each flattened `inst` (FlattenVisitor).
import {
  buildChildParamEnv,
  buildEntryParamEnv,
  type ModuleParamEnv,
  type ParamOrigin,
  resolveAttributeParamOrigins,
  substituteAttributeParams,
} from "../module-params.js";
import {
  type SwNetAssignment,
  type SwNetExpression,
  type SwNetInstStatement,
  type SwNetModule,
  type SwNetUseStatement,
} from "../parsers/sw-net.js";
import { type SwNetResolvedModule, type SwNetResolvedModuleKey } from "../resolvers/sw-net.js";
import { buildModulePortNameSets, resolveStringPortDirection } from "../shared/module-port-directions.js";

export interface FlattenNaming {
  /** Flattened id of an instance; `path` ends with the statement's own instance id. */
  instanceId(path: string[]): string;
  /** Flattened name of a module-local net; `scopePath` is the instance path of the module that owns it. */
  netName(scopePath: string[], name: string): string;
}

export interface FlattenInstanceEvent<TScope> {
  scope: TScope;
  moduleKey: SwNetResolvedModuleKey;
  statement: SwNetInstStatement;
  /** Instance path including the statement's own id. */
  instancePath: string[];
  flattenedId: string;
  /** The statement's attributes with every `@param` replaced by its value (issue #109). Prefer this over `statement.attributes`. */
  attributes: SwNetAssignment[];
  /** Attributes written as `@param`, mapped to the place that controls them; `undefined` marks one nested in a list literal. */
  paramOrigins: Record<string, ParamOrigin | undefined>;
  /** Inputs/outputs with identifiers namespaced and port references substituted; unresolvable ones are dropped. */
  inputs: SwNetAssignment[];
  outputs: SwNetAssignment[];
}

export interface FlattenUseEvent<TScope> {
  parentScope: TScope;
  parentModuleKey: SwNetResolvedModuleKey;
  statement: SwNetUseStatement;
  targetModule: SwNetResolvedModule;
  /** Instance path including the `use` statement's own id. */
  instancePath: string[];
  flattenedId: string;
}

export interface FlattenUnresolvedPort {
  /** Flattened id of the inst/use statement that holds the unresolvable port reference. */
  flattenedId: string;
  portName: string;
  /** "drives-input": an inner write targets the module's own input port. "undeclared": no usable binding. */
  reason: "drives-input" | "undeclared";
}

export interface FlattenVisitor<TScope> {
  naming: FlattenNaming;
  rootScope: TScope;
  /** Called for a `use` statement once its bindings are resolved; returns the scope for the target module's body. */
  enterUse(event: FlattenUseEvent<TScope>): TScope;
  onInstance(event: FlattenInstanceEvent<TScope>): void;
  onUnresolvedPort(problem: FlattenUnresolvedPort): void;
}

export function formatResolvedModuleKey(key: SwNetResolvedModuleKey): string {
  return `${key.documentPath}#${key.moduleId}`;
}

/** Inline `entryKey`'s complete `use` tree, reporting every flattened `inst` to the visitor in source order. */
export function walkFlattenedModule<TScope>(
  modules: SwNetResolvedModule[],
  entryKey: SwNetResolvedModuleKey,
  visitor: FlattenVisitor<TScope>,
): void {
  const moduleByKey = new Map(modules.map((module) => [formatResolvedModuleKey(module.key), module] as const));
  const entryModule = moduleByKey.get(formatResolvedModuleKey(entryKey));
  const entryParamEnv = entryModule
    ? buildEntryParamEnv(entryModule.module, entryKey.documentPath)
    : new Map();
  walkModule(entryKey, [], new Map(), entryParamEnv, visitor.rootScope, moduleByKey, visitor);
}

function walkModule<TScope>(
  moduleKey: SwNetResolvedModuleKey,
  instancePath: string[],
  portBindings: Map<string, SwNetExpression>,
  paramEnv: ModuleParamEnv,
  scope: TScope,
  moduleByKey: Map<string, SwNetResolvedModule>,
  visitor: FlattenVisitor<TScope>,
): void {
  const resolvedModule = moduleByKey.get(formatResolvedModuleKey(moduleKey));

  if (!resolvedModule) {
    throw new Error(`Resolved module ${formatResolvedModuleKey(moduleKey)} was not indexed.`);
  }

  assertUniqueStatementInstanceIds(resolvedModule.module, moduleKey);

  const modulePorts = buildModulePortNameSets(resolvedModule.module.ports);
  // The entry module's quoted strings name real project ports and pass through unchanged.
  const isEntryModule = instancePath.length === 0;

  const resolveList = (
    assignments: SwNetAssignment[],
    direction: "in" | "out",
    flattenedId: string,
  ): SwNetAssignment[] => {
    const resolved: SwNetAssignment[] = [];

    for (const assignment of assignments) {
      const value = resolveExpression(assignment.value, direction, flattenedId);

      if (value !== undefined) {
        resolved.push({ key: assignment.key, value });
      }
    }

    return resolved;
  };

  // Identifiers always become module-local nets, per this tool's documented convention
  // (src/core/spec/tool-conventions.ts): a bare identifier is a net even if its text matches a port name;
  // only a quoted string references the module's own declared port. A port reference is substituted with
  // whatever the caller bound that port to, looked up by the port's own declared direction rather than the
  // usage site's. This is deliberately asymmetric: an output port behaves like an ordinary net as well as a
  // port (one producer, any number of readers, including the module itself); an input port is a port only,
  // so the module body may never write it (a second producer for a single-source signal).
  const resolveExpression = (
    expression: SwNetExpression,
    direction: "in" | "out",
    flattenedId: string,
  ): SwNetExpression | undefined => {
    if (expression.kind === "identifier") {
      return { kind: "identifier", value: visitor.naming.netName(instancePath, expression.value) };
    }

    if (expression.kind !== "string") {
      return expression;
    }

    if (isEntryModule) {
      return expression;
    }

    const portDirection = resolveStringPortDirection(expression.value, direction, modulePorts);

    if (portDirection === undefined) {
      visitor.onUnresolvedPort({
        flattenedId,
        portName: expression.value,
        reason: direction === "out" && modulePorts.in.has(expression.value) ? "drives-input" : "undeclared",
      });
      return undefined;
    }

    const resolved = portBindings.get(bindingKey(portDirection, expression.value));

    if (!resolved) {
      visitor.onUnresolvedPort({ flattenedId, portName: expression.value, reason: "undeclared" });
      return undefined;
    }

    return resolved;
  };

  for (const statement of resolvedModule.module.statements) {
    const statementPath = [...instancePath, statement.instanceId];
    const flattenedId = visitor.naming.instanceId(statementPath);

    if (statement.kind === "inst") {
      const inputs = resolveList(statement.inputs, "in", flattenedId);
      const outputs = resolveList(statement.outputs, "out", flattenedId);
      visitor.onInstance({
        scope,
        moduleKey,
        statement,
        instancePath: statementPath,
        flattenedId,
        attributes: substituteAttributeParams(statement.attributes, paramEnv),
        paramOrigins: resolveAttributeParamOrigins(statement.attributes, paramEnv),
        inputs,
        outputs,
      });
      continue;
    }

    // `use` statement: resolve its own bindings in the current scope, then recurse into the target
    // module with those as the child's port bindings.
    const childPortBindings = new Map<string, SwNetExpression>();

    for (const assignment of statement.inputs) {
      const value = resolveExpression(assignment.value, "in", flattenedId);

      if (value !== undefined) {
        childPortBindings.set(bindingKey("in", assignment.key), value);
      }
    }

    for (const assignment of statement.outputs) {
      const value = resolveExpression(assignment.value, "out", flattenedId);

      if (value !== undefined) {
        childPortBindings.set(bindingKey("out", assignment.key), value);
      }
    }

    const useEdge = resolvedModule.uses.find((candidate) => candidate.statement === statement);

    if (!useEdge) {
      throw new Error(`Use statement ${flattenedId} in ${formatResolvedModuleKey(moduleKey)} was not resolved.`);
    }

    const targetModule = moduleByKey.get(formatResolvedModuleKey(useEdge.target));

    if (!targetModule) {
      throw new Error(`Resolved module ${formatResolvedModuleKey(useEdge.target)} was not indexed.`);
    }

    const childScope = visitor.enterUse({
      parentScope: scope,
      parentModuleKey: moduleKey,
      statement,
      targetModule,
      instancePath: statementPath,
      flattenedId,
    });
    const childParamEnv = buildChildParamEnv(targetModule.module, statement.args, paramEnv, {
      documentPath: moduleKey.documentPath,
      moduleId: moduleKey.moduleId,
      instanceId: statement.instanceId,
    });
    walkModule(useEdge.target, statementPath, childPortBindings, childParamEnv, childScope, moduleByKey, visitor);
  }
}

// Reject a module body that declares two inst/use statements under the same instance id: the namespacing
// scheme only stays collision-free if every module's own statements already have unique instance ids.
function assertUniqueStatementInstanceIds(module: SwNetModule, moduleKey: SwNetResolvedModuleKey): void {
  const seen = new Set<string>();

  for (const statement of module.statements) {
    if (seen.has(statement.instanceId)) {
      throw new Error(
        `Duplicate instance id ${statement.instanceId} in module ${formatResolvedModuleKey(moduleKey)}; every inst/use statement needs a unique instance id.`,
      );
    }

    seen.add(statement.instanceId);
  }
}

function bindingKey(direction: "in" | "out", portName: string): string {
  return `${direction}:${portName}`;
}
