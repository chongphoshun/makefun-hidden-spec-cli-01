// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit
// format (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls).
// It reads all four to one specification, finds the lines an edit names even
// when the model drifted their whitespace or indentation, and changes every
// file or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

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

/** A file's own line break, its lines, and whether it ends with a break. */
function fileParts(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** new path -> path the file had before the patch, for files moved by a move edit. */
  readonly movedFrom = new Map<string, string>();
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

/** Record a move of a file that existed before the patch (or was itself moved). */
function applyMove(tree: Tree, oldP: string, newP: string, text: string): void {
  const wasBefore = tree.original(oldP) !== null || tree.movedFrom.has(oldP);
  const origin = tree.movedFrom.get(oldP) ?? oldP;
  tree.now.set(oldP, null);
  tree.now.set(newP, text);
  tree.movedFrom.delete(oldP);
  if (wasBefore && origin !== newP) tree.movedFrom.set(newP, origin);
  else tree.movedFrom.delete(newP);
}

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

/** Line equality at one matching tier (SPEC.md section 5). */
function eqAt(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

function findOccurrences(o: string[], lines: string[], from: number, tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!eqAt(tier, o[j]!, lines[i + j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(o: string[], lines: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = findOccurrences(o, lines, from, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** First line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findSingleLine(anchor: string, lines: string[], from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (eqAt(t, anchor, lines[i]!)) return i;
    }
  }
  return null;
}

interface NItem {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Build the lines N writes over a match at `pos`: context lines come from the
 * file's own matched lines; at tier 2 every other line is re-indented from the
 * old block's leading whitespace to the file's. */
function applyN(items: NItem[], fileLines: string[], pos: number, tier: number, oLines: string[]): string[] {
  const f = leadST(fileLines[pos] ?? '');
  const p = leadST(oLines.length > 0 ? oLines[0]! : '');
  const out: string[] = [];
  for (const it of items) {
    if (it.ctx) {
      out.push(fileLines[pos + it.oIdx]!);
    } else if (tier === 2) {
      const t = it.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(it.text);
    }
  }
  return out;
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

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  body: string[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  createFlag: boolean;
  delFlag: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:[ \t].*)?$/;
const GIT_RE = /^diff --git a\/(.*) b\/(.*)$/;

function dashPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let state: 'out' | 'header' | 'between' = 'out';
  const startSection = (): USection => {
    const s: USection = { gitOld: null, gitNew: null, dashOld: null, dashNew: null, renFrom: null, renTo: null, createFlag: false, delFlag: false, hunks: [] };
    sections.push(s);
    cur = s;
    state = 'header';
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = GIT_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.gitOld = m[1]!.trim();
      s.gitNew = m[2]!.trim();
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (state === 'out' || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      state = 'between';
      i = j;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.dashOld = dashPath(l);
          cur.dashNew = dashPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        cur.dashNew = dashPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.createFlag = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.delFlag = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (state === 'between' && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = startSection();
      s.dashOld = dashPath(l);
      s.dashNew = dashPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (state === 'out' && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = startSection();
      s.dashOld = dashPath(l);
      s.dashNew = dashPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(s: USection, strict: boolean): Edit {
  const oldP = s.dashOld ?? s.renFrom ?? s.gitOld ?? '';
  const newP = s.dashNew ?? s.renTo ?? s.gitNew ?? '';
  return (tree) => {
    const isCreate = s.createFlag || oldP === '/dev/null';
    const isDelete = !isCreate && (s.delFlag || newP === '/dev/null');
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let plus: string[] = [];
      let lastPlusBackslash = false;
      let hasPlus = false;
      for (const h of s.hunks) {
        for (let bi = 0; bi < h.body.length; bi++) {
          const bl = h.body[bi]!;
          if (bl.startsWith('+')) {
            plus.push(bl.slice(1));
            hasPlus = true;
            lastPlusBackslash = bi + 1 < h.body.length && h.body[bi + 1]!.startsWith('\\');
          }
        }
      }
      tree.now.set(newP, !hasPlus ? '' : plus.join('\n') + (lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      tree.movedFrom.delete(oldP);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
    } else if (!safe(oldP)) {
      throw new Fail('unsafe', oldP);
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    let { lines, br, final } = fileParts(before);
    let d = 0;
    for (const h of s.hunks) {
      const r = applyUnifiedHunk(lines, final, h, d, strict, oldP);
      lines = r.lines;
      final = r.final;
      d += r.dDelta;
    }
    const text = joinFile(lines, br, final);
    if (oldP !== newP) applyMove(tree, oldP, newP, text);
    else tree.now.set(oldP, text);
  };
}

function applyUnifiedHunk(
  lines: string[],
  final: boolean,
  h: Hunk,
  d: number,
  strict: boolean,
  path: string,
): { lines: string[]; final: boolean; dDelta: number } {
  const oLines: string[] = [];
  const nItems: NItem[] = [];
  for (const bl of h.body) {
    if (bl.startsWith('\\')) continue;
    if (bl.startsWith(' ')) {
      const t = bl.slice(1);
      oLines.push(t);
      nItems.push({ text: t, ctx: true, oIdx: oLines.length - 1 });
    } else if (bl.startsWith('-')) {
      oLines.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      nItems.push({ text: bl.slice(1), ctx: false, oIdx: -1 });
    } else if (bl === '') {
      oLines.push('');
      nItems.push({ text: '', ctx: true, oIdx: oLines.length - 1 });
    }
  }
  let lastIdx = -1;
  for (let k = 0; k < h.body.length; k++) {
    const bl = h.body[k]!;
    if (bl.startsWith(' ') || bl.startsWith('+') || bl === '') lastIdx = k;
  }
  const backslash = lastIdx >= 0 && lastIdx + 1 < h.body.length && h.body[lastIdx + 1]!.startsWith('\\');
  if (oLines.length === 0) {
    const pos = Math.min(Math.max(h.a + d, 0), lines.length);
    const inserted = applyN(nItems, lines, pos, 0, oLines);
    const out = [...lines.slice(0, pos), ...inserted, ...lines.slice(pos)];
    return { lines: out, final: pos === lines.length ? !backslash : final, dDelta: nItems.length };
  }
  const found = findTier(oLines, lines, 0, strict);
  if (!found) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const inserted = applyN(nItems, lines, best, found.tier, oLines);
  const out = [...lines.slice(0, best), ...inserted, ...lines.slice(best + oLines.length)];
  const toEnd = best + oLines.length === lines.length;
  return { lines: out, final: toEnd ? !backslash : final, dDelta: nItems.length - oLines.length };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const { lines, br, final } = fileParts(before);
      const found = findTier(b.oldLines, lines, 0, strict);
      if (!found) throw new Fail('no-match', b.path);
      if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.pos[0]!;
      const nItems: NItem[] = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const inserted = applyN(nItems, lines, pos, found.tier, b.oldLines);
      const out = [...lines.slice(0, pos), ...inserted, ...lines.slice(pos + b.oldLines.length)];
      tree.now.set(b.path, joinFile(out, br, final));
    };
  });
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
}

function vSectionStart(l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (l.startsWith('*** Add File:')) return { kind: 'add', path: l.slice(13).trim() };
  if (l.startsWith('*** Delete File:')) return { kind: 'delete', path: l.slice(16).trim() };
  if (l.startsWith('*** Update File:')) return { kind: 'update', path: l.slice(16).trim() };
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const st = vSectionStart(l);
    if (!st) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = { kind: st.kind, path: st.path, line: i + 1, moveTo: null, addLines: [], chunks: [] };
    sections.push(sec);
    i++;
    if (st.kind === 'add') {
      const raw: { line: string; num: number }[] = [];
      while (i < last) {
        const l2 = lines[i]!;
        if (vSectionStart(l2)) break;
        if (l2 === '' || l2.startsWith('+') || blank(l2)) {
          raw.push({ line: l2, num: i + 1 });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
      const addLines: string[] = [];
      for (const e of raw) {
        if (e.line === '') addLines.push('');
        else if (e.line.startsWith('+')) addLines.push(e.line.slice(1));
        else throw new Exit2(`error: parse ${e.num}`);
      }
      sec.addLines = addLines;
      continue;
    }
    if (st.kind === 'delete') {
      while (i < last) {
        const l2 = lines[i]!;
        if (vSectionStart(l2)) break;
        if (blank(l2)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      continue;
    }
    // update
    if (i < last && lines[i]!.startsWith('*** Move to:')) {
      sec.moveTo = lines[i]!.slice(12).trim();
      i++;
    }
    let curChunk: VChunk | null = null;
    let afterEof = false;
    const endChunk = (eof: boolean): void => {
      if (curChunk) {
        while (curChunk.body.length > 0 && blank(curChunk.body[curChunk.body.length - 1]!)) curChunk.body.pop();
        curChunk.eof = eof;
        sec.chunks.push(curChunk);
        curChunk = null;
      }
    };
    while (i < last) {
      const l2 = lines[i]!;
      if (vSectionStart(l2)) break;
      if (l2.startsWith('@@')) {
        endChunk(false);
        afterEof = false;
        curChunk = { anchor: l2.slice(2).trim(), body: [], eof: false };
        i++;
        continue;
      }
      if (l2 === '*** End of File' || (l2.startsWith('*** End of File') && l2.trimEnd() === '*** End of File')) {
        if (!curChunk) throw new Exit2(`error: parse ${i + 1}`);
        endChunk(true);
        afterEof = true;
        i++;
        continue;
      }
      if (blank(l2) && afterEof) {
        i++;
        continue;
      }
      if (l2.startsWith(' ') || l2.startsWith('-') || l2.startsWith('+') || l2 === '') {
        if (!curChunk) curChunk = { anchor: null, body: [], eof: false };
        afterEof = false;
        curChunk.body.push(l2);
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (curChunk) {
      while (curChunk.body.length > 0 && blank(curChunk.body[curChunk.body.length - 1]!)) curChunk.body.pop();
      sec.chunks.push(curChunk);
      curChunk = null;
    }
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    return (tree: Tree) => {
      if (sec.kind === 'add') {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        tree.movedFrom.delete(sec.path);
        return;
      }
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      let { lines, br, final } = fileParts(before);
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null && ch.anchor !== '') {
          const at = findSingleLine(ch.anchor, lines, cursor, strict);
          if (at === null) throw new Fail('no-match', sec.path);
          cursor = at + 1;
        }
        const oLines: string[] = [];
        const nItems: NItem[] = [];
        for (const bl of ch.body) {
          if (bl.startsWith(' ')) {
            const t = bl.slice(1);
            oLines.push(t);
            nItems.push({ text: t, ctx: true, oIdx: oLines.length - 1 });
          } else if (bl.startsWith('-')) {
            oLines.push(bl.slice(1));
          } else if (bl.startsWith('+')) {
            nItems.push({ text: bl.slice(1), ctx: false, oIdx: -1 });
          } else if (bl === '') {
            oLines.push('');
            nItems.push({ text: '', ctx: true, oIdx: oLines.length - 1 });
          }
        }
        if (oLines.length === 0) {
          const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
          const inserted = applyN(nItems, lines, pos, 0, oLines);
          lines = [...lines.slice(0, pos), ...inserted, ...lines.slice(pos)];
          cursor = pos + inserted.length;
          continue;
        }
        const found = findTier(oLines, lines, cursor, strict);
        if (!found) throw new Fail('no-match', sec.path);
        let pos: number | null = null;
        for (const p of found.pos) {
          if (ch.eof && p + oLines.length !== lines.length) continue;
          pos = p;
          break;
        }
        if (pos === null) throw new Fail('no-match', sec.path);
        const inserted = applyN(nItems, lines, pos, found.tier, oLines);
        lines = [...lines.slice(0, pos), ...inserted, ...lines.slice(pos + oLines.length)];
        cursor = pos + inserted.length;
      }
      const text = joinFile(lines, br, final);
      if (sec.moveTo !== null) applyMove(tree, sec.path, sec.moveTo, text);
      else tree.now.set(sec.path, text);
    };
  });
}

// ---- Invocation, output and exit codes (SPEC.md sections 1, 2 and 10) ----

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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoved = new Map(tree.movedFrom);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.movedFrom.clear();
      for (const [k, v] of beforeMoved) tree.movedFrom.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const handled = new Set<string>();
  for (const [np, origin] of tree.movedFrom) {
    if (tree.original(origin) !== null && tree.get(np) !== null && tree.get(origin) === null) {
      rows.push({ key: np, line: `R ${origin} -> ${np}` });
      handled.add(np);
      handled.add(origin);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (handled.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
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
