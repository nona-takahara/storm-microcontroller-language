export type SupportedLanguage = "en" | "ja";

export const enMessages = {
  "cli.usageHeading": "Usage:",
  "cli.specEnglishOnly": "The spec command always outputs English.",
  "cli.invalidLanguage": "Invalid --lang value: {value}. Expected auto, en, or ja.",
  "cli.missingLanguage": "Missing value for --lang. Expected auto, en, or ja.",
  "cli.duplicateLanguage": "The --lang option may only be specified once.",
  "cli.wroteFile": "Wrote {path}",
  "cli.typecheckPassed": "DSL typecheck passed.",
  "cli.resolved": "Resolved {documents, plural, one {# document} other {# documents}}, {modules, plural, one {# module} other {# modules}}, and {uses, plural, one {# use statement} other {# use statements}}.",
  "cli.autoLayout": "auto-layout",
  "cli.fileReadFailed": "Failed to read file:",
  "cli.operationFailed": "Operation failed:",
  "diagnostic.severity.error": "error",
  "diagnostic.severity.warning": "warning",
  "diagnostic.severity.info": "info",
  "diagnostic.fileNotFound": "File not found: {path}",
  "diagnostic.fileReadFailed": "Failed to read {path}:\n  {detail}",
  "diagnostic.internalError": "Internal error:\n  {detail}",
  "diagnostic.operationFailed": "Operation failed:\n  {detail}",
  "diagnostic.fallback": "{message}",
  "import.empty": "No IR nodes were imported. Loaded {definitions} definitions but did not match any XML content.",
  "import.summary": "Imported {nodes} nodes, {links} links, and {submodules} submodules from XML.",
  "import.projectNodeSkipped": "Skipped a project node because component_id or node data was missing.",
  "import.projectNodeUnclassified": "Project node {typeKey} is not classified yet; imported with inferred direction={direction} signal={signal}.",
  "import.projectBridgeSkipped": "Skipped a project bridge component because object or object id was missing.",
  "import.logicComponentSkipped": "Skipped a logic component because object or object id was missing.",
  "import.logicComponentUnresolved": "No definition matched logic component type {componentType}; imported as a generic logic node.",
  "import.projectNodeWithoutBridge": "Project node {rawId} has no components_bridge.c entry.",
  "import.projectBridgeTypeMismatch": "Project node {rawId} expected bridge type {expected} but found {actual}.",
  "import.bridgeWithoutProjectNode": "Bridge component {rawId} has no matching project node.",
  "import.projectOutputWithoutBridge": "Project output node {rawId} has no components_bridge.c entry.",
  "import.bridgeOutputSourceMissing": "Output bridge {rawId} does not specify an internal source component.",
  "import.submoduleInputSynthesized": "Synthesized a submodule input port for external component_id={rawId} referenced from components.c or components_bridge.c.",
  "import.propertyMissing": "Required property {propertyKey} was not found for {definitionId}.",
  "project.entryLayoutMismatch": "entryDocument.swMcl.moduleId is {actual}, expected {expected}.",
  "project.importLoaderRequired": "Document {documentId} imports {path}, but no loadImportedDocument callback was provided.",
  "project.importNotFound": "Could not load imported document {path} from {documentId}.",
  "project.nodeDefinitionMissing": "Project node type {type} is not defined in definitions.",
  "project.swMclModuleMissing": "sw-mcl moduleId {moduleId} does not exist in {documentId}.",
  "project.entryModuleNotFound": "Entry module {moduleId} does not exist in {documentId}.",
  "project.componentDefinitionMissing": "Component type {typeId} is not defined in definitions.",
  "project.scriptMissing": "Script {scriptRef} was not found in document {documentId}.",
  "project.duplicateUseInstance": "Instance id {instanceId} is used more than once in module {moduleId}.",
  "project.unboundUseInput": "Input port {portName} of module {moduleId} is not bound by {instanceId}.",
  "project.portAssignedMultiple": "Port {portName} is assigned more than once on {instanceId}.",
  "project.modulePortMissing": "Module {moduleId} has no port {portName} (referenced by {instanceId}).",
  "project.moduleInputDrivenInternally": "{context} tries to drive its own input port {portName}; an input port has exactly one producer (the caller's binding), so nothing inside module {moduleId} may also drive it.",
  "project.netSignalMismatch": "Net {netKey} in module {moduleId} has inconsistent signal kinds: {edges}.",
  "graph.instanceLayoutMismatch": "sw-mcl has no instance layout entry matching sw-net instanceId {instanceId}. If this instance was renamed in .sw-net, its .sw-mcl entry needs the same id.",
  "graph.duplicateNetProducer": "Multiple instance outputs drive net {netName}; using the first producer.",
  "graph.unresolvedNet": "Input {inputKey} on {instanceId} references unknown net {netName}.",
  "graph.unresolvedInputPort": "Input {inputKey} on {instanceId} references unknown module input port {portName}.",
  "graph.unresolvedOutputPort": "Output {outputKey} on {instanceId} references unknown module output port {portName}.",
  "export.entryLayoutMissing": "sw-mcl for entry module {moduleId} was not found; instances will share the module canvas anchor position.",
  "export.submoduleEntryMissing": "project.json does not define a submodule entry for {moduleId}; treating sw-mcl positions as absolute.",
  "export.portLayoutMissing": "sw-mcl is missing a port layout entry for {portKey}.",
  "export.ambiguousNamedPorts": "sw-net declares {count} {portKey} ports sharing the same name; project.json node {nodeId} is ambiguous, using the first.",
  "export.ambiguousProjectNodes": "Multiple project nodes map to {portKey}; later matches may be ambiguous.",
  "export.instanceLayoutMissing": "sw-mcl is missing an instance layout entry for {instanceId}.",
  "export.undeclaredModulePort": "{context} references undeclared module port {portName}.",
  "export.moduleLayoutMissing": "sw-mcl for module {moduleKey} was not found; instances embedded via {instanceId} will share its anchor position.",
  "export.duplicateNetProducer": "Multiple instance outputs drive net {netName}; using the first producer.",
  "export.attributeNonScalar": "Attribute {attributeKey} on {instanceId} is not a scalar and was skipped.",
  "export.scriptRefInvalid": "script_ref on {instanceId} is not a string and was skipped.",
  "export.scriptTextMissing": "No script text resolver value was provided for {scriptRef}; exporting an empty Lua script.",
  "export.unknownNet": "Input {inputKey} on {instanceId} references unknown net {netName}.",
  "export.unknownInputPort": "Input {inputKey} on {instanceId} references unknown module input port {portName}.",
  "export.nonNetInput": "Input {inputKey} on {instanceId} uses a non-net expression and was skipped.",
  "export.bridgePositionMissing": "No bridge position was found for project node {nodeId}.",
  "export.projectOutputUndriven": "Project output {nodeId} is not driven by any sw-net output assignment.",
  "export.itemListExpectedString": "Expected a JSON string for item-list target {segment}.",
  "export.itemListInvalidJson": "Failed to parse JSON for item-list target {segment}; left unset.",
  "export.itemListExpectedArray": "Expected a JSON array for item-list target {segment}; left unset.",
  "compare.network": "Network comparison: {verdict}",
  "compare.matchedNodes": "Matched nodes: {count}",
  "compare.reason": "Reason: {reason}",
  "compare.noDifferences": "Differences: none",
  "compare.differences": "Differences ({count}):",
  "compare.moduleComparisons": "Module comparisons ({count}):",
  "compare.moduleSummary": "{moduleA} ↔ {moduleB}: {verdict} ({matched} matched, {differences} differences)",
  "compare.unmatchedModulesA": "Unmatched modules in A: {modules}",
  "compare.unmatchedModulesB": "Unmatched modules in B: {modules}",
  "compare.verdict.equivalent": "equivalent",
  "compare.verdict.different": "different",
  "compare.verdict.indeterminate": "indeterminate",
  "compare.difference.unmatchedNode": "node {node} exists only in {side}",
  "compare.difference.unmatchedLink": "link {link} exists only in {side}",
  "compare.difference.inputMismatch": "input {portKey} differs between {nodeA} and {nodeB}",
  "compare.difference.propertyMismatch": "{source} {key} differs between {nodeA} ({valueA}) and {nodeB} ({valueB})",
  "compare.value.absent": "absent",
  "compare.diagnostic.moduleIdsPaired": "Module IDs must be provided for both comparison targets or neither target.",
  "compare.diagnostic.unsupportedInput": "Expected a project.json or .sw-net path, received {path}.",
  "compare.diagnostic.moduleNotFound": "Module {moduleId} was not found in comparison target {side}.",
  "compare.diagnostic.moduleAmbiguous": "Module {moduleId} is ambiguous in comparison target {side}; it is defined in multiple documents.",
  "compare.diagnostic.entryNotFound": "Entry document does not define module {moduleId}.",
  "compare.diagnostic.entryAmbiguous": "Select an entry module explicitly when the entry document does not have a unique module or a module named main.",
  "compare.node.port": "{id} (port {direction} {name}, {signal}, occurrence {occurrence})",
  "compare.node.gate": "{id} ({definitionId})",
  "layout.error": "error",
  "layout.warning": "warning",
  "layout.noTarget": "no target module found; use --module/module_id to select one of: {availableIds}.",
  "layout.outsideScope": "module {moduleId} is outside layout-dsl's v1 scope (one module per file) and was left untouched; see issue #7.",
  "layout.summary": "{path}: {kept} kept, {added} added, {overwritten} overwritten.",
  "layout.autoResolveFailed": "Could not resolve layout targets for auto-layout: {detail}",
  "layout.autoSkipped": "Auto-layout skipped for {path}: {detail}",
  "layout.pathWarning": "{path}: {detail}",
  "layout.autoComputed": "Computed missing layout for {documentId} in memory (not written to disk): {count, plural, one {# position} other {# positions}} filled in.",
  "layout.autoFailed": "Auto-layout failed for {path}: {detail}",
  "sync.changes": "Changes ({count}):",
  "sync.change": "- {kind}: {node}",
  "sync.warnings": "Warnings ({count}):",
  "sync.warning": "- {kind}: {impacts}",
  "sync.conflicts": "Blocking conflicts ({count}):",
  "sync.conflict": "- {kind}: {impacts}",
  "sync.suggestion": "  Suggested edit: {suggestion}",
  "sync.summary": "Summary: {added} added, {removed} removed, {updated} updated, {rewired} rewired, {conflicts} blocking conflicts.",
  "sync.result.written": "Synchronization applied. Files were written.",
  "sync.result.dryRun": "Dry run completed. No files were written.",
  "sync.result.blocked": "Synchronization was blocked. No files were written.",
  "sync.kind.added": "added",
  "sync.kind.removed": "removed",
  "sync.kind.updated": "updated",
  "sync.kind.rewired": "rewired",
  "sync.warning.layout-overwrite": "layout overwrite",
  "sync.warning.layout-projection": "layout not applied",
  "sync.conflict.module-boundary": "module boundary",
  "sync.conflict.shared-module-divergence": "shared module divergence",
  "sync.conflict.ambiguous-correspondence": "ambiguous correspondence",
  "sync.conflict.ambiguous-placement": "ambiguous placement",
  "sync.conflict.layout-projection": "layout projection",
  "sync.suggestion.add-module-port": "edit module ports",
  "sync.suggestion.add-pin-assignment": "edit internal pin assignments",
  "sync.suggestion.add-use-binding": "edit affected use bindings",
  "sync.suggestion.duplicate-module": "duplicate the module for divergent use sites",
  "sync.suggestion.update-shared-module": "apply one common change to the shared module",
  "sync.suggestion.review-candidates": "review the listed modules, instances, and use sites",
} as const;

export type MessageId = keyof typeof enMessages;
export type MessageValue = string | number | boolean | Date | null | undefined;
export type MessageArguments = Record<string, MessageValue>;
export type NoMessageArguments = Record<never, never>;

export interface MessageArgsById {
  "cli.usageHeading": NoMessageArguments;
  "cli.specEnglishOnly": NoMessageArguments;
  "cli.invalidLanguage": { value: string };
  "cli.missingLanguage": NoMessageArguments;
  "cli.duplicateLanguage": NoMessageArguments;
  "cli.wroteFile": { path: string };
  "cli.typecheckPassed": NoMessageArguments;
  "cli.resolved": { documents: number; modules: number; uses: number };
  "cli.autoLayout": NoMessageArguments;
  "cli.fileReadFailed": NoMessageArguments;
  "cli.operationFailed": NoMessageArguments;
  "diagnostic.severity.error": NoMessageArguments;
  "diagnostic.severity.warning": NoMessageArguments;
  "diagnostic.severity.info": NoMessageArguments;
  "diagnostic.fileNotFound": { path: string };
  "diagnostic.fileReadFailed": { path: string; detail: string };
  "diagnostic.internalError": { detail: string };
  "diagnostic.operationFailed": { detail: string };
  "diagnostic.fallback": { message: string };
  "import.empty": { definitions: number };
  "import.summary": { nodes: number; links: number; submodules: number };
  "import.projectNodeSkipped": NoMessageArguments;
  "import.projectNodeUnclassified": { typeKey: string; direction: string; signal: string };
  "import.projectBridgeSkipped": NoMessageArguments;
  "import.logicComponentSkipped": NoMessageArguments;
  "import.logicComponentUnresolved": { componentType: string };
  "import.projectNodeWithoutBridge": { rawId: string };
  "import.projectBridgeTypeMismatch": { rawId: string; expected: string | number; actual: string | number };
  "import.bridgeWithoutProjectNode": { rawId: string };
  "import.projectOutputWithoutBridge": { rawId: string };
  "import.bridgeOutputSourceMissing": { rawId: string };
  "import.submoduleInputSynthesized": { rawId: string };
  "import.propertyMissing": { propertyKey: string; definitionId: string };
  "project.entryLayoutMismatch": { actual: string; expected: string };
  "project.importLoaderRequired": { documentId: string; path: string };
  "project.importNotFound": { path: string; documentId: string };
  "project.nodeDefinitionMissing": { type: string };
  "project.swMclModuleMissing": { moduleId: string; documentId: string };
  "project.entryModuleNotFound": { moduleId: string; documentId: string };
  "project.componentDefinitionMissing": { typeId: string };
  "project.scriptMissing": { scriptRef: string; documentId: string };
  "project.duplicateUseInstance": { instanceId: string; moduleId: string };
  "project.unboundUseInput": { portName: string; moduleId: string; instanceId: string };
  "project.portAssignedMultiple": { portName: string; instanceId: string };
  "project.modulePortMissing": { moduleId: string; portName: string; instanceId: string };
  "project.moduleInputDrivenInternally": { context: string; portName: string; moduleId: string };
  "project.netSignalMismatch": { netKey: string; moduleId: string; edges: string };
  "graph.instanceLayoutMismatch": { instanceId: string };
  "graph.duplicateNetProducer": { netName: string };
  "graph.unresolvedNet": { inputKey: string; instanceId: string; netName: string };
  "graph.unresolvedInputPort": { inputKey: string; instanceId: string; portName: string };
  "graph.unresolvedOutputPort": { outputKey: string; instanceId: string; portName: string };
  "export.entryLayoutMissing": { moduleId: string };
  "export.submoduleEntryMissing": { moduleId: string };
  "export.portLayoutMissing": { portKey: string };
  "export.ambiguousNamedPorts": { count: number; portKey: string; nodeId: string };
  "export.ambiguousProjectNodes": { portKey: string };
  "export.instanceLayoutMissing": { instanceId: string };
  "export.undeclaredModulePort": { context: string; portName: string };
  "export.moduleLayoutMissing": { moduleKey: string; instanceId: string };
  "export.duplicateNetProducer": { netName: string };
  "export.attributeNonScalar": { attributeKey: string; instanceId: string };
  "export.scriptRefInvalid": { instanceId: string };
  "export.scriptTextMissing": { scriptRef: string };
  "export.unknownNet": { inputKey: string; instanceId: string; netName: string };
  "export.unknownInputPort": { inputKey: string; instanceId: string; portName: string };
  "export.nonNetInput": { inputKey: string; instanceId: string };
  "export.bridgePositionMissing": { nodeId: string };
  "export.projectOutputUndriven": { nodeId: string };
  "export.itemListExpectedString": { segment: string };
  "export.itemListInvalidJson": { segment: string };
  "export.itemListExpectedArray": { segment: string };
  "compare.network": { verdict: string };
  "compare.matchedNodes": { count: number };
  "compare.reason": { reason: string };
  "compare.noDifferences": NoMessageArguments;
  "compare.differences": { count: number };
  "compare.moduleComparisons": { count: number };
  "compare.moduleSummary": { moduleA: string; moduleB: string; verdict: string; matched: number; differences: number };
  "compare.unmatchedModulesA": { modules: string };
  "compare.unmatchedModulesB": { modules: string };
  "compare.verdict.equivalent": NoMessageArguments;
  "compare.verdict.different": NoMessageArguments;
  "compare.verdict.indeterminate": NoMessageArguments;
  "compare.difference.unmatchedNode": { node: string; side: string };
  "compare.difference.unmatchedLink": { link: string; side: string };
  "compare.difference.inputMismatch": { portKey: string; nodeA: string; nodeB: string };
  "compare.difference.propertyMismatch": {
    source: string; key: string; nodeA: string; valueA: string; nodeB: string; valueB: string;
  };
  "compare.value.absent": NoMessageArguments;
  "compare.diagnostic.moduleIdsPaired": NoMessageArguments;
  "compare.diagnostic.unsupportedInput": { path: string };
  "compare.diagnostic.moduleNotFound": { moduleId: string; side: string };
  "compare.diagnostic.moduleAmbiguous": { moduleId: string; side: string };
  "compare.diagnostic.entryNotFound": { moduleId: string };
  "compare.diagnostic.entryAmbiguous": NoMessageArguments;
  "compare.node.port": { id: string; direction: string; name: string; signal: string; occurrence: number };
  "compare.node.gate": { id: string; definitionId: string };
  "layout.error": NoMessageArguments;
  "layout.warning": NoMessageArguments;
  "layout.noTarget": { availableIds: string };
  "layout.outsideScope": { moduleId: string };
  "layout.summary": { path: string; kept: number; added: number; overwritten: number };
  "layout.autoResolveFailed": { detail: string };
  "layout.autoSkipped": { path: string; detail: string };
  "layout.pathWarning": { path: string; detail: string };
  "layout.autoComputed": { documentId: string; count: number };
  "layout.autoFailed": { path: string; detail: string };
  "sync.changes": { count: number };
  "sync.change": { kind: string; node: string };
  "sync.warnings": { count: number };
  "sync.warning": { kind: string; impacts: string };
  "sync.conflicts": { count: number };
  "sync.conflict": { kind: string; impacts: string };
  "sync.suggestion": { suggestion: string };
  "sync.summary": { added: number; removed: number; updated: number; rewired: number; conflicts: number };
  "sync.result.written": NoMessageArguments;
  "sync.result.dryRun": NoMessageArguments;
  "sync.result.blocked": NoMessageArguments;
  "sync.kind.added": NoMessageArguments;
  "sync.kind.removed": NoMessageArguments;
  "sync.kind.updated": NoMessageArguments;
  "sync.kind.rewired": NoMessageArguments;
  "sync.warning.layout-overwrite": NoMessageArguments;
  "sync.warning.layout-projection": NoMessageArguments;
  "sync.conflict.module-boundary": NoMessageArguments;
  "sync.conflict.shared-module-divergence": NoMessageArguments;
  "sync.conflict.ambiguous-correspondence": NoMessageArguments;
  "sync.conflict.ambiguous-placement": NoMessageArguments;
  "sync.conflict.layout-projection": NoMessageArguments;
  "sync.suggestion.add-module-port": NoMessageArguments;
  "sync.suggestion.add-pin-assignment": NoMessageArguments;
  "sync.suggestion.add-use-binding": NoMessageArguments;
  "sync.suggestion.duplicate-module": NoMessageArguments;
  "sync.suggestion.update-shared-module": NoMessageArguments;
  "sync.suggestion.review-candidates": NoMessageArguments;
}

export const jaMessages: Record<MessageId, string> = {
  "cli.usageHeading": "使用方法:",
  "cli.specEnglishOnly": "specコマンドの出力は常に英語です。",
  "cli.invalidLanguage": "--langの値が不正です: {value}。auto、en、jaのいずれかを指定してください。",
  "cli.missingLanguage": "--langの値がありません。auto、en、jaのいずれかを指定してください。",
  "cli.duplicateLanguage": "--langオプションは1回だけ指定できます。",
  "cli.wroteFile": "書き込みました: {path}",
  "cli.typecheckPassed": "DSLの型チェックに成功しました。",
  "cli.resolved": "{documents}個のドキュメント、{modules}個のモジュール、{uses}個のuse文を解決しました。",
  "cli.autoLayout": "自動レイアウト",
  "cli.fileReadFailed": "ファイルを読み込めませんでした:",
  "cli.operationFailed": "処理に失敗しました:",
  "diagnostic.severity.error": "エラー",
  "diagnostic.severity.warning": "警告",
  "diagnostic.severity.info": "情報",
  "diagnostic.fileNotFound": "ファイルが見つかりません: {path}",
  "diagnostic.fileReadFailed": "ファイルを読み込めませんでした: {path}\n  {detail}",
  "diagnostic.internalError": "内部エラーが発生しました:\n  {detail}",
  "diagnostic.operationFailed": "処理に失敗しました:\n  {detail}",
  "diagnostic.fallback": "{message}",
  "import.empty": "IRノードをインポートできませんでした。{definitions}件の定義を読み込みましたが、XML内容に一致しませんでした。",
  "import.summary": "XMLからノード{nodes}件、リンク{links}件、サブモジュール{submodules}件をインポートしました。",
  "import.projectNodeSkipped": "component_idまたはノードデータがないため、プロジェクトノードをスキップしました。",
  "import.projectNodeUnclassified": "プロジェクトノード {typeKey} は未分類です。direction={direction}、signal={signal} と推定してインポートしました。",
  "import.projectBridgeSkipped": "objectまたはobject idがないため、プロジェクトブリッジコンポーネントをスキップしました。",
  "import.logicComponentSkipped": "objectまたはobject idがないため、ロジックコンポーネントをスキップしました。",
  "import.logicComponentUnresolved": "ロジックコンポーネントtype {componentType} に一致する定義がないため、汎用ロジックノードとしてインポートしました。",
  "import.projectNodeWithoutBridge": "プロジェクトノード {rawId} にcomponents_bridge.cのエントリがありません。",
  "import.projectBridgeTypeMismatch": "プロジェクトノード {rawId} の想定ブリッジtypeは {expected} ですが、実際は {actual} です。",
  "import.bridgeWithoutProjectNode": "ブリッジコンポーネント {rawId} に対応するプロジェクトノードがありません。",
  "import.projectOutputWithoutBridge": "プロジェクト出力ノード {rawId} にcomponents_bridge.cのエントリがありません。",
  "import.bridgeOutputSourceMissing": "出力ブリッジ {rawId} に内部ソースコンポーネントが指定されていません。",
  "import.submoduleInputSynthesized": "components.cまたはcomponents_bridge.cから参照された外部component_id={rawId}に対し、サブモジュール入力ポートを生成しました。",
  "import.propertyMissing": "{definitionId} に必須プロパティ {propertyKey} がありません。",
  "project.entryLayoutMismatch": "entryDocument.swMcl.moduleIdは {actual} ですが、{expected} が必要です。",
  "project.importLoaderRequired": "ドキュメント {documentId} は {path} をインポートしていますが、loadImportedDocumentコールバックがありません。",
  "project.importNotFound": "{documentId} からインポートされたドキュメント {path} を読み込めませんでした。",
  "project.nodeDefinitionMissing": "プロジェクトノードtype {type} はdefinitionsに定義されていません。",
  "project.swMclModuleMissing": "sw-mclのmoduleId {moduleId} は {documentId} に存在しません。",
  "project.entryModuleNotFound": "エントリーモジュール {moduleId} は {documentId} に存在しません。",
  "project.componentDefinitionMissing": "コンポーネントtype {typeId} はdefinitionsに定義されていません。",
  "project.scriptMissing": "スクリプト {scriptRef} がドキュメント {documentId} にありません。",
  "project.duplicateUseInstance": "instance id {instanceId} はモジュール {moduleId} 内で複数回使われています。",
  "project.unboundUseInput": "モジュール {moduleId} の入力ポート {portName} が {instanceId} によって接続されていません。",
  "project.portAssignedMultiple": "ポート {portName} が {instanceId} で複数回割り当てられています。",
  "project.modulePortMissing": "モジュール {moduleId} にポート {portName} がありません（{instanceId}から参照）。",
  "project.moduleInputDrivenInternally": "{context} が自身の入力ポート {portName} を駆動しようとしています。入力ポートのproducerはcallerのbindingだけなので、モジュール {moduleId} の内部からは駆動できません。",
  "project.netSignalMismatch": "モジュール {moduleId} のnet {netKey} でsignal種別が一致しません: {edges}。",
  "graph.instanceLayoutMismatch": "sw-netのinstanceId {instanceId} に対応するインスタンスレイアウトがsw-mclにありません。.sw-netで名前を変更した場合は、.sw-mclのidも同じ名前にしてください。",
  "graph.duplicateNetProducer": "複数のインスタンス出力がnet {netName} を駆動しています。最初のproducerを使用します。",
  "graph.unresolvedNet": "{instanceId} の入力 {inputKey} が未知のnet {netName} を参照しています。",
  "graph.unresolvedInputPort": "{instanceId} の入力 {inputKey} が未知のモジュール入力ポート {portName} を参照しています。",
  "graph.unresolvedOutputPort": "{instanceId} の出力 {outputKey} が未知のモジュール出力ポート {portName} を参照しています。",
  "export.entryLayoutMissing": "エントリーモジュール {moduleId} のsw-mclがありません。各インスタンスはモジュールキャンバスのアンカー位置を共有します。",
  "export.submoduleEntryMissing": "project.jsonにサブモジュール {moduleId} のエントリがありません。sw-mclの位置を絶対位置として扱います。",
  "export.portLayoutMissing": "sw-mclにポート {portKey} のレイアウトエントリがありません。",
  "export.ambiguousNamedPorts": "sw-netに同名の {portKey} ポートが{count}個あります。project.jsonノード {nodeId} を一意に対応付けられないため、最初のポートを使います。",
  "export.ambiguousProjectNodes": "複数のプロジェクトノードが {portKey} に対応しています。後続の対応付けが曖昧になる可能性があります。",
  "export.instanceLayoutMissing": "sw-mclにインスタンス {instanceId} のレイアウトエントリがありません。",
  "export.undeclaredModulePort": "{context} が未宣言のモジュールポート {portName} を参照しています。",
  "export.moduleLayoutMissing": "モジュール {moduleKey} のsw-mclがありません。{instanceId} 経由で埋め込まれたインスタンスはアンカー位置を共有します。",
  "export.duplicateNetProducer": "複数のインスタンス出力がnet {netName} を駆動しています。最初のproducerを使用します。",
  "export.attributeNonScalar": "{instanceId} の属性 {attributeKey} はscalarではないためスキップしました。",
  "export.scriptRefInvalid": "{instanceId} のscript_refは文字列ではないためスキップしました。",
  "export.scriptTextMissing": "{scriptRef} のスクリプト本文を解決できなかったため、空のLuaスクリプトをエクスポートします。",
  "export.unknownNet": "{instanceId} の入力 {inputKey} が未知のnet {netName} を参照しています。",
  "export.unknownInputPort": "{instanceId} の入力 {inputKey} が未知のモジュール入力ポート {portName} を参照しています。",
  "export.nonNetInput": "{instanceId} の入力 {inputKey} はnet式ではないためスキップしました。",
  "export.bridgePositionMissing": "プロジェクトノード {nodeId} のブリッジ位置がありません。",
  "export.projectOutputUndriven": "プロジェクト出力 {nodeId} はどのsw-net出力代入からも駆動されていません。",
  "export.itemListExpectedString": "item-listターゲット {segment} にはJSON文字列が必要です。",
  "export.itemListInvalidJson": "item-listターゲット {segment} のJSONを解析できなかったため、値を設定しませんでした。",
  "export.itemListExpectedArray": "item-listターゲット {segment} にはJSON配列が必要なため、値を設定しませんでした。",
  "compare.network": "ネットワーク比較: {verdict}",
  "compare.matchedNodes": "一致したノード: {count}",
  "compare.reason": "理由: {reason}",
  "compare.noDifferences": "差分: なし",
  "compare.differences": "差分（{count}件）:",
  "compare.moduleComparisons": "モジュール比較（{count}件）:",
  "compare.moduleSummary": "{moduleA} ↔ {moduleB}: {verdict}（一致 {matched}、差分 {differences}）",
  "compare.unmatchedModulesA": "Aにのみ存在するモジュール: {modules}",
  "compare.unmatchedModulesB": "Bにのみ存在するモジュール: {modules}",
  "compare.verdict.equivalent": "同等",
  "compare.verdict.different": "異なる",
  "compare.verdict.indeterminate": "判定不能",
  "compare.difference.unmatchedNode": "ノード {node} は {side} にのみ存在します",
  "compare.difference.unmatchedLink": "リンク {link} は {side} にのみ存在します",
  "compare.difference.inputMismatch": "入力 {portKey} が {nodeA} と {nodeB} で異なります",
  "compare.difference.propertyMismatch": "{source} {key} が {nodeA}（{valueA}）と {nodeB}（{valueB}）で異なります",
  "compare.value.absent": "なし",
  "compare.diagnostic.moduleIdsPaired": "モジュールIDは比較対象の両方に指定するか、どちらにも指定しないでください。",
  "compare.diagnostic.unsupportedInput": "project.jsonまたは.sw-netのパスが必要ですが、{path}が指定されました。",
  "compare.diagnostic.moduleNotFound": "比較対象{side}にモジュール {moduleId} が見つかりません。",
  "compare.diagnostic.moduleAmbiguous": "比較対象{side}のモジュール {moduleId} は複数のドキュメントで定義されているため一意に決まりません。",
  "compare.diagnostic.entryNotFound": "エントリードキュメントにモジュール {moduleId} が定義されていません。",
  "compare.diagnostic.entryAmbiguous": "エントリードキュメントに一意のモジュールまたはmainモジュールがない場合は、エントリーモジュールを明示的に選択してください。",
  "compare.node.port": "{id}（ポート {direction} {name}、{signal}、出現番号 {occurrence}）",
  "compare.node.gate": "{id}（{definitionId}）",
  "layout.error": "エラー",
  "layout.warning": "警告",
  "layout.noTarget": "対象モジュールが見つかりません。--module/module_idで次のいずれかを指定してください: {availableIds}。",
  "layout.outsideScope": "モジュール {moduleId} はlayout-dsl v1の対象外（1ファイルにつき1モジュール）なので変更していません。issue #7を参照してください。",
  "layout.summary": "{path}: 維持 {kept}、追加 {added}、上書き {overwritten}。",
  "layout.autoResolveFailed": "自動レイアウトの対象を解決できませんでした: {detail}",
  "layout.autoSkipped": "{path} の自動レイアウトをスキップしました: {detail}",
  "layout.pathWarning": "{path}: {detail}",
  "layout.autoComputed": "{documentId} の不足レイアウトをメモリ上で計算しました（ディスクには未書き込み）: {count}個の位置を補完。",
  "layout.autoFailed": "{path} の自動レイアウトに失敗しました: {detail}",
  "sync.changes": "変更（{count}件）:",
  "sync.change": "- {kind}: {node}",
  "sync.warnings": "警告（{count}件）:",
  "sync.warning": "- {kind}: {impacts}",
  "sync.conflicts": "ブロッキング競合（{count}件）:",
  "sync.conflict": "- {kind}: {impacts}",
  "sync.suggestion": "  編集候補: {suggestion}",
  "sync.summary": "集計: 追加 {added}、削除 {removed}、更新 {updated}、配線変更 {rewired}、ブロッキング競合 {conflicts}。",
  "sync.result.written": "同期を適用し、ファイルを書き込みました。",
  "sync.result.dryRun": "dry-runが完了しました。ファイルは変更していません。",
  "sync.result.blocked": "同期を中止しました。ファイルは変更していません。",
  "sync.kind.added": "追加",
  "sync.kind.removed": "削除",
  "sync.kind.updated": "更新",
  "sync.kind.rewired": "配線変更",
  "sync.warning.layout-overwrite": "レイアウト上書き",
  "sync.warning.layout-projection": "レイアウト未反映",
  "sync.conflict.module-boundary": "module境界",
  "sync.conflict.shared-module-divergence": "共有moduleの利用箇所間差異",
  "sync.conflict.ambiguous-correspondence": "対応の曖昧性",
  "sync.conflict.ambiguous-placement": "配置先の曖昧性",
  "sync.conflict.layout-projection": "レイアウト投影",
  "sync.suggestion.add-module-port": "moduleポートを編集する",
  "sync.suggestion.add-pin-assignment": "内部pin assignmentを編集する",
  "sync.suggestion.add-use-binding": "影響するuse bindingを編集する",
  "sync.suggestion.duplicate-module": "差異のあるuse向けにmoduleを複製する",
  "sync.suggestion.update-shared-module": "共有moduleへ共通の変更を適用する",
  "sync.suggestion.review-candidates": "列挙されたmodule・instance・useを確認する",
};

export type LocalizedMessage = {
  [K in MessageId]: keyof MessageArgsById[K] extends never
    ? { messageId: K; messageArgs?: MessageArgsById[K] }
    : { messageId: K; messageArgs: MessageArgsById[K] }
}[MessageId];
