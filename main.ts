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
  /** Successful move edits, as (old path, new path), for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
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

/** Split a file's text into its lines, its line break and whether it ends with one (SPEC.md section 3). */
interface SplitFile {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const lines = text.split(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(f: SplitFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** One line of N: a context line names its index in O, an added line does not. */
interface NewLine {
  text: string;
  ctx: number | null;
}

function normAt(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in the file's lines at this tier (overlaps allowed). */
function occurrences(file: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const want = oldLines.map((l) => normAt(l, tier));
  for (let i = 0; i + oldLines.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (normAt(file[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs, with its positions. */
function firstTier(file: string[], oldLines: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(file, oldLines, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** Replace O at `pos` with N: context lines keep the file's own lines, tier 2 re-indents the rest. */
function spliceLines(file: string[], pos: number, oldLines: string[], next: NewLine[], tier: number): string[] {
  const out = file.slice(0, pos);
  const fLead = leadingWs(file[pos] ?? '');
  const pLead = leadingWs(oldLines[0] ?? '');
  for (const nl of next) {
    if (nl.ctx !== null) out.push(file[pos + nl.ctx]!);
    else if (tier === 2 && nl.text.trim() !== '' && nl.text.startsWith(pLead)) out.push(fLead + nl.text.slice(pLead.length));
    else out.push(nl.text);
  }
  out.push(...file.slice(pos + oldLines.length));
  return out;
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

/** A parsed unified hunk: its old/new lines, its start line and its no-newline mark. */
interface Hunk {
  a: number;
  oldLines: string[];
  next: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
  /** A `\` line follows the section's last `+` line (for created files). */
  lastPlusNoEol: boolean;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_DIFF = /^diff --git a\/(.+?) b\/(.+)$/;

const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

/** A `--- ` / `+++ ` path: text after four characters, to the first tab, spaces trimmed. */
function headerPath(line: string): string | null {
  let p = trimSpaces(line.slice(4).split('\t')[0]!);
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A section's header: paths, create/delete flags. Returns the index after the header. */
function parseUnifiedHeader(lines: string[], start: number, sec: Section, gitOld: string | null, gitNew: string | null): number {
  let i = start;
  const n = lines.length;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let hasPair = false;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  let hasRenameFrom = false;
  let hasRenameTo = false;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (HUNK_HEAD.test(l)) break;
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (!hasPair) {
          pairOld = headerPath(l);
          pairNew = headerPath(lines[i + 1]!);
          hasPair = true;
        }
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      if (!hasPair && !hasRenameTo) {
        renameNew = headerPath(l);
        hasRenameTo = true;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('rename from ')) {
      if (!hasRenameFrom) {
        renameOld = trimSpaces(l.slice('rename from '.length));
        hasRenameFrom = true;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (!hasRenameTo) {
        renameNew = trimSpaces(l.slice('rename to '.length));
        hasRenameTo = true;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.create = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.remove = true;
      i += 1;
      continue;
    }
    i += 1; // index, mode, similarity, Index:, anything else: ignored
  }
  sec.oldPath = hasPair ? pairOld : hasRenameFrom ? renameOld : gitOld;
  sec.newPath = hasPair ? pairNew : hasRenameTo ? renameNew : gitNew;
  if (sec.oldPath === null) sec.create = true;
  if (sec.newPath === null) sec.remove = true;
  return i;
}

/** Build one hunk from its body lines (trailing empty lines already removed). */
function buildHunk(a: number, body: string[], sec: Section): Hunk {
  const oldLines: string[] = [];
  const next: NewLine[] = [];
  let lastKept = -1;
  for (let k = 0; k < body.length; k += 1) {
    const b = body[k]!;
    if (b.startsWith('\\')) continue;
    const kind = b === '' ? ' ' : b[0]!;
    if (kind === ' ') {
      const text = b === '' ? '' : b.slice(1);
      next.push({ text, ctx: oldLines.length });
      oldLines.push(text);
      lastKept = k;
    } else if (kind === '-') {
      oldLines.push(b.slice(1));
    } else if (kind === '+') {
      next.push({ text: b.slice(1), ctx: null });
      lastKept = k;
    }
  }
  const noEol = lastKept >= 0 && lastKept + 1 < body.length && body[lastKept + 1]!.startsWith('\\');
  let lastPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    if (body[k]!.startsWith('+')) lastPlus = k;
  }
  if (lastPlus >= 0) sec.lastPlusNoEol = lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\');
  return { a, oldLines, next, noEol };
}

/** A section's hunks. Returns the index after the last hunk. */
function parseUnifiedHunks(lines: string[], start: number, sec: Section): number {
  let i = start;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    const head = HUNK_HEAD.exec(l);
    if (head !== null) {
      const a = Number(head[1]);
      i += 1;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sec.hunks.push(buildHunk(a, body, sec));
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1; // prose, code fences, anything else between hunks: ignored
  }
  return i;
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length > 0) {
      const found = firstTier(f.lines, h.oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.at[0]!;
      for (const pos of found.at) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const runsToEnd = best + h.oldLines.length === f.lines.length;
      f = { ...f, lines: spliceLines(f.lines, best, h.oldLines, h.next, found.tier) };
      if (runsToEnd) f = { ...f, finalBreak: !h.noEol };
    } else {
      const at = Math.max(0, Math.min(h.a + d, f.lines.length));
      const inserted = h.next.map((nl) => nl.text);
      const lines = [...f.lines.slice(0, at), ...inserted, ...f.lines.slice(at)];
      const atEnd = at === f.lines.length;
      f = { ...f, lines };
      if (atEnd) f = { ...f, finalBreak: !h.noEol };
    }
    d += h.next.length - h.oldLines.length;
  }
  return joinFile(f);
}

/** One unified section is one edit: create, delete, move or change. */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.create) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const added: string[] = [];
      for (const h of sec.hunks) for (const nl of h.next) if (nl.ctx === null) added.push(nl.text);
      tree.now.set(newP, joinFile({ lines: added, br: '\n', finalBreak: added.length > 0 ? !sec.lastPlusNoEol : false }));
      return;
    }
    if (sec.remove) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return;
    if (oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, applyHunks(before, sec.hunks, strict, oldP));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(before, sec.hunks, strict, oldP));
  };
}

/** Read a unified patch into its sections' edits (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = GIT_DIFF.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldPath: null, newPath: null, create: false, remove: false, hunks: [], lastPlusNoEol: false };
      sections.push(sec);
      i += 1;
      i = parseUnifiedHeader(lines, i, sec, m[1]!, m[2]!);
      i = parseUnifiedHunks(lines, i, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { oldPath: null, newPath: null, create: false, remove: false, hunks: [], lastPlusNoEol: false };
      sections.push(sec);
      i = parseUnifiedHeader(lines, i, sec, null, null);
      i = parseUnifiedHunks(lines, i, sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One SEARCH/REPLACE block is one edit: create when old is empty, else replace once. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ lines: [...newLines], br: '\n', finalBreak: newLines.length > 0 }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = firstTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const next: NewLine[] = newLines.map((text) => ({ text, ctx: null }));
    tree.now.set(path, joinFile({ ...f, lines: spliceLines(f.lines, found.at[0]!, oldLines, next, found.tier) }));
  };
}

/** Read SEARCH/REPLACE blocks into edits (SPEC.md section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let k = searchAt - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchAt + 1}`);
    let eq = -1;
    for (let k = searchAt + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    edits.push(srEdit(path, lines.slice(searchAt + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** A V4A chunk: an optional anchor, old/new lines, and whether it is end-of-file. */
interface V4aChunk {
  anchor: string | null;
  oldLines: string[];
  next: NewLine[];
  eof: boolean;
}

interface RawLine {
  text: string;
  idx: number;
}

function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

/** Blank lines at the end of a section are not part of it. */
function trimTrailingBlanks(raw: RawLine[]): void {
  while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
}

/** The first tier with an occurrence at or after `from` (and ending at `endAt`, when set). */
function firstTierFrom(file: string[], oldLines: string[], from: number, strict: boolean, endAt: number | null): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(file, oldLines, t).filter((p) => p >= from && (endAt === null || p + oldLines.length === endAt));
    if (at.length > 0) return { tier: t, pos: at[0]! };
  }
  return null;
}

/** Apply a V4A section's chunks in order, with the cursor, to a file's text. */
function applyV4aChunks(before: string, chunks: V4aChunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let lines = f.lines;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const found = firstTierFrom(lines, [ch.anchor], cursor, strict, null);
      if (found === null) throw new Fail('no-match', path);
      cursor = found.pos + 1;
    }
    if (ch.oldLines.length > 0) {
      const found = firstTierFrom(lines, ch.oldLines, cursor, strict, ch.eof ? lines.length : null);
      if (found === null) throw new Fail('no-match', path);
      lines = spliceLines(lines, found.pos, ch.oldLines, ch.next, found.tier);
      cursor = found.pos + ch.next.length;
    } else {
      const at = ch.eof ? lines.length : cursor;
      const inserted = ch.next.map((nl) => nl.text);
      lines = [...lines.slice(0, at), ...inserted, ...lines.slice(at)];
      cursor = at + inserted.length;
    }
  }
  return joinFile({ ...f, lines });
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinFile({ lines: [...fileLines], br: '\n', finalBreak: fileLines.length > 0 }));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const after = applyV4aChunks(before, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(moveTo, after);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, after);
    }
  };
}

/** Parse one Update File section's lines into its edit. */
function v4aUpdate(path: string, raw: RawLine[], updateIdx: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let hasMoveTo = false;
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const close = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (let k = 0; k < raw.length; k += 1) {
    const r = raw[k]!;
    const text = r.text;
    if (text.startsWith('*** Move to: ')) {
      if (k === 0 && !hasMoveTo) {
        moveTo = trimSpaces(text.slice('*** Move to: '.length));
        hasMoveTo = true;
        continue;
      }
      throw new Exit2(`error: parse ${r.idx + 1}`);
    }
    if (text.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.idx + 1}`);
      cur.eof = true;
      close();
      continue;
    }
    if (text.startsWith('***')) throw new Exit2(`error: parse ${r.idx + 1}`);
    if (text.startsWith('@@')) {
      close();
      const anchor = trimSpaces(text.slice(2));
      cur = { anchor: anchor === '' ? null : anchor, oldLines: [], next: [], eof: false };
      continue;
    }
    if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) cur = { anchor: null, oldLines: [], next: [], eof: false };
      if (text === '' || text.startsWith(' ')) {
        const t = text === '' ? '' : text.slice(1);
        cur.next.push({ text: t, ctx: cur.oldLines.length });
        cur.oldLines.push(t);
      } else if (text.startsWith('-')) {
        cur.oldLines.push(text.slice(1));
      } else {
        cur.next.push({ text: text.slice(1), ctx: null });
      }
      continue;
    }
    throw new Exit2(`error: parse ${r.idx + 1}`);
  }
  close();
  if (chunks.length === 0 && !hasMoveTo) throw new Exit2(`error: parse ${updateIdx + 1}`);
  return v4aUpdateEdit(path, moveTo, chunks, strict);
}

/** Read a V4A patch into its sections' edits (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let k = 0; k < n; k += 1) {
    if (!blank(lines[k]!)) {
      if (first < 0) first = k;
      last = k;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (isV4aSectionStart(l)) {
      const startIdx = i;
      const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      const path = trimSpaces(l.slice(prefix.length));
      i += 1;
      const raw: RawLine[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i += 1;
      }
      trimTrailingBlanks(raw);
      if (kind === 'add') {
        const fileLines: string[] = [];
        for (const r of raw) {
          if (r.text === '') fileLines.push('');
          else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
          else throw new Exit2(`error: parse ${r.idx + 1}`);
        }
        edits.push(v4aAddEdit(path, fileLines));
      } else if (kind === 'delete') {
        if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
        edits.push(v4aDeleteEdit(path));
      } else {
        edits.push(v4aUpdate(path, raw, startIdx, strict));
      }
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...movesBefore);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: a successful move whose old path is gone and whose new path is new
  // replaces its D and A lines with one R line, sorted by the new path.
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const paired = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    if (paired.has(oldP) || paired.has(newP)) continue;
    const oldWas = tree.original(oldP);
    const oldNow = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const newWas = tree.original(newP);
    const newNow = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      paired.add(oldP);
      paired.add(newP);
    }
  }
  for (const p of changed) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  const outRows = rows.map((r) => r.line);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
