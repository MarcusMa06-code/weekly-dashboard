// Checks public/data/plan.json against itself and against the milestone on GitHub.
// Run with `npm run check`. Needs the GitHub CLI (`gh`) signed in. Exits 1 on errors.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const plan = JSON.parse(readFileSync(new URL('../public/data/plan.json', import.meta.url), 'utf8'));
const errors = [];
const warnings = [];

//// Shape

for (const key of ['teamName', 'repo', 'milestone', 'refreshed', 'headline', 'team', 'bundles', 'issues']) {
  if (!(key in plan)) errors.push(`plan.${key} is missing`);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.milestone?.due ?? '')) errors.push('milestone.due must be YYYY-MM-DD');
if (plan.bundles.length !== plan.team.length) {
  warnings.push(`${plan.bundles.length} bundles for ${plan.team.length} people`);
}

const seen = new Map();
for (const bundle of plan.bundles) {
  for (const key of ['id', 'name', 'tagline', 'issues']) {
    if (!bundle[key]) errors.push(`bundle ${bundle.id ?? '?'} has no ${key}`);
  }
  for (const n of bundle.issues) {
    if (seen.has(n)) errors.push(`#${n} is in both "${seen.get(n)}" and "${bundle.id}"`);
    seen.set(n, bundle.id);
    if (!plan.issues[String(n)]) errors.push(`#${n} (bundle "${bundle.id}") has no entry in plan.issues`);
  }
}

for (const [number, issue] of Object.entries(plan.issues)) {
  const where = `#${number}`;
  if (!seen.has(Number(number))) errors.push(`${where} is not in any bundle`);
  for (const key of ['title', 'short', 'headline', 'bullets', 'blockedBy']) {
    if (issue[key] === undefined) errors.push(`${where} has no ${key}`);
  }
  if (!(issue.effort > 0)) errors.push(`${where} needs a positive effort`);
  if (issue.short?.length > 20) warnings.push(`${where} short name "${issue.short}" may not fit on the map`);
  if (issue.headline?.length > 110) warnings.push(`${where} headline is ${issue.headline.length} characters; aim for under 110`);
  if (issue.bullets && (issue.bullets.length < 2 || issue.bullets.length > 4)) {
    warnings.push(`${where} has ${issue.bullets.length} bullets; aim for 2 to 4`);
  }
  for (const bullet of issue.bullets ?? []) {
    if (bullet.length > 130) warnings.push(`${where} bullet is ${bullet.length} characters: "${bullet.slice(0, 40)}…"`);
  }
  const text = [issue.headline, ...(issue.bullets ?? []), issue.early ?? ''].join(' ');
  if (/why (this|it) matters/i.test(text)) errors.push(`${where} uses a "why this matters" line; show the impact through the content instead`);
}

//// Effort balance

const efforts = plan.bundles.map((b) => b.issues.reduce((sum, n) => sum + (plan.issues[String(n)]?.effort ?? 0), 0));
const spread = Math.max(...efforts) - Math.min(...efforts);
const total = efforts.reduce((a, b) => a + b, 0);
console.log('Bundles:');
plan.bundles.forEach((b, i) => {
  console.log(`  ${'ABCDEFGHIJ'[i]} ${b.name.padEnd(34)} ${String(efforts[i]).padStart(4)} pts  ${Math.round((efforts[i] / total) * 100)}%`);
});
if (spread > 1.5) warnings.push(`effort spread is ${spread} points; aim for 1.5 or less`);

//// GitHub

try {
  const [owner, name] = plan.repo.split('/');
  const query = `query($owner:String!,$name:String!,$ms:Int!){repository(owner:$owner,name:$name){milestone(number:$ms){
    title dueOn issues(first:100,states:[OPEN,CLOSED]){nodes{number state blockedBy(first:20){nodes{number}}}}}}}`;
  const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
    '-F', `ms=${plan.milestone.number}`], { encoding: 'utf8' });
  const milestone = JSON.parse(out).data.repository.milestone;
  if (!milestone) throw new Error(`milestone ${plan.milestone.number} not found`);
  if (milestone.title !== plan.milestone.title) {
    errors.push(`milestone ${plan.milestone.number} is "${milestone.title}" on GitHub, not "${plan.milestone.title}"`);
  }
  if (milestone.dueOn && !milestone.dueOn.startsWith(plan.milestone.due)) {
    warnings.push(`GitHub says the milestone is due ${milestone.dueOn.slice(0, 10)}, the plan says ${plan.milestone.due}`);
  }
  const onGitHub = new Map(milestone.issues.nodes.map((i) => [i.number, i]));
  for (const issue of milestone.issues.nodes) {
    if (issue.state === 'OPEN' && !plan.issues[String(issue.number)]) {
      errors.push(`#${issue.number} is open in ${milestone.title} but missing from the plan`);
    }
  }
  for (const [number, issue] of Object.entries(plan.issues)) {
    const live = onGitHub.get(Number(number));
    if (!live) {
      errors.push(`#${number} is in the plan but not in ${milestone.title} on GitHub`);
      continue;
    }
    const liveBlockers = live.blockedBy.nodes.map((b) => b.number).filter((b) => plan.issues[String(b)]).sort();
    const planBlockers = [...issue.blockedBy].sort();
    if (liveBlockers.join() !== planBlockers.join()) {
      warnings.push(`#${number} blockedBy is [${planBlockers}] in the plan but [${liveBlockers}] on GitHub`);
    }
  }
} catch (err) {
  warnings.push(`skipped the GitHub check: ${err.message.split('\n')[0]}`);
}

for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error: ${e}`);
console.log(errors.length ? `\n${errors.length} error(s).` : '\nPlan looks good.');
process.exit(errors.length ? 1 : 0);
