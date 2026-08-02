import type { Diagnostic, SourcePosition, SourceSpan } from "@neurosa/ast";

export type TokenKind =
  | "IDENTIFIER"
  | "NUMBER"
  | "STRING"
  | "LBRACE"
  | "RBRACE"
  | "LPAREN"
  | "RPAREN"
  | "COLON"
  | "COMMA"
  | "ARROW"
  | "EOF";

export interface Token {
  readonly kind: TokenKind;
  readonly lexeme: string;
  readonly value: string | number | null;
  readonly span: SourceSpan;
}

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
}

const punctuation: Readonly<Record<string, TokenKind>> = {
  "{": "LBRACE",
  "}": "RBRACE",
  "(": "LPAREN",
  ")": "RPAREN",
  ":": "COLON",
  ",": "COMMA",
};

export function lex(source: string, file = "<memory>"): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;

  const position = (): SourcePosition => ({ offset, line, column });
  const span = (start: SourcePosition): SourceSpan => ({ file, start, end: position() });
  const peek = (distance = 0): string | undefined => source[offset + distance];
  const advance = (): string => {
    const character = source[offset] ?? "";
    offset += 1;
    if (character === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return character;
  };
  const push = (
    kind: TokenKind,
    start: SourcePosition,
    startOffset: number,
    value: Token["value"] = null,
  ): void => {
    tokens.push({ kind, lexeme: source.slice(startOffset, offset), value, span: span(start) });
  };
  const report = (code: string, message: string, start: SourcePosition): void => {
    diagnostics.push({ code, message, severity: "error", span: span(start) });
  };

  while (offset < source.length) {
    const character = peek();
    if (character === undefined) break;

    if (/\s/u.test(character)) {
      advance();
      continue;
    }

    if (character === "/" && peek(1) === "/") {
      while (offset < source.length && peek() !== "\n") advance();
      continue;
    }

    const start = position();
    const startOffset = offset;

    if (character === "-" && peek(1) === ">") {
      advance();
      advance();
      push("ARROW", start, startOffset);
      continue;
    }

    const punctuationKind = punctuation[character];
    if (punctuationKind !== undefined) {
      advance();
      push(punctuationKind, start, startOffset);
      continue;
    }

    if (character === '"') {
      advance();
      let value = "";
      let terminated = false;
      while (offset < source.length) {
        const current = advance();
        if (current === '"') {
          terminated = true;
          break;
        }
        if (current === "\\") {
          const escaped = advance();
          const escapes: Readonly<Record<string, string>> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
            '"': '"',
          };
          value += escapes[escaped] ?? escaped;
        } else {
          value += current;
        }
      }
      if (!terminated) {
        report("NEUROSA-L002", "Niedomknięty literał tekstowy", start);
      } else {
        push("STRING", start, startOffset, value);
      }
      continue;
    }

    const beginsNumber =
      /\d/u.test(character) ||
      (character === "-" && peek(1) !== undefined && /\d/u.test(peek(1) ?? ""));
    if (beginsNumber) {
      if (character === "-") advance();
      while (peek() !== undefined && /\d/u.test(peek() ?? "")) advance();
      if (peek() === "." && peek(1) !== undefined && /\d/u.test(peek(1) ?? "")) {
        advance();
        while (peek() !== undefined && /\d/u.test(peek() ?? "")) advance();
      }
      const lexeme = source.slice(startOffset, offset);
      const value = Number(lexeme);
      if (!Number.isFinite(value)) {
        report("NEUROSA-L003", `Nieprawidłowa liczba '${lexeme}'`, start);
      } else {
        push("NUMBER", start, startOffset, value);
      }
      continue;
    }

    if (/[A-Za-z_]/u.test(character)) {
      advance();
      while (peek() !== undefined && /[A-Za-z0-9_]/u.test(peek() ?? "")) advance();
      push("IDENTIFIER", start, startOffset, source.slice(startOffset, offset));
      continue;
    }

    advance();
    report("NEUROSA-L001", `Nieoczekiwany znak '${character}'`, start);
  }

  const eof = position();
  tokens.push({
    kind: "EOF",
    lexeme: "",
    value: null,
    span: { file, start: eof, end: eof },
  });
  return { tokens, diagnostics };
}
