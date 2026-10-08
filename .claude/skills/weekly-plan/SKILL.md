---
name: weekly-plan
description: Refresh the team dashboard for the next milestone. Use on milestone deadline day, when asked to plan the next week, or mid-week to add plain-English notes for newly opened PRs. Reads the milestone's issues and the tp code, proposes issue changes that let more people work in parallel, splits the work into five even bundles, writes plain-English summaries, and updates public/data/plan.json.
---

# Weekly plan

The dashboard helps a team see what this week's work is, how it connects, and split it evenly. Each teammate clicks **Assign me** on one bundle, which assigns every issue in it to them on GitHub. This skill writes the plan the page renders: `public/data/plan.json`.

- **Group repo:** `repo` in `public/data/plan.json`. Below, `OWNER/NAME` stands for it.
- **Team:** `team` in `plan.json`. Make one bundle per person.
- **Code:** a local clone of the group repo. Look for `../tp` first. If it isn't there, ask for the path. A personal fork's default branch can lag behind the team's, so always read the group repo's default branch (step 4).
- **Who approves:** the person running this skill. Nothing on GitHub changes without their go-ahead.

## Weekly refresh

1. **Find the milestone.** List milestones with `gh api repos/OWNER/NAME/milestones`. Pick the open one with the earliest due date after today. The one due today is finishing.
2. **Archive last week.** Copy `public/data/plan.json` to `public/data/weeks/<old milestone title>.json`.
3. **Read the issues.** Read each issue body (`gh issue view N -R OWNER/NAME`) and GitHub's native dependencies (the GraphQL query in `scripts/check-plan.mjs` shows how). Note any unfinished issues from last week. Ask whether they move into this week.
4. **Read the code.** In the local clone, run `git fetch https://github.com/OWNER/NAME.git <default branch>`, then read `FETCH_HEAD`. Look at the files each issue will touch to estimate effort.
5. **Look for bottlenecks.** If one issue blocks most others, or a chain leaves people waiting at the start of the week, propose a restructure (see below). **Wait for approval before you change anything on GitHub.**
6. **Make five bundles** (rules below) and **write the summaries** (style below).
7. **Write `public/data/plan.json`** (schema below). Set `refreshed` to today.
8. **Run `npm run check`.** Fix every error and weigh the warnings. It checks the plan against GitHub.
9. **Preview** with `npm run dev` (http://localhost:8787) if the shape of the week changed a lot.
10. **Show the bundle table** that `npm run check` prints, plus any proposals. Once you get the go-ahead, commit and push to `main`. Cloudflare deploys every push to `main` within a minute or two, so don't run `wrangler deploy` yourself.

## Mid-week PR notes

When a PR linked to a planned issue changes scope, or has something teammates should know before it merges, add `prs["<PR number>"].bullets` with 2–3 bullets in the summary style. The page shows them under the issue. Skip PRs that just do what the issue says.

## Effort points

Estimate from the code, not from issue length. One point is roughly half a focused day for this team.

| Points | Looks like |
|---|---|
| 1–1.5 | Docs or screenshots, or a few lines plus tests |
| 2 | One or two small commands on an existing mechanism, with tests and UG/DG |
| 3 | A feature with about three commands, parsers, model methods, tests and UG/DG |
| 3.5–4 | A new shared mechanism or storage format that other features build on |
| 5+ | Touches most layers. Try to split it. |

## Bundle rules

- One bundle per teammate. **Never name or suggest owners.** People pick for themselves.
- Keep bundle efforts within 1.5 points of each other. `npm run check` warns otherwise.
- Pair an item that can start early with one that comes later, so nobody waits at the start of the week or crunches at the end.
- Put the issue others wait on first in its bundle. Give critical-path work to bundles with less else to do.
- Where balance allows, keep code that changes together in one bundle (a command and its tests, storage and its cleanup).
- Name bundles by what the person ends up owning ("Groups, then attendance"), not by letters or numbers.

## Restructuring issues

Common fixes for a one-at-a-time chain:

- Split out the small, additive part others need (an interface or Model method) so it can merge within a day.
- Let dependants build against existing domain classes, test fixtures or a stub, and merge after.
- Move deletions and cleanups last. They conflict with every open branch.

After approval:

- Rewrite or create issues in the format the team already uses (read a few first). Keep them precise; they are often written for coding agents.
- Use the right milestone and labels (`type.*`, `priority.*`).
- Update GitHub's native blocked-by links to match each "Blocked by" section, using the GraphQL mutations `addBlockedBy` and `removeBlockedBy` with issue node IDs.

## Writing the summaries

Issues are written for agents. The summaries are for people. This follows the [eli5](https://github.com/dreambigou/eli5) idea of fitting the explanation to its audience. The audience here is a teammate who knows the codebase's language and architecture but hasn't read the issue.

- `short`: 1–3 words that fit a map node, e.g. "Data file".
- `headline`: one sentence about what a TA, or the team, gets once it lands. Mention class names only when the change is purely internal.
- `bullets`: 2–3 lines of up to about 100 characters each:
  - what changes,
  - the rule that would surprise someone,
  - anything that affects how to build or merge it.
  Put commands in backticks.
- `early`: only when the work can start before its blockers merge. Say exactly how.
- **Never write a "why this matters" line or section.** The page shows impact through the dependency map, the "N tasks wait on this" line it works out from GitHub, and the headline. Don't repeat dependency counts in the bullets either.
- Use plain words. Avoid: leverage, robust, seamless, ensure, utilize, comprehensive, streamline.
- Each line should make sense on its own, to someone who reads only that line.

## plan.json schema

```json
{
  "teamName": "T12-4",
  "repo": "OWNER/NAME",
  "milestone": { "number": 4, "title": "v1.4", "due": "2026-10-22" },
  "refreshed": "2026-10-15",
  "headline": "One sentence about what the app can do by the end of the week.",
  "checkpoints": [{ "date": "2026-10-16", "text": "#56 merged, so three tasks can start" }],
  "team": [{ "login": "github-username", "name": "First name" }],
  "bundles": [
    { "id": "kebab-id", "name": "What you end up owning", "tagline": "One line: what comes first, what comes after.", "issues": [56, 57] }
  ],
  "issues": {
    "56": {
      "title": "Issue title as on GitHub",
      "short": "Save status",
      "effort": 3,
      "blockedBy": [],
      "headline": "…",
      "bullets": ["…", "…"],
      "early": "optional"
    }
  },
  "prs": { "90": { "bullets": ["…"] } }
}
```

Keep `teamName` and `team` as they are. If the team changes, also update `TEAM_LOGINS` in `wrangler.jsonc`: it is the list of accounts allowed to sign in. `blockedBy` is a snapshot used only when GitHub can't be reached; live data overrides it.
