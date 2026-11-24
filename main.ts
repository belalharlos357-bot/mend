// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
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
  moves: { old: string; new: string }[] = [];
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

// ---------------------------------------------------------------------------
// Files and line matching (SPEC.md sections 3 and 5)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in fileLines at the given tier, at or after `from`. */
function occurrencesAt(fileLines: string[], O: string[], tier: number, from = 0): number[] {
  const res: number[] = [];
  if (O.length === 0) return res;
  const oKeys = O.map((l) => tierKey(l, tier));
  for (let i = from; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (tierKey(fileLines[i + j], tier) !== oKeys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** First tier (0, 1, 2, or only 0 when strict) at which O occurs at or after `from`. */
function firstTierWith(
  fileLines: string[],
  O: string[],
  from = 0,
  strict = false,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(fileLines, O, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

interface OL {
  text: string;
  context: boolean;
}

/**
 * Build the lines that replace the matched block. Context lines are written as the
 * file's own matched line; other lines of N are re-indented at tier 2.
 */
function buildReplacement(O: OL[], N: OL[], fileLines: string[], pos: number, tier: number): string[] {
  const oCtx: number[] = [];
  O.forEach((l, i) => {
    if (l.context) oCtx.push(i);
  });
  const F = pos < fileLines.length ? leadingWS(fileLines[pos]) : '';
  const P = O.length > 0 ? leadingWS(O[0].text) : '';
  const out: string[] = [];
  let ci = 0;
  for (const n of N) {
    if (n.context) {
      out.push(fileLines[pos + oCtx[ci++]]);
    } else {
      let line = n.text;
      if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) {
        line = F + line.slice(P.length);
      }
      out.push(line);
    }
  }
  return out;
}

function spliceFile(f: FileState, pos: number, oLen: number, repl: string[], newFinal: boolean): FileState {
  return {
    lines: [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + oLen)],
    br: f.br,
    final: newFinal,
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  O: OL[];
  N: OL[];
  /** a `\` line follows the last context or `+` body line */
  lastNewNoNL: boolean;
  /** a `\` line follows the last `+` body line */
  lastPlusNoNL: boolean;
  hasPlus: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;

interface Section {
  oldPath: string;
  newPath: string;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(line: string): string {
  // text after the four characters, up to the first tab, surrounding spaces removed
  const t = line.slice(4).split('\t')[0].trim();
  return stripAB(t);
}

/** Parse one hunk starting at lines[i] (a valid @@ header). Returns the hunk and the next index. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i])!;
  const a = parseInt(m[1], 10);
  const body: { kind: string; text: string }[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push({ kind: l === '' ? ' ' : l[0], text: l === '' ? '' : l.slice(1) });
      j += 1;
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1].kind === ' ' && body[body.length - 1].text === '') body.pop();
  let lastNewIdx = -1;
  let lastPlusIdx = -1;
  body.forEach((b, idx) => {
    if (b.kind === ' ' || b.kind === '+') lastNewIdx = idx;
    if (b.kind === '+') lastPlusIdx = idx;
  });
  const lastNewNoNL = lastNewIdx >= 0 && body[lastNewIdx + 1] !== undefined && body[lastNewIdx + 1].kind === '\\';
  const lastPlusNoNL = lastPlusIdx >= 0 && body[lastPlusIdx + 1] !== undefined && body[lastPlusIdx + 1].kind === '\\';
  const O: OL[] = [];
  const N: OL[] = [];
  let hasPlus = false;
  for (const b of body) {
    if (b.kind === ' ') {
      O.push({ text: b.text, context: true });
      N.push({ text: b.text, context: true });
    } else if (b.kind === '-') {
      O.push({ text: b.text, context: false });
    } else if (b.kind === '+') {
      N.push({ text: b.text, context: false });
      hasPlus = true;
    }
  }
  return { hunk: { a, O, N, lastNewNoNL, lastPlusNoNL, hasPlus }, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const sections: Section[] = [];
  let section: Section | null = null;
  let i = 0;
  const flush = () => {
    if (section) {
      sections.push(section);
      section = null;
    }
  };
  while (i < n) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      flush();
      section = { oldPath: m[1], newPath: m[2], isNew: false, isDel: false, hunks: [] };
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (section && section.hunks.length === 0) {
        section.oldPath = headerPath(l);
        section.newPath = headerPath(lines[i + 1]);
        i += 2;
        continue;
      }
      flush();
      section = { oldPath: headerPath(l), newPath: headerPath(lines[i + 1]), isNew: false, isDel: false, hunks: [] };
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (section && section.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (!section) throw new Exit2(`error: parse ${i + 1}`);
      if (!HUNK_RE.test(l)) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      section.hunks.push(hunk);
      i = next;
      continue;
    }
    if (section && section.hunks.length === 0) {
      if (l.startsWith('rename from ')) section.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) section.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) section.isNew = true;
      else if (l.startsWith('deleted file mode')) section.isDel = true;
      // index, old mode, new mode, similarity/dissimilarity index, Index: and anything else: ignored
    }
    i += 1;
  }
  flush();
  return sections.map((s) => sectionToEdit(s, strict));
}

function applyUnifiedHunk(f: FileState, hunk: Hunk, strict: boolean, d: number, path: string): FileState {
  const O = hunk.O.map((l) => l.text);
  if (O.length === 0) {
    const pos = Math.min(hunk.a + d, f.lines.length);
    const repl = buildReplacement(hunk.O, hunk.N, f.lines, pos, 0);
    const newFinal = pos === f.lines.length ? !hunk.lastNewNoNL : f.final;
    return spliceFile(f, pos, 0, repl, newFinal);
  }
  const found = firstTierWith(f.lines, O, 0, strict);
  if (!found) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0];
  let bestDist = Math.abs(best - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const repl = buildReplacement(hunk.O, hunk.N, f.lines, best, found.tier);
  let newFinal = f.final;
  if (best + O.length === f.lines.length) {
    if (hunk.N.length > 0) newFinal = !hunk.lastNewNoNL;
    else newFinal = best > 0;
  }
  return spliceFile(f, best, O.length, repl, newFinal);
}

function sectionToEdit(s: Section, strict: boolean): Edit {
  const oldP = s.oldPath;
  const newP = s.newPath;
  const isCreation = oldP === '/dev/null' || s.isNew;
  const isDeletion = newP === '/dev/null' || s.isDel;
  if (isCreation) {
    const target = newP;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const outLines: string[] = [];
      for (const h of s.hunks) {
        for (const x of h.N) if (!x.context) outLines.push(x.text);
      }
      let noNL = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        if (s.hunks[k].hasPlus) {
          noNL = s.hunks[k].lastPlusNoNL;
          break;
        }
      }
      tree.now.set(target, outLines.length === 0 ? '' : outLines.join('\n') + (noNL ? '' : '\n'));
    };
  }
  if (isDeletion) {
    const target = oldP;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const content = tree.get(oldP);
      if (content === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let f = splitFile(content);
      let d = 0;
      for (const h of s.hunks) {
        f = applyUnifiedHunk(f, h, strict, d, oldP);
        d += h.N.length - h.O.length;
      }
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(f));
      tree.moves.push({ old: oldP, new: newP });
    };
  }
  const target = oldP;
  return (tree) => {
    if (!safe(target)) throw new Fail('unsafe', target);
    const content = tree.get(target);
    if (content === null) throw new Fail('missing', target);
    let f = splitFile(content);
    let d = 0;
    for (const h of s.hunks) {
      f = applyUnifiedHunk(f, h, strict, d, target);
      d += h.N.length - h.O.length;
    }
    tree.now.set(target, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    const f = splitFile(content);
    const found = firstTierWith(f.lines, oldLines, 0, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0];
    const O: OL[] = oldLines.map((t) => ({ text: t, context: false }));
    const N: OL[] = newLines.map((t) => ({ text: t, context: false }));
    const repl = buildReplacement(O, N, f.lines, pos, found.tier);
    tree.now.set(path, joinFile(spliceFile(f, pos, oldLines.length, repl, f.final)));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    let si = -1;
    for (let j = i; j < n; j++) {
      if (lines[j].trimEnd() === '<<<<<<< SEARCH') {
        si = j;
        break;
      }
    }
    if (si === -1) break;
    let path: string | null = null;
    for (let j = si - 1; j > prevEnd; j--) {
      const l = lines[j];
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${si + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = si + 1; j < n; j++) {
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') break;
    }
    let rep = -1;
    for (let j = eq === -1 ? si + 1 : eq + 1; j < n; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq === -1 || rep === -1) throw new Exit2(`error: parse ${si + 1}`);
    const oldLines = lines.slice(si + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSearchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

function findSingleLine(fileLines: string[], anchor: string, from: number, strict: boolean): { tier: number; pos: number } | null {
  const found = firstTierWith(fileLines, [anchor], from, strict);
  if (!found) return null;
  return { tier: found.tier, pos: found.positions[0] };
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: OL[];
  N: OL[];
}

function makeV4aEdit(
  kind: string,
  path: string,
  secLines: { text: string; no: number }[],
  headerNo: number,
  strict: boolean,
): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const { text, no } of secLines) {
      if (text === '') fileLines.push('');
      else if (text.startsWith('+')) fileLines.push(text.slice(1));
      else throw new Exit2(`error: parse ${no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0].no}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // update
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let idx = 0;
  if (secLines.length > 0 && secLines[0].text.startsWith('*** Move to: ')) {
    moveTo = secLines[0].text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  for (; idx < secLines.length; idx++) {
    const { text, no } = secLines[idx];
    if (text.startsWith('@@')) {
      if (cur) chunks.push(cur);
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, O: [], N: [] };
    } else if (text === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (!cur) {
        if (chunks.length === 0) cur = { anchor: null, eof: false, O: [], N: [] };
        else throw new Exit2(`error: parse ${no}`);
      }
      if (text === '') {
        cur.O.push({ text: '', context: true });
        cur.N.push({ text: '', context: true });
      } else if (text.startsWith(' ')) {
        const t = text.slice(1);
        cur.O.push({ text: t, context: true });
        cur.N.push({ text: t, context: true });
      } else if (text.startsWith('-')) {
        cur.O.push({ text: text.slice(1), context: false });
      } else if (text.startsWith('+')) {
        cur.N.push({ text: text.slice(1), context: false });
      }
    } else {
      throw new Exit2(`error: parse ${no}`);
    }
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(content);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const aFound = findSingleLine(f.lines, ch.anchor, cursor, strict);
        if (!aFound) throw new Fail('no-match', path);
        cursor = aFound.pos + 1;
      }
      const O = ch.O.map((l) => l.text);
      if (O.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const repl = buildReplacement(ch.O, ch.N, f.lines, pos, 0);
        f = spliceFile(f, pos, 0, repl, f.final);
        cursor = pos + repl.length;
      } else {
        const found = firstTierWith(f.lines, O, cursor, strict);
        if (!found) throw new Fail('no-match', path);
        let pos: number | null = null;
        for (const p of found.positions) {
          if (ch.eof) {
            if (p + O.length === f.lines.length) {
              pos = p;
              break;
            }
          } else {
            pos = p;
            break;
          }
        }
        if (pos === null) throw new Fail('no-match', path);
        const repl = buildReplacement(ch.O, ch.N, f.lines, pos, found.tier);
        f = spliceFile(f, pos, O.length, repl, f.final);
        cursor = pos + repl.length;
      }
    }
    const newText = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, newText);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, newText);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i])) {
      i += 1;
      continue;
    }
    const l = lines[i];
    let kind: string | null = null;
    let p = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      p = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      p = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      p = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secLines: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < last) {
      const lj = lines[j];
      if (lj.startsWith('*** Add File: ') || lj.startsWith('*** Delete File: ') || lj.startsWith('*** Update File: ')) break;
      secLines.push({ text: lj, no: j + 1 });
      j += 1;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1].text)) secLines.pop();
    edits.push(makeV4aEdit(kind, p, secLines, i + 1, strict));
    i = j;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Main (SPEC.md sections 1, 2, 10)
// ---------------------------------------------------------------------------

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
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface OutEntry {
    sortKey: string;
    line: string;
  }
  const entries: OutEntry[] = [];
  const consumed = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      entries.push({ sortKey: m.new, line: `R ${m.old} -> ${m.new}` });
      consumed.add(m.old);
      consumed.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ sortKey: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
