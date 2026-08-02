import {
  NeurosaDiagnosticError,
  type BrainNode,
  type Diagnostic,
  type IdentifierNode,
  type NeuronNode,
  type ObsidianSourceNode,
  type ProgramNode,
  type PropertyNode,
  type PropertyValueNode,
  type RegionMemberNode,
  type RegionNode,
  type ScalarLiteralNode,
  type SourceSpan,
  type SynapseNode,
} from "@neurosa/ast";
import { lex, type Token, type TokenKind } from "@neurosa/lexer";

function mergeSpan(start: SourceSpan, end: SourceSpan): SourceSpan {
  return { file: start.file, start: start.start, end: end.end };
}

class Parser {
  private current = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parseProgram(): ProgramNode {
    const brain = this.parseBrain();
    const eof = this.expect("EOF", "Oczekiwano końca pliku po deklaracji brain");
    return { kind: "Program", brain, span: mergeSpan(brain.span, eof.span) };
  }

  private parseBrain(): BrainNode {
    const keyword = this.expectKeyword("brain");
    const id = this.parseIdentifier("Oczekiwano identyfikatora brain");
    this.expect("LBRACE", "Oczekiwano '{' po identyfikatorze brain");
    const regions: RegionNode[] = [];
    while (!this.check("RBRACE") && !this.check("EOF")) {
      if (!this.checkKeyword("region")) {
        this.fail("NEUROSA-P102", "Oczekiwano deklaracji region wewnątrz brain");
      }
      regions.push(this.parseRegion());
    }
    const close = this.expect("RBRACE", "Oczekiwano '}' zamykającego deklarację brain");
    return { kind: "Brain", id, regions, span: mergeSpan(keyword.span, close.span) };
  }

  private parseRegion(): RegionNode {
    const keyword = this.expectKeyword("region");
    const id = this.parseIdentifier("Oczekiwano identyfikatora region");
    this.expect("LBRACE", "Oczekiwano '{' po identyfikatorze region");
    const members: RegionMemberNode[] = [];
    while (!this.check("RBRACE") && !this.check("EOF")) {
      if (this.checkKeyword("neuron")) {
        members.push(this.parseNeuron());
      } else if (this.checkKeyword("synapse")) {
        members.push(this.parseSynapse());
      } else {
        this.fail("NEUROSA-P103", "Oczekiwano deklaracji neuron albo synapse wewnątrz region");
      }
    }
    const close = this.expect("RBRACE", "Oczekiwano '}' zamykającego deklarację region");
    return { kind: "Region", id, members, span: mergeSpan(keyword.span, close.span) };
  }

  private parseNeuron(): NeuronNode {
    const keyword = this.expectKeyword("neuron");
    const id = this.parseIdentifier("Oczekiwano identyfikatora neuron");
    const properties = this.parsePropertyBlock("neuron");
    return {
      kind: "Neuron",
      id,
      properties,
      span: mergeSpan(keyword.span, this.previous().span),
    };
  }

  private parseSynapse(): SynapseNode {
    const keyword = this.expectKeyword("synapse");
    const source = this.parseIdentifier("Oczekiwano identyfikatora neuronu źródłowego");
    this.expect("ARROW", "Oczekiwano '->' pomiędzy końcami synapsy");
    const target = this.parseIdentifier("Oczekiwano identyfikatora neuronu docelowego");
    const properties = this.parsePropertyBlock("synapse");
    return {
      kind: "Synapse",
      source,
      target,
      properties,
      span: mergeSpan(keyword.span, this.previous().span),
    };
  }

  private parsePropertyBlock(owner: string): PropertyNode[] {
    this.expect("LBRACE", `Oczekiwano '{' przed właściwościami ${owner}`);
    const properties: PropertyNode[] = [];
    while (!this.check("RBRACE") && !this.check("EOF")) {
      properties.push(this.parseProperty());
      this.match("COMMA");
    }
    this.expect("RBRACE", `Oczekiwano '}' zamykającego właściwości ${owner}`);
    return properties;
  }

  private parseProperty(): PropertyNode {
    const name = this.parseIdentifier("Oczekiwano nazwy właściwości");
    this.expect("COLON", `Oczekiwano ':' po właściwości '${name.name}'`);
    const value = this.parsePropertyValue();
    return { kind: "Property", name, value, span: mergeSpan(name.span, value.span) };
  }

  private parsePropertyValue(): PropertyValueNode {
    if (this.match("NUMBER")) {
      const token = this.previous();
      return this.scalar(token, token.value as number);
    }
    if (this.match("STRING")) {
      const token = this.previous();
      return this.scalar(token, token.value as string);
    }
    if (this.check("IDENTIFIER")) {
      const token = this.advance();
      if (token.lexeme === "obsidian" && this.check("LPAREN")) {
        return this.parseObsidianSource(token);
      }
      if (this.check("LPAREN")) {
        this.fail("NEUROSA-P105", `Nieznana funkcja źródłowa '${token.lexeme}'`, token);
      }
      const value =
        token.lexeme === "true" ? true : token.lexeme === "false" ? false : token.lexeme;
      return this.scalar(token, value);
    }
    this.fail("NEUROSA-P104", 'Oczekiwano wartości skalarnej albo obsidian("ścieżka")');
  }

  private parseObsidianSource(callee: Token): ObsidianSourceNode {
    this.expect("LPAREN", "Oczekiwano '(' po obsidian");
    const path = this.expect("STRING", "Oczekiwano ścieżki w cudzysłowie wewnątrz obsidian()");
    this.expect("RPAREN", "Oczekiwano ')' po ścieżce Obsidian");
    return {
      kind: "ObsidianSource",
      path: path.value as string,
      span: mergeSpan(callee.span, this.previous().span),
    };
  }

  private scalar(token: Token, value: ScalarLiteralNode["value"]): ScalarLiteralNode {
    return { kind: "ScalarLiteral", value, raw: token.lexeme, span: token.span };
  }

  private parseIdentifier(message: string): IdentifierNode {
    const token = this.expect("IDENTIFIER", message);
    return { kind: "Identifier", name: token.lexeme, span: token.span };
  }

  private expectKeyword(keyword: string): Token {
    if (!this.checkKeyword(keyword)) {
      this.fail("NEUROSA-P101", `Oczekiwano '${keyword}'`);
    }
    return this.advance();
  }

  private checkKeyword(keyword: string): boolean {
    return this.check("IDENTIFIER") && this.peek().lexeme === keyword;
  }

  private expect(kind: TokenKind, message: string): Token {
    if (!this.check(kind)) this.fail("NEUROSA-P100", message);
    return this.advance();
  }

  private match(kind: TokenKind): boolean {
    if (!this.check(kind)) return false;
    this.advance();
    return true;
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private advance(): Token {
    const token = this.peek();
    if (token.kind !== "EOF") this.current += 1;
    return token;
  }

  private peek(): Token {
    const token = this.tokens[this.current];
    if (token === undefined) {
      throw new Error("Naruszono niezmiennik parsera: strumień tokenów nie zawiera EOF");
    }
    return token;
  }

  private previous(): Token {
    const token = this.tokens[Math.max(0, this.current - 1)];
    if (token === undefined)
      throw new Error("Naruszono niezmiennik parsera: brak poprzedniego tokenu");
    return token;
  }

  private fail(code: string, message: string, token = this.peek()): never {
    const diagnostic: Diagnostic = { code, message, severity: "error", span: token.span };
    throw new NeurosaDiagnosticError([diagnostic]);
  }
}

export function parse(source: string, file = "<memory>"): ProgramNode {
  const result = lex(source, file);
  if (result.diagnostics.length > 0) throw new NeurosaDiagnosticError(result.diagnostics);
  return new Parser(result.tokens).parseProgram();
}

export { NeurosaDiagnosticError } from "@neurosa/ast";
