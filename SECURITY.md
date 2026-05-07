# Security Policy

## Supported Versions

Security fixes target the latest released Treenix packages and the current `main` branch. Older versions may receive fixes when practical, but users should upgrade to the latest release.

## Reporting a Vulnerability

Please do not report security vulnerabilities in public issues.

Use GitHub private vulnerability reporting for this repository. If that is unavailable, email `support@treenix.io` with `SECURITY` in the subject.

Include:

- Affected package and version or commit.
- A clear reproduction.
- Impact and expected attacker capabilities.
- Any logs, stack traces, or proof-of-concept code.

We will acknowledge the report, investigate it, and coordinate disclosure before publishing details.

## Threat Model

Treenix treats these as untrusted:

- Network requests, websocket clients, MCP clients, and browser input.
- User-provided data, uploaded files, and imported external content.
- Third-party services and their responses.

Treenix treats these as trusted:

- Project maintainers and repository write access.
- Developer machines, CI runners, deployment infrastructure, and Node.js runtime.
- Treenix configuration, first-party mods, and code intentionally installed by the application owner.

## In Scope

- Authentication or authorization bypass.
- ACL bypass that exposes or mutates private tree data.
- Path traversal or mount escape outside configured storage boundaries.
- Remote code execution reachable through an untrusted boundary.
- Cross-site scripting in Treenix-provided runtime, editor, or SSR output.
- MCP or action execution that bypasses Treenix validation, ACL, or action routing.
- Leaks of secrets or private data caused by Treenix runtime behavior.

## Out of Scope

- Malicious dependencies, custom mods, plugins, or application code installed by the project owner.
- Vulnerabilities in applications built with Treenix unless caused by Treenix itself.
- Misconfigured deployments, exposed secrets, weak credentials, or unsafe infrastructure.
- Social engineering, phishing, spam, or physical attacks.
- Denial-of-service reports without a clear confidentiality or integrity impact.

Reports outside this scope may still be fixed as normal bugs.
