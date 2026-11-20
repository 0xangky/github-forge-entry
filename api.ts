// The three API surfaces: REST v3, GraphQL v4 and MCP, all backed by the same ForgeStore.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForgeStore, VIEWER_LOGIN, VIEWER_ID, DEFAULT_BRANCH, hashObject,
  repoGlobalId, issueGlobalId, pullGlobalId, decodeGlobalId,
  type Repo, type Issue, type Pull,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}
function fail(res: ServerResponse, status: number, message: string): void { sendJson(res, status, { message }); }

interface ApiRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  host: string;
  bodyText: string;
  json: unknown;
  jsonError: boolean;
}

// ---------------------------------------------------------------- REST v3
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, node_id: repoGlobalId(repo.id), name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User', node_id: Buffer.from(`user:${VIEWER_ID}`).toString('base64') },
    private: repo.private, description: repo.description, default_branch: repo.defaultBranch,
    has_issues: true, has_projects: false, has_wiki: false, has_downloads: false,
    fork: false, archived: false, disabled: false, size: 0, language: null,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt, updated_at: repo.createdAt, pushed_at: repo.createdAt,
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: issue.id, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state, labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    comments: issue.comments.length, comments_url: '', created_at: issue.createdAt, updated_at: issue.createdAt,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id, node_id: pull.id, number: pull.number, title: pull.title, body: pull.body,
    state: pull.state, merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeSha,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${VIEWER_LOGIN}:${pull.head.ref}`, user: { login: VIEWER_LOGIN } },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${VIEWER_LOGIN}:${pull.base.ref}`, user: { login: VIEWER_LOGIN } },
    comments: 0, commits: 1, changed_files: pull.files.length,
    created_at: pull.createdAt, updated_at: pull.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function b64decode(value: string): Buffer { return Buffer.from(value, 'base64'); }

/** Handle a REST route. Returns true when the path belonged to /api/v3. */
export function handleRest(store: ForgeStore, req: ApiRequest, res: ServerResponse): boolean {
  const { method, pathname, query, json, jsonError } = req;
  const prefix = '/api/v3';
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
  const rel = pathname === prefix ? '/' : pathname.slice(prefix.length);
  const origin = `http://${req.host}`;

  if (jsonError) { fail(res, 400, 'Problem parsing JSON'); return true; }

  if (method === 'GET' && (rel === '/' || rel === '')) {
    sendJson(res, 200, {
      current_user_url: `${origin}/api/v3/user`,
      repository_url: `${origin}/api/v3/repos`,
      rate_limit_url: `${origin}/api/v3/rate_limit`,
    }, { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo' });
    return true;
  }
  if (method === 'GET' && rel === '/meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false, ssh_key_fingerprints: {}, hooks: [], git: [], web: [] });
    return true;
  }
  if (method === 'GET' && rel === '/user') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: Buffer.from(`user:${VIEWER_ID}`).toString('base64'), type: 'User', name: 'Ada Iversen', email: `${VIEWER_LOGIN}@example.invalid`, private: false, public_repos: store.repos.size });
    return true;
  }
  if (method === 'GET' && rel === '/user/repos') {
    const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
    const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
    const all = [...store.repos.values()].filter((r) => r.owner === VIEWER_LOGIN);
    const start = (page - 1) * perPage;
    const items = all.slice(start, start + perPage).map(repoJson);
    const headers: Record<string, string> = {};
    if (start + perPage < all.length) {
      headers.link = `<${origin}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"`;
    }
    sendJson(res, 200, items, headers);
    return true;
  }
  if (method === 'POST' && rel === '/user/repos') {
    const body = asRecord(json);
    const name = text(body.name);
    if (!name) { fail(res, 422, 'Repository name is required'); return true; }
    const result = store.createRepo(name, { description: text(body.description), private: body.private === true });
    if (!result.repo) { fail(res, 422, result.error ?? 'Repository already exists'); return true; }
    sendJson(res, 201, repoJson(result.repo));
    return true;
  }

  // /repos/{owner}/{repo}/...
  const m = /^\/repos\/([^/]+)\/([^/]+)((?:\/.*)?)$/.exec(rel);
  if (!m) { fail(res, 404, 'Not Found'); return true; }
  const owner = decodeURIComponent(m[1] ?? '');
  const repoName = decodeURIComponent(m[2] ?? '');
  const sub = m[3] ?? '';
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  if (!repo) { fail(res, 404, 'Not Found'); return true; }

  if (sub === '') {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
    if (method === 'PATCH') {
      const body = asRecord(json);
      if ('description' in body) repo.description = text(body.description);
      if ('private' in body) repo.private = body.private === true;
      sendJson(res, 200, repoJson(repo)); return true;
    }
    if (method === 'DELETE') { store.repos.delete(`${owner}/${repoName}`); res.writeHead(204, { 'content-length': 0 }); res.end(); return true; }
  }

  if (method === 'GET' && sub === '/branches') {
    const items = [...repo.refs].filter(([name, oid]) => name.startsWith('refs/heads/') && oid !== '0'.repeat(40))
      .map(([name, sha]) => ({ name: name.slice(11), commit: { sha, url: '' }, protected: false }));
    if (!items.some((b) => b.name === repo.defaultBranch)) {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      items.unshift({ name: repo.defaultBranch, commit: { sha: tip ?? '0'.repeat(40), url: '' }, protected: false });
    }
    sendJson(res, 200, items); return true;
  }
  const branchMatch = /^\/branches\/([^/]+)$/.exec(sub);
  if (method === 'GET' && branchMatch) {
    const name = decodeURIComponent(branchMatch[1] ?? '');
    const sha = repo.refs.get(`refs/heads/${name}`);
    if (!sha) { fail(res, 404, 'Branch not found'); return true; }
    sendJson(res, 200, { name, commit: { sha }, protected: false }); return true;
  }
  if (method === 'POST' && sub === '/git/refs') {
    const body = asRecord(json);
    const ref = text(body.ref); const sha = text(body.sha);
    if (!ref.startsWith('refs/') || !sha) { fail(res, 422, 'Invalid ref'); return true; }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha, type: 'commit' } }); return true;
  }
  const gitRefMatch = /^\/git\/refs\/heads\/(.+)$/.exec(sub);
  if (method === 'GET' && gitRefMatch) {
    const name = decodeURIComponent(gitRefMatch[1] ?? '');
    const sha = repo.refs.get(`refs/heads/${name}`);
    if (!sha) { fail(res, 404, 'Not Found'); return true; }
    sendJson(res, 200, { ref: `refs/heads/${name}`, object: { sha, type: 'commit' } }); return true;
  }
  if (method === 'GET' && sub === '/commits') {
    let tip = query.get('sha') ?? repo.defaultBranch;
    let oid = repo.refs.get(`refs/heads/${tip}`) ?? tip;
    if (!store.getObject(oid)) oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
    const out: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    while (oid && store.getObject(oid) && !seen.has(oid)) {
      seen.add(oid);
      const obj = store.getObject(oid)!;
      if (obj.type !== 'commit') break;
      const data = obj.data.toString('utf8');
      const message = data.slice(data.indexOf('\n\n') + 2);
      const author = /^author (.*)$/m.exec(data)?.[1] ?? '';
      out.push({ sha: oid, commit: { message, author: { name: author.replace(/ <.*/, ''), email: /<([^>]*)>/.exec(author)?.[1] ?? '' }, committer: { name: author.replace(/ <.*/, '') } }, parents: [...data.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((x) => ({ sha: x[1] })) });
      const parent = /^parent ([0-9a-f]{40})$/m.exec(data)?.[1];
      oid = parent ?? '';
    }
    sendJson(res, 200, out); return true;
  }

  // contents
  if (sub === '/contents' || sub.startsWith('/contents/')) {
    const rawPath = sub.startsWith('/contents/') ? sub.slice('/contents/'.length) : '';
    const filePath = rawPath.split('/').map(decodeURIComponent).join('/');
    if (method === 'PUT') {
      const body = asRecord(json);
      const branch = text(body.branch) || repo.defaultBranch;
      const files = new Map(store.filesOf(repo, branch));
      const current = files.get(filePath);
      const providedSha = text(body.sha);
      if (providedSha) {
        const expected = current === undefined ? '' : hashObject('blob', Buffer.from(current, 'utf8'));
        if (providedSha !== expected) { fail(res, 409, 'sha does not match the current file'); return true; }
      }
      const content = b64decode(text(body.content)).toString('utf8');
      files.set(filePath, content);
      const commitSha = store.commitFiles(repo, branch, files, text(body.message) || 'Update file');
      const blobSha = hashObject('blob', Buffer.from(content, 'utf8'));
      sendJson(res, current === undefined ? 201 : 200, {
        content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: Buffer.byteLength(content, 'utf8'), encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64'), type: 'file' },
        commit: { sha: commitSha, message: text(body.message) },
      });
      return true;
    }
    if (method === 'GET') {
      const ref = query.get('ref');
      const branch = ref && repo.refs.has(`refs/heads/${ref}`) ? ref : (ref ?? repo.defaultBranch);
      const files = store.filesOf(repo, branch);
      if (filePath && files.has(filePath)) {
        const content = files.get(filePath)!;
        sendJson(res, 200, {
          type: 'file', encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64'),
          sha: hashObject('blob', Buffer.from(content, 'utf8')), size: Buffer.byteLength(content, 'utf8'),
          name: filePath.split('/').pop(), path: filePath,
        });
        return true;
      }
      const prefix = filePath ? `${filePath}/` : '';
      const children = [...files.keys()].filter((p) => p.startsWith(prefix));
      if (children.length) {
        const names = new Set(children.map((p) => p.slice(prefix.length).split('/')[0] ?? ''));
        const items: Array<Record<string, unknown>> = [];
        for (const name of [...names].sort()) {
          const path = `${prefix}${name}`;
          const isDir = children.some((p) => p.startsWith(`${path}/`));
          const content = files.get(path);
          items.push({
            type: isDir ? 'dir' : 'file', name, path,
            sha: isDir ? hashObject('tree', Buffer.from(path)) : hashObject('blob', Buffer.from(content ?? '', 'utf8')),
            size: isDir ? 0 : Buffer.byteLength(content ?? '', 'utf8'),
          });
        }
        sendJson(res, 200, items); return true;
      }
      fail(res, 404, 'Not Found'); return true;
    }
    if (method === 'DELETE') {
      const body = asRecord(json);
      const branch = text(body.branch) || repo.defaultBranch;
      const files = new Map(store.filesOf(repo, branch));
      if (!files.delete(filePath)) { fail(res, 404, 'Not Found'); return true; }
      const sha = store.commitFiles(repo, branch, files, text(body.message) || 'Delete file');
      sendJson(res, 200, { commit: { sha }, content: null }); return true;
    }
  }

  if (method === 'POST' && sub === '/labels') {
    const body = asRecord(json);
    const name = text(body.name);
    if (!name) { fail(res, 422, 'Label name is required'); return true; }
    repo.labels.set(name, { name, color: text(body.color) || 'ededed' });
    sendJson(res, 201, { id: repo.labels.size, name, color: text(body.color) || 'ededed', default: false }); return true;
  }

  if (method === 'POST' && sub === '/issues') {
    const body = asRecord(json);
    const labels = Array.isArray(body.labels) ? body.labels.map((l) => (typeof l === 'string' ? l : text(asRecord(l).name))) : [];
    const result = store.createIssue(repo, text(body.title), text(body.body), labels);
    if (!result.issue) { fail(res, 422, result.error ?? 'Invalid issue'); return true; }
    sendJson(res, 201, issueJson(repo, result.issue)); return true;
  }
  if (method === 'GET' && sub === '/issues') {
    const state = query.get('state') ?? 'open';
    let items = repo.issues.filter((i) => state === 'all' || i.state === state);
    const direction = query.get('direction') ?? (query.get('sort') === 'created' ? 'asc' : 'desc');
    items = [...items].sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);
    if (query.has('per_page')) items = items.slice(0, Math.max(1, Number(query.get('per_page')) || 30));
    sendJson(res, 200, items.map((i) => issueJson(repo, i))); return true;
  }
  const issueMatch = /^\/issues\/(\d+)(?:\/(comments))?$/.exec(sub);
  if (issueMatch) {
    const number = Number(issueMatch[1]);
    const issue = repo.issues.find((i) => i.number === number);
    if (!issue) { fail(res, 404, 'Not Found'); return true; }
    if (issueMatch[2] === 'comments') {
      if (method === 'POST') {
        const body = asRecord(json);
        const id = issue.comments.length + 1;
        issue.comments.push({ id, body: text(body.body) });
        sendJson(res, 201, { id, body: text(body.body), user: { login: VIEWER_LOGIN }, created_at: issue.createdAt }); return true;
      }
      if (method === 'GET') { sendJson(res, 200, issue.comments.map((c, i) => ({ id: c.id, node_id: '', body: c.body, user: { login: VIEWER_LOGIN }, created_at: issue.createdAt }))); return true; }
    } else if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue)); return true;
    } else if (method === 'PATCH') {
      const body = asRecord(json);
      if (typeof body.state === 'string') issue.state = body.state === 'closed' ? 'closed' : 'open';
      sendJson(res, 200, issueJson(repo, issue)); return true;
    }
  }

  if (method === 'POST' && sub === '/pulls') {
    const body = asRecord(json);
    const result = store.createPull(repo, text(body.title), text(body.body), text(body.head), text(body.base));
    if (!result.pull) { fail(res, 422, result.error ?? 'Invalid pull request'); return true; }
    sendJson(res, 201, pullJson(repo, result.pull)); return true;
  }
  if (method === 'GET' && sub === '/pulls') {
    const state = query.get('state') ?? 'open';
    const items = repo.pulls.filter((p) => state === 'all' || p.state === state);
    if (query.has('per_page')) items.slice(0, Math.max(1, Number(query.get('per_page')) || 30));
    sendJson(res, 200, items.map((p) => pullJson(repo, p))); return true;
  }
  const pullMatch = /^\/pulls\/(\d+)(?:\/(files|merge))?$/.exec(sub);
  if (pullMatch) {
    const number = Number(pullMatch[1]);
    const action = pullMatch[2];
    if (action === 'merge' && method === 'PUT') {
      const result = store.mergePull(repo, number);
      if (result.status === 'notfound') { fail(res, 404, 'Pull request not found'); return true; }
      if (result.status === 'conflict') { fail(res, 405, 'Pull request is conflicted'); return true; }
      sendJson(res, 200, { sha: result.sha, merged: true, message: `Squashed and merged pull request #${number}` }); return true;
    }
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) { fail(res, 404, 'Not Found'); return true; }
    if (action === 'files' && method === 'GET') { sendJson(res, 200, pull.files); return true; }
    if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return true; }
  }
  fail(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------- GraphQL (a small, targeted executor)
interface Selection { name: string; alias: string; args: Record<string, unknown>; children: Selection[] }

/** Read one GraphQL value (string, number, enum, list or input object) starting at `at`. */
function readValue(src: string, at: number): { value: unknown; next: number } {
  let i = at;
  const skip = (): void => { while (i < src.length && /[\s,]/.test(src[i]!)) i++; };
  skip();
  const ch = src[i] ?? '';
  if (ch === '"' || ch === "'") {
    const quote = ch; i++; let out = '';
    while (i < src.length) {
      const c = src[i++]!;
      if (c === '\\') { out += src[i++] ?? ''; continue; }
      if (c === quote) break;
      out += c;
    }
    return { value: out, next: i };
  }
  if (ch === '[') {
    i++; const list: unknown[] = [];
    for (;;) { skip(); if (src[i] === ']' || i >= src.length) { i++; break; } const r = readValue(src, i); list.push(r.value); i = r.next; }
    return { value: list, next: i };
  }
  if (ch === '{') {
    i++; const obj: Record<string, unknown> = {};
    for (;;) {
      skip();
      if (src[i] === '}' || i >= src.length) { i++; break; }
      let key: string;
      if (src[i] === '"' || src[i] === "'") {
        const kr = readValue(src, i); key = String(kr.value); i = kr.next;
      } else {
        const s = i; while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
        key = src.slice(s, i);
      }
      skip();
      if (src[i] === ':') i++;
      const r = readValue(src, i); obj[key] = r.value; i = r.next;
    }
    return { value: obj, next: i };
  }
  const s = i;
  while (i < src.length && !/[\s,)\]}]/.test(src[i]!)) i++;
  const token = src.slice(s, i);
  if (token === 'true') return { value: true, next: i };
  if (token === 'false') return { value: false, next: i };
  if (token === 'null') return { value: null, next: i };
  if (/^-?\d+(\.\d+)?$/.test(token)) return { value: Number(token), next: i };
  return { value: token, next: i };
}

/** Parse an argument list, substituting variables textually before reading values. */
function parseArgs(text: string, vars: Record<string, unknown>): Record<string, unknown> {
  if (!text.trim()) return {};
  const replaced = text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, key: string) => JSON.stringify(vars[key] ?? null));
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < replaced.length) {
    while (i < replaced.length && /[\s,]/.test(replaced[i]!)) i++;
    if (i >= replaced.length) break;
    const s = i;
    while (i < replaced.length && /[A-Za-z0-9_]/.test(replaced[i]!)) i++;
    const key = replaced.slice(s, i);
    while (i < replaced.length && /\s/.test(replaced[i]!)) i++;
    if (replaced[i] === ':') i++;
    const r = readValue(replaced, i);
    if (key) out[key] = r.value;
    i = r.next;
  }
  return out;
}

function parseSelections(src: string, vars: Record<string, unknown> = {}): Selection[] {
  const out: Selection[] = [];
  let i = 0;
  const skip = (): void => { while (i < src.length && /[\s,]/.test(src[i]!)) i++; };
  const readName = (): string => { const s = i; while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++; return src.slice(s, i); };
  const readBalanced = (open: string, close: string): string => {
    let depth = 0; let quote = ''; const s = i;
    for (; i < src.length; i++) {
      const ch = src[i]!;
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) { i++; return src.slice(s, i); } }
    }
    return src.slice(s);
  };
  while (i < src.length) {
    skip();
    if (i >= src.length) break;
    if (src.startsWith('...', i)) {
      i += 3; skip(); readName(); skip(); readName(); skip();
      if (src[i] === '{') out.push(...parseSelections(readBalanced('{', '}'), vars));
      continue;
    }
    if (src[i] === '}') { i++; break; }
    let name = readName();
    if (!name) { i++; continue; }
    let alias = name;
    skip();
    if (src[i] === ':') { i++; skip(); alias = name; name = readName(); }
    let args: Record<string, unknown> = {};
    skip();
    if (src[i] === '(') args = parseArgs(readBalanced('(', ')').slice(1, -1), vars);
    skip();
    let children: Selection[] = [];
    if (src[i] === '{') children = parseSelections(readBalanced('{', '}'), vars);
    out.push({ name, alias, args, children });
  }
  return out;
}
const CHILD_TYPES: Record<string, string> = {
  viewer: 'User', owner: 'User', user: 'User', repository: 'Repository', node: 'Node',
  defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest',
  pullRequests: 'PullRequestConnection', nodes: 'Node', pageInfo: 'PageInfo', files: 'PullRequestFileConnection',
  commentEdge: 'IssueCommentEdge', createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload',
  createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload',
  addComment: 'AddCommentPayload', comment: 'IssueComment', headRef: 'Ref', baseRef: 'Ref',
};
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'repository', 'labels', 'comments', 'createdAt', 'updatedAt', 'author', 'url'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'description', 'url'],
  SearchType: [],
};
const SEARCH_TYPES = ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION', 'WIKI'];

function issueGql(repo: Repo, i: Issue): Record<string, unknown> {
  return { id: i.id, number: i.number, title: i.title, state: i.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN', body: i.body, createdAt: i.createdAt, labels: { nodes: i.labels.map((l) => ({ name: l.name })), __nodeType: 'Label' } };
}
function pullGql(repo: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id, number: p.number, state: p.merged ? 'MERGED' : p.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
    merged: p.merged, headRefName: p.head.ref, baseRefName: p.base.ref, mergeable: 'MERGEABLE',
    title: p.title, body: p.body, createdAt: p.createdAt, mergeCommit: p.mergeSha ? { oid: p.mergeSha } : null,
    files: { nodes: p.files.map((f) => ({ path: f.filename })), __nodeType: 'PullRequestFile' },
  };
}
function repoGql(repo: Repo): Record<string, unknown> {
  return {
    id: repoGlobalId(repo.id), databaseId: repo.id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner }, defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN', hasIssuesEnabled: true, description: repo.description, createdAt: repo.createdAt,
    issue: (args: Record<string, unknown>) => { const i = repo.issues.find((x) => x.number === Number(args.number)); return i ? issueGql(repo, i) : null; },
    issues: (args: Record<string, unknown>) => {
      const states = Array.isArray(args.states) ? args.states.map(String) : [];
      let items = repo.issues.filter((i) => states.length === 0 || states.includes(i.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'));
      const order = asRecord(args.orderBy);
      const desc = order.direction ? order.direction === 'DESC' : true;
      items = [...items].sort((a, b) => desc ? b.number - a.number : a.number - b.number);
      const first = Number(args.first ?? items.length) || items.length;
      let start = 0;
      if (typeof args.after === 'string' && args.after) {
        const idx = items.findIndex((i) => issueGlobalId(repo.id, i.number) === args.after || String(i.number) === args.after);
        start = idx >= 0 ? idx + 1 : 0;
      }
      const page = items.slice(start, start + first);
      return {
        nodes: page.map((i) => issueGql(repo, i)), __nodeType: 'Issue',
        pageInfo: { hasNextPage: start + first < items.length, endCursor: page.length ? issueGlobalId(repo.id, page[page.length - 1]!.number) : null },
      };
    },
    pullRequests: (args: Record<string, unknown>) => {
      const first = Number(args.first ?? repo.pulls.length) || repo.pulls.length;
      const items = [...repo.pulls].filter((p) => p.state === 'open').slice(0, first);
      return { nodes: items.map((p) => pullGql(repo, p)), __nodeType: 'PullRequest' };
    },
    pullRequest: (args: Record<string, unknown>) => { const p = repo.pulls.find((x) => x.number === Number(args.number)); return p ? pullGql(repo, p) : null; },
  };
}

function execute(selections: Selection[], parent: unknown, typeName: string, store: ForgeStore, errors: string[], operation: 'query' | 'mutation'): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const obj = parent !== null && typeof parent === 'object' ? parent as Record<string, unknown> : {};
  for (const sel of selections) {
    if (sel.name === '__typename') { result[sel.alias] = typeName; continue; }
    if (sel.name === '__type') {
      const name = String(sel.args.name ?? '');
      result[sel.alias] = {
        name, kind: 'OBJECT',
        fields: (TYPE_FIELDS[name] ?? []).map((f) => ({ name: f })),
        enumValues: (name === 'SearchType' ? SEARCH_TYPES : []).map((f) => ({ name: f })),
      };
      continue;
    }
    let value: unknown;
    let childType = sel.name === 'nodes' && typeof obj.__nodeType === 'string'
      ? obj.__nodeType as string
      : (CHILD_TYPES[sel.name] ?? 'Object');
    if (typeof obj[sel.name] === 'function') {
      try { value = (obj[sel.name] as (args: Record<string, unknown>) => unknown)(sel.args); }
      catch (err) { errors.push(err instanceof Error ? err.message : String(err)); value = null; }
    } else if (Object.prototype.hasOwnProperty.call(obj, sel.name)) {
      value = obj[sel.name];
    } else {
      errors.push(`Cannot query field "${sel.name}" on type "${typeName}".`);
      value = null;
    }
    if (sel.children.length && value !== null && value !== undefined) {
      value = Array.isArray(value)
        ? value.map((item) => execute(sel.children, item, childType, store, errors, operation))
        : execute(sel.children, value, childType, store, errors, operation);
    }
    result[sel.alias] = value;
  }
  return result;
}

function findRepoByGlobalId(store: ForgeStore, id: unknown): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  const decoded = decodeGlobalId(id);
  if (decoded?.kind === 'repository') return store.repoById(Number(decoded.parts[0]));
  return undefined;
}
function findIssueByGlobalId(store: ForgeStore, id: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof id !== 'string') return undefined;
  const d = decodeGlobalId(id);
  if (d?.kind !== 'issue') return undefined;
  const repo = store.repoById(Number(d.parts[0]));
  const issue = repo?.issues.find((i) => i.number === Number(d.parts[1]));
  return repo && issue ? { repo, issue } : undefined;
}
function findPullByGlobalId(store: ForgeStore, id: unknown): { repo: Repo; pull: Pull } | undefined {
  if (typeof id !== 'string') return undefined;
  const d = decodeGlobalId(id);
  if (d?.kind !== 'pull') return undefined;
  const repo = store.repoById(Number(d.parts[0]));
  const pull = repo?.pulls.find((p) => p.number === Number(d.parts[1]));
  return repo && pull ? { repo, pull } : undefined;
}

function gqlRoot(store: ForgeStore): Record<string, unknown> {
  return {
    viewer: { login: VIEWER_LOGIN, id: Buffer.from(`user:${VIEWER_ID}`).toString('base64') },
    repository: (args: Record<string, unknown>) => {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoGql(repo) : null;
    },
    node: (args: Record<string, unknown>) => {
      const id = String(args.id ?? '');
      const d = decodeGlobalId(id);
      if (d?.kind === 'repository') { const r = store.repoById(Number(d.parts[0])); return r ? { ...repoGql(r), id } : null; }
      if (d?.kind === 'issue') { const f = findIssueByGlobalId(store, id); return f ? { ...issueGql(f.repo, f.issue), id } : null; }
      return null;
    },
    createIssue: (args: Record<string, unknown>) => {
      const input = asRecord(args.input);
      const repo = findRepoByGlobalId(store, input.repositoryId);
      if (!repo) return { issue: null };
      const r = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''));
      return { issue: r.issue ? issueGql(repo, r.issue) : null };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = asRecord(args.input);
      const found = findIssueByGlobalId(store, input.issueId);
      if (!found) return { issue: null };
      const issue = store.closeIssue(found.repo, found.issue.number)!;
      return { issue: issueGql(found.repo, issue) };
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = asRecord(args.input);
      const repo = findRepoByGlobalId(store, input.repositoryId);
      if (!repo) return { pullRequest: null };
      const r = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      return { pullRequest: r.pull ? pullGql(repo, r.pull) : null };
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = asRecord(args.input);
      const found = findPullByGlobalId(store, input.pullRequestId);
      if (!found) return { pullRequest: null };
      const r = store.mergePull(found.repo, found.pull.number);
      return { pullRequest: pullGql(found.repo, found.pull) };
    },
    addComment: (args: Record<string, unknown>) => {
      const input = asRecord(args.input);
      const found = findIssueByGlobalId(store, input.subjectId);
      if (!found) return { commentEdge: { node: null } };
      const id = `${found.issue.id}:c${found.issue.comments.length + 1}`;
      found.issue.comments.push({ id: found.issue.comments.length + 1, body: String(input.body ?? '') });
      return { commentEdge: { node: { id, body: String(input.body ?? '') } } };
    },
  };
}

function runOperation(store: ForgeStore, op: unknown): Record<string, unknown> {
  const record = asRecord(op);
  const query = String(record.query ?? '');
  const variables = asRecord(record.variables);
  const trimmed = query.trim();
  const operation: 'query' | 'mutation' = /^mutation\b/.test(trimmed) ? 'mutation' : 'query';
  // Skip the operation header, including any parenthesised variable definitions, and find
  // the first selection-set brace at parenthesis depth zero.
  let depth = 0; let quote = ''; let body = '';
  for (let index = 0; index < trimmed.length; index++) {
    const ch = trimmed[index]!;
    if (quote) { if (ch === '\\') index++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '{' && depth === 0) { body = trimmed.slice(index + 1); break; }
  }
  const selections = parseSelections(body, variables);
  const errors: string[] = [];
  const data = execute(selections, gqlRoot(store), operation === 'mutation' ? 'Mutation' : 'Query', store, errors, operation);
  return { data, ...(errors.length ? { errors: errors.map((message) => ({ message })) } : {}) };
}

export function handleGraphQL(store: ForgeStore, res: ServerResponse, json: unknown, jsonError: boolean): void {
  if (jsonError) { sendJson(res, 400, { errors: [{ message: 'Problem parsing JSON' }] }); return; }
  if (Array.isArray(json)) { sendJson(res, 200, json.map((op) => runOperation(store, op))); return; }
  sendJson(res, 200, runOperation(store, json));
}

// ---------------------------------------------------------------- MCP
interface Tool { name: string; description: string; inputSchema: Record<string, unknown> }
const TOOLS: Tool[] = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated viewer.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Open an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository, optionally filtered by state.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request from a head branch into a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'list_repos', description: 'List repositories owned by the authenticated viewer.', inputSchema: { type: 'object', properties: {}, required: [] } },
];
const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function rpcResult(id: unknown, result: unknown): Record<string, unknown> { return { jsonrpc: '2.0', id: id ?? null, result }; }
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false, resultType: 'tools/call' };
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; code: number; message: string } | { ok: false; toolError: string } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, code: -32602, message: `Unknown tool: ${name}` };
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  for (const key of required) {
    if (!(key in args) || args[key] === undefined || args[key] === null || args[key] === '') {
      return { ok: false, code: -32602, message: `Missing required argument: ${key}` };
    }
  }
  const owner = String(args.owner ?? VIEWER_LOGIN);
  const repoName = String(args.repo ?? '');
  switch (name) {
    case 'create_repo': {
      const r = store.createRepo(String(args.name ?? ''), { description: String(args.description ?? ''), private: args.private === true });
      return r.repo ? { ok: true, value: repoJson(r.repo) } : { ok: false, toolError: r.error ?? 'could not create repository' };
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      return repo ? { ok: true, value: repoJson(repo) } : { ok: false, toolError: 'Repository not found' };
    }
    case 'list_repos': {
      return { ok: true, value: [...store.repos.values()].filter((r) => r.owner === VIEWER_LOGIN).map(repoJson) };
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, toolError: 'Repository not found' };
      const r = store.createIssue(repo, String(args.title ?? ''), String(args.body ?? ''));
      return r.issue ? { ok: true, value: issueJson(repo, r.issue) } : { ok: false, toolError: r.error ?? 'could not create issue' };
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, toolError: 'Repository not found' };
      const state = String(args.state ?? 'open');
      const items = repo.issues.filter((i) => state === 'all' || i.state === state);
      return { ok: true, value: items.map((i) => issueJson(repo, i)) };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, toolError: 'Repository not found' };
      const r = store.createPull(repo, String(args.title ?? ''), String(args.body ?? ''), String(args.head ?? ''), String(args.base ?? ''));
      return r.pull ? { ok: true, value: pullJson(repo, r.pull) } : { ok: false, toolError: r.error ?? 'could not create pull request' };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, toolError: 'Repository not found' };
      const result = store.mergePull(repo, Number(args.pull_number));
      if (result.status === 'ok') return { ok: true, value: { merged: true, sha: result.sha } };
      return { ok: false, toolError: result.status === 'conflict' ? 'Pull request is conflicted' : 'Pull request not found' };
    }
    default: return { ok: false, code: -32602, message: `Unknown tool: ${name}` };
  }
}

export function handleMcp(store: ForgeStore, res: ServerResponse, method: string, bodyText: string, parsed: unknown, jsonError: boolean): void {
  if (method === 'DELETE') { res.writeHead(204, { 'content-length': 0 }); res.end(); return; }
  if (method !== 'POST') { sendJson(res, 405, rpcError(null, -32600, 'Method not allowed')); return; }
  if (jsonError) { sendJson(res, 400, rpcError(null, -32700, 'Parse error')); return; }
  const req = asRecord(parsed);
  const id = req.id ?? null;
  const rpcMethod = String(req.method ?? '');
  const params = asRecord(req.params);
  if (rpcMethod === 'notifications/initialized' || rpcMethod === 'notifications/cancelled') {
    res.writeHead(202, { 'content-length': 0 }); res.end(); return;
  }
  if (rpcMethod === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      resultType: 'server-discover', serverInfo: SERVER_INFO, capabilities: { tools: { listChanged: false } },
      supportedVersions: SUPPORTED_VERSIONS, instructions: 'A GitHub-compatible git forge.',
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    }));
    return;
  }
  if (rpcMethod === 'initialize') {
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: String(params.protocolVersion ?? '2025-11-25'), serverInfo: SERVER_INFO,
      capabilities: { tools: { listChanged: false } }, instructions: 'A GitHub-compatible git forge.',
    }), { 'mcp-session-id': 'forge-session' });
    return;
  }
  if (rpcMethod === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS })); return;
  }
  if (rpcMethod === 'tools/call') {
    const name = String(params.name ?? '');
    const result = callTool(store, name, asRecord(params.arguments));
    if ('code' in result) { sendJson(res, 200, rpcError(id, result.code, result.message)); return; }
    if ('toolError' in result) {
      sendJson(res, 200, rpcResult(id, { content: [{ type: 'text', text: result.toolError }], isError: true })); return;
    }
    sendJson(res, 200, rpcResult(id, toolResult(result.value))); return;
  }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${rpcMethod}`));
}
