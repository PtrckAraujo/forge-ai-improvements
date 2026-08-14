# Working agreements for this repository

## Never push to the upstream project

`PtrckAraujo/forge-ai-improvements` is a fork of `Card-Forge/forge`. **Nothing from this
repository may be pushed to, or opened as a pull request against, the upstream project.** Not a
branch, not a tag, not a pull request base.

That applies to every route, not only `git push`:

- **Remotes.** `origin` is the only remote, and it points at
  `https://github.com/PtrckAraujo/forge-ai-improvements`. Do not add an `upstream` remote, and do
  not set a `pushurl` that points anywhere else.
- **Pull requests.** GitHub defaults a PR opened from a fork to the *upstream* repository as its
  base. Always set the base explicitly to `PtrckAraujo/forge-ai-improvements` and confirm it before
  creating a PR. This is the easiest way to get it wrong, because the wrong answer is the default.
- **GitHub API/MCP tools.** `owner` must be `PtrckAraujo` and `repo` must be
  `forge-ai-improvements` on anything that writes.

Two mechanisms enforce this, and neither replaces reading the above:

1. `.git/hooks/pre-push` fails any push whose remote URL is not this repository. It lives in
   `.git/`, so it is local to a working copy and does not travel with a clone — reinstall it in a
   fresh checkout.
2. The session's git proxy refuses to supply credentials for repositories outside the authorised
   set, so a push to `Card-Forge/forge` gets a 403 before the hook is even consulted.

## Branches and pull requests

- Work goes on a branch, never directly on `master`.
- Do not push a branch that was not asked for, and do not open a pull request unless asked.
- A merged pull request cannot carry follow-up work. Start a fresh branch from the current
  `master` and open a new pull request instead of adding commits to the merged branch.

## Testing

This fork has no working CI: 13 workflows are listed as active but the repository has never
executed a single workflow run, including on merged pull requests. **An absent red mark means
nothing was checked, not that something passed.** Local runs are the only gate:

```
xvfb-run -a mvn -B -o -pl forge-gui-desktop -am test
```

`xvfb-run` is required — the desktop test harness initialises a GUI and fails headless.

Behaviour-equivalence work has a stricter bar than "tests pass"; see
[docs/Development/AI-Performance-Phase1.md](docs/Development/AI-Performance-Phase1.md) for the
trace-and-state comparison, and note that it must be run with assertions **disabled**, or the
shadow checks recompute exactly what the change avoids computing and hide it.
