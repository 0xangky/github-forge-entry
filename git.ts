// Git smart HTTP: v2/v0 upload-pack and v0 receive-pack, implemented directly on the
// store's object model. No git binary, no dependency outside node:zlib/crypto (in store.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeStore, parseCommit, parseTag, readPack, writePack, ZERO_OID, type GitObject, type Repo } from './store.ts';

const U_RESULT = 'application/x-git-upload-pack-result';
const R_RESULT = 'application/x-git-receive-pack-result';
const U_ADV = 'application/x-git-upload-pack-advertisement';
const R_ADV = 'application/x-git-receive-pack-advertisement';

function pkt(payload: string | Uint8Array): Buffer {
  const b = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const h = Buffer.allocUnsafe(4);
  h.write((b.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([h, b]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface ParsedPkt { lines: string[]; consumed: number }
function parsePackets(body: Uint8Array, stopAtFlush = true): ParsedPkt {
  const b = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const lines: string[] = [];
  let pos = 0;
  while (pos + 4 <= b.length) {
    const len = parseInt(b.subarray(pos, pos + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len < 1 || len > b.length - pos) break;
    if (len === 0) { pos += 4; if (stopAtFlush && lines.length) break; continue; } // flush
    if (len === 1 || len === 2) { pos += 4; continue; } // delim / response-end
    const payload = b.subarray(pos + 4, pos + len);
    lines.push(payload.toString('utf8').replace(/\n$/, ''));
    pos += len;
  }
  return { lines, consumed: pos };
}

function reply(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}
function text(res: ServerResponse, status: number, body: string): void {
  reply(res, status, 'text/plain; charset=utf-8', Buffer.from(body, 'utf8'));
}

function refLines(store: ForgeStore, repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [];
  const refs = [...repo.refs].filter(([, oid]) => oid !== ZERO_OID);
  const first = refs.find(([name]) => name === 'refs/heads/main') ?? refs[0];
  const peeled: string[] = [];
  if (first) {
    parts.push(pkt(`${first[1]} ${first[0]}\u0000${caps}\n`));
    if (first[0] === 'HEAD') parts.push(pkt(`${first[1]} HEAD\n`));
  } else {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  }
  for (const [name, oid] of refs) {
    if (name === first?.[0]) continue;
    parts.push(pkt(`${oid} ${name}\n`));
  }
  if (!first) parts.push(pkt(`${ZERO_OID} HEAD\n`));
  else if (first[0] !== 'HEAD') parts.push(pkt(`${first[1]} HEAD\n`));
  for (const [name, oid] of refs) {
    if (!name.startsWith('refs/tags/')) continue;
    const tag = store.getObject(oid);
    if (tag?.type === 'tag') peeled.push(pkt(`${parseTag(tag.data).object} ${name}^{}\n`));
  }
  parts.push(...peeled, FLUSH);
  return Buffer.concat(parts);
}

function advertisement(store: ForgeStore, repo: Repo, service: string, v2: boolean): Buffer {
  if (v2) {
    return Buffer.concat([
      pkt('version 2\n'),
      pkt('agent=github-forge/1.0\n'),
      pkt('ls-refs\n'),
      pkt('fetch=shallow wait-for-done filter\n'),
      pkt('object-format=sha1\n'),
      FLUSH,
    ]);
  }
  const preamble = `# service=${service}\n`;
  if (service === 'git-receive-pack') {
    const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet';
    return Buffer.concat([pkt(preamble), FLUSH, refLines(store, repo, service, caps)]);
  }
  const caps = 'side-band-64k ofs-delta shallow thin-pack no-progress multi_ack_detailed symref=HEAD:refs/heads/main';
  return Buffer.concat([pkt(preamble), FLUSH, refLines(store, repo, service, caps)]);
}

function lsRefs(store: ForgeStore, repo: Repo, lines: string[]): Buffer {
  let peel = false; let symrefs = false; const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const tip = repo.refs.get('refs/heads/main') ?? [...repo.refs.values()][0] ?? ZERO_OID;
  const out: Buffer[] = [];
  if (keep('HEAD')) {
    out.push(pkt(`${tip} HEAD${symrefs || prefixes.length === 0 ? ' symref-target:refs/heads/main' : ''}\n`));
  }
  for (const [name, oid] of [...repo.refs].sort(([a], [b]) => a.localeCompare(b))) {
    if (!keep(name) || oid === ZERO_OID) continue;
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const tag = store.getObject(oid);
      if (tag?.type === 'tag') line += ` peeled:${parseTag(tag.data).object}`;
    }
    out.push(pkt(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

function commitChain(store: ForgeStore, want: string, limit: number, skip: Set<string>): string[] {
  const out: string[] = []; const seen = new Set<string>(); const q = [want];
  while (q.length && out.length < limit) {
    const oid = q.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const o = store.getObject(oid);
    if (!o) continue;
    if (o.type !== 'commit') continue;
    const parents = parseCommit(o.data).parents;
    if (skip.has(oid)) { for (const p of parents) q.push(p); continue; }
    out.push(oid);
    for (const p of parents) q.push(p);
  }
  return out;
}

function fetchObjects(store: ForgeStore, wants: string[], haves: string[], shallow: string[], depth: number | undefined) {
  const shallowSet = new Set(shallow);
  let oids: string[]; const shallowInfo: string[] = [];
  if (depth !== undefined) {
    const commits: string[] = []; const seen = new Set<string>();
    for (const want of wants) {
      const limit = Math.max(0, depth - (shallowSet.has(want) ? 1 : 0));
      for (const c of commitChain(store, want, limit, shallowSet)) {
        if (!seen.has(c)) { seen.add(c); commits.push(c); }
      }
    }
    const commitSet = new Set(commits);
    const oidSet = new Set<string>(commits);
    for (const c of commits) {
      const o = store.getObject(c);
      if (!o) continue;
      const tree = parseCommit(o.data).tree;
      for (const id of store.reachable([tree])) oidSet.add(id);
    }
    for (const oid of shallowSet) {
      const o = store.getObject(oid);
      if (o?.type === 'commit') {
        const parents = parseCommit(o.data).parents;
        if (parents.some((p) => commitSet.has(p))) shallowInfo.push(`unshallow ${oid}`);
      }
    }
    for (const c of commits) {
      const o = store.getObject(c);
      if (o?.type === 'commit' && parseCommit(o.data).parents.some((p) => !commitSet.has(p))) shallowInfo.push(`shallow ${c}`);
    }
    oids = [...oidSet];
  } else {
    const stop = store.reachable(haves);
    oids = [...store.reachable(wants, stop)];
  }
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const o = store.getObject(oid);
    if (o) objects.push(o);
  }
  return { objects, shallowInfo };
}

function packBody(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const size = 32 * 1024;
  for (let i = 0; i < pack.length; i += size) {
    const part = pack.subarray(i, Math.min(i + size, pack.length));
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), part])));
  }
  if (chunks.length === 0) chunks.push(pkt(Buffer.concat([Buffer.from([1]), pack])));
  return chunks;
}

function handleFetch(store: ForgeStore, res: ServerResponse, body: Uint8Array, v2: boolean): void {
  const { lines } = parsePackets(body, false);
  const start = lines.findIndex((l) => l === 'fetch' || l === 'command=fetch');
  const args = lines.slice(start + 1);
  const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.split(' ')[1] ?? '');
    else if (line.startsWith('have ')) haves.push(line.split(' ')[1] ?? '');
    else if (line.startsWith('shallow ')) shallow.push(line.split(' ')[1] ?? '');
    else if (line.startsWith('deepen ')) depth = Number(line.split(' ')[1]);
  }
  const { objects, shallowInfo } = fetchObjects(store, wants, haves, shallow, depth);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (v2) {
    parts.push(pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH);
    if (shallowInfo.length) {
      parts.push(pkt('shallow-info\n'));
      for (const line of shallowInfo) parts.push(pkt(`${line}\n`));
      parts.push(FLUSH);
    }
    parts.push(pkt('packfile\n'), ...packBody(pack), FLUSH);
  } else {
    parts.push(pkt('NAK\n'));
    for (const line of shallowInfo) parts.push(pkt(`${line}\n`));
    parts.push(...packBody(pack), FLUSH);
  }
  reply(res, 200, U_RESULT, Buffer.concat(parts));
}

interface RefDecision { ref: string; ok: boolean; reason: string; old: string; neu: string }

function handleReceive(
  store: ForgeStore, res: ServerResponse, body: Uint8Array,
  decide: (d: RefDecision[]) => RefDecision[], apply: (d: RefDecision[]) => void,
): void {
  const { lines, consumed } = parsePackets(body);
  const commands = lines.map((l) => l.replace(/\u0000.*$/, '')).filter((l) => /^[0-9a-f]{40} [0-9a-f]{40} refs\//.test(l));
  const sideband = lines.some((l) => l.includes('side-band-64k'));
  try {
    const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    let start = consumed;
    // A command list may be terminated by more than one flush packet.
    while (start + 4 <= bytes.length && bytes.subarray(start, start + 4).toString('ascii') === '0000') start += 4;
    const packBytes = bytes.subarray(start);
    if (packBytes.length >= 32) {
      for (const object of readPack(packBytes)) store.putObject(object.type, object.data);
    }
  } catch {
    const failure = [pkt('unpack pack parse failure\n'), FLUSH];
    const banded = sideband ? failure.map((p) => pkt(Buffer.concat([Buffer.from([1]), p.subarray(4)]))) : failure;
    return reply(res, 200, R_RESULT, Buffer.concat(banded));
  }
  const decisions: RefDecision[] = commands.map((command) => {
    const [oldOid, newOid, ref] = command.split(' ');
    return { ref: ref ?? '', ok: true, reason: '', old: oldOid ?? ZERO_OID, neu: newOid ?? ZERO_OID };
  });
  const decided = decide(decisions);
  const reportLines = ['unpack ok', ...decided.map((d) => (d.ok ? `ok ${d.ref}` : `ng ${d.ref} ${d.reason}`))];
  apply(decided);
  if (sideband) {
    const banded = reportLines.map((l) => pkt(Buffer.concat([Buffer.from([1]), Buffer.from(`${l}\n`, 'utf8')])));
    banded.push(FLUSH);
    return reply(res, 200, R_RESULT, Buffer.concat(banded));
  }
  reply(res, 200, R_RESULT, Buffer.concat([...reportLines.map((l) => pkt(`${l}\n`)), FLUSH]));
}

/** Handle one smart-HTTP request. Returns false when the path is not a git service. */
export function handleGit(store: ForgeStore, req: IncomingMessage, res: ServerResponse, pathname: string, body: Uint8Array): boolean {
  const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (!m) return false;
  const owner = decodeURIComponent(m[1] ?? '');
  const name = decodeURIComponent(m[2] ?? '');
  const rest = m[3] ?? '';
  const repo = store.getRepo(owner, name);
  if (!repo) { text(res, 404, 'Not Found'); return true; }
  const method = req.method ?? 'GET';
  const service = (() => {
    try { return new URL(req.url ?? '/', 'http://x').searchParams.get('service') ?? ''; } catch { return ''; }
  })();
  const v2 = (req.headers['git-protocol'] ?? '').toString().toLowerCase() === 'version=2';

  if (method === 'GET' && rest === '/info/refs') {
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { text(res, 404, 'Not Found'); return true; }
    const isV2 = service === 'git-upload-pack' && v2;
    reply(res, 200, service === 'git-upload-pack' ? U_ADV : R_ADV, advertisement(store, repo, service, isV2));
    return true;
  }
  if (method === 'POST' && rest === '/git-upload-pack') {
    const { lines } = parsePackets(body, false);
    if (lines[0] === 'command=ls-refs' || lines.includes('command=ls-refs')) {
      const after = lines.slice(lines.indexOf('command=ls-refs') + 1);
      reply(res, 200, U_RESULT, lsRefs(store, repo, after));
    } else if (lines[0] === 'command=fetch' || lines.includes('command=fetch')) {
      handleFetch(store, res, body, v2);
    } else {
      reply(res, 200, U_RESULT, FLUSH);
    }
    return true;
  }
  if (method === 'POST' && rest === '/git-receive-pack') {
    const decide = (decisions: RefDecision[]): RefDecision[] => decisions.map((d) => {
      const current = repo.refs.get(d.ref);
      if (d.neu === ZERO_OID) {
        return !current || current === d.old ? d : { ...d, ok: false, reason: 'reference is different' };
      }
      if (d.old === ZERO_OID) {
        return current && current !== ZERO_OID ? { ...d, ok: false, reason: 'already exists' } : d;
      }
      if (current !== d.old) return { ...d, ok: false, reason: 'stale info' };
      return store.isAncestor(d.old, d.neu) ? d : { ...d, ok: false, reason: 'non-fast-forward' };
    });
    const apply = (decisions: RefDecision[]): void => {
      for (const d of decisions) {
        if (!d.ok) continue;
        if (d.neu === ZERO_OID) { repo.refs.delete(d.ref); repo.files.delete(d.ref.slice(11)); }
        else repo.refs.set(d.ref, d.neu);
      }
    };
    handleReceive(store, res, body, decide, apply);
    return true;
  }
  text(res, 404, 'Not Found');
  return true;
}
