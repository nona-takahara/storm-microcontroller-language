// sw-net parser that tokenizes the DSL, validates namespace rules, and produces the typed AST.
import { type IrSignalKind } from "../ir.js";

export interface SwNetParseOptions {
  sourceName?: string;
}

export interface SwNetDocument {
  imports: SwNetImport[];
  modules: SwNetModule[];
}

export interface SwNetImport {
  alias: string;
  path: string;
}

export interface SwNetModule {
  id: string;
  ports: SwNetPort[];
  statements: SwNetStatement[];
}

export interface SwNetPort {
  direction: "in" | "out";
  name: string;
  signal: IrSignalKind;
}

export type SwNetStatement = SwNetInstStatement | SwNetUseStatement;

export interface SwNetInstStatement {
  kind: "inst";
  typeId: string;
  instanceId: string;
  attributes: SwNetAssignment[];
  inputs: SwNetAssignment[];
  outputs: SwNetAssignment[];
}

export interface SwNetUseStatement {
  kind: "use";
  moduleRef: SwNetModuleRef;
  instanceId: string;
  inputs: SwNetAssignment[];
  outputs: SwNetAssignment[];
}

export type SwNetModuleRef = SwNetLocalModuleRef | SwNetImportedModuleRef;

export interface SwNetLocalModuleRef {
  kind: "local";
  moduleId: string;
}

export interface SwNetImportedModuleRef {
  kind: "imported";
  alias: string;
  moduleId: string;
}

export interface SwNetAssignment {
  key: string;
  value: SwNetExpression;
}

export type SwNetExpression =
  | SwNetIdentifierExpression
  | SwNetStringExpression
  | SwNetNumberExpression
  | SwNetBooleanExpression
  | SwNetNullExpression;

export interface SwNetIdentifierExpression {
  kind: "identifier";
  value: string;
}

export interface SwNetStringExpression {
  kind: "string";
  value: string;
}

export interface SwNetNumberExpression {
  kind: "number";
  value: number;
}

export interface SwNetBooleanExpression {
  kind: "boolean";
  value: boolean;
}

export interface SwNetNullExpression {
  kind: "null";
  value: null;
}

/** Error type for syntax and namespace problems found while parsing sw-net source text. */
export class SwNetParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
    readonly sourceName?: string,
  ) {
    const formattedLocation = sourceName ? `${sourceName}:${line}:${column}` : `line ${line}, column ${column}`;
    super(`${message} at ${formattedLocation}`);
    this.name = "SwNetParseError";
  }
}

type TokenKind =
  | "identifier"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "colon"
  | "comma"
  | "dot"
  | "equal"
  | "lparen"
  | "rparen"
  | "arrow"
  | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  value?: string | number | boolean | null;
  line: number;
  column: number;
}

/** Parse sw-net source text into the typed AST used by resolvers and higher-level library APIs. */
export function parseSwNetDocument(text: string, options: SwNetParseOptions = {}): SwNetDocument {
  return new SwNetParser(text, options.sourceName).parseDocument();
}

/** Recursive-descent parser for the sw-net grammar. */
class SwNetParser {
  private readonly lexer: SwNetLexer;

  constructor(
    text: string,
    private readonly sourceName?: string,
  ) {
    this.lexer = new SwNetLexer(text, sourceName);
  }

  /** Parse a complete sw-net document, enforcing import-before-module ordering. */
  parseDocument(): SwNetDocument {
    const imports: SwNetImport[] = [];
    const modules: SwNetModule[] = [];
    let hasSeenModule = false;

    while (!this.isToken("eof")) {
      if (this.isIdentifier("import")) {
        if (hasSeenModule) {
          const token = this.peek();
          this.raiseError("import must appear before the first module definition", token);
        }

        imports.push(this.parseImport());
        continue;
      }

      if (this.isIdentifier("module")) {
        hasSeenModule = true;
        modules.push(this.parseModule());
        continue;
      }

      this.raiseError(`Unexpected token ${this.describeToken(this.peek())}`, this.peek());
    }

    this.expect("eof");
    validateDocumentNamespaces({ imports, modules }, this.sourceName);

    return {
      imports,
      modules,
    };
  }

  /** Parse one `import alias from "./path.sw-net"` declaration. */
  private parseImport(): SwNetImport {
    this.expectIdentifier("import");
    const alias = this.expect("identifier").text;
    this.expectIdentifier("from");
    const pathToken = this.expect("string");

    return {
      alias,
      path: expectStringTokenValue(pathToken),
    };
  }

  /** Parse one `module ... end` block. */
  private parseModule(): SwNetModule {
    this.expectIdentifier("module");
    const id = this.expect("identifier").text;
    const ports: SwNetPort[] = [];
    const statements: SwNetStatement[] = [];

    while (!this.isIdentifier("end")) {
      if (this.isToken("eof")) {
        this.raiseError(`Unterminated module ${id}`, this.peek());
      }

      if (this.isIdentifier("port")) {
        ports.push(this.parsePort());
        continue;
      }

      if (this.isIdentifier("inst")) {
        statements.push(this.parseInstStatement());
        continue;
      }

      if (this.isIdentifier("use")) {
        statements.push(this.parseUseStatement());
        continue;
      }

      this.raiseError(`Unexpected token ${this.describeToken(this.peek())} in module ${id}`, this.peek());
    }

    this.expectIdentifier("end");

    return {
      id,
      ports,
      statements,
    };
  }

  /** Parse one `port in|out ... : signal` declaration. */
  private parsePort(): SwNetPort {
    this.expectIdentifier("port");
    const directionToken = this.expect("identifier");
    const direction = parseDirection(directionToken, this.sourceName);
    const name = this.parsePortName();
    this.expect("colon");
    const signalToken = this.expect("identifier");

    return {
      direction,
      name,
      signal: parseSignalKind(signalToken, this.sourceName),
    };
  }

  /** Parse either a quoted or bare port name. */
  private parsePortName(): string {
    if (this.isToken("string")) {
      return expectStringTokenValue(this.expect("string"));
    }

    return this.expect("identifier").text;
  }

  /** Parse one `inst` statement including optional attributes and pin assignments. */
  private parseInstStatement(): SwNetInstStatement {
    this.expectIdentifier("inst");
    const typeId = this.expect("identifier").text;
    const instanceId = this.expect("identifier").text;
    const attributes = this.isToken("lparen") ? this.parseAttributeAssignments() : [];
    const { inputs, outputs } = this.parsePinAssignments();

    return {
      kind: "inst",
      typeId,
      instanceId,
      attributes,
      inputs,
      outputs,
    };
  }

  /** Parse one `use` statement that instantiates another module. */
  private parseUseStatement(): SwNetUseStatement {
    this.expectIdentifier("use");
    const moduleRef = this.parseModuleRef();
    const instanceId = this.expect("identifier").text;
    const { inputs, outputs } = this.parsePinAssignments();

    return {
      kind: "use",
      moduleRef,
      instanceId,
      inputs,
      outputs,
    };
  }

  /** Parse either a local module reference or an alias-qualified imported module reference. */
  private parseModuleRef(): SwNetModuleRef {
    const firstToken = this.expect("identifier");

    if (!this.isToken("dot")) {
      return {
        kind: "local",
        moduleId: firstToken.text,
      };
    }

    this.expect("dot");
    const secondToken = this.expect("identifier");

    return {
      kind: "imported",
      alias: firstToken.text,
      moduleId: secondToken.text,
    };
  }

  /** Parse the optional `(key=value, ...)` attribute clause on an inst statement. */
  private parseAttributeAssignments(): SwNetAssignment[] {
    this.expect("lparen");

    if (this.isToken("rparen")) {
      this.expect("rparen");
      return [];
    }

    const assignments = this.parseAssignmentList("rparen");
    this.expect("rparen");
    return assignments;
  }

  /** Parse the shared `: inputs -> outputs` clause used by inst and use statements. */
  private parsePinAssignments(): { inputs: SwNetAssignment[]; outputs: SwNetAssignment[] } {
    this.expect("colon");
    const inputs = this.isToken("arrow") ? [] : this.parseAssignmentList("arrow");
    this.expect("arrow");
    const outputs = this.isStatementBoundary(this.peek()) ? [] : this.parseAssignmentList("statement");

    return { inputs, outputs };
  }

  /** Parse a comma-separated assignment list until the requested terminator is reached. */
  private parseAssignmentList(terminator: "rparen" | "arrow" | "statement"): SwNetAssignment[] {
    const assignments: SwNetAssignment[] = [];

    while (true) {
      assignments.push(this.parseAssignment());

      if (this.isToken("comma")) {
        this.expect("comma");
        continue;
      }

      if (terminator === "statement") {
        break;
      }

      if (this.isToken(terminator)) {
        break;
      }

      this.raiseError(`Expected ${terminator} or comma after assignment`, this.peek());
    }

    return assignments;
  }

  /** Parse one `key=value` assignment. */
  private parseAssignment(): SwNetAssignment {
    const key = this.expect("identifier").text;
    this.expect("equal");

    return {
      key,
      value: this.parseExpression(),
    };
  }

  /** Parse one scalar or identifier expression supported by the current sw-net grammar. */
  private parseExpression(): SwNetExpression {
    if (this.isToken("string")) {
      return {
        kind: "string",
        value: expectStringTokenValue(this.expect("string")),
      };
    }

    if (this.isToken("number")) {
      return {
        kind: "number",
        value: expectNumberTokenValue(this.expect("number")),
      };
    }

    if (this.isToken("boolean")) {
      return {
        kind: "boolean",
        value: expectBooleanTokenValue(this.expect("boolean")),
      };
    }

    if (this.isToken("null")) {
      this.expect("null");
      return {
        kind: "null",
        value: null,
      };
    }

    const identifierToken = this.expect("identifier");
    return {
      kind: "identifier",
      value: identifierToken.text,
    };
  }

  /** Detect tokens that terminate the current statement without consuming them. */
  private isStatementBoundary(token: Token): boolean {
    return (
      token.kind === "eof" ||
      token.kind === "rparen" ||
      this.isKeywordToken(token, "port") ||
      this.isKeywordToken(token, "inst") ||
      this.isKeywordToken(token, "use") ||
      this.isKeywordToken(token, "end") ||
      this.isKeywordToken(token, "module") ||
      this.isKeywordToken(token, "import")
    );
  }

  /** Test whether a token is a specific keyword encoded as an identifier token. */
  private isKeywordToken(token: Token, keyword: string): boolean {
    return token.kind === "identifier" && token.text === keyword;
  }

  /** Test whether the current lookahead token matches a specific keyword. */
  private isIdentifier(keyword: string): boolean {
    return this.isKeywordToken(this.peek(), keyword);
  }

  /** Test whether the current lookahead token has a specific token kind. */
  private isToken(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  /** Consume one token of the expected kind or raise a parse error. */
  private expect(kind: TokenKind): Token {
    const token = this.peek();

    if (token.kind !== kind) {
      this.raiseError(`Expected ${kind} but found ${this.describeToken(token)}`, token);
    }

    return this.lexer.next();
  }

  /** Consume one identifier token with a required keyword spelling. */
  private expectIdentifier(keyword: string): Token {
    const token = this.expect("identifier");

    if (token.text !== keyword) {
      this.raiseError(`Expected ${keyword} but found ${token.text}`, token);
    }

    return token;
  }

  /** Read the current lookahead token without consuming it. */
  private peek(): Token {
    return this.lexer.peek();
  }

  /** Format a token for human-readable parse errors. */
  private describeToken(token: Token): string {
    return token.kind === "eof" ? "end of file" : token.text;
  }

  /** Raise a source-located parse error using the current document metadata. */
  private raiseError(message: string, token: Token): never {
    throw new SwNetParseError(message, token.line, token.column, this.sourceName);
  }
}

/** Streaming lexer for the sw-net grammar. */
class SwNetLexer {
  private index = 0;
  private line = 1;
  private column = 1;
  private lookahead?: Token;

  constructor(
    private readonly text: string,
    private readonly sourceName?: string,
  ) {}

  /** Read the current token without consuming it. */
  peek(): Token {
    this.lookahead ??= this.readToken();
    return this.lookahead;
  }

  /** Consume and return the current token. */
  next(): Token {
    const token = this.peek();
    this.lookahead = undefined;
    return token;
  }

  /** Tokenize one lexical item from the current character position. */
  private readToken(): Token {
    this.skipIgnored();

    if (this.index >= this.text.length) {
      return this.createToken("eof", "");
    }

    const startLine = this.line;
    const startColumn = this.column;
    const char = this.text[this.index];

    if (char === ":") {
      this.advance();
      return { kind: "colon", text: ":", line: startLine, column: startColumn };
    }

    if (char === ",") {
      this.advance();
      return { kind: "comma", text: ",", line: startLine, column: startColumn };
    }

    if (char === ".") {
      this.advance();
      return { kind: "dot", text: ".", line: startLine, column: startColumn };
    }

    if (char === "=") {
      this.advance();
      return { kind: "equal", text: "=", line: startLine, column: startColumn };
    }

    if (char === "(") {
      this.advance();
      return { kind: "lparen", text: "(", line: startLine, column: startColumn };
    }

    if (char === ")") {
      this.advance();
      return { kind: "rparen", text: ")", line: startLine, column: startColumn };
    }

    if (char === "-" && this.peekChar(1) === ">") {
      this.advance();
      this.advance();
      return { kind: "arrow", text: "->", line: startLine, column: startColumn };
    }

    if (char === "\"") {
      const text = this.readQuotedText();
      const value = parseQuotedText(text, startLine, startColumn, this.sourceName);
      return {
        kind: "string",
        text,
        value,
        line: startLine,
        column: startColumn,
      };
    }

    if (isNumberStart(char, this.peekChar(1))) {
      const text = this.readNumberText();
      const value = Number(text);

      if (!Number.isFinite(value)) {
        throw new SwNetParseError(`Invalid number literal ${text}`, startLine, startColumn, this.sourceName);
      }

      return {
        kind: "number",
        text,
        value,
        line: startLine,
        column: startColumn,
      };
    }

    if (isIdentifierStart(char)) {
      const text = this.readIdentifierText();

      if (text === "true" || text === "false") {
        return {
          kind: "boolean",
          text,
          value: text === "true",
          line: startLine,
          column: startColumn,
        };
      }

      if (text === "null") {
        return {
          kind: "null",
          text,
          value: null,
          line: startLine,
          column: startColumn,
        };
      }

      return {
        kind: "identifier",
        text,
        line: startLine,
        column: startColumn,
      };
    }

    throw new SwNetParseError(`Unexpected character ${char}`, startLine, startColumn, this.sourceName);
  }

  /** Skip whitespace and line comments before lexing the next token. */
  private skipIgnored(): void {
    while (this.index < this.text.length) {
      const char = this.text[this.index];

      if (char === "#") {
        this.skipComment();
        continue;
      }

      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        this.advance();
        continue;
      }

      break;
    }
  }

  /** Skip a `#` line comment. */
  private skipComment(): void {
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      this.advance();

      if (char === "\n") {
        break;
      }
    }
  }

  /** Read a quoted string literal including escape sequences. */
  private readQuotedText(): string {
    const start = this.index;
    this.advance();

    while (this.index < this.text.length) {
      const char = this.text[this.index];

      if (char === "\\") {
        this.advance();

        if (this.index < this.text.length) {
          this.advance();
        }

        continue;
      }

      this.advance();

      if (char === "\"") {
        return this.text.slice(start, this.index);
      }
    }

    throw new SwNetParseError("Unterminated string literal", this.line, this.column, this.sourceName);
  }

  /** Read the textual form of one numeric literal. */
  private readNumberText(): string {
    const start = this.index;

    if (this.text[this.index] === "+" || this.text[this.index] === "-") {
      this.advance();
    }

    while (isDigit(this.text[this.index])) {
      this.advance();
    }

    if (this.text[this.index] === ".") {
      this.advance();

      while (isDigit(this.text[this.index])) {
        this.advance();
      }
    }

    if (this.text[this.index] === "e" || this.text[this.index] === "E") {
      this.advance();

      if (this.text[this.index] === "+" || this.text[this.index] === "-") {
        this.advance();
      }

      while (isDigit(this.text[this.index])) {
        this.advance();
      }
    }

    return this.text.slice(start, this.index);
  }

  /** Read the textual form of one bare identifier or keyword. */
  private readIdentifierText(): string {
    const start = this.index;
    this.advance();

    while (isIdentifierPart(this.text[this.index])) {
      this.advance();
    }

    return this.text.slice(start, this.index);
  }

  /** Create one token record at the current lexer location. */
  private createToken(kind: TokenKind, text: string): Token {
    return {
      kind,
      text,
      line: this.line,
      column: this.column,
    };
  }

  /** Advance the lexer by one UTF-16 code unit while maintaining line/column counters. */
  private advance(): void {
    const char = this.text[this.index];
    this.index += 1;

    if (char === "\n") {
      this.line += 1;
      this.column = 1;
      return;
    }

    this.column += 1;
  }

  /** Peek ahead in the raw text without changing the lexer cursor. */
  private peekChar(offset: number): string | undefined {
    return this.text[this.index + offset];
  }
}

/** Validate top-level namespace rules such as duplicate module ids and alias collisions. */
function validateDocumentNamespaces(document: SwNetDocument, sourceName: string | undefined): void {
  const moduleIds = new Set<string>();
  const importAliases = new Set<string>();

  for (const module of document.modules) {
    if (moduleIds.has(module.id)) {
      throw new SwNetParseError(`Duplicate module id ${module.id}`, 1, 1, sourceName);
    }

    moduleIds.add(module.id);
  }

  for (const imported of document.imports) {
    if (importAliases.has(imported.alias)) {
      throw new SwNetParseError(`Duplicate import alias ${imported.alias}`, 1, 1, sourceName);
    }

    if (moduleIds.has(imported.alias)) {
      throw new SwNetParseError(`Import alias ${imported.alias} conflicts with a local module id`, 1, 1, sourceName);
    }

    importAliases.add(imported.alias);
  }
}

/** Parse a port direction token. */
function parseDirection(token: Token, sourceName?: string): "in" | "out" {
  if (token.text === "in" || token.text === "out") {
    return token.text;
  }

  throw new SwNetParseError(`Expected in or out but found ${token.text}`, token.line, token.column, sourceName);
}

/** Parse a signal-kind token. */
function parseSignalKind(token: Token, sourceName?: string): IrSignalKind {
  if (
    token.text === "number" ||
    token.text === "boolean" ||
    token.text === "composite" ||
    token.text === "video" ||
    token.text === "execute" ||
    token.text === "unknown"
  ) {
    return token.text;
  }

  throw new SwNetParseError(
    `Expected signal kind but found ${token.text}`,
    token.line,
    token.column,
    sourceName,
  );
}

/** Decode a quoted string literal using JSON string semantics. */
function parseQuotedText(text: string, line: number, column: number, sourceName?: string): string {
  try {
    const parsed = JSON.parse(text);

    if (typeof parsed !== "string") {
      throw new Error("Expected string");
    }

    return parsed;
  } catch {
    throw new SwNetParseError(`Invalid string literal ${text}`, line, column, sourceName);
  }
}

/** Assert that a token carries a string value. */
function expectStringTokenValue(token: Token): string {
  if (typeof token.value === "string") {
    return token.value;
  }

  throw new Error("Expected string token value");
}

/** Assert that a token carries a numeric value. */
function expectNumberTokenValue(token: Token): number {
  if (typeof token.value === "number") {
    return token.value;
  }

  throw new Error("Expected number token value");
}

/** Assert that a token carries a boolean value. */
function expectBooleanTokenValue(token: Token): boolean {
  if (typeof token.value === "boolean") {
    return token.value;
  }

  throw new Error("Expected boolean token value");
}

/** Test whether a character can start a bare identifier. */
function isIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z_]/.test(value);
}

/** Test whether a character can continue a bare identifier. */
function isIdentifierPart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

/** Test whether a character is an ASCII decimal digit. */
function isDigit(value: string | undefined): boolean {
  return value !== undefined && /[0-9]/.test(value);
}

/** Test whether the current character pair can start a numeric literal. */
function isNumberStart(first: string | undefined, second: string | undefined): boolean {
  if (first === undefined) {
    return false;
  }

  if (isDigit(first)) {
    return true;
  }

  return (first === "+" || first === "-") && isDigit(second);
}
