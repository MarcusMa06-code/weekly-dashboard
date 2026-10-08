// Sets up the dashboard for a team: writes wrangler.jsonc and an empty public/data/plan.json.
// Run with `npm run setup`. Uses the GitHub CLI (`gh`) when available to suggest answers.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const root = new URL('../', import.meta.url);
const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
const lines = rl[Symbol.asyncIterator](); // reads answers in order, typed or piped

async function ask(question, fallback = '') {
  stdout.write(fallback ? `${question} [${fallback}]: ` : `${question}: `);
  const { value, done } = await lines.next();
  const answer = done ? '' : value.trim();
  if (!stdin.isTTY) {
    stdout.write(`${answer}\n`);
  }
  return answer || fallback;
}

function gh(...args) {
  try {
    return JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

console.log('\nThis writes wrangler.jsonc and an empty plan. Press Enter to accept a suggestion in [brackets].\n');

const planPath = new URL('public/data/plan.json', root);
if (existsSync(planPath)) {
  const existing = JSON.parse(readFileSync(planPath, 'utf8'));
  if (existing.bundles?.length && existing.teamName !== 'Example') {
    const go = await ask(`A plan for ${existing.teamName} already exists and will be replaced. Continue? (y/n)`, 'n');
    if (!/^y/i.test(go)) {
      rl.close();
      process.exit(0);
    }
  }
}

const teamName = await ask('Team name shown on the page (e.g. T12-4)');
const repo = await ask('Group repo, as owner/name (e.g. AY2627S1-CS2103T-T12-4/tp)');
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('That does not look like owner/name.');
  process.exit(1);
}

const collaborators = gh(`repos/${repo}/collaborators`)?.map((c) => c.login) ?? [];
const loginAnswer = await ask('GitHub usernames of everyone on the team, comma-separated', collaborators.join(','));
const logins = loginAnswer.split(',').map((l) => l.trim()).filter(Boolean);
if (!logins.length) {
  console.error('Add at least one GitHub username.');
  process.exit(1);
}

const team = [];
for (const login of logins) {
  const fullName = gh(`users/${login}`)?.name;
  team.push({ login, name: await ask(`  Name to show for ${login}`, fullName?.split(' ')[0] || login) });
}

const today = new Date().toISOString().slice(0, 10);
const milestones = gh(`repos/${repo}/milestones?state=open&sort=due_on&direction=asc`) ?? [];
const next = milestones.find((m) => m.due_on && m.due_on.slice(0, 10) >= today) ?? milestones[0];
const milestoneNumber = Number(await ask('Milestone number to plan first', next ? String(next.number) : ''));
const chosen = milestones.find((m) => m.number === milestoneNumber);
const milestoneTitle = await ask('Milestone title', chosen?.title ?? '');
const due = await ask('Milestone due date (YYYY-MM-DD)', chosen?.due_on?.slice(0, 10) ?? '');

const domain = await ask('Your own domain or subdomain for the dashboard (leave empty to use a free workers.dev address)');
const slug = teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
const worker = await ask('Cloudflare Worker name', `${slug}-dashboard`);
const clientId = await ask('GitHub App Client ID (leave empty if you have not made the app yet)', 'REPLACE_WITH_GITHUB_APP_CLIENT_ID');
rl.close();

const hosting = domain
  ? `  // Serve only on the custom domain, so GitHub sign-in always returns to the registered callback.
  "workers_dev": false,
  "preview_urls": false,
  "routes": [
    { "pattern": "${domain}", "custom_domain": true }
  ],`
  : `  // Served at https://${worker}.<your-subdomain>.workers.dev. Cloudflare shows the full address after the first deploy.
  "workers_dev": true,
  "preview_urls": false,`;

writeFileSync(new URL('wrangler.jsonc', root), `{
  "name": "${worker}",
  "main": "src/worker.js",
  "compatibility_date": "2025-10-01",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS"
  },
${hosting}
  "vars": {
    // Public client ID of the GitHub App used for "Sign in with GitHub".
    "GITHUB_CLIENT_ID": "${clientId}",
    // The only GitHub accounts allowed to sign in and assign issues. Everyone else is turned away.
    "TEAM_LOGINS": "${logins.join(',')}"
  }
  // Secrets (set in Cloudflare under Settings → Variables and Secrets, type Secret):
  //   GITHUB_CLIENT_SECRET  the GitHub App's client secret
  //   SESSION_SECRET        any long random string; encrypts the sign-in cookie
}
`);

writeFileSync(planPath, `${JSON.stringify({
  teamName,
  repo,
  milestone: { number: milestoneNumber, title: milestoneTitle, due },
  refreshed: today,
  headline: 'This week\'s plan has not been written yet.',
  checkpoints: [],
  team,
  bundles: [],
  issues: {},
  prs: {},
}, null, 2)}\n`);

const pkgPath = new URL('package.json', root);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.name = worker;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const site = domain ? `https://${domain}` : `https://${worker}.<your-subdomain>.workers.dev`;
console.log(`
Done. Wrote wrangler.jsonc and public/data/plan.json.

Next:
  1. Create the GitHub App (see README). Homepage URL: ${site}
     Redirect URI: ${site}/auth/callback
  2. Put its Client ID in wrangler.jsonc if you skipped it here.
  3. Open Claude Code in this folder and ask it to write this week's plan.
  4. Commit, push, and connect the repo in Cloudflare (see README).
`);
