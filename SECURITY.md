# Security Policy

## Scope

Libris is a self-hosted application. There is no central hosted service — each user runs their own instance. Security vulnerabilities therefore affect individual deployments rather than a shared platform.

In-scope issues include:

- Authentication or authorization bypasses
- Path traversal or arbitrary file read/write
- Remote code execution
- SQL injection or data leakage
- Insecure default configuration that puts self-hosters at risk

Out of scope:

- Vulnerabilities that require physical access to the server
- Denial-of-service attacks against self-hosted instances
- Issues in third-party dependencies (report those upstream)

## Reporting a Vulnerability

Open a [GitHub issue](../../issues) and label it `security`. If the issue is sensitive and you'd prefer it not be public before a fix is available, use [GitHub's private vulnerability reporting](../../security/advisories/new) if enabled, or describe the issue minimally in a public issue and we'll move the conversation privately.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- The version of Libris you tested against
- Any suggested mitigations if you have them

## Response

This is a small open-source project maintained in spare time. I'll aim to acknowledge reports within a few days and provide a fix or workaround within a reasonable timeframe depending on severity. Critical issues will be prioritized.

There is no bug bounty program.
