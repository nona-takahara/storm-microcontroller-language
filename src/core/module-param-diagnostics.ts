// Diagnostics for module parameters (issue #109): declarations, `@name` references, and use arguments.
import { createErrorDiagnostic, type Diagnostic } from "./diagnostics.js";
import { type LocalizedMessage } from "./i18n/index.js";
import { collectParamRefNames } from "./module-params.js";
import { type SwNetAssignment, type SwNetExpression } from "./parsers/sw-net.js";
import { type SwNetResolutionResult, type SwNetResolvedModule } from "./resolvers/sw-net.js";

/** Validate parameter declarations, references, and use arguments across every resolved module. */
export function validateModuleParams(swNet: SwNetResolutionResult, diagnostics: Diagnostic[]): void {
  for (const resolved of swNet.modules) {
    validateDeclarations(resolved, diagnostics);
    validateReferences(resolved, diagnostics);
  }

  for (const use of swNet.uses) {
    const target = swNet.modules.find(
      (candidate) =>
        candidate.key.documentPath === use.target.documentPath && candidate.key.moduleId === use.target.moduleId,
    );

    if (target) {
      validateUseArguments(use.caller.documentPath, use.caller.moduleId, use.statement.instanceId, use.statement.args, target, swNet, diagnostics);
    }
  }
}

function validateDeclarations(resolved: SwNetResolvedModule, diagnostics: Diagnostic[]): void {
  const seen = new Set<string>();

  for (const param of resolved.module.params) {
    if (seen.has(param.key)) {
      diagnostics.push(
        error(resolved, "PARAM_DUPLICATE", `Parameter ${param.key} is declared more than once in module ${resolved.key.moduleId}.`, resolved.key.moduleId, {
          messageId: "project.paramDuplicate",
          messageArgs: { paramName: param.key, moduleId: resolved.key.moduleId },
        }),
      );
    }
    seen.add(param.key);

    if (param.value.kind === "list" || param.value.kind === "paramRef") {
      diagnostics.push(
        error(resolved, "PARAM_DEFAULT_INVALID", `Parameter ${param.key} of module ${resolved.key.moduleId} needs a scalar default value.`, resolved.key.moduleId, {
          messageId: "project.paramDefaultInvalid",
          messageArgs: { paramName: param.key, moduleId: resolved.key.moduleId },
        }),
      );
    }
  }
}

// `@name` is only valid in inst attribute values and use arguments, and must name a declared parameter.
function validateReferences(resolved: SwNetResolvedModule, diagnostics: Diagnostic[]): void {
  const declared = new Set(resolved.module.params.map((param) => param.key));
  const moduleId = resolved.key.moduleId;

  const checkAllowed = (instanceId: string, assignments: readonly SwNetAssignment[]) => {
    for (const assignment of assignments) {
      for (const paramName of collectParamRefNames(assignment.value)) {
        if (!declared.has(paramName)) {
          diagnostics.push(
            error(resolved, "PARAM_UNDECLARED", `${instanceId} in module ${moduleId} references undeclared parameter @${paramName}.`, instanceId, {
              messageId: "project.paramUndeclared",
              messageArgs: { paramName, moduleId, instanceId },
            }),
          );
        }
      }
    }
  };

  const checkForbidden = (instanceId: string, assignments: readonly SwNetAssignment[]) => {
    for (const assignment of assignments) {
      for (const paramName of collectParamRefNames(assignment.value)) {
        diagnostics.push(
          error(resolved, "PARAM_REF_NOT_ALLOWED", `@${paramName} on ${instanceId} in module ${moduleId} is not allowed in pin bindings.`, instanceId, {
            messageId: "project.paramRefNotAllowed",
            messageArgs: { paramName, moduleId, instanceId },
          }),
        );
      }
    }
  };

  for (const statement of resolved.module.statements) {
    checkAllowed(statement.instanceId, statement.kind === "inst" ? statement.attributes : statement.args);
    checkForbidden(statement.instanceId, statement.inputs);
    checkForbidden(statement.instanceId, statement.outputs);
  }
}

function validateUseArguments(
  documentPath: string,
  callerModuleId: string,
  instanceId: string,
  args: readonly SwNetAssignment[],
  target: SwNetResolvedModule,
  swNet: SwNetResolutionResult,
  diagnostics: Diagnostic[],
): void {
  const caller = swNet.modules.find(
    (candidate) => candidate.key.documentPath === documentPath && candidate.key.moduleId === callerModuleId,
  );
  const targetModuleId = target.key.moduleId;
  const defaults = new Map(target.module.params.map((param) => [param.key, param.value] as const));
  const callerDefaults = new Map(caller?.module.params.map((param) => [param.key, param.value] as const) ?? []);
  const seen = new Set<string>();

  for (const arg of args) {
    const defaultValue = defaults.get(arg.key);

    if (defaultValue === undefined || seen.has(arg.key)) {
      if (defaultValue === undefined) {
        diagnostics.push(
          createErrorDiagnostic("USE_ARG_UNKNOWN", `Module ${targetModuleId} has no parameter ${arg.key} (passed by ${instanceId}).`, "sw-net", documentPath, instanceId, {
            messageId: "project.useArgUnknown",
            messageArgs: { argName: arg.key, moduleId: targetModuleId, instanceId },
          }),
        );
      }
      continue;
    }
    seen.add(arg.key);

    // A forwarded `@parent` takes the type of the parent's own default; an unresolvable one is reported elsewhere.
    const effective = arg.value.kind === "paramRef" ? callerDefaults.get(arg.value.name) : arg.value;
    const expected = describeKind(defaultValue);
    const actual = effective ? describeKind(effective) : undefined;

    if (actual && expected !== "null" && actual !== "null" && actual !== expected) {
      diagnostics.push(
        createErrorDiagnostic(
          "USE_ARG_TYPE_MISMATCH",
          `Argument ${arg.key} on ${instanceId} is ${actual}, but parameter ${arg.key} of module ${targetModuleId} defaults to ${expected}.`,
          "sw-net",
          documentPath,
          instanceId,
          {
            messageId: "project.useArgTypeMismatch",
            messageArgs: { argName: arg.key, moduleId: targetModuleId, instanceId, expected, actual },
          },
        ),
      );
    }
  }
}

function describeKind(expression: SwNetExpression): string {
  return expression.kind === "identifier" ? "string" : expression.kind;
}

function error(
  resolved: SwNetResolvedModule,
  code: string,
  message: string,
  instanceId: string,
  localized: LocalizedMessage,
): Diagnostic {
  return createErrorDiagnostic(code, message, "sw-net", resolved.key.documentPath, instanceId, localized);
}
