# Ducky Demo

Auto-generate a demo video of your app on every pull request.

When a PR is ready, this action renders a short demo of your app and posts it back as a PR comment: no setup beyond a key and a few lines of workflow.

## Quick start

1. Add your Ducky API key as a repository secret named **`DUCKY_API_KEY`** (Settings → Secrets and variables → Actions).
2. Create `.github/workflows/ducky.yml`:

```yaml
name: Ducky demo
on:
  pull_request:

permissions:
  contents: read       # your repo, as workflows normally grant
  deployments: read    # find the PR's preview deployment
  pull-requests: write # read the PR to derive the demo, and post the comment

jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - uses: neocho/ducky-demo-action@v1
        with:
          api-key: ${{ secrets.DUCKY_API_KEY }}
```

Open a pull request: Ducky waits for the PR's preview deployment, reads the PR to decide what to demo, renders it, and posts the video. If a PR has nothing user-visible to show (a refactor, CI change, docs), Ducky skips it quietly. Ducky reads the PR (title, description, diff) on every run, so `pull-requests` access is always required; the `write` above already includes that read.

Ducky demos **open** pull requests. Once a PR is merged or closed there is nothing left to review, so a run against it exits green without rendering.

> The no-`url` setup works when your host reports its deploys to GitHub's deployments API with the deployed URL, per PR. Vercel does. Netlify and Cloudflare Pages don't: pass `url` explicitly there (recipe 2 below). GitHub Pages reports its deploys too, but only for the single site it publishes, never per PR, so there is no PR preview for Ducky to find: deploy the PR's code somewhere yourself and pass that URL (recipe 2).

## Also using the Ducky GitHub App?

If the [Ducky GitHub App](https://tryducky.dev) is installed on the repo, the action hands the render to the App instead of rendering twice: one render, one comment, posted by the App with its full verification detail. The action keeps the CI signal (the check goes red if the render fails within `render-timeout`; a render that outlives the budget leaves a green check and finishes on the dashboard). Repos without the App render through the action, which posts the comment Ducky composes for the result: the verified demo with its proof detail, or an honest note when verification held the demo back, the render failed, or there was nothing to show. Nothing to configure either way.

## Pointing Ducky at the right URL

The demo is only as good as the URL it renders. Three setups:

**1. Your host builds a preview per PR and reports it to GitHub (Vercel, …):** omit `url` (the Quick start above). Ducky polls GitHub until a deployment of the PR's commit succeeds with a URL and renders that, so the demo shows the PR's actual change. Tune the wait with `wait-timeout` (default 300s). Hosts that deploy without writing GitHub deployments (Netlify, Cloudflare Pages) need recipe 2.

**2. You deploy from your own workflow:** put the Ducky step after your deploy step and pass the URL you deployed:

```yaml
      - run: ./deploy.sh                       # your existing deploy
      # if your deploy command returns before the new version is live,
      # add your host's wait command here (e.g. aws ecs wait services-stable)
      - uses: neocho/ducky-demo-action@v1
        with:
          url: https://staging.your-app.example.com
          api-key: ${{ secrets.DUCKY_API_KEY }}
```

**3. Your deploy runs on `push`, not on `pull_request`:** trigger Ducky the same way, with its step after the deploy. Ducky finds the open pull request that contains the pushed commit and posts the demo there:

```yaml
on:
  push:
    branches-ignore: [main]   # PR branches; Ducky resolves the PR from the commit
```

A push with no open pull request behind it (a merge into `main`, a direct commit) is a quiet skip: nothing renders and the check stays green.

(Don't point a `pull_request`-triggered run at prod: prod doesn't have the PR's change yet, so the demo would show the old version.)

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | Yes | (none) | Your Ducky API key (use a repository secret). |
| `url` | No | the PR's preview deployment | The deployed URL to demo. When omitted, Ducky waits for this commit's deployment via GitHub and uses its URL. |
| `task` | No | derived from the PR | Force what to show, e.g. `"Sign up for a new account"`. Ducky always reads the PR (title, description, diff; `pull-requests: read` stays required) to judge and describe the change; this input overrides only the demo objective. |
| `reel` | No | `true` | Post the polished narrated reel, or the raw screen recording. |
| `wait-timeout` | No | `300` | Seconds to wait for the deployment when `url` is omitted. |
| `render-timeout` | No | `600` | Seconds to watch the render before the step moves on. Set `0` to submit and not wait. The demo still finishes server-side; without the App installed, the step leaves a note on the PR instead of the video. |
| `credential` | No | (none) | Label of a stored Ducky credential for signing into your app (a captured session or a test email+password). Only the label rides in the workflow, never the secret. |
| `vercel-bypass` | No | (none) | Label of a stored Vercel Protection Bypass credential, for previews behind Vercel's wall. |
| `login-hints` | No | (none) | Comma-separated URL fragments of your login page(s), e.g. `/enter,/portal`. Lets Ducky fail loudly when a session expires instead of demoing your login wall. |

## Demoing an app behind a login

If your app needs a login, store a credential with Ducky **once**, then reference it by label:

```yaml
      - uses: neocho/ducky-demo-action@v1
        with:
          api-key: ${{ secrets.DUCKY_API_KEY }}
          credential: my-app-login      # stored via `ducky capture` or the API
          vercel-bypass: my-bypass      # if your previews sit behind Vercel's wall
```

A stored **session** lands the demo already signed in; a stored **test email+password** has Ducky type it into your login form (the secret never enters the AI's context or the video trajectory).

## Get a key

Sign up at **[tryducky.dev](https://tryducky.dev)**.
