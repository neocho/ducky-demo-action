# Ducky Demo

Auto-generate a demo video of your app on every pull request.

When a PR is ready, this action renders a short demo of your app and posts it back as a PR comment — no setup beyond a key and a few lines of workflow.

## Quick start

1. Add your Ducky API key as a repository secret named **`DUCKY_API_KEY`** (Settings → Secrets and variables → Actions).
2. Create `.github/workflows/ducky.yml`:

```yaml
name: Ducky demo
on:
  pull_request:

permissions:
  pull-requests: write

jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - uses: neocho/ducky-demo-action@v1
        with:
          url: https://your-app.example.com
          task: "Show the new checkout flow"
          api-key: ${{ secrets.DUCKY_API_KEY }}
```

Open a pull request — Ducky posts the demo on it.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `url` | Yes | — | The deployed URL to demo. |
| `task` | Yes | — | What to show, e.g. `"Sign up for a new account"`. |
| `api-key` | Yes | — | Your Ducky API key (use a repository secret). |
| `reel` | No | `true` | Post the polished narrated reel, or the raw screen recording. |

## Get a key

Sign up at **[tryducky.dev](https://tryducky.dev)**.
