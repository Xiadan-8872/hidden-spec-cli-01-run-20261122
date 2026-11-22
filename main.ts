// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- SPEC.md section 3: a file's lines ----------

interface FText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { br, lines: parts, final: fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

// ---------- SPEC.md section 5: matching lines ----------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimWs(s);
}

/** Start indices where O occurs in lines at the given tier, at or after `from`. */
function occAt(lines: string[], O: string[], tier: number, from: number, endAtLast: boolean): number[] {
  const out: number[] = [];
  const n = O.length;
  if (n === 0) return out;
  const no = O.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + n <= lines.length; i++) {
    if (endAtLast && i + n !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (normLine(lines[i + k]!, tier) !== no[k]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2, or only 0 when strict) at which O occurs; null when it never does. */
function findTier(lines: string[], O: string[], strict: boolean, from: number, endAtLast: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occAt(lines, O, t, from, endAtLast);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * Build the replacement lines for a matched occurrence. nCtx[j] is the index in O of the
 * context line N[j] is, or null when N[j] is a new line. Context lines are written as the
 * file's own matched line; at tier 2 every other line is re-indented from P to F.
 */
function buildNew(O: string[], N: string[], nCtx: (number | null)[], fileLines: string[], start: number, tier: number): string[] {
  const out: string[] = [];
  const F = leadWs(fileLines[start] ?? '');
  const P = leadWs(O[0] ?? '');
  for (let j = 0; j < N.length; j++) {
    const c = nCtx[j];
    if (c !== null && c !== undefined) {
      out.push(fileLines[start + c]!);
    } else {
      const l = N[j]!;
      if (tier === 2 && l !== '' && l.trim() !== '' && l.startsWith(P)) out.push(F + l.slice(P.length));
      else out.push(l);
    }
  }
  return out;
}

// ---------- SPEC.md section 6: unified diffs ----------

interface Hunk {
  a: number;
  O: string[];
  N: string[];
  nCtx: (number | null)[];
  noEol: boolean;
  noEolPlus: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function uniPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkBody(body: string[]): { O: string[]; N: string[]; nCtx: (number | null)[]; noEol: boolean; noEolPlus: boolean } {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: (number | null)[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l.startsWith(' ')) {
      O.push(l.slice(1));
      N.push(l.slice(1));
      nCtx.push(O.length - 1);
      lastCtxPlus = i;
    } else if (l.startsWith('-')) {
      O.push(l.slice(1));
    } else if (l.startsWith('+')) {
      N.push(l.slice(1));
      nCtx.push(null);
      lastCtxPlus = i;
      lastPlus = i;
    } else if (l.startsWith('\\')) {
      // no-newline marker: refers to the body line before it
    } else if (l === '') {
      O.push('');
      N.push('');
      nCtx.push(O.length - 1);
      lastCtxPlus = i;
    }
  }
  const noEol = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
  const noEolPlus = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { O, N, nCtx, noEol, noEolPlus };
}

/** Apply a section's hunks in order to a file's text; throws Fail on the first failing hunk. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const ft = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      const oldLen = ft.lines.length;
      const ins = Math.min(h.a + d, oldLen);
      const touchesEnd = ins === oldLen;
      ft.lines.splice(ins, 0, ...h.N);
      if (touchesEnd) ft.final = !h.noEol;
      d += h.N.length;
    } else {
      const found = findTier(ft.lines, h.O, strict, 0, false);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const o of found.occ) {
        const dist = Math.abs(o - target);
        if (dist < bestDist) { best = o; bestDist = dist; }
      }
      const start = best;
      const touchesEnd = start + h.O.length === ft.lines.length;
      const repl = buildNew(h.O, h.N, h.nCtx, ft.lines, start, found.tier);
      ft.lines.splice(start, h.O.length, ...repl);
      if (touchesEnd) ft.final = !h.noEol;
      d += h.N.length - h.O.length;
    }
  }
  return joinFile(ft.lines, ft.br, ft.final);
}

function makeUniEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.newFile;
    const isDelete = newP === null || sec.deletedFile;
    if (isCreate) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plusLines: string[] = [];
      let noEolLast = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (let j = 0; j < h.N.length; j++) {
          if (h.nCtx[j] === null) { plusLines.push(h.N[j]!); hasPlus = true; }
        }
        if (hasPlus) noEolLast = h.noEolPlus;
      }
      tree.now.set(np, plusLines.length === 0 ? '' : plusLines.join('\n') + (noEolLast ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(tree.get(oldP)!, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push({ old: oldP, nw: newP });
      return;
    }
    const p = oldP!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(tree.get(p)!, sec.hunks, strict, p));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let current: UniSection | null = null;
  let inHeader = false;
  let hasPaths = false;
  let i = 0;
  const n = lines.length;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const gitRe = /^diff --git a\/(.+) b\/(.+)$/;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = gitRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      current = { oldPath: m[1]!, newPath: m[2]!, newFile: false, deletedFile: false, hunks: [] };
      sections.push(current);
      inHeader = true;
      hasPaths = false;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (current === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') {
          body.push(bl);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const parsed = parseHunkBody(body);
      current.hunks.push({ a, O: parsed.O, N: parsed.N, nCtx: parsed.nCtx, noEol: parsed.noEol, noEolPlus: parsed.noEolPlus });
      inHeader = false;
      i = j;
      continue;
    }
    if (current !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (!hasPaths) {
          current.oldPath = uniPath(line.slice(4));
          current.newPath = uniPath(lines[i + 1]!.slice(4));
          hasPaths = true;
          i += 2;
          continue;
        }
        current = { oldPath: uniPath(line.slice(4)), newPath: uniPath(lines[i + 1]!.slice(4)), newFile: false, deletedFile: false, hunks: [] };
        sections.push(current);
        hasPaths = true;
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) { current.oldPath = line.slice('rename from '.length).trim(); i++; continue; }
      if (line.startsWith('rename to ')) { current.newPath = line.slice('rename to '.length).trim(); i++; continue; }
      if (line.startsWith('new file mode')) { current.newFile = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { current.deletedFile = true; i++; continue; }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      current = { oldPath: uniPath(line.slice(4)), newPath: uniPath(lines[i + 1]!.slice(4)), newFile: false, deletedFile: false, hunks: [] };
      sections.push(current);
      inHeader = true;
      hasPaths = true;
      i += 2;
      continue;
    }
    i++;
  }
  return sections.map((sec) => makeUniEdit(sec, strict));
}

// ---------- SPEC.md section 7: SEARCH/REPLACE blocks ----------

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const ft = splitFile(before);
    const found = findTier(ft.lines, oldLines, strict, 0, false);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const start = found.occ[0]!;
    const repl = buildNew(oldLines, newLines, newLines.map(() => null), ft.lines, start, found.tier);
    ft.lines.splice(start, oldLines.length, ...repl);
    tree.now.set(path, joinFile(ft.lines, ft.br, ft.final));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') { s = j; break; }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { eq = j; break; }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(makeSearchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------- SPEC.md section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  O: string[];
  N: string[];
  nCtx: (number | null)[];
  eof: boolean;
}

function makeV4aAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeV4aUpdate(path: string, newPath: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (newPath !== null && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const ft = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = findTier(ft.lines, [ch.anchor], strict, cursor, false);
        if (!a) throw new Fail('no-match', path);
        cursor = a.occ[0]! + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? ft.lines.length : cursor;
        ft.lines.splice(at, 0, ...ch.N);
        cursor = at + ch.N.length;
      } else {
        const found = findTier(ft.lines, ch.O, strict, cursor, ch.eof);
        if (!found) throw new Fail('no-match', path);
        const start = found.occ[0]!;
        const repl = buildNew(ch.O, ch.N, ch.nCtx, ft.lines, start, found.tier);
        ft.lines.splice(start, ch.O.length, ...repl);
        cursor = start + repl.length;
      }
    }
    const out = joinFile(ft.lines, ft.br, ft.final);
    if (newPath !== null) {
      tree.now.set(path, null);
      tree.now.set(newPath, out);
      tree.moves.push({ old: path, nw: newPath });
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i]!)) { first = i; break; }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (line.startsWith('*** Add File: ')) { kind = 'add'; path = line.slice('*** Add File: '.length).trim(); }
    else if (line.startsWith('*** Delete File: ')) { kind = 'del'; path = line.slice('*** Delete File: '.length).trim(); }
    else if (line.startsWith('*** Update File: ')) { kind = 'upd'; path = line.slice('*** Update File: '.length).trim(); }
    else throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    let end = i + 1;
    while (end < last) {
      const l = lines[end]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      end++;
    }
    let secEnd = end;
    while (secEnd > i + 1 && blank(lines[secEnd - 1]!)) secEnd--;
    if (kind === 'add') {
      const fl: string[] = [];
      for (let k = i + 1; k < secEnd; k++) {
        const l = lines[k]!;
        if (l.startsWith('+')) fl.push(l.slice(1));
        else if (l === '') fl.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(makeV4aAdd(path, fl));
    } else if (kind === 'del') {
      for (let k = i + 1; k < secEnd; k++) {
        if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(makeV4aDelete(path));
    } else {
      let newPath: string | null = null;
      let k = i + 1;
      if (k < secEnd && lines[k]!.startsWith('*** Move to: ')) {
        newPath = lines[k]!.slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; body: string[]; eof: boolean } | null = null;
      const closeChunk = (): void => {
        if (cur === null) return;
        const O: string[] = [];
        const N: string[] = [];
        const nCtx: (number | null)[] = [];
        for (const l of cur.body) {
          if (l.startsWith(' ')) { O.push(l.slice(1)); N.push(l.slice(1)); nCtx.push(O.length - 1); }
          else if (l.startsWith('-')) O.push(l.slice(1));
          else if (l.startsWith('+')) { N.push(l.slice(1)); nCtx.push(null); }
          else if (l === '') { O.push(''); N.push(''); nCtx.push(O.length - 1); }
        }
        chunks.push({ anchor: cur.anchor, O, N, nCtx, eof: cur.eof });
        cur = null;
      };
      while (k < secEnd) {
        const l = lines[k]!;
        if (l.startsWith('@@')) {
          closeChunk();
          cur = { anchor: l.slice(2).trim(), body: [], eof: false };
          k++;
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${k + 1}`);
          cur.eof = true;
          closeChunk();
          k++;
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${k + 1}`);
            cur = { anchor: null, body: [], eof: false };
          }
          cur.body.push(l);
          k++;
        } else {
          throw new Exit2(`error: parse ${k + 1}`);
        }
      }
      closeChunk();
      if (chunks.length === 0 && newPath === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(makeV4aUpdate(path, newPath, chunks, strict));
    }
    i = end;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.now.get(p) !== tree.original(p));
  const covered = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      covered.add(m.old);
      covered.add(m.nw);
    }
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
