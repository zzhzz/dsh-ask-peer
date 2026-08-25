# Contributing to dsh-ask-peer

Thanks for helping improve dsh-ask-peer. The project is still on the
DeepSeek Harness developer-preview line, so small, focused changes are the
easiest to review and keep compatible.

## Development setup

You need Node.js `^22.19.0 || >=24.0.0` and pnpm 10 or newer.

```sh
git clone https://github.com/zzhzz/dsh-ask-peer.git
cd dsh-ask-peer
pnpm install
pnpm run build
```

The build runs the TypeScript compiler and creates both the host plugin and
the browser bundle under `lib/`.

## Validation

Run the checks that match your change:

```sh
pnpm run typecheck  # TypeScript changes
pnpm run build      # host plugin and browser bundle
pnpm smoke          # three local agents with a mock model
pnpm web-check      # plugin discovery and browser-bundle serving
```

`pnpm smoke` and `pnpm web-check` use local ports and temporary profiles. If a
check reports that a port is occupied, stop the existing dsh instance named
in the error and run the check again.

The `scripts/real-*.sh` checks exercise live-model or interactive browser
flows. They may use a DeepSeek API key and existing local dsh identities, so
run them only when your change affects those end-to-end paths. Each script's
header documents its prerequisites and cleanup behavior.

Documentation-only changes do not need the runtime smoke checks. Please still
verify commands, file names, links, and examples against the current tree.

## Pull requests

- Keep each pull request focused on one behavior or documentation topic.
- Explain the user-visible effect and why the change is useful.
- Include the checks you ran and their results.
- Update `README.md` for user-facing behavior and `docs/ARCHITECTURE.md` for
  protocol, configuration, security-model, or roadmap changes.
- Do not commit generated `lib/` output, dependencies, credentials, local
  settings, logs, or test artifacts.
- Call out wire-protocol or configuration compatibility changes explicitly.

Bug reports and feature proposals are welcome as GitHub issues. For security
issues, avoid publishing secrets, keys, tokens, or exploit details in a public
issue or pull request; contact the maintainer privately first.
