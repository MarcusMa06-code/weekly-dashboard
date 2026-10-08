// Serves the dashboard, signs teammates in with GitHub, and assigns bundles of issues.
// Static files in public/ are served directly; only /api/* and /auth/* reach this code.

const SESSION_COOKIE = 'session';
const STATE_COOKIE = 'oauth_state';
const SESSION_MAX_AGE = 60 * 60 * 24 * 180; // GitHub refresh tokens last six months
const USER_AGENT = 'weekly-dashboard';

const STATE_QUERY = `
query ($owner: String!, $name: String!, $milestone: Int!) {
  repository(owner: $owner, name: $name) {
    milestone(number: $milestone) {
      title
      dueOn
      issues(first: 50, states: [OPEN, CLOSED]) {
        nodes {
          number
          title
          url
          state
          assignees(first: 5) { nodes { login name avatarUrl } }
          blockedBy(first: 10) { nodes { number title state } }
          blocking(first: 20) { nodes { number title state milestone { number } } }
          closedByPullRequestsReferences(first: 5, includeClosedPrs: true) {
            nodes { number title url state isDraft author { login } }
          }
        }
      }
    }
  }
}`;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/auth/login') return login(request, env);
      if (pathname === '/auth/callback') return await callback(request, env);
      if (pathname === '/auth/logout' && request.method === 'POST') return logout(request);
      if (pathname === '/api/state' && request.method === 'GET') return await state(request, env);
      if (pathname === '/api/claim' && request.method === 'POST') return await assign(request, env, 'POST');
      if (pathname === '/api/release' && request.method === 'POST') return await assign(request, env, 'DELETE');
      if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) return json({ error: 'Not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: err.message || 'Something went wrong' }, err.status || 500);
    }
  },
};

//// Sign-in

function login(request, env) {
  const origin = new URL(request.url).origin;
  const state = randomToken();
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${origin}/auth/callback`,
    state,
  });
  const headers = new Headers({ Location: `https://github.com/login/oauth/authorize?${params}` });
  headers.append('Set-Cookie', cookie(STATE_COOKIE, state, 600));
  return new Response(null, { status: 302, headers });
}

async function callback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state !== readCookie(request, STATE_COOKIE)) {
    return redirect('/?signin=failed');
  }

  let session;
  try {
    const token = await exchangeToken(env, { code, redirect_uri: `${url.origin}/auth/callback` });
    const user = await github(token.access_token, '/user');
    if (!isTeamMember(env, user.login)) {
      console.warn('Sign-in refused for non-member:', user.login);
      return redirect('/?signin=denied');
    }
    session = { ...tokenFields(token), login: user.login };
  } catch (err) {
    console.error('Sign-in failed:', err.message);
    return redirect(`/?signin=failed&reason=${encodeURIComponent(err.message)}`);
  }

  const headers = new Headers({ Location: '/' });
  headers.append('Set-Cookie', await sessionCookie(env, session));
  headers.append('Set-Cookie', cookie(STATE_COOKIE, '', 0));
  return new Response(null, { status: 302, headers });
}

function logout(request) {
  if (!isSameOrigin(request)) return json({ error: 'Bad origin' }, 403);
  return json({ ok: true }, 200, cookie(SESSION_COOKIE, '', 0));
}

async function exchangeToken(env, params) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      ...params,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw httpError(401, data.error_description || 'GitHub sign-in failed.');
  }
  return data;
}

function tokenFields(token) {
  const now = Date.now();
  return {
    token: token.access_token,
    expires: token.expires_in ? now + token.expires_in * 1000 : null,
    refresh: token.refresh_token || null,
  };
}

/**
 * Returns the signed-in session, refreshing an expired GitHub token when possible.
 * {@code setCookie} is set when the cookie must change (refreshed or cleared).
 */
async function getSession(request, env) {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) {
    return {};
  }
  const cleared = cookie(SESSION_COOKIE, '', 0);
  const session = await decrypt(env, raw).catch(() => null);
  if (!session || !isTeamMember(env, session.login)) {
    return { setCookie: cleared };
  }
  if (!session.expires || Date.now() < session.expires - 60_000) {
    return { session };
  }
  if (!session.refresh) {
    return { setCookie: cleared };
  }
  const token = await exchangeToken(env, { grant_type: 'refresh_token', refresh_token: session.refresh })
      .catch(() => null);
  if (!token) {
    return { setCookie: cleared };
  }
  const refreshed = { ...tokenFields(token), login: session.login };
  return { session: refreshed, setCookie: await sessionCookie(env, refreshed) };
}

/**
 * Local preview only: when DEV_FAKE_LOGIN is set in .dev.vars, act as that GitHub user without signing in.
 * Reads use GITHUB_TOKEN and assignments are simulated. Never set it in production.
 */
async function devSession(env) {
  if (!env.DEV_FAKE_LOGIN) {
    return null;
  }
  return { session: { login: env.DEV_FAKE_LOGIN, token: env.GITHUB_TOKEN, fake: true } };
}

//// API

async function state(request, env) {
  const { session, setCookie } = await devSession(env) ?? await getSession(request, env);
  const token = session?.token || env.GITHUB_TOKEN;
  if (!token) {
    return json({ signedIn: false }, 200, setCookie);
  }

  const plan = await loadPlan(request, env);
  const [owner, name] = plan.repo.split('/');
  let data;
  try {
    data = await graphql(token, STATE_QUERY, { owner, name, milestone: plan.milestone.number });
  } catch (err) {
    if (err.status === 401 && session) {
      return json({ signedIn: false }, 200, cookie(SESSION_COOKIE, '', 0));
    }
    throw err;
  }

  const milestone = data.repository.milestone;
  const issues = milestone.issues.nodes.map((issue) => ({
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    assignees: issue.assignees.nodes.map((a) => ({ login: a.login, name: a.name, avatar: a.avatarUrl })),
    blockedBy: issue.blockedBy.nodes.map((b) => ({ number: b.number, title: b.title, state: b.state })),
    blocking: issue.blocking.nodes.map((b) => ({
      number: b.number,
      title: b.title,
      state: b.state,
      milestone: b.milestone?.number ?? null,
    })),
    prs: issue.closedByPullRequestsReferences.nodes.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      author: pr.author?.login ?? null,
    })),
  }));

  return json({
    signedIn: Boolean(session),
    viewer: session ? { login: session.login } : null,
    milestone: { title: milestone.title, dueOn: milestone.dueOn },
    issues,
    fetchedAt: new Date().toISOString(),
  }, 200, setCookie);
}

/**
 * Assigns ({@code POST}) or unassigns ({@code DELETE}) the signed-in teammate on every issue in a bundle.
 * The issue list comes from the published plan, never from the request.
 */
async function assign(request, env, method) {
  if (!isSameOrigin(request)) {
    return json({ error: 'Bad origin' }, 403);
  }
  const { session, setCookie } = await devSession(env) ?? await getSession(request, env);
  if (!session) {
    return json({ error: 'Sign in with GitHub first.', signedIn: false }, 401, setCookie);
  }
  if (session.fake) {
    // Local preview only: pretend GitHub took a moment and succeeded, without changing any issue.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return json({ ok: true, results: [] });
  }

  const { bundle: bundleId } = await request.json().catch(() => ({}));
  const plan = await loadPlan(request, env);
  const bundle = plan.bundles.find((b) => b.id === bundleId);
  if (!bundle) {
    return json({ error: 'Unknown bundle.' }, 404, setCookie);
  }

  const results = await Promise.all(bundle.issues.map((number) =>
    github(session.token, `/repos/${plan.repo}/issues/${number}/assignees`, {
      method,
      body: { assignees: [session.login] },
    }).then(() => ({ number, ok: true }), (err) => ({ number, ok: false, error: err.message }))));

  const failed = results.filter((r) => !r.ok);
  return json({ ok: failed.length === 0, results }, failed.length ? 502 : 200, setCookie);
}

async function loadPlan(request, env) {
  const res = await env.ASSETS.fetch(new Request(new URL('/data/plan.json', request.url)));
  if (!res.ok) {
    throw httpError(500, 'The plan file is missing.');
  }
  return res.json();
}

//// GitHub

async function github(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw httpError(res.status, data.message || `GitHub returned ${res.status}.`);
  }
  return data;
}

async function graphql(token, query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors) {
    throw httpError(res.status === 200 ? 502 : res.status,
        data.errors?.[0]?.message || data.message || `GitHub returned ${res.status}.`);
  }
  return data.data;
}

//// Cookies and encryption

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return rest.join('=');
    }
  }
  return null;
}

async function sessionCookie(env, session) {
  return cookie(SESSION_COOKIE, await encrypt(env, session), SESSION_MAX_AGE);
}

async function sessionKey(env) {
  if (!env.SESSION_SECRET) {
    throw httpError(500, 'SESSION_SECRET is not set.');
  }
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SESSION_SECRET));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sessionKey(env), plain));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64Url(out);
}

async function decrypt(env, text) {
  const bytes = fromBase64Url(text);
  const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) }, await sessionKey(env), bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

function toBase64Url(bytes) {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function randomToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

//// Helpers

/**
 * Only the logins in TEAM_LOGINS (wrangler.jsonc) may sign in, see live status through their token,
 * or assign issues. Everyone else can still read the published plan. A missing list lets nobody in.
 */
function isTeamMember(env, login) {
  const team = (env.TEAM_LOGINS || '').split(',').map((l) => l.trim().toLowerCase()).filter(Boolean);
  return Boolean(login) && team.includes(login.toLowerCase());
}

function isSameOrigin(request) {
  return request.headers.get('Origin') === new URL(request.url).origin;
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function json(body, status = 200, setCookie) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  if (setCookie) {
    headers.append('Set-Cookie', setCookie);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
