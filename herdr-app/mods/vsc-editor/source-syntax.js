// Preview grammars run locally for both local and SSH files; no external tools.
import Prism from "./vendor/prism.js";

const NIX = { id: "nix", name: "Nix" };
const RTL = { id: "verilog", name: "Verilog / SystemVerilog" };
const AMS = { id: "verilog-ams", name: "Verilog-A / AMS" };
const VHDL = { id: "vhdl", name: "VHDL" };
const SPICE = { id: "spice", name: "SPICE / CDL" };
const SPECTRE = { id: "spectre", name: "Spectre" };
const LANGUAGES = {
  nix: NIX, v: RTL, vh: RTL, sv: RTL, svh: RTL, verilog: RTL,
  va: AMS, vams: AMS, vhd: VHDL, vhdl: VHDL,
  sp: SPICE, spi: SPICE, spice: SPICE, cir: SPICE, ckt: SPICE, cdl: SPICE,
  spf: SPICE, dspf: SPICE, net: SPICE, netlist: SPICE, scs: SPECTRE, spectre: SPECTRE,
};

export function sourceLanguage(path) {
  const name = path.split("/").pop();
  const extension = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(LANGUAGES, extension) ? LANGUAGES[extension] : null;
}

// Add signed based values, unsized unbased values, and time literals to Prism's RTL grammar.
Prism.languages.verilog.number = /(?:\b\d[\d_]*)?'s?[bodh]\s*[\da-fxz_?]+|'[01xz]\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d[\d_]*)?(?:[munpf]?s)?\b/i;
Prism.languages["verilog-ams"] = Prism.languages.extend("verilog", {
  keyword: [ /\b(?:abstol|access|ac_stim|analog|analysis|branch|connectmodule|connectrules|continuous|ddt|ddt_nature|discipline|discrete|electrical|endconnectrules|enddiscipline|endnature|exclude|flow|from|idt|idt_nature|inf|laplace_nd|laplace_np|laplace_zd|laplace_zp|last_crossing|nature|potential|slew|timer|transition|units|white_noise|flicker_noise|zi_nd|zi_np|zi_zd|zi_zp)\b/, Prism.languages.verilog.keyword ],
  number: [ /(?:\b\d+(?:\.\d*)?|\B\.\d+)(?:e[+-]?\d+)?[TGMKkmunpfa]\b/, Prism.languages.verilog.number ],
});

// These are circuit netlists, rather than the unrelated Spice programming language.
Prism.languages.spice = {
  comment: [
    { pattern: /(^[\t ]*)\*[^\r\n]*/m, lookbehind: true, greedy: true },
    { pattern: /(^|\s)\$[^\r\n]*/m, lookbehind: true, greedy: true },
    { pattern: /;[^\r\n]*/, greedy: true },
  ],
  string: { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/, greedy: true },
  keyword: { pattern: /(^[\t ]*)\.[a-z][\w]*/im, lookbehind: true, greedy: true },
  function: { pattern: /(^[\t ]*)[a-z][\w.!:$\[\]/-]*/im, lookbehind: true, greedy: true },
  variable: /\b[a-z_]\w*(?=\s*=)/i,
  number: /(?:\b\d+(?:\.\d*)?|\B\.\d+)(?:e[+-]?\d+)?(?:meg|mil|[tgkmunpf])?(?:[a-z]+)?\b/i,
  operator: /[+*/^=<>-]/,
  punctuation: /[()[\]{},:]/,
};
Prism.languages.spectre = Prism.languages.extend("spice", {
  comment: { pattern: /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//, greedy: true },
  keyword: /\b(?:ac|ahdl_include|alter|altergroup|assert|check|checklimit|dc|dcmatch|ends|endsection|endlibrary|global|ic|include|info|library|model|montecarlo|nodeset|noise|options|parameters|paramset|save|saveOptions|section|simulator|statistics|subckt|sweep|tran|vary)\b/,
});

const KINDS = {
  comment: "comment", string: "string", url: "string", char: "string", number: "number",
  keyword: "keyword", important: "keyword", boolean: "boolean", constant: "constant",
  function: "function", property: "function", variable: "variable", "attr-name": "variable",
  operator: "operator", punctuation: "punctuation", interpolation: "text",
};

// Keep the source lossless, including tabs, CRLF and the final newline. A preview
// expands tabs only while painting; Edit and Copy always use the original text.
export function highlightSource(text, language) {
  const grammar = Prism.languages[language];
  if (!grammar) throw new Error(`No preview grammar registered for ${language}`);
  const rows = [[]];
  function append(value, kind) {
    const lines = value.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i) rows.push([]);
      if (!lines[i]) continue;
      const row = rows[rows.length - 1], previous = row[row.length - 1];
      if (previous?.kind === kind) previous.text += lines[i];
      else row.push({ text: lines[i], kind });
    }
  }
  function visit(token, inherited = "text") {
    if (typeof token === "string") { append(token, inherited); return; }
    if (Array.isArray(token)) { for (const child of token) visit(child, inherited); return; }
    const aliases = Array.isArray(token.alias) ? token.alias : [token.alias];
    const kind = KINDS[token.type] ?? aliases.map(alias => KINDS[alias]).find(Boolean) ?? inherited;
    visit(token.content, kind);
  }
  visit(Prism.tokenize(text, grammar));
  return rows;
}

export function displayRow(row) {
  let column = 0;
  return row.map(piece => {
    let text = "";
    for (const char of piece.text.replace(/\r$/, "")) {
      if (char === "\t") { const spaces = 4 - column % 4; text += " ".repeat(spaces); column += spaces; }
      else { text += char; column += char.codePointAt(0) > 255 ? 2 : 1; }
    }
    return { ...piece, text };
  });
}
