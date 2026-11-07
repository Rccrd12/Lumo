// TeX math in the chat's answers ($…$, $$…$$, \(…\), \[…\]), drawn as
// MathML with no library: the notation answers use — Greek letters, operators and
// arrows, sub- and superscripts, \frac, \sqrt, \vec (and \vect, \vv) and
// other accents, \mathbb and friends, \text, \left…\right with brackets as
// tall as what they hold, matrices, array, cases and aligned rows, sums with
// their limits above and below, and the physics package's \dd, \dv, \pdv,
// \abs, \norm and bra-kets. A command it does not know shows what it is
// given, or else its name, never raw markup.
//
// Built with textContent only, like the rest of the Markdown (markdown.ts);
// the WebView lays the MathML out with the math font (styles in style.css).

import { h } from "./dom";

const SYMBOLS: Record<string, string> = {
  // Greek
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ",
  varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
  Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // Operators and relations
  cdot: "⋅", times: "×", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘", bullet: "•",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼", simeq: "≃",
  cong: "≅", equiv: "≡", propto: "∝", ll: "≪", gg: "≫", prec: "≺", succ: "≻",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇",
  cup: "∪", cap: "∩", setminus: "∖", emptyset: "∅", varnothing: "∅", forall: "∀", exists: "∃",
  nexists: "∄", neg: "¬", lnot: "¬", land: "∧", wedge: "∧", lor: "∨", vee: "∨", oplus: "⊕",
  otimes: "⊗", odot: "⊙", ominus: "⊖", perp: "⊥", leqslant: "⩽", geqslant: "⩾", lesssim: "≲",
  gtrsim: "≳", nleq: "≰", ngeq: "≱", triangleq: "≜", doteq: "≐", coloneqq: "≔", asymp: "≍",
  models: "⊨", vdash: "⊢", dashv: "⊣", therefore: "∴", because: "∵", subsetneq: "⊊", supsetneq: "⊋",
  nsubseteq: "⊈", sqsubseteq: "⊑", sqcup: "⊔", sqcap: "⊓", uplus: "⊎", owns: "∋", complement: "∁",
  bigcup: "⋃", bigcap: "⋂", bigoplus: "⨁", bigotimes: "⨂", bigodot: "⨀", biguplus: "⨄", bigsqcup: "⨆",
  bigvee: "⋁", bigwedge: "⋀", diamond: "⋄", lozenge: "◊", blacksquare: "■", Box: "□", wp: "℘",
  imath: "ı", jmath: "ȷ", varkappa: "ϰ", digamma: "ϝ", colon: ":", cdotp: "·", ldotp: ".",
  backslash: "∖", lvert: "|", rvert: "|", lVert: "‖", rVert: "‖", lbrack: "[", rbrack: "]",
  sharp: "♯", flat: "♭", natural: "♮", bowtie: "⋈", amalg: "⨿", wr: "≀", oslash: "⊘", parallel: "∥", mid: "∣", nmid: "∤", top: "⊤", bot: "⊥",
  // Calculus and the rest
  infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬",
  iiint: "∭", oint: "∮", sqrt: "√", ell: "ℓ", hbar: "ℏ", Re: "ℜ", Im: "ℑ", aleph: "ℵ", angle: "∠",
  degree: "°", prime: "′", dagger: "†", triangle: "△", square: "□", checkmark: "✓",
  // Arrows
  to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔", Rightarrow: "⇒",
  Leftarrow: "⇐", Leftrightarrow: "⇔", implies: "⟹", impliedby: "⟸", iff: "⟺", mapsto: "↦",
  longrightarrow: "⟶", longleftarrow: "⟵", uparrow: "↑", downarrow: "↓", nearrow: "↗", searrow: "↘",
  hookrightarrow: "↪", rightharpoonup: "⇀", Longrightarrow: "⟹", Longleftarrow: "⟸",
  Longleftrightarrow: "⟺", longleftrightarrow: "⟷", longmapsto: "⟼", Uparrow: "⇑", Downarrow: "⇓",
  updownarrow: "↕", nwarrow: "↖", swarrow: "↙", leadsto: "⇝", rightleftharpoons: "⇌",
  leftharpoonup: "↼", hookleftarrow: "↩", rightrightarrows: "⇉", circlearrowright: "↻",
  // Dots, brackets, spaces
  dots: "…", ldots: "…", dotsc: "…", dotsb: "⋯", dotsm: "⋯", dotsi: "⋯", dotso: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", langle: "⟨", rangle: "⟩",
  lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", lbrace: "{", rbrace: "}", vert: "|", Vert: "‖",
  "|": "‖", "{": "{", "}": "}", "%": "%", "$": "$", "&": "&", "#": "#", _: "_",
  quad: " ", qquad: "  ", ",": " ", ":": " ", ";": " ", "!": "", " ": " ",
  enspace: " ", thinspace: " ", medspace: " ", thickspace: " ", ">": " ", negthinspace: "",
  // The number sets that notes define as macros of their own: \R, \N…
  R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ",
  // More Greek: the capitals that look Latin, the slanted capitals, Hebrew.
  Alpha: "A", Beta: "B", Epsilon: "E", Zeta: "Z", Eta: "H", Iota: "I", Kappa: "K", Mu: "M", Nu: "N",
  Omicron: "O", omicron: "ο", Rho: "P", Tau: "T", Chi: "X", varGamma: "𝛤", varDelta: "𝛥",
  varTheta: "𝛩", varLambda: "𝛬", varXi: "𝛯", varPi: "𝛱", varSigma: "𝛴", varUpsilon: "𝛶",
  varPhi: "𝛷", varPsi: "𝛹", varOmega: "𝛺", beth: "ℶ", gimel: "ℷ", daleth: "ℸ",
  // Letter-like symbols
  hslash: "ℏ", eth: "ð", mho: "℧", Finv: "Ⅎ", Game: "⅁", Bbbk: "𝕜", backprime: "‵",
  // Operations
  ddagger: "‡", ddag: "‡", dag: "†", Dagger: "‡", centerdot: "⋅", bigcirc: "◯", bigtriangleup: "△",
  bigtriangledown: "▽", triangleleft: "◃", triangleright: "▹", lhd: "⊲", rhd: "⊳", unlhd: "⊴",
  unrhd: "⊵", boxplus: "⊞", boxminus: "⊟", boxtimes: "⊠", boxdot: "⊡", circledast: "⊛",
  circledcirc: "⊚", circleddash: "⊝", curlyvee: "⋎", curlywedge: "⋏", divideontimes: "⋇",
  dotplus: "∔", doublebarwedge: "⩞", intercal: "⊺", leftthreetimes: "⋋", rightthreetimes: "⋌",
  ltimes: "⋉", rtimes: "⋊", smallsetminus: "∖", veebar: "⊻", barwedge: "⊼", Cap: "⋒", Cup: "⋓",
  minus: "−", bigsqcap: "⨅", gt: ">", lt: "<",
  // Relations, and their negations
  approxeq: "≊", backsim: "∽", backsimeq: "⋍", bumpeq: "≏", Bumpeq: "≎", circeq: "≗",
  curlyeqprec: "⋞", curlyeqsucc: "⋟", doteqdot: "≑", Doteq: "≑", eqcirc: "≖", eqsim: "≂",
  eqslantgtr: "⪖", eqslantless: "⪕", fallingdotseq: "≒", risingdotseq: "≓", geqq: "≧", leqq: "≦",
  ggg: "⋙", gggtr: "⋙", lll: "⋘", llless: "⋘", gnapprox: "⪊", gneq: "⪈", gneqq: "≩", gnsim: "⋧",
  gtrapprox: "⪆", gtrdot: "⋗", gtreqless: "⋛", gtreqqless: "⪌", gtrless: "≷", lessapprox: "⪅",
  lessdot: "⋖", lesseqgtr: "⋚", lesseqqgtr: "⪋", lessgtr: "≶", lnapprox: "⪉", lneq: "⪇",
  lneqq: "≨", lnsim: "⋦", ncong: "≇", ngtr: "≯", nless: "≮", nprec: "⊀", nsucc: "⊁",
  npreceq: "⋠", nsucceq: "⋡", nsim: "≁", nparallel: "∦", nshortmid: "∤", nshortparallel: "∦",
  nsupseteq: "⊉", nsubset: "⊄", nsupset: "⊅", ntriangleleft: "⋪", ntriangleright: "⋫",
  ntrianglelefteq: "⋬", ntrianglerighteq: "⋭", nvdash: "⊬", nvDash: "⊭", nVdash: "⊮", nVDash: "⊯",
  precapprox: "⪷", preccurlyeq: "≼", preceq: "⪯", precsim: "≾", precnsim: "⋨", precneqq: "⪵",
  succapprox: "⪸", succcurlyeq: "≽", succeq: "⪰", succsim: "≿", succnsim: "⋩", succneqq: "⪶",
  sqsubset: "⊏", sqsupset: "⊐", sqsupseteq: "⊒", Subset: "⋐", Supset: "⋑", subseteqq: "⫅",
  supseteqq: "⫆", subsetneqq: "⫋", supsetneqq: "⫌", thicksim: "∼", thickapprox: "≈",
  trianglelefteq: "⊴", trianglerighteq: "⊵", vartriangle: "△", vartriangleleft: "⊲",
  vartriangleright: "⊳", vDash: "⊨", Vdash: "⊩", Vvdash: "⊪", smile: "⌣", frown: "⌢",
  between: "≬", pitchfork: "⋔", shortmid: "∣", shortparallel: "∥", varpropto: "∝",
  backepsilon: "϶", notni: "∌", nni: "∌", multimap: "⊸", eqqcolon: "≕", coloneq: "≔",
  Coloneqq: "⩴", eqcolon: "≕", lesseqslant: "⩽", nleqslant: "⪇", ngeqslant: "⪈", nleqq: "≰",
  ngeqq: "≱", gtreqslant: "⪖", nmodels: "⊭", sqsubsetneq: "⋤",
  // Arrows
  Lleftarrow: "⇚", Rrightarrow: "⇛", Lsh: "↰", Rsh: "↱", curvearrowleft: "↶",
  curvearrowright: "↷", circlearrowleft: "↺", downdownarrows: "⇊", upuparrows: "⇈",
  leftleftarrows: "⇇", leftrightarrows: "⇆", rightleftarrows: "⇄", leftrightharpoons: "⇋",
  leftrightsquigarrow: "↭", rightsquigarrow: "⇝", looparrowleft: "↫", looparrowright: "↬",
  twoheadleftarrow: "↞", twoheadrightarrow: "↠", leftarrowtail: "↢", rightarrowtail: "↣",
  downharpoonleft: "⇃", downharpoonright: "⇂", upharpoonleft: "↿", upharpoonright: "↾",
  restriction: "↾", leftharpoondown: "↽", rightharpoondown: "⇁", nleftarrow: "↚",
  nrightarrow: "↛", nLeftarrow: "⇍", nRightarrow: "⇏", nleftrightarrow: "↮", nLeftrightarrow: "⇎",
  Updownarrow: "⇕", dashrightarrow: "⇢", dashleftarrow: "⇠", mapsfrom: "↤", Longmapsto: "⟾",
  longmapsfrom: "⟻", righttoleftarrow: "⇄",
  // Big operators and integrals
  iiiint: "⨌", oiint: "∯", oiiint: "∰", intop: "∫", smallint: "∫", bigplus: "⨁",
  // Brackets
  llbracket: "⟦", rrbracket: "⟧", lgroup: "⟮", rgroup: "⟯", ulcorner: "⌜", urcorner: "⌝",
  llcorner: "⌞", lrcorner: "⌟", lmoustache: "⎰", rmoustache: "⎱", lparen: "(", rparen: ")",
  // Shapes, suits and the rest
  measuredangle: "∡", sphericalangle: "∢", bigstar: "★", blacklozenge: "⧫", blacktriangle: "▲",
  blacktriangledown: "▼", blacktriangleleft: "◀", blacktriangleright: "▶", triangledown: "▿",
  clubsuit: "♣", diamondsuit: "♢", heartsuit: "♡", spadesuit: "♠", varclubsuit: "♧",
  vardiamondsuit: "♦", varheartsuit: "♥", varspadesuit: "♤", Diamond: "◊", maltese: "✠",
  surd: "√", copyright: "©", textcopyright: "©", pounds: "£", yen: "¥", euro: "€", S: "§",
  P: "¶", textdegree: "°", circledR: "®", circledS: "Ⓢ", hdots: "…", iddots: "⋰", adots: "⋰",
  And: "&", infin: "∞", diameter: "⌀", Diamondblack: "◆",
  textasciitilde: "~", textbackslash: "\\", textbar: "|", textendash: "–", textemdash: "—",
};

/** Functions set upright: \sin x, \lim, \max… */
const FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "log", "ln", "lg", "exp", "lim", "liminf", "limsup", "max", "min", "sup", "inf", "det", "dim",
  "ker", "deg", "gcd", "arg", "Pr", "mod", "rank", "tr", "sgn", "hom", "lcm", "Tr", "diag",
  "argmax", "argmin", "span", "Var", "Cov", "erf", "csch", "sech", "coth", "arccot",
  "arcsec", "arccsc", "sh", "ch", "th", "tg", "ctg", "cth", "arctg", "arcctg", "injlim", "projlim",
  "codim", "id", "sign", "ord", "lub", "glb", "Ker", "Im", "End", "Aut", "Hom", "supp", "dom",
  "cod", "card", "rk", "Res", "vol", "corr", "plim", "esssup", "essinf", "adj", "proj",
]);

/** The accents' marks, drawn over the letter; the wide ones stretch to what they cover. */
const ACCENTS: Record<string, string> = {
  vec: "→", hat: "ˆ", tilde: "˜", dot: "˙", ddot: "¨", dddot: "⋯", acute: "´", grave: "`",
  check: "ˇ", breve: "˘", bar: "¯", mathring: "˚",
};
const WIDE_ACCENTS: Record<string, string> = {
  widehat: "\u0302", widetilde: "˜", widecheck: "ˇ", overrightarrow: "→", overleftarrow: "←",
  overleftrightarrow: "↔", Overrightarrow: "⇒", overgroup: "⏠", overlinesegment: "↔",
};
const UNDER_ACCENTS: Record<string, string> = {
  underrightarrow: "→", underleftarrow: "←", underleftrightarrow: "↔", undergroup: "⏡", utilde: "˜",
};

/** \mathbb letters (double-struck). */
const DOUBLE: Record<string, string> = {
  C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ",
};

function doubleStruck(c: string): string {
  if (DOUBLE[c]) return DOUBLE[c];
  if (/[A-Z]/.test(c)) return String.fromCodePoint(0x1d538 + c.charCodeAt(0) - 65);
  if (/[a-z]/.test(c)) return String.fromCodePoint(0x1d552 + c.charCodeAt(0) - 97);
  if (/[0-9]/.test(c)) return String.fromCodePoint(0x1d7d8 + c.charCodeAt(0) - 48);
  return c;
}

function script(c: string): string {
  const special: Record<string, string> = { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ" };
  if (special[c]) return special[c];
  if (/[A-Z]/.test(c)) return String.fromCodePoint(0x1d49c + c.charCodeAt(0) - 65);
  return c;
}

function fraktur(c: string): string {
  const special: Record<string, string> = { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" };
  if (special[c]) return special[c];
  if (/[A-Z]/.test(c)) return String.fromCodePoint(0x1d504 + c.charCodeAt(0) - 65);
  if (/[a-z]/.test(c)) return String.fromCodePoint(0x1d51e + c.charCodeAt(0) - 97);
  return c;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

type Node =
  | { t: "sym"; v: string; upright?: boolean }
  | { t: "group"; c: Node[] }
  | { t: "sup"; base: Node | null; sup: Node | null; sub: Node | null }
  | { t: "frac"; num: Node; den: Node; size?: "display" | "text"; line?: boolean }
  | { t: "sqrt"; body: Node; index: Node | null }
  | { t: "accent"; mark: string; body: Node; stretchy?: boolean; under?: boolean }
  | { t: "over"; body: Node; under?: boolean }
  | { t: "style"; style: "bold" | "boldit" | "italic" | "upright" | "text" | "display" | "textstyle"; body: Node }
  | { t: "cancel"; kind: "cancel" | "bcancel" | "xcancel" | "sout"; body: Node }
  | { t: "matrix"; rows: Node[][]; open: string; close: string; align: string[]; kind: "matrix" | "aligned" | "cases"; small?: boolean }
  | { t: "fence"; open: string; body: Node[]; close: string }
  | { t: "delim"; v: string }
  | { t: "big"; v: string; scale: number }
  | { t: "stack"; top: Node | null; body: Node; bottom: Node | null }
  | { t: "box"; body: Node }
  | { t: "op"; name: string };

/** What \left, \right, \middle and \big take: one character or one command. */
const DELIMS: Record<string, string> = {
  "(": "(", ")": ")", "[": "[", "]": "]", "|": "|", "/": "/", "<": "⟨", ">": "⟩",
  "\\{": "{", "\\}": "}", "\\|": "‖", "\\lbrace": "{", "\\rbrace": "}", "\\langle": "⟨", "\\rangle": "⟩",
  "\\vert": "|", "\\Vert": "‖", "\\lvert": "|", "\\rvert": "|", "\\lVert": "‖", "\\rVert": "‖",
  "\\lfloor": "⌊", "\\rfloor": "⌋", "\\lceil": "⌈", "\\rceil": "⌉", "\\lbrack": "[", "\\rbrack": "]",
  "\\backslash": "∖", "\\uparrow": "↑", "\\downarrow": "↓", "\\.": "", ".": "",
};

const BIG_SIZES: Record<string, number> = {
  big: 1.2, bigl: 1.2, bigr: 1.2, bigm: 1.2, Big: 1.6, Bigl: 1.6, Bigr: 1.6, Bigm: 1.6,
  bigg: 2, biggl: 2, biggr: 2, biggm: 2, Bigg: 2.4, Biggl: 2.4, Biggr: 2.4, Biggm: 2.4,
};

/** The environments: their brackets, how their columns line up, and their spacing. */
const ENVIRONMENTS: Record<string, { open: string; close: string; kind: "matrix" | "aligned" | "cases"; align?: string }> = {
  matrix: { open: "", close: "", kind: "matrix" },
  smallmatrix: { open: "", close: "", kind: "matrix" },
  array: { open: "", close: "", kind: "matrix" },
  subarray: { open: "", close: "", kind: "matrix" },
  pmatrix: { open: "(", close: ")", kind: "matrix" },
  bmatrix: { open: "[", close: "]", kind: "matrix" },
  Bmatrix: { open: "{", close: "}", kind: "matrix" },
  vmatrix: { open: "|", close: "|", kind: "matrix" },
  Vmatrix: { open: "‖", close: "‖", kind: "matrix" },
  cases: { open: "{", close: "", kind: "cases", align: "l" },
  dcases: { open: "{", close: "", kind: "cases", align: "l" },
  rcases: { open: "", close: "}", kind: "cases", align: "l" },
  aligned: { open: "", close: "", kind: "aligned", align: "rl" },
  align: { open: "", close: "", kind: "aligned", align: "rl" },
  alignat: { open: "", close: "", kind: "aligned", align: "rl" },
  alignedat: { open: "", close: "", kind: "aligned", align: "rl" },
  flalign: { open: "", close: "", kind: "aligned", align: "rl" },
  eqnarray: { open: "", close: "", kind: "aligned", align: "rcl" },
  split: { open: "", close: "", kind: "aligned", align: "rl" },
  gather: { open: "", close: "", kind: "aligned", align: "c" },
  gathered: { open: "", close: "", kind: "aligned", align: "c" },
  equation: { open: "", close: "", kind: "aligned", align: "c" },
  multline: { open: "", close: "", kind: "aligned", align: "c" },
};

/** Sums, products, limits…: in a formula on a line of its own, their scripts go above and below. */
const BIG_OPERATORS = new Set(["∑", "∏", "∐", "⋃", "⋂", "⨁", "⨂", "⨀", "⨄", "⨆", "⨅", "⋁", "⋀"]);
const LIMIT_FUNCTIONS = new Set(["lim", "liminf", "limsup", "max", "min", "sup", "inf", "argmax", "argmin", "injlim", "projlim", "det", "gcd", "Pr", "plim", "esssup", "essinf"]);

/** Where `\end{env}` closes the `\begin` whose body starts at `from`, nested ones skipped. */
function environmentEnd(s: string, from: number): { start: number; end: number } | null {
  const re = /\\(begin|end)\s*\{[^}]*\}/g;
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    depth += m[1] === "begin" ? 1 : -1;
    if (depth === 0) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/**
 * The body of an environment cut at its row breaks (`\\`) or its column marks
 * (`&`), but only those of this level: not inside braces nor a nested
 * environment, and never `\&`.
 */
function splitTop(body: string, at: "row" | "cell"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "\\") {
      if (body.startsWith("\\begin", i)) depth++;
      else if (body.startsWith("\\end", i)) depth--;
      if (body[i + 1] === "\\" && at === "row" && depth === 0) {
        parts.push(body.slice(from, i));
        i += 2;
        // \\[4pt]: the spacing is not drawn.
        const space = /^\s*\[[^\]]*\]/.exec(body.slice(i));
        if (space) i += space[0].length;
        from = i;
        i--;
        continue;
      }
      i++; // \& and \\ are not marks of this level
    } else if (c === "&" && at === "cell" && depth === 0) {
      parts.push(body.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(body.slice(from));
  return parts;
}

class Parser {
  private i = 0;
  private s: string;
  /** How many \left are open: only then does \right end what is being read. */
  private fences = 0;
  constructor(s: string) {
    this.s = s;
  }

  parse(): Node[] {
    const out: Node[] = [];
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "}") break;
      if (/\s/.test(c)) {
        this.i++;
        continue;
      }
      if (this.fences > 0 && /^\\right(?![A-Za-z])/.test(this.s.slice(this.i, this.i + 7))) break;
      if (c === "^" || c === "_") {
        this.i++;
        const arg = this.atom();
        const last = out.pop() ?? null;
        const node = last && last.t === "sup" && (c === "^" ? !last.sup : !last.sub) ? last : { t: "sup" as const, base: last, sup: null, sub: null };
        if (c === "^") node.sup = arg;
        else node.sub = arg;
        out.push(node);
        continue;
      }
      const atom = this.atom();
      if (atom) out.push(atom);
    }
    return out;
  }

  /** The whole formula: a "}" with no "{" is skipped, not the end of it. */
  parseAll(): Node[] {
    const out = this.parse();
    while (this.i < this.s.length) {
      this.i++;
      out.push(...this.parse());
    }
    return out;
  }

  private group(): Node {
    // At "{": up to its "}".
    this.i++;
    const fences = this.fences;
    this.fences = 0;
    const c = this.parse();
    this.fences = fences;
    if (this.s[this.i] === "}") this.i++;
    return { t: "group", c };
  }

  /** One argument: a group, a command, or one character. */
  private atom(): Node | null {
    const s = this.s;
    while (/\s/.test(s[this.i] ?? "")) this.i++;
    if (this.i >= s.length) return null;
    const c = s[this.i];
    if (c === "{") return this.group();
    if (c === "\\") return this.command();
    if (c === "'") {
      this.i++;
      return { t: "sym", v: "′", upright: true };
    }
    this.i++;
    if (c === "~") return { t: "sym", v: " ", upright: true };
    if (c === "&") return null;
    // The hyphen of the source is a minus sign in a formula.
    if (c === "-") return { t: "sym", v: "−", upright: true };
    return { t: "sym", v: c, upright: !/[A-Za-z]/.test(c) };
  }

  private name(): string {
    const s = this.s;
    this.i++; // the backslash
    const m = /^[A-Za-z]+/.exec(s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      // \operatorname*{argmax}: the star changes nothing drawn.
      if (s[this.i] === "*") this.i++;
      return m[0];
    }
    return s[this.i++] ?? "";
  }

  /** A delimiter after \left, \right, \middle or \big: "(" or "\langle", "." for none. */
  private delimiter(): string {
    while (/\s/.test(this.s[this.i] ?? "")) this.i++;
    const s = this.s;
    if (s[this.i] === "\\") {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(this.i));
      if (!m) return "";
      this.i += m[0].length;
      return DELIMS[m[0]] ?? SYMBOLS[m[1]] ?? "";
    }
    const c = s[this.i++] ?? "";
    return DELIMS[c] ?? c;
  }

  /** A braced argument read as words, unparsed: \color{red}, \hspace{1em}… */
  private raw(): string {
    while (/\s/.test(this.s[this.i] ?? "")) this.i++;
    if (this.s[this.i] !== "{") return "";
    let depth = 0;
    const start = this.i + 1;
    for (; this.i < this.s.length; this.i++) {
      if (this.s[this.i] === "{") depth++;
      else if (this.s[this.i] === "}" && --depth === 0) break;
    }
    const words = this.s.slice(start, this.i);
    this.i++;
    return words;
  }

  private command(): Node | null {
    const name = this.name();
    const arg = () => this.atom() ?? { t: "group" as const, c: [] };
    switch (name) {
      case "frac": case "cfrac":
        return { t: "frac", num: arg(), den: arg() };
      case "dfrac": case "tfrac":
        return { t: "frac", num: arg(), den: arg(), size: name === "dfrac" ? "display" : "text" };
      case "binom": case "dbinom": case "tbinom": {
        const top = arg();
        const bottom = arg();
        const size = name === "dbinom" ? "display" : name === "tbinom" ? "text" : undefined;
        return { t: "fence", open: "(", body: [{ t: "frac", num: top, den: bottom, line: false, size }], close: ")" };
      }
      case "pmod": return { t: "group", c: [{ t: "sym", v: "\u2003", upright: true }, this.fenced("(", { t: "group", c: [{ t: "op", name: "mod" }, arg()] }, ")")] };
      case "bmod": return { t: "group", c: [{ t: "sym", v: "\u205f", upright: true }, { t: "op", name: "mod" }, { t: "sym", v: "\u205f", upright: true }] };
      case "cancel": case "bcancel": case "xcancel": case "sout": return { t: "cancel", kind: name, body: arg() };
      case "substack": {
        const rows = splitTop(this.raw(), "row").map((r) => [{ t: "group" as const, c: new Parser(r.trim()).parseAll() }]);
        return { t: "matrix", rows, open: "", close: "", align: ["c"], kind: "matrix", small: true };
      }
      case "displaystyle": case "textstyle": {
        // To the end of the group it is in: \displaystyle\int… in the text.
        const body: Node = { t: "group", c: this.parse() };
        return { t: "style", style: name === "displaystyle" ? "display" : "textstyle", body };
      }
      case "sqrt": {
        let index: Node | null = null;
        if (this.s[this.i] === "[") {
          const end = this.s.indexOf("]", this.i);
          if (end > 0) {
            index = { t: "group", c: new Parser(this.s.slice(this.i + 1, end)).parse() };
            this.i = end + 1;
          }
        }
        return { t: "sqrt", body: arg(), index };
      }
      case "overline": return { t: "over", body: arg() };
      case "underline": return { t: "over", body: arg(), under: true };
      // \vect{v} and \vv{v}: the vector macros of many notes and packages.
      case "vect": case "vv": case "Vec": return { t: "accent", mark: ACCENTS.vec, body: arg() };
      case "overbrace": return { t: "stack", top: { t: "sym", v: "⏞", upright: true }, body: arg(), bottom: null };
      case "underbrace": return { t: "stack", top: null, body: arg(), bottom: { t: "sym", v: "⏟", upright: true } };
      case "overset": case "stackrel": {
        const top = arg();
        return { t: "stack", top, body: arg(), bottom: null };
      }
      case "underset": {
        const bottom = arg();
        return { t: "stack", top: null, body: arg(), bottom };
      }
      case "xrightarrow": case "xleftarrow": case "xRightarrow": case "xLeftarrow": case "xleftrightarrow": {
        const below = this.optional();
        const arrows: Record<string, string> = { xrightarrow: "⟶", xleftarrow: "⟵", xRightarrow: "⟹", xLeftarrow: "⟸", xleftrightarrow: "⟷" };
        return { t: "stack", top: arg(), body: { t: "sym", v: arrows[name], upright: true }, bottom: below };
      }
      case "boxed": case "fbox": return { t: "box", body: arg() };
      case "mathbb": case "Bbb": return this.mapped(arg(), doubleStruck);
      case "mathcal": case "mathscr": return this.mapped(arg(), script);
      case "mathfrak": return this.mapped(arg(), fraktur);
      case "mathbf": case "bf": case "vb": case "vectorbold": case "textbf":
        return name === "textbf" ? this.text("bold") : { t: "style", style: "bold", body: arg() };
      case "boldsymbol": case "bm": case "pmb":
        return { t: "style", style: "boldit", body: arg() };
      case "mathit": case "it": return { t: "style", style: "italic", body: arg() };
      case "mathrm": case "operatorname": case "mathsf": case "mathtt": case "rm": case "mathup":
        return { t: "style", style: "upright", body: arg() };
      case "text": case "textrm": case "textit": case "mbox": case "textnormal": case "textsf": case "texttt": case "hbox":
        return this.text("text");
      case "left": {
        const open = this.delimiter();
        this.fences++;
        const body = this.parse();
        this.fences--;
        let close = "";
        if (this.s.startsWith("\\right", this.i)) {
          this.i += "\\right".length;
          close = this.delimiter();
        }
        return { t: "fence", open, body, close };
      }
      case "right": {
        // A \right with no \left: its delimiter, as is.
        const d = this.delimiter();
        return d ? { t: "sym", v: d, upright: true } : null;
      }
      case "middle": return { t: "delim", v: this.delimiter() };
      case "begin": return this.environment();
      case "end": {
        arg();
        return null;
      }
      case "\\": case "newline": case "cr": {
        // A line break outside an environment: the rows are not drawn apart.
        const space = /^\s*\[[^\]]*\]/.exec(this.s.slice(this.i));
        if (space) this.i += space[0].length;
        return null;
      }
      case "scriptstyle": case "scriptscriptstyle": case "limits":
      case "nolimits": case "notag": case "nonumber": case "hline": case "hdashline": case "nobreak":
      case "allowbreak": case "relax": case "strut": case "centering": case "small": case "large":
      case "Large": case "normalsize": case "footnotesize": case "tiny": case "huge": case "Huge":
        return null;
      case "label": case "hspace": case "vspace": case "phantom": case "vphantom": case "hphantom":
      case "kern": case "mkern": case "hskip": case "mskip":
        if (/^\s*\{/.test(this.s.slice(this.i))) this.raw();
        else this.dimension();
        return name === "hspace" || name === "phantom" || name === "hphantom" ? { t: "sym", v: " ", upright: true } : null;
      case "color": this.raw(); return null;
      case "textcolor": case "colorbox": this.raw(); return arg();
      case "tag": return { t: "style", style: "upright", body: { t: "sym", v: `  (${this.raw()})`, upright: true } };
      // The physics package's notation, which answers copy from LaTeX sources:
      // \dd x, \dv{f}{x}, \pdv{f}{x}, \abs{x}, \norm{v}, \vb{F}, bra-kets…
      case "dd": case "differential": {
        const order = this.optional();
        const d: Node = order ? { t: "sup", base: { t: "sym", v: "d", upright: true }, sup: order, sub: null } : { t: "sym", v: "d", upright: true };
        return this.s[this.i] === "{" ? { t: "group", c: [d, arg()] } : d;
      }
      case "dv": case "derivative": return this.derivative("d");
      case "pdv": case "partialderivative": return this.derivative("∂");
      case "abs": case "absolutevalue": return this.fenced("|", arg(), "|");
      case "norm": return this.fenced("‖", arg(), "‖");
      case "ev": case "expval": case "expectationvalue": return this.fenced("⟨", arg(), "⟩");
      case "bra": return this.fenced("⟨", arg(), "|");
      case "ket": return this.fenced("|", arg(), "⟩");
      case "braket": {
        const a = arg();
        const b = this.s[this.i] === "{" ? arg() : a;
        return this.fenced("⟨", { t: "group", c: [a, { t: "sym", v: "|", upright: true }, b] }, "⟩");
      }
      case "vu": case "vectorunit": return { t: "style", style: "bold", body: { t: "accent", mark: ACCENTS.hat, body: arg() } };
      case "grad": case "gradient": return { t: "sym", v: "∇", upright: true };
      case "curl": return { t: "sym", v: "∇×", upright: true };
      case "divergence": return { t: "sym", v: "∇·", upright: true };
      case "order": return { t: "group", c: [{ t: "sym", v: "O", upright: false }, this.fenced("(", arg(), ")")] };
      case "qty": case "quantity":
        // \qty(x), \qty[x]: the brackets that follow are drawn as they are.
        return this.s[this.i] === "{" ? this.fenced("{", arg(), "}") : null;
      case "not": {
        const next = this.atom();
        if (next && next.t === "sym") return { t: "sym", v: `${next.v}̸`, upright: true };
        return next;
      }
    }
    if (name in BIG_SIZES) {
      const v = this.delimiter();
      return v ? { t: "big", v, scale: BIG_SIZES[name] } : null;
    }
    if (ACCENTS[name]) return { t: "accent", mark: ACCENTS[name], body: arg() };
    if (WIDE_ACCENTS[name]) return { t: "accent", mark: WIDE_ACCENTS[name], body: arg(), stretchy: true };
    if (UNDER_ACCENTS[name]) return { t: "accent", mark: UNDER_ACCENTS[name], body: arg(), stretchy: true, under: true };
    if (FUNCTIONS.has(name)) return { t: "op", name };
    if (name in SYMBOLS) return { t: "sym", v: SYMBOLS[name], upright: true };
    // Unknown, as a macro of the answer's own (\vett{v}, \R…): what it is
    // given if it takes something, else its name, upright, rather than the markup.
    while (this.s[this.i] === " ") this.i++;
    if (this.s[this.i] === "{") return arg();
    return { t: "sym", v: name, upright: true };
  }

  /** A TeX length right here (\kern 2pt, \hskip-1mu), skipped. */
  private dimension() {
    const m = /^\s*-?[\d.]+\s*[a-z]{2}/.exec(this.s.slice(this.i));
    if (m) this.i += m[0].length;
  }

  /** `[…]` right here, if there is one: \dd[3]{x}, \dv[2]{f}{x}. */
  private optional(): Node | null {
    if (this.s[this.i] !== "[") return null;
    const end = this.s.indexOf("]", this.i);
    if (end < 0) return null;
    const inside = new Parser(this.s.slice(this.i + 1, end)).parse();
    this.i = end + 1;
    return { t: "group", c: inside };
  }

  /** `open` body `close`, upright. */
  private fenced(open: string, body: Node, close: string): Node {
    return { t: "group", c: [{ t: "sym", v: open, upright: true }, body, { t: "sym", v: close, upright: true }] };
  }

  /** \dv{f}{x} as df/dx, \dv{x} as d/dx, \dv[2]{f}{x} as d²f/dx²; `d` is "d" or "∂". */
  private derivative(d: string): Node {
    const order = this.optional();
    const mark = (): Node => (order ? { t: "sup", base: { t: "sym", v: d, upright: true }, sup: order, sub: null } : { t: "sym", v: d, upright: true });
    const first = this.atom() ?? { t: "group" as const, c: [] };
    while (this.s[this.i] === " ") this.i++;
    if (this.s[this.i] !== "{") {
      // Only the variable: the operator d/dx.
      const by: Node = order ? { t: "sup", base: first, sup: order, sub: null } : first;
      return { t: "frac", num: mark(), den: { t: "group", c: [{ t: "sym", v: d, upright: true }, by] } };
    }
    const by = this.atom() ?? { t: "group" as const, c: [] };
    const den: Node = { t: "group", c: [{ t: "sym", v: d, upright: true }, order ? { t: "sup", base: by, sup: order, sub: null } : by] };
    return { t: "frac", num: { t: "group", c: [mark(), first] }, den };
  }

  /** \text{…}: what is inside, as words; $…$ in it is math again. */
  private text(style: "text" | "bold"): Node {
    while (this.s[this.i] === " ") this.i++;
    if (this.s[this.i] !== "{") return { t: "group", c: [] };
    const words = this.raw();
    const parts: Node[] = words.split(/\$([^$]*)\$/).map((part, k) =>
      k % 2 ? { t: "group", c: new Parser(part).parseAll() } : { t: "sym", v: part.replace(/\\([{}$%&#_ ])/g, "$1"), upright: true },
    );
    const body: Node = parts.length === 1 ? parts[0] : { t: "group", c: parts };
    if (style === "bold") return { t: "style", style: "text", body: { t: "style", style: "bold", body } };
    return { t: "style", style: "text", body };
  }

  private mapped(node: Node, f: (c: string) => string): Node {
    const flat = flatten(node);
    return { t: "sym", v: [...flat].map(f).join(""), upright: true };
  }

  /** \begin{pmatrix} a & b \\ c & d \end{pmatrix}, cases, aligned, array… */
  private environment(): Node | null {
    const env = this.raw().trim();
    const base = env.replace(/\*$/, "");
    const spec = ENVIRONMENTS[base] ?? { open: "", close: "", kind: "matrix" as const };
    // What comes after the name: array's columns {c|c}, alignat's {2}, pmatrix*'s [r].
    let columns = spec.align ?? "";
    if (base === "array" || base === "subarray") columns = this.raw().replace(/[^lcr]/g, "");
    else if (base === "alignat" || base === "alignedat") this.raw();
    else if (env.endsWith("*") && this.s[this.i] === "[") {
      const end = this.s.indexOf("]", this.i);
      if (end > 0) {
        columns = this.s.slice(this.i + 1, end).replace(/[^lcr]/g, "");
        this.i = end + 1;
      }
    }
    const end = environmentEnd(this.s, this.i);
    const body = this.s.slice(this.i, end ? end.start : undefined);
    this.i = end ? end.end : this.s.length;
    const rows = splitTop(body, "row")
      .filter((r, k, all) => r.trim() !== "" || k < all.length - 1)
      .map((r) => splitTop(r, "cell").map((cell) => ({ t: "group" as const, c: new Parser(cell.trim()).parseAll() })));
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const align: string[] = [];
    for (let k = 0; k < cols; k++) {
      if (spec.kind === "aligned" && columns === "rl") align.push(k % 2 ? "l" : "r");
      else align.push(columns[k] ?? columns[columns.length - 1] ?? "c");
    }
    return { t: "matrix", rows, open: spec.open, close: spec.close, align, kind: spec.kind };
  }
}

/** The plain characters of a node, for \mathbb{R} and the like. */
function flatten(node: Node): string {
  switch (node.t) {
    case "sym": return node.v;
    case "group": return node.c.map(flatten).join("");
    case "style": return flatten(node.body);
    default: return "";
  }
}

// ── Drawing ───────────────────────────────────────────────────────────────────
//
// The formula becomes MathML, which the WebView lays out itself with the
// math font's own tables (Cambria Math on Windows): integrals and sums at
// their display size, brackets that stretch, fractions, roots, scripts and
// the room around each operator as TeX sets them.

const MATHML = "http://www.w3.org/1998/Math/MathML";

type Child = Element | string | null;

function m(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): Element {
  const el = document.createElementNS(MATHML, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
}

/** Relations, with room on both sides: a = b, x ∈ A, f → g. */
const RELATIONS = new Set([..."=<>≤≥≠≈∼≃≅≡∝≪≫≺≻∈∉∋⊂⊃⊆⊇⊊⊋⊈⊑→←↔⇒⇐⇔⟹⟸⟺↦⟶⟵⟷⟼⇝⇌∥⊥≜≐≔≍⊨⊢⊣≲≳⩽⩾≰≱"]);
/** Operations between two terms, with a little less: a + b, a × b. A sign in front (−x) keeps none. */
const BINARY = new Set([..."+−×÷±∓·⋅∗⋆∘∪∩∖∧∨⊕⊖⊗⊙⊘⊎⊔⊓"]);
const INTEGRALS = new Set([..."∫∬∭∮∯∰⨌"]);
/** Brackets: as written they keep their size; \left, \right and \big make them taller. */
const BRACKETS = new Set([..."()[]{}|‖⟨⟩⌊⌋⌈⌉⟦⟧⟮⟯⌜⌝⌞⌟⎰⎱"]);
/** Symbols that are things, not operations, though they sit among the operators in Unicode. */
const ORDINARY = new Set([..."∂∇∞∅∠∡∢∟∴∵⊤⊥△▽◊□■★"]);
/** Letters set upright, as TeX does: capital Greek and the letter-like symbols. */
const UPRIGHT_LETTERS = /^[ΓΔΘΛΞΠΣΥΦΨΩ∇ℏℓ℘ℜℑℵℶℷℸð℧Ⅎ⅁]$/u;
/** The widths of the spaces: \, \: \; \quad, \qquad, ~ and \enspace. */
const SPACE_WIDTHS: Record<string, number> = { " ": 0.1667, " ": 0.2222, " ": 0.2778, " ": 0.5, " ": 1, " ": 0.3333 };

/** Whether a character is an operator for MathML: arrows, relations, operations, punctuation. */
function isOperatorChar(c: string): boolean {
  if (ORDINARY.has(c)) return false;
  if (RELATIONS.has(c) || BINARY.has(c) || BRACKETS.has(c) || INTEGRALS.has(c) || BIG_OPERATORS.has(c)) return true;
  if (",;:.!?/′″‴∀∃∄¬&".includes(c)) return true;
  const cp = c.codePointAt(0) ?? 0;
  return (
    (cp >= 0x2190 && cp <= 0x21ff) || // arrows
    (cp >= 0x2200 && cp <= 0x22ff) || // mathematical operators
    (cp >= 0x27f0 && cp <= 0x27ff) || // long arrows
    (cp >= 0x2900 && cp <= 0x297f) || // more arrows
    (cp >= 0x2a00 && cp <= 0x2aff) || // more operators
    (cp >= 0x2308 && cp <= 0x230b) || // floor and ceiling
    (cp >= 0x23de && cp <= 0x23df) // over- and underbrace
  );
}

// ── Letters in a style: \mathbf, \boldsymbol, \mathit ──────────────────────

type LetterStyle = "bold" | "boldit" | "italic" | "upright" | null;
let letterStyle: LetterStyle = null;
/** Inside \text: words, not math. */
let inText = false;

const ITALIC_HOLES: Record<string, string> = { h: "ℎ" };

function styled(c: string, style: LetterStyle): string {
  const upper = /[A-Z]/.test(c);
  const lower = /[a-z]/.test(c);
  const digit = /[0-9]/.test(c);
  const at = (base: number, from: string) => String.fromCodePoint(base + c.charCodeAt(0) - from.charCodeAt(0));
  switch (style) {
    case "bold":
      if (upper) return at(0x1d400, "A");
      if (lower) return at(0x1d41a, "a");
      if (digit) return at(0x1d7ce, "0");
      return c;
    case "boldit":
      if (upper) return at(0x1d468, "A");
      if (lower) return at(0x1d482, "a");
      if (digit) return at(0x1d7ce, "0");
      return c;
    case "italic":
      if (ITALIC_HOLES[c]) return ITALIC_HOLES[c];
      if (upper) return at(0x1d434, "A");
      if (lower) return at(0x1d44e, "a");
      return c;
    default:
      return c;
  }
}

/** One symbol: a number, a letter, an operator, a space or a word. */
function symbol(v: string, upright: boolean | undefined): Element {
  if (inText) return m("mtext", {}, v.replace(/ /g, " "));
  if (v === "") return m("mspace", { width: "-0.1667em" }); // \!
  if (/^\s+$/u.test(v)) {
    const width = [...v].reduce((sum, c) => sum + (SPACE_WIDTHS[c] ?? 0.25), 0);
    return m("mspace", { width: `${width.toFixed(4)}em` });
  }
  const chars = [...v];
  if (/^[0-9]+$/.test(v)) return m("mn", {}, letterStyle ? chars.map((c) => styled(c, letterStyle)).join("") : v);
  if (chars.length === 1 && /[A-Za-z]/.test(v)) {
    if (letterStyle && letterStyle !== "upright") return m("mi", { mathvariant: "normal" }, styled(v, letterStyle));
    if (letterStyle === "upright" || upright) return m("mi", { mathvariant: "normal" }, v);
    return m("mi", {}, v);
  }
  if (chars.length === 1 && isOperatorChar(v)) {
    const attrs: Record<string, string> = {};
    // A bracket as written keeps its size; only \left…\right stretches.
    // and, like TeX's, takes no room around it: |x|, not | x |.
    if (BRACKETS.has(v)) Object.assign(attrs, { stretchy: "false", lspace: "0", rspace: "0" });
    // a/b written in a line: the slash sits between them with no room, as in TeX.
    if (v === "/") Object.assign(attrs, { stretchy: "false", lspace: "0", rspace: "0" });
    if (RELATIONS.has(v)) attrs.class = "mx-rel";
    // \implies, \impliedby, \iff: LaTeX sets them with a thick space on each side.
    if ("⟹⟸⟺".includes(v)) Object.assign(attrs, { lspace: "0.5556em", rspace: "0.5556em" });
    // ∫ and ∑: TeX's thin space beside them, not the wide default of the rarer ones (∬, ∯…).
    if (INTEGRALS.has(v)) Object.assign(attrs, { lspace: "0.1667em", rspace: "0.0833em" });
    if (BIG_OPERATORS.has(v)) Object.assign(attrs, { lspace: "0.1667em", rspace: "0.1667em" });
    // f′: the math font's prime already sits high, close to the letter.
    if (v === "′" || v === "″" || v === "‴") Object.assign(attrs, { class: "mx-prime", lspace: "0", rspace: "0" });
    return m("mo", attrs, v);
  }
  if (chars.length === 1) {
    // Greek small letters lean like Latin ones; capitals and ℝ, ℏ… stand.
    if (/^[α-ωϑϕϖϰϱϵϝ]$/u.test(v) && !letterStyle) return m("mi", {}, v);
    if (letterStyle === "bold" || letterStyle === "boldit") return m("mi", { mathvariant: "normal", class: "mx-bold" }, v);
    if (UPRIGHT_LETTERS.test(v) || upright) return m("mi", { mathvariant: "normal" }, v);
    return m("mi", {}, v);
  }
  // A word (a macro's name, \tag's number) or a composed sign (∇×, ≠ written \not=).
  if (/^\p{L}+$/u.test(v)) return m("mi", { mathvariant: "normal" }, v);
  if (chars.length <= 3 && chars.every((c) => isOperatorChar(c) || /\p{M}/u.test(c) || ORDINARY.has(c))) return m("mo", {}, v);
  return m("mtext", {}, v.replace(/ /g, " "));
}

/** The names TeX sets as two words: lim sup, arg max… */
const OP_NAMES: Record<string, string> = {
  liminf: "lim\u2009inf", limsup: "lim\u2009sup", argmax: "arg\u2009max", argmin: "arg\u2009min",
  injlim: "inj\u2009lim", projlim: "proj\u2009lim", esssup: "ess\u2009sup", essinf: "ess\u2009inf",
};

function opName(name: string): string {
  return OP_NAMES[name] ?? name;
}

/** Whether a node is ∑, ∏, \lim, \max… whose scripts go above and below on a line of its own. */
function isBigOperator(node: Node | null): boolean {
  if (!node) return false;
  if (node.t === "sym") return BIG_OPERATORS.has(node.v);
  if (node.t === "op") return LIMIT_FUNCTIONS.has(node.name);
  if (node.t === "style") return node.style === "upright" && LIMIT_FUNCTIONS.has(flatten(node.body));
  return false;
}

/** The marks of the accents, as MathML draws them over a letter. */
function accent(node: Extract<Node, { t: "accent" }>): Element {
  const mark = m("mo", { stretchy: node.stretchy ? "true" : "false", class: node.mark === "→" && !node.stretchy ? "mx-vec" : "mx-accent" }, node.mark);
  if (node.under) return m("munder", { accentunder: "true" }, draw(node.body), mark);
  return m("mover", { accent: "true", class: node.mark === "→" ? "mx-vecover" : "" }, draw(node.body), mark);
}

function draw(node: Node): Element {
  switch (node.t) {
    case "sym":
      return symbol(node.v, node.upright);
    case "op":
      return m("mi", { mathvariant: "normal", class: "mx-op" }, opName(node.name));
    case "group":
      return drawAll(node.c);
    case "sup": {
      const base = node.base ? draw(node.base) : m("mrow");
      // ∑, \lim: limits above and below on a line of its own, beside it in the text.
      if (isBigOperator(node.base)) {
        const b = node.base!;
        const op = b.t === "sym"
          ? m("mo", { movablelimits: "true", class: "mx-bigop" }, b.v)
          : m("mo", { movablelimits: "true", lspace: "0.1667em", rspace: "0.1667em", class: "mx-op" }, b.t === "op" ? opName(b.name) : flatten(b));
        const tag = node.sub && node.sup ? "munderover" : node.sub ? "munder" : "mover";
        return m(tag, { class: "mx-limits" }, op, node.sub ? draw(node.sub) : null, node.sup ? draw(node.sup) : null);
      }
      // \overbrace{…}^{n}, \underbrace{…}_{n}: always above and below.
      if (node.base?.t === "stack") {
        const tag = node.sub && node.sup ? "munderover" : node.sub ? "munder" : "mover";
        return m(tag, { class: "mx-limits" }, base, node.sub ? draw(node.sub) : null, node.sup ? draw(node.sup) : null);
      }
      const cls = node.base?.t === "sym" && INTEGRALS.has(node.base.v) ? "mx-script mx-int" : "mx-script";
      if (node.sup && node.sub) return m("msubsup", { class: cls }, base, draw(node.sub), draw(node.sup));
      if (node.sup) return m("msup", { class: cls }, base, draw(node.sup));
      return m("msub", { class: cls }, base, node.sub ? draw(node.sub) : m("mrow"));
    }
    case "frac": {
      const attrs: Record<string, string> = { class: "mx-frac" };
      if (node.line === false) attrs.linethickness = "0";
      const frac = m("mfrac", attrs, draw(node.num), draw(node.den));
      // \dfrac in the text: as big as on a line of its own; \tfrac: as small as in the text.
      if (node.size === "display") return m("mrow", { displaystyle: "true" }, frac);
      if (node.size === "text") return m("mrow", { displaystyle: "false" }, frac);
      return frac;
    }
    case "sqrt": {
      // The radical sign and its bar drawn by style.css as one line, as tall
      // as what it holds: the font's √ and MathML's bar do not always meet.
      const root = m("mrow", { class: "mx-sqrt" }, draw(node.body));
      if (!node.index) return root;
      return m("mrow", { class: "mx-root" }, m("mpadded", { voffset: "0.55em", class: "mx-root-index" }, draw(node.index)), root);
    }
    case "accent":
      return accent(node);
    case "over":
      if (node.under) return m("munder", { accentunder: "true" }, draw(node.body), m("mo", { stretchy: "true" }, "_"));
      return m("mover", { accent: "true" }, draw(node.body), m("mo", { stretchy: "true" }, "‾"));
    case "style": {
      if (node.style === "text") {
        const was = inText;
        inText = true;
        try {
          return m("mrow", { class: "mx-text" }, draw(node.body));
        } finally {
          inText = was;
        }
      }
      if (node.style === "display" || node.style === "textstyle") {
        return m("mrow", { displaystyle: node.style === "display" ? "true" : "false" }, draw(node.body));
      }
      const was = letterStyle;
      letterStyle = node.style;
      try {
        return m("mrow", { class: `mx-${node.style}` }, draw(node.body));
      } finally {
        letterStyle = was;
      }
    }
    case "cancel":
      return m("mrow", { class: `mx-cancel mx-${node.kind}` }, draw(node.body));
    case "fence":
      return m("mrow", { class: "mx-fence" }, fenceMark(node.open, "prefix"), drawAll(node.body), fenceMark(node.close, "postfix"));
    case "delim":
      return m("mo", { stretchy: "true", symmetric: "true", class: "mx-delim" }, node.v);
    case "big":
      return m("mo", { stretchy: "true", symmetric: "true", minsize: `${node.scale}em`, maxsize: `${node.scale}em`, class: "mx-delim" }, node.v);
    case "stack": {
      const body = draw(node.body);
      // A brace or an arrow over or under: as wide as what it spans.
      const stretch = (n: Node | null) => (n && n.t === "sym" && isOperatorChar(n.v) ? m("mo", { stretchy: "true" }, n.v) : n ? draw(n) : null);
      const base = node.body.t === "sym" && isOperatorChar(node.body.v) ? m("mo", { stretchy: "true", class: "mx-xarrow" }, node.body.v) : body;
      // \overbrace and \underbrace: a brace as wide as what it spans, drawn
      // by style.css in pieces (two ends, the point, the lines between), since
      // not every math font's brace stretches cleanly in the WebView.
      if (node.top?.t === "sym" && node.top.v === "⏞") return m("mrow", { class: "mx-stack mx-overbrace" }, base);
      if (node.bottom?.t === "sym" && node.bottom.v === "⏟") return m("mrow", { class: "mx-stack mx-underbrace" }, base);
      if (node.top && node.bottom) return m("munderover", { class: "mx-stack" }, base, stretch(node.bottom), stretch(node.top));
      if (node.top) return m("mover", { class: "mx-stack" }, base, stretch(node.top));
      if (node.bottom) return m("munder", { class: "mx-stack" }, base, stretch(node.bottom));
      return base;
    }
    case "box":
      return m("mrow", { class: "mx-box" }, draw(node.body));
    case "matrix":
      return matrix(node);
  }
}

/** A bracket of \left…\right: as tall as what it holds. "." is none. */
function fenceMark(v: string, form: "prefix" | "postfix"): Element | null {
  if (!v) return null;
  // Not symmetric: the bracket hugs what it holds, as LaTeX's does, rather
  // than growing as far below the axis as the tallest part reaches above.
  return m("mo", { stretchy: "true", symmetric: "false", fence: "true", form, class: "mx-delim" }, v);
}

function matrix(node: Extract<Node, { t: "matrix" }>): Element {
  const cols = Math.max(1, ...node.rows.map((r) => r.length));
  const attrs: Record<string, string> = { class: `mx-grid mx-grid-${node.kind}` };
  // aligned rows are equations set as on a line of their own; matrices and cases are not.
  if (node.kind === "aligned") attrs.displaystyle = "true";
  if (node.small) attrs.class += " mx-grid-small";
  const table = m("mtable", attrs);
  for (const row of node.rows) {
    const tr = m("mtr");
    for (let k = 0; k < cols; k++) {
      const cell = m("mtd", { class: "mx-cell" }, row[k] ? draw(row[k]) : null) as HTMLElement;
      const align = node.align[k] ?? "c";
      if (align !== "c") cell.style.textAlign = align === "l" ? "left" : "right";
      // aligned: a gap between each pair of columns, none inside one.
      if (node.kind === "aligned" && k > 0 && k % 2 === 0) cell.classList.add("mx-cell-pair");
      if (node.kind === "aligned" && k % 2 === 1) cell.classList.add("mx-cell-right");
      tr.append(cell);
    }
    table.append(tr);
  }
  if (!node.open && !node.close) return m("mrow", { class: "mx-matrix" }, table);
  return m("mrow", { class: "mx-fence mx-matrix" }, fenceMark(node.open, "prefix"), table, fenceMark(node.close, "postfix"));
}

/** Whether a node ends a term, so that a + or − after it joins two terms. */
function isOperand(node: Node | null): boolean {
  if (!node) return false;
  if (node.t === "op") return false;
  if (node.t !== "sym") return node.t !== "delim";
  return !RELATIONS.has(node.v) && !BINARY.has(node.v) && !"([{⟨,;:".includes(node.v) && node.v.trim() !== "";
}

/** Whether a node opens with a bracket: \sin(x) takes no space before it. */
function opensWithBracket(node: Node | undefined): boolean {
  if (!node) return true;
  if (node.t === "fence" || node.t === "big") return true;
  if (node.t === "sup") return opensWithBracket(node.base ?? undefined);
  if (node.t === "sym") return "([{⟨|‖".includes(node.v) || RELATIONS.has(node.v) || BINARY.has(node.v) || ",;.".includes(node.v) || /^\s*$/.test(node.v);
  return false;
}

function isDigit(node: Node | undefined): node is Extract<Node, { t: "sym" }> {
  return node?.t === "sym" && /^[0-9]$/.test(node.v);
}

/**
 * A row of nodes. Numbers stay whole (3.14), a sign in front of a term is
 * not an operation (−x), and \sin x gets its thin space.
 */
function drawAll(input: Node[]): Element {
  const nodes = input;
  const row = m("mrow");
  let prev: Node | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!inText && isDigit(n)) {
      // Digits, with a point or comma between digits: one number.
      let v = n.v;
      while (isDigit(nodes[i + 1]) || (nodes[i + 1]?.t === "sym" && (nodes[i + 1] as { v: string }).v === "." && isDigit(nodes[i + 2]))) {
        v += (nodes[++i] as { v: string }).v;
      }
      row.append(m("mn", {}, letterStyle ? [...v].map((c) => styled(c, letterStyle)).join("") : v));
      prev = n;
      continue;
    }
    if (!inText && n.t === "sym" && n.upright && BINARY.has(n.v)) {
      // A sign in front (−x, (−1)) has no room around it; between two terms it does.
      const el = m("mo", isOperand(prev) ? { class: "mx-bin", lspace: "0.2222em", rspace: "0.2222em" } : { form: "prefix", lspace: "0", rspace: "0" }, n.v);
      row.append(el);
      prev = n;
      continue;
    }
    const isOp = n.t === "op" || (n.t === "sup" && n.base?.t === "op" && !isBigOperator(n.base));
    if (isOp && isOperand(prev)) row.append(m("mspace", { width: "0.1667em" }));
    row.append(draw(n));
    if (isOp && !opensWithBracket(nodes[i + 1])) row.append(m("mspace", { width: "0.1667em" }));
    prev = n;
  }
  return row;
}

/** TeX as a math element: inline in the text, or a centred line of its own. */
export function renderMath(tex: string, display = false): Element {
  try {
    const nodes = new Parser(tex.trim()).parseAll();
    const math = m("math", { class: display ? "mx mx-display" : "mx" }, drawAll(nodes));
    if (display) math.setAttribute("display", "block");
    // The TeX it was written in, for copying and screen readers' fallback.
    math.setAttribute("alttext", tex.trim());
    return math;
  } catch {
    return h("span", { class: "md-code", text: tex });
  } finally {
    letterStyle = null;
    inText = false;
  }
}
