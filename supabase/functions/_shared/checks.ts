// Verificações determinísticas da personalização.
// Rodam antes da IA: limites e conjunto de caracteres são regras duras que o
// modelo recebe como contexto e nunca pode sobrescrever.

export type Charset = "engraving" | "print" | "embroidery";

export interface ProductRule {
  max_chars: number;
  charset: Charset;
}

export type Violation =
  | "empty"
  | "over_limit"
  | "emoji"
  | "unsupported_chars"
  | "whitespace";

export interface FieldCheck {
  name: string;
  value: string;
  length: number;
  max_chars: number | null;
  violations: Violation[];
  unsupported: string[];
}

export interface ChecksResult {
  passed: boolean;
  has_rule: boolean;
  fields: FieldCheck[];
}

const EMOJI = /\p{Extended_Pictographic}/u;
// Componentes invisíveis que acompanham emojis (seletor de variação, ZWJ,
// tons de pele, tags) fazem parte do emoji, não são "caracteres não suportados".
const EMOJI_PART = /[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\u{E0020}-\u{E007F}]/u;

// Letras (inclui acentuadas), dígitos e espaço + pontuação permitida por técnica.
const ALLOWED: Record<Charset, RegExp> = {
  engraving: /^[\p{L}\p{N} .,'&\-!?:/()#+]$/u,
  embroidery: /^[\p{L}\p{N} .'&\-!]$/u,
  print: /^[^\p{Cc}\p{Cs}]$/u, // impressão aceita quase tudo, exceto controle
};

export function checkPersonalisation(
  fields: Record<string, string>,
  rule: ProductRule | null,
): ChecksResult {
  const results: FieldCheck[] = Object.entries(fields).map(([name, raw]) => {
    const value = raw ?? "";
    const chars = Array.from(value); // conta code points, não unidades UTF-16
    const violations: Violation[] = [];
    const unsupported = new Set<string>();

    if (value.trim().length === 0) violations.push("empty");
    if (rule && chars.length > rule.max_chars) violations.push("over_limit");
    if (EMOJI.test(value)) violations.push("emoji");
    if (/^\s|\s$|\s{2,}/.test(value)) violations.push("whitespace");

    if (rule) {
      for (const ch of chars) {
        if (EMOJI_PART.test(ch) || !ALLOWED[rule.charset].test(ch)) unsupported.add(ch);
      }
      // emoji já é reportado separadamente; só marca unsupported se houver outros
      const nonEmoji = [...unsupported].filter((c) => !EMOJI_PART.test(c));
      if (nonEmoji.length > 0) violations.push("unsupported_chars");
    }

    return {
      name,
      value,
      length: chars.length,
      max_chars: rule?.max_chars ?? null,
      violations,
      unsupported: [...unsupported],
    };
  });

  return {
    passed: results.every((f) => f.violations.length === 0),
    has_rule: rule !== null,
    fields: results,
  };
}
