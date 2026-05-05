# Contributing to Treenix

Thanks for contributing to Treenix. This guide explains how to set up the repo, open pull requests, and sign off commits.

Keep contributions small, explicit, and easy to review.

## Before You Start

- For bugs, open an issue with a minimal reproduction.
- For larger changes, open an issue or discussion first so the design can be agreed before code is written.
- Security issues must be reported privately. See [SECURITY.md](./SECURITY.md).

## Local Setup

Requirements:

- Node.js 22 or newer
- npm

```bash
npm install
npm test
npm run typecheck
```

Useful scripts:

```bash
npm run dev:server
npm run dev:front
npm run schema
npm run test:e2e
```

## Repository Shape

- `core/`
- `packages/react/`
- `packages/ssr/`
- `mods/`
- `docs/`

## Engineering Rules

- Fix root causes, not symptoms.
- Do not add defensive filters inside trusted Treenix boundaries. If internal data violates a contract, let it fail loudly and fix the source.
- Keep core primitives small and dependency-light.
- Use existing Treenix helpers and local patterns before adding new abstractions.
- Client mutations should go through typed actions, not direct tree writes.
- Tests should verify public contracts, not implementation details.

## Pull Requests

Before opening a PR:

- Run the focused tests for your change.
- Run `npm test` or explain why it was not run.
- Run `npm run typecheck` for TypeScript changes.
- Update docs when behavior, public APIs, or setup steps change.
- Keep unrelated refactors out of the PR.

PRs should include:

- What changed.
- Why it changed.
- How it was tested.
- Any migration or compatibility notes.

## Developer Certificate of Origin

By submitting a commit to this project, you certify that your contribution complies with the Developer Certificate of Origin (DCO). Please use `git commit -s` to sign off your changes.

The sign-off line must look like this:

```text
Signed-off-by: Your Name <your.email@example.com>
```

You can add it automatically:

```bash
git commit -s
```

By making a contribution to this project, I certify that:

1. The contribution was created in whole or in part by me and I have the right to submit it under the open source license indicated in the file; or

2. The contribution is based upon previous work that, to the best of my knowledge, is covered under an appropriate open source license and I have the right under that license to submit that work with modifications, whether created in whole or in part by me, under the same open source license (unless I am permitted to submit under a different license), as indicated in the file; or

3. The contribution was provided directly to me by some other person who certified 1., 2. or 3. and I have not modified it.

4. I understand and agree that this project and the contribution are public and that a record of the contribution, including all personal information I submit with it, including my sign-off, is maintained indefinitely and may be redistributed consistent with this project or the open source license(s) involved.

## License

By contributing, you agree that your contribution will be licensed under the license terms of this repository.
