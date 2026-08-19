import {
  parseSwNetDocumentWithObserver,
  tokenizeSwNetDocument,
  type SwNetAssignment,
  type SwNetDocument,
  type SwNetImport,
  type SwNetModule,
  type SwNetParseOptions,
  type SwNetPort,
  type SwNetStatement,
  type SwNetToken,
} from "./sw-net.js";

export interface SwNetSourceSpan {
  start: number;
  end: number;
}

export type SwNetSourceElement =
  | SwNetImport
  | SwNetModule
  | SwNetPort
  | SwNetStatement
  | SwNetAssignment;

export interface SwNetSourceElementSpan<T extends SwNetSourceElement = SwNetSourceElement>
  extends SwNetSourceSpan {
  value: T;
}

export type SwNetSourceTriviaKind = "whitespace" | "newline" | "comment";

export interface SwNetSourceTrivia extends SwNetSourceSpan {
  kind: SwNetSourceTriviaKind;
  text: string;
}

export interface SwNetSourceDocument {
  text: string;
  ast: SwNetDocument;
  newline: "\n" | "\r\n";
  trivia: SwNetSourceTrivia[];
  tokens: SwNetToken[];
  elements: SwNetSourceElementSpan[];
  spanOf(value: SwNetSourceElement): SwNetSourceSpan;
}

export interface SwNetTextEdit extends SwNetSourceSpan {
  newText: string;
}

/** Parse sw-net while retaining the exact source and source ranges needed for surgical edits. */
export function parseSwNetSourceDocument(
  text: string,
  options: SwNetParseOptions = {},
): SwNetSourceDocument {
  const spans = new Map<object, SwNetSourceSpan>();
  const elements: SwNetSourceElementSpan[] = [];
  const ast = parseSwNetDocumentWithObserver(
    text,
    {
      record(value, start, end) {
        const span = { start, end };
        spans.set(value, span);
        elements.push({ value: value as SwNetSourceElement, ...span });
      },
    },
    options,
  );

  elements.sort((left, right) => left.start - right.start || right.end - left.end);

  return {
    text,
    ast,
    newline: text.includes("\r\n") ? "\r\n" : "\n",
    trivia: scanTrivia(text),
    tokens: tokenizeSwNetDocument(text, options),
    elements,
    spanOf(value) {
      const span = spans.get(value);

      if (!span) {
        throw new Error("The sw-net element does not belong to this source document.");
      }

      return span;
    },
  };
}

/** Validate and apply a set of non-overlapping edits without touching any other source byte. */
export function applySwNetTextEdits(text: string, edits: readonly SwNetTextEdit[]): string {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  let previousEnd = 0;

  for (const edit of ordered) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end)) {
      throw new Error("sw-net text edit offsets must be integers.");
    }

    if (edit.start < 0 || edit.end < edit.start || edit.end > text.length) {
      throw new Error(`Invalid sw-net text edit range [${edit.start}, ${edit.end}).`);
    }

    if (edit.start < previousEnd) {
      throw new Error(`Overlapping sw-net text edit at offset ${edit.start}.`);
    }

    previousEnd = edit.end;
  }

  let result = text;

  for (const edit of ordered.reverse()) {
    result = `${result.slice(0, edit.start)}${edit.newText}${result.slice(edit.end)}`;
  }

  return result;
}

/** Build an edit that removes syntax while leaving an adjacent line comment in the document. */
export function createSwNetElementRemovalEdit(
  source: SwNetSourceDocument,
  element: SwNetSourceElement,
): SwNetTextEdit {
  const span = source.spanOf(element);
  const lineStart = findLineStart(source.text, span.start);
  const startsAtIndentedLine = /^[\t ]*$/.test(source.text.slice(lineStart, span.start));
  const nextLineStart = findNextLineStart(source.text, span.end);
  const lineTail = source.text.slice(span.end, nextLineStart);
  const hasComment = /^[\t ]*#/.test(lineTail);
  const hasOnlyWhitespaceAndNewline = /^[\t ]*(?:\r?\n|$)$/.test(lineTail);

  return {
    start: startsAtIndentedLine ? lineStart : span.start,
    end: !hasComment && hasOnlyWhitespaceAndNewline ? nextLineStart : span.end,
    newText: "",
  };
}

/** Insert a rendered statement immediately before a module's terminal `end`, matching local style. */
export function createSwNetStatementInsertionEdit(
  source: SwNetSourceDocument,
  module: SwNetModule,
  renderedStatement: string,
): SwNetTextEdit {
  const moduleSpan = source.spanOf(module);
  const endLineStart = findLineStart(source.text, moduleSpan.end - 1);
  const indent = inferStatementIndent(source, module);
  const lines = renderedStatement.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const rendered = `${lines.map((line) => `${indent}${line}`).join(source.newline)}${source.newline}`;

  return { start: endLineStart, end: endLineStart, newText: rendered };
}

function inferStatementIndent(
  source: SwNetSourceDocument,
  module: SwNetModule,
): string {
  const previous = module.statements.at(-1) ?? module.ports.at(-1);

  if (previous) {
    const start = source.spanOf(previous).start;
    return source.text.slice(findLineStart(source.text, start), start);
  }

  const moduleStart = source.spanOf(module).start;
  return `${source.text.slice(findLineStart(source.text, moduleStart), moduleStart)}  `;
}

function findLineStart(text: string, offset: number): number {
  const newline = text.lastIndexOf("\n", Math.max(0, offset - 1));
  return newline < 0 ? 0 : newline + 1;
}

function findNextLineStart(text: string, offset: number): number {
  const newline = text.indexOf("\n", offset);
  return newline < 0 ? text.length : newline + 1;
}

function scanTrivia(text: string): SwNetSourceTrivia[] {
  const trivia: SwNetSourceTrivia[] = [];
  let index = 0;
  let inString = false;

  while (index < text.length) {
    const start = index;
    const char = text[index]!;

    if (inString) {
      if (char === "\\") {
        index += Math.min(2, text.length - index);
      } else {
        index += 1;
        inString = char !== '"';
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      index += 1;
      continue;
    }

    if (char === "#") {
      while (index < text.length && text[index] !== "\r" && text[index] !== "\n") {
        index += 1;
      }
      trivia.push({ kind: "comment", start, end: index, text: text.slice(start, index) });
      continue;
    }

    if (char === "\r" || char === "\n") {
      index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
      trivia.push({ kind: "newline", start, end: index, text: text.slice(start, index) });
      continue;
    }

    if (char === " " || char === "\t") {
      while (text[index] === " " || text[index] === "\t") {
        index += 1;
      }
      trivia.push({ kind: "whitespace", start, end: index, text: text.slice(start, index) });
      continue;
    }

    index += 1;
  }

  return trivia;
}
