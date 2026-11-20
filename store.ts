// The forge's own store: an in-memory model of repositories, refs and raw git objects.
// No network, no clock, no randomness: every id is a deterministic function of an
// incrementing counter or of the bytes it names (git SHA-1).
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen'; // buildScenario().viewer.login, fixed by the contest seed.
export const VIEWER_ID = 1000;
export const ZERO_OID = '0'.repeat(40);
export const DEFAULT_BRANCH = 'main';
const EPOCH = 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario's day one.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer }
export interface TreeEntry { mode: string; name: string; oid: string }

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return createHash('sha1').update(`${type} ${body.length}\u0000`).update(body).digest('hex');
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < b.length) {
    const space = b.indexOf(0x20, i);
    const nul = b.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > b.length) break;
    out.push({
      mode: b.subarray(i, space).toString('ascii'),
      name: b.subarray(space + 1, nul).toString('utf8'),
      oid: b.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return out;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const x = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const y = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(x, y);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }
export function parseCommit(data: Uint8Array): CommitView {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const blank = b.indexOf('\n\n');
  const header = b.subarray(0, blank < 0 ? b.length : blank).toString('utf8');
  const message = blank < 0 ? '' : b.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of header.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(o: {
  tree: string; parents?: string[]; message: string; author?: string; committer?: string; timestamp?: number;
}): Buffer {
  const who = `${o.author ?? `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid>`} ${o.timestamp ?? EPOCH} +0000`;
  const lines = [`tree ${o.tree}`, ...(o.parents ?? []).map((p) => `parent ${p}`), `author ${who}`, `committer ${o.committer ?? who}`, ''];
  return Buffer.from(`${lines.join('\n')}\n${o.message}`, 'utf8');
}

export function parseTag(data: Uint8Array): { object: string; type: string; tag: string; tagger: string } {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const blank = b.indexOf('\n\n');
  const header = b.subarray(0, blank < 0 ? b.length : blank).toString('utf8');
  const m: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp >= 0) m[line.slice(0, sp)] = line.slice(sp + 1);
  }
  return { object: m.object ?? '', type: m.type ?? '', tag: m.tag ?? '', tagger: m.tagger ?? '' };
}

// ---- packfile write (plain objects; the client's reader accepts these) ----
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = { commit: 1, tree: 2, blob: 3, tag: 4 }[type];
  let n = size;
  let first = (code << 4) | (n & 0x0f);
  n = Math.floor(n / 16);
  const bytes: number[] = [];
  while (n > 0) { bytes.push(first | 0x80); first = n & 0x7f; n = Math.floor(n / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: GitObject[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [head];
  for (const o of objects) {
    parts.push(packObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---- packfile read (handles OFS_DELTA and REF_DELTA too) ----
function readVarint(b: Buffer, pos: number): { size: number; next: number; first: number } {
  let byte = b[pos]; const first = byte;
  let size = byte & 0x0f; let shift = 4; let i = pos + 1;
  while (byte & 0x80) {
    byte = b[i++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: i, first };
}
function inflateAt(b: Buffer, offset: number): { data: Buffer; next: number } {
  const r = inflateSync(b.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: r.buffer, next: offset + r.engine.bytesWritten };
}
function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const out: number[] = []; let i = 0;
  const size = (): number => { let v = 0; let s = 0; for (;;) { const x = delta[i++]; v += (x & 0x7f) * 2 ** s; s += 7; if (!(x & 0x80)) return v; } };
  const baseSize = size(); const targetSize = size();
  if (baseSize !== base.length) throw new Error('bad delta base size');
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0; let len = 0;
      for (let bit = 0; bit < 4; bit++) if (op & (1 << bit)) off += delta[i++] * 2 ** (8 * bit);
      for (let bit = 0; bit < 3; bit++) if (op & (4 << bit)) len += delta[i++] * 2 ** (8 * bit);
      if (len === 0) len = 0x10000;
      for (let k = 0; k < len; k++) out.push(base[off + k]);
    } else if (op !== 0) {
      for (let k = 0; k < op; k++) out.push(delta[i++]);
    } else throw new Error('bad delta opcode');
  }
  if (out.length !== targetSize) throw new Error('bad delta target size');
  return Buffer.from(out);
}

/** Parse a received packfile and return its objects (resolving deltas). */
export function readPack(pack: Uint8Array): GitObject[] {
  const b = Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
  if (b.length < 32 || b.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = b.readUInt32BE(8);
  const end = b.length - 20;
  const raw: Array<{ type: number; size: number; data: Buffer; offset: number; baseOffset?: number; baseOid?: string; resolved?: GitObject }> = [];
  const byOffset = new Map<number, typeof raw[number]>();
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const at = pos;
    const h = readVarint(b, pos);
    pos = h.next;
    const type = (h.first >> 4) & 7;
    const e: typeof raw[number] = { type, size: h.size, data: Buffer.alloc(0), offset: at };
    if (type === 6) {
      let byte = b[pos++]; let value = byte & 0x7f;
      while (byte & 0x80) { byte = b[pos++]; value = ((value + 1) * 128) + (byte & 0x7f); }
      e.baseOffset = at - value;
    } else if (type === 7) {
      e.baseOid = b.subarray(pos, pos + 20).toString('hex'); pos += 20;
    }
    const inf = inflateAt(b.subarray(0, end), pos);
    e.data = inf.data; pos = inf.next;
    raw.push(e); byOffset.set(at, e);
  }
  const resolve = (e: typeof raw[number]): GitObject => {
    if (e.resolved) return e.resolved;
    let type: GitObjectType; let data: Buffer;
    if (e.type === 6) {
      const base = byOffset.get(e.baseOffset!);
      if (!base) throw new Error('missing ofs-delta base');
      const r = resolve(base); type = r.type; data = applyDelta(r.data, e.data);
    } else if (e.type === 7) {
      const base = [...byOffset.values()].find((x) => resolve(x) && hashObject(resolve(x).type, resolve(x).data) === e.baseOid);
      if (!base) throw new Error('missing ref-delta base');
      const r = resolve(base); type = r.type; data = applyDelta(r.data, e.data);
    } else {
      type = ({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' } as Record<number, GitObjectType>)[e.type];
      data = e.data;
    }
    e.resolved = { type, data };
    return e.resolved;
  };
  return raw.map(resolve);
}

// ---- store ----
export interface Issue {
  number: number; id: string; title: string; body: string; state: 'open' | 'closed';
  labels: Array<{ name: string; color: string }>; comments: Array<{ id: number; body: string }>;
  createdAt: string;
}
export interface Pull {
  number: number; id: string; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedAt: string | null; mergeSha: string | null;
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
  createdAt: string;
}
export interface Repo {
  id: number; owner: string; name: string; description: string; private: boolean;
  defaultBranch: string; refs: Map<string, string>;
  files: Map<string, Map<string, string>>; // branch -> path -> content
  issues: Issue[]; nextIssue: number; pulls: Pull[]; nextPull: number;
  labels: Map<string, { name: string; color: string }>; createdAt: string;
}

export function repoGlobalId(id: number): string { return Buffer.from(`repository:${id}`).toString('base64'); }
export function issueGlobalId(repoId: number, n: number): string { return Buffer.from(`issue:${repoId}:${n}`).toString('base64'); }
export function pullGlobalId(repoId: number, n: number): string { return Buffer.from(`pull:${repoId}:${n}`).toString('base64'); }
export function commentGlobalId(repoId: number, n: number, i: number): string { return Buffer.from(`comment:${repoId}:${n}:${i}`).toString('base64'); }
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    return { kind: kind ?? '', parts };
  } catch { return null; }
}

export class ForgeStore {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>(); // key: owner/name
  private nextRepoId = 5000;
  private clock = 0;

  private stamp(): string {
    this.clock += 1;
    return new Date((EPOCH + this.clock) * 1000).toISOString();
  }
  private timestamp(): number { this.clock += 1; return EPOCH + this.clock; }

  repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.repoKey(owner, name)); }
  repoById(id: number): Repo | undefined {
    for (const r of this.repos.values()) if (r.id === id) return r;
    return undefined;
  }

  createRepo(name: string, opts: { owner?: string; description?: string; private?: boolean } = {}): { repo?: Repo; error?: string } {
    const owner = opts.owner ?? VIEWER_LOGIN;
    if (this.getRepo(owner, name)) return { error: 'Repository already exists' };
    const repo: Repo = {
      id: this.nextRepoId++, owner, name, description: opts.description ?? '',
      private: opts.private ?? false, defaultBranch: DEFAULT_BRANCH,
      refs: new Map(), files: new Map([[DEFAULT_BRANCH, new Map()]]),
      issues: [], nextIssue: 1, pulls: [], nextPull: 1, labels: new Map(), createdAt: this.stamp(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return { repo };
  }

  putObject(type: GitObjectType, data: Uint8Array): string {
    const oid = hashObject(type, data);
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data: buf });
    return oid;
  }
  getObject(oid: string): GitObject | undefined { return this.objects.get(oid); }

  /** All object ids reachable from the given roots, following commits, trees and tags. */
  reachable(roots: Iterable<string>, stop: Set<string> = new Set()): Set<string> {
    const seen = new Set<string>(); const queue = [...roots];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid) || stop.has(oid)) continue;
      const o = this.objects.get(oid);
      if (!o) continue;
      seen.add(oid);
      if (o.type === 'commit') {
        const c = parseCommit(o.data);
        queue.push(c.tree, ...c.parents);
      } else if (o.type === 'tree') {
        for (const e of parseTree(o.data)) if (e.mode !== '160000') queue.push(e.oid);
      } else if (o.type === 'tag') {
        queue.push(parseTag(o.data).object);
      }
    }
    return seen;
  }

  isAncestor(oldOid: string, newOid: string): boolean {
    if (oldOid === newOid) return true;
    const seen = new Set<string>(); const q = [newOid];
    while (q.length) {
      const oid = q.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const o = this.objects.get(oid);
      if (!o || o.type !== 'commit') continue;
      for (const p of parseCommit(o.data).parents) {
        if (p === oldOid) return true;
        q.push(p);
      }
    }
    return false;
  }

  /** Files of a branch as path -> content; derived from git objects when written by a push. */
  filesOf(repo: Repo, branch: string): Map<string, string> {
    const cached = repo.files.get(branch);
    if (cached) return cached;
    const files = new Map<string, string>();
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip) {
      const commit = this.objects.get(tip);
      if (commit && commit.type === 'commit') this.walkTree(this.objects.get(parseCommit(commit.data).tree), '', files);
    }
    repo.files.set(branch, files);
    return files;
  }
  private walkTree(tree: GitObject | undefined, prefix: string, out: Map<string, string>): void {
    if (!tree || tree.type !== 'tree') return;
    for (const e of parseTree(tree.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      const child = this.objects.get(e.oid);
      if (e.mode === '40000') this.walkTree(child, path, out);
      else if (child && child.type === 'blob') out.set(path, child.data.toString('utf8'));
    }
  }

  /** The path -> content snapshot of a commit object. */
  filesAtCommit(oid: string): Map<string, string> {
    const files = new Map<string, string>();
    const commit = this.objects.get(oid);
    if (commit && commit.type === 'commit') this.walkTree(this.objects.get(parseCommit(commit.data).tree), '', files);
    return files;
  }

  /** Commit a snapshot of `files` to `branch`, returning the new commit id. */
  commitFiles(repo: Repo, branch: string, files: Map<string, string>, message: string, parents?: string[]): string {
    const root = new Map<string, TreeEntry>();
    const dirs = new Map<string, Map<string, TreeEntry>>();
    for (const [path, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const segments = path.split('/');
      const blobOid = this.putObject('blob', Buffer.from(content, 'utf8'));
      if (segments.length === 1) {
        root.set(segments[0]!, { mode: '100644', name: segments[0]!, oid: blobOid });
      } else {
        const dir = segments.slice(0, -1).join('/');
        if (!dirs.has(dir)) dirs.set(dir, new Map());
        dirs.get(dir)!.set(segments[segments.length - 1]!, { mode: '100644', name: segments[segments.length - 1]!, oid: blobOid });
      }
    }
    // deepest directories first
    const treeIds = new Map<string, string>();
    for (const dir of [...dirs.keys()].sort((a, b) => b.split('/').length - a.split('/').length)) {
      const entries = [...dirs.get(dir)!.values()];
      const parts = dir.split('/');
      const name = parts.pop()!;
      const parent = parts.join('/');
      const treeOid = this.putObject('tree', buildTree(entries));
      treeIds.set(dir, treeOid);
      const holder = parent ? dirs.get(parent) : root;
      if (holder) holder.set(name, { mode: '40000', name, oid: treeOid });
      else dirs.set(parent, new Map([[name, { mode: '40000', name, oid: treeOid }]]));
    }
    const rootOid = this.putObject('tree', buildTree([...root.values()]));
    const existing = parents ?? (() => { const t = repo.refs.get(`refs/heads/${branch}`); return t && t !== ZERO_OID ? [t] : []; })();
    const commitOid = this.putObject('commit', buildCommit({ tree: rootOid, parents: existing, message, timestamp: this.timestamp() }));
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.files.set(branch, new Map([...files].map(([k, v]) => [k, v])));
    return commitOid;
  }

  /** Difference of two branches' file maps, as pull-request file entries. */
  diffFiles(repo: Repo, base: string, head: string): Pull['files'] {
    const a = this.filesOf(repo, base); const b = this.filesOf(repo, head);
    const out: Pull['files'] = [];
    for (const [path, content] of b) {
      if (!a.has(path)) out.push({ filename: path, status: 'added', additions: content.split('\n').length, deletions: 0, changes: content.split('\n').length });
      else if (a.get(path) !== content) {
        const add = content.split('\n').length; const del = (a.get(path) ?? '').split('\n').length;
        out.push({ filename: path, status: 'modified', additions: add, deletions: del, changes: add + del });
      }
    }
    for (const [path] of a) if (!b.has(path)) out.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
    return out;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[] = []): { issue?: Issue; error?: string } {
    for (const label of labels) if (!repo.labels.has(label)) return { error: `Label ${label} does not exist` };
    const n = repo.nextIssue++;
    const issue: Issue = {
      number: n, id: issueGlobalId(repo.id, n), title, body, state: 'open',
      labels: labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
      comments: [], createdAt: this.stamp(),
    };
    repo.issues.push(issue);
    return { issue };
  }

  closeIssue(repo: Repo, number: number): Issue | undefined {
    const issue = repo.issues.find((i) => i.number === number);
    if (issue) issue.state = 'closed';
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): { pull?: Pull; error?: string } {
    const headRef = repo.refs.get(`refs/heads/${head}`);
    const baseRef = repo.refs.get(`refs/heads/${base}`);
    if (!headRef || !baseRef) return { error: 'Branch not found' };
    const n = repo.nextPull++;
    const pull: Pull = {
      number: n, id: pullGlobalId(repo.id, n), title, body, state: 'open', merged: false,
      mergedAt: null, mergeSha: null,
      head: { ref: head, sha: headRef }, base: { ref: base, sha: baseRef },
      files: this.diffFiles(repo, base, head), createdAt: this.stamp(),
    };
    repo.pulls.push(pull);
    return { pull };
  }

  /** Squash-merge a pull request; 405 when the base and head changed the same file differently. */
  mergePull(repo: Repo, number: number): { status: 'ok' | 'notfound' | 'conflict'; pull?: Pull; sha?: string } {
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) return { status: 'notfound' };
    if (pull.merged) return { status: 'ok', pull, sha: pull.mergeSha ?? undefined };
    const baseFiles = this.filesOf(repo, pull.base.ref);
    const headFiles = this.filesOf(repo, pull.head.ref);
    // Conflict: the head changed a path that the base has changed since the pull was opened,
    // and the two sides now disagree. Compare against the base tip remembered at PR creation.
    const ancestorFiles = this.filesAtCommit(pull.base.sha);
    for (const [path, value] of headFiles) {
      const original = ancestorFiles.get(path);
      const current = baseFiles.get(path);
      if (original !== undefined && value !== original && current !== undefined && current !== original && value !== current) {
        return { status: 'conflict' };
      }
      if (original === undefined && current !== undefined && value !== current && !baseFiles.has(path)) {
        // both sides added the same path with different bytes
        return { status: 'conflict' };
      }
    }
    const merged = new Map(baseFiles);
    for (const [path, value] of headFiles) merged.set(path, value);
    const sha = this.commitFiles(repo, pull.base.ref, merged, `Merge pull request #${number} from ${pull.head.ref}`);
    pull.state = 'closed'; pull.merged = true; pull.mergedAt = this.stamp(); pull.mergeSha = sha;
    pull.base.sha = sha;
    return { status: 'ok', pull, sha };
  }
}
