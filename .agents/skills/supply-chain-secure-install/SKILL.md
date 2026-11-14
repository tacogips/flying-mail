---
name: supply-chain-secure-install
description: Use when installing, updating, or auditing npm dependencies with Bun. Provides Shai-Hulud supply chain attack countermeasures including bunfig.toml hardening, lockfile verification, trustedDependencies management, and CI/CD pipeline security.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
user-invocable: true
---

# Supply Chain Secure Install

This skill provides comprehensive defense-in-depth guidelines for safe package installation with Bun, based on lessons learned from the Shai-Hulud 1.0 (September 2025) and Shai-Hulud 2.0 (November 2025) npm supply chain attacks.

## When to Apply

Apply these guidelines when:
- Installing new dependencies (`bun add`)
- Updating existing dependencies (`bun update`)
- Setting up CI/CD pipelines that install packages
- Auditing current project dependency security posture
- Reviewing pull requests that modify `package.json` or lockfiles

## Threat Model: Shai-Hulud Attack Vectors

The Shai-Hulud attacks exploited:

| Attack Vector | Description | Countermeasure |
|--------------|-------------|----------------|
| Lifecycle scripts | `preinstall`/`postinstall` scripts execute malicious code on `bun install` | Bun blocks by default; use `trustedDependencies` allowlist |
| Freshly published packages | Compromised packages published and consumed within hours | `minimumReleaseAge` in bunfig.toml |
| Token theft from .npmrc | Malware reads `_authToken` from `.npmrc` files | Never store tokens in project `.npmrc`; use env vars |
| Typosquatting | Fake packages with similar names | Manual review before adding dependencies |
| Dependency confusion | Public package replaces private one | Scoped packages + registry configuration |
| BYOR (Bring Your Own Runtime) | Attacker installs Bun as evasion technique | Not applicable to Bun projects (already using Bun) |

## Lifecycle Script Blocking (Bun Default Behavior)

Bun's most important security advantage over npm/yarn: **lifecycle scripts (`preinstall`, `postinstall`, `prepare`) are blocked by default** for all third-party packages.

This is the PRIMARY defense against Shai-Hulud. The attack chain depends entirely on `preinstall` scripts executing `setup_bun.js` automatically during `bun install`. With Bun's default behavior, this execution is blocked.

### How It Works

| Package Manager | Default Behavior | Shai-Hulud Risk |
|----------------|-----------------|-----------------|
| npm | ALL lifecycle scripts execute automatically | HIGH - attack succeeds |
| yarn | ALL lifecycle scripts execute automatically | HIGH - attack succeeds |
| pnpm 10+ | lifecycle scripts disabled by default | LOW - blocked |
| **Bun** | **lifecycle scripts blocked by default** | **LOW - blocked** |

In Bun, only packages explicitly listed in `trustedDependencies` in `package.json` are allowed to run lifecycle scripts. All other packages' scripts are silently skipped.

### What Gets Blocked

```json
// In a compromised package's package.json:
{
  "scripts": {
    "preinstall": "node setup_bun.js",     // BLOCKED by Bun
    "postinstall": "node malicious.js",    // BLOCKED by Bun
    "install": "node compromise.js"        // BLOCKED by Bun
  }
}
```

### Comparison with npm --ignore-scripts

```bash
# npm requires explicit flag (easy to forget)
npm install --ignore-scripts

# pnpm 10+ disables by default, but respects .npmrc
# WARNING: Shai-Hulud could manipulate .npmrc to re-enable scripts

# Bun: blocked by default, CANNOT be re-enabled via .npmrc
# Only trustedDependencies allowlist enables scripts
bun install  # Scripts already blocked, no flag needed
```

**IMPORTANT**: Bun does NOT respect `.npmrc`'s `ignore-scripts` setting. This is actually a security advantage -- attackers cannot re-enable scripts by manipulating `.npmrc`.

## Cooldown Period (minimumReleaseAge)

The second critical defense: `minimumReleaseAge` prevents installation of freshly published package versions.

**Why this matters**: Shai-Hulud 1.0 (September 2025) was detected in 2.5 hours, and 2.0 (November 2025) in 12 hours. A cooldown period of even 1 day would have completely blocked both attacks.

**How it works**: When `minimumReleaseAge` is configured, Bun checks the publish timestamp of each package version. If a version was published more recently than the configured threshold, Bun refuses to install it and falls back to the most recent version that satisfies the age requirement.

## bunfig.toml Hardening

### Required Configuration

Every project MUST have a `bunfig.toml` with these security settings:

```toml
[install]
# Pin exact versions - no semver ranges
exact = true

# Generate text lockfile for reviewable git diffs
saveTextLockfile = true

# CRITICAL: Minimum age before a package version can be installed
# 259200 = 3 days (Shai-Hulud 1.0 was detected in 2.5 hours)
# 604800 = 7 days (recommended for production projects)
minimumReleaseAge = 259200

# NOTE: Bun blocks lifecycle scripts by default (secure by design)
# Use "trustedDependencies" in package.json to allowlist specific packages
```

### minimumReleaseAge Reference

| Value | Duration | Use Case |
|-------|----------|----------|
| 86400 | 1 day | Fast-moving development, acceptable risk |
| 259200 | 3 days | Standard projects (DEFAULT) |
| 604800 | 7 days | Production/commercial projects (RECOMMENDED) |
| 1209600 | 14 days | High-security environments |

### minimumReleaseAge Exclusions

For packages that require faster updates (e.g., type definitions), use `minimumReleaseAgeExcludes` in bunfig.toml:

```toml
[install]
minimumReleaseAge = 604800

# Packages excluded from release age requirement
minimumReleaseAgeExcludes = [
  "@types/bun",
  "@types/node",
  "typescript"
]
```

**WARNING**: Keep the exclusion list minimal. Each exclusion is a potential attack surface.

## trustedDependencies Management

Bun blocks lifecycle scripts by default. Only packages listed in `trustedDependencies` in `package.json` can run install scripts.

### Rules

1. **Default to empty array**: Start with `"trustedDependencies": []`
2. **Add only when necessary**: Only add packages that genuinely need lifecycle scripts
3. **Document the reason**: Add a comment explaining why each package is trusted
4. **Review periodically**: Audit the list on a regular cadence

### Common Packages Requiring Trust

```json
{
  "trustedDependencies": [
    "esbuild",
    "@swc/core",
    "sharp",
    "better-sqlite3",
    "playwright"
  ]
}
```

### Verification Before Trust

Before adding a package to `trustedDependencies`:

1. **Check the package source**: Review the `postinstall` script on npm/GitHub
2. **Check maintenance status**: Active maintainers, recent commits, no ownership transfers
3. **Check download count**: Established packages with high download counts are lower risk
4. **Check with Socket.dev**: Use `npx socket-npm info <package>` if available

## Lockfile Security

### Mandatory Practices

1. **Always commit lockfiles**: Both `bun.lockb` (binary) and `bun.lock` (text) must be in git
2. **Review lockfile changes**: Text lockfile diffs show exactly what changed
3. **Use `bun install --frozen-lockfile` in CI**: Prevents unexpected dependency resolution

### CI Pipeline Example

```yaml
- name: Install dependencies
  run: bun install --frozen-lockfile
```

### Lockfile Integrity Checks

```bash
# Verify lockfile is up-to-date without modifying it
bun install --frozen-lockfile

# If this fails, the lockfile is out of sync with package.json
# Developer must run `bun install` locally and commit the updated lockfile
```

## Pre-Install Dependency Review

### Before Adding a New Package

Run these checks before `bun add <package>`:

```bash
# 1. Check package info on npm
bun pm info <package>

# 2. Check for known vulnerabilities
bun audit

# 3. Review the package on npm website
# Check: maintainers, last publish date, weekly downloads, dependencies count

# 4. Check for typosquatting
# Verify the exact package name matches the official one
# Common tricks: lodash vs 1odash, express vs expresss
```

### Red Flags During Review

| Red Flag | Risk |
|----------|------|
| Published less than 7 days ago | Potentially compromised freshly published package |
| Single maintainer | Higher risk of account compromise |
| Very few downloads | Potential typosquatting |
| Excessive dependencies | Larger attack surface |
| Recent ownership change | Possible account takeover |
| No source repository linked | Cannot verify code matches published package |
| `preinstall` / `postinstall` scripts | Arbitrary code execution during install |
| Minified/obfuscated code in npm package | Hiding malicious behavior |

## CI/CD Pipeline Security

### Secure Installation in CI

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read  # Minimal permissions
    steps:
      - uses: actions/checkout@<SHA>
        with:
          persist-credentials: false

      - uses: oven-sh/setup-bun@<SHA>
        with:
          bun-version: latest

      # CRITICAL: frozen lockfile prevents supply chain manipulation
      - name: Install dependencies
        run: bun install --frozen-lockfile

      # Run audit after install
      - name: Security audit
        run: bun audit
```

### Environment Variable Protection in CI

```yaml
# NEVER expose npm tokens as environment variables accessible to all steps
# Use step-level env only where needed

# BAD
env:
  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}

# GOOD - only expose to the step that needs it
steps:
  - name: Publish
    env:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
    run: bun publish
```

## .npmrc Security

### Project-Level .npmrc

The project `.npmrc` should NEVER contain auth tokens:

```ini
# .npmrc - safe settings only
registry=https://registry.npmjs.org/
# Do NOT put _authToken here
```

### .gitignore

Ensure `.npmrc` with tokens is never committed:

```gitignore
# User-level .npmrc may contain tokens
.npmrc.local
```

### Token Storage

| Environment | Where to Store Tokens |
|------------|----------------------|
| Local development | `~/.npmrc` (user home, NOT project) |
| CI/CD | Environment variables / secrets manager |
| Docker | Build args or runtime secrets |

## Periodic Audit Checklist

Run these checks regularly (weekly or per-sprint):

```bash
# 1. Check for known vulnerabilities
bun audit

# 2. Check for outdated packages
bun outdated

# 3. Verify lockfile integrity
bun install --frozen-lockfile

# 4. Review trustedDependencies list
# Ensure each entry is still necessary
```

## CI/CD Environment Hardening

Shai-Hulud 2.0 detects CI/CD environments by checking for specific environment variables (`GITHUB_ACTIONS`, `BUILDKITE`, `PROJECT_ID`, `CODEBUILD_BUILD_NUMBER`, `CIRCLE_SHA1`). When detected, it runs in foreground mode for maximum credential extraction during the build window.

### GitHub Actions Hardening

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15  # Prevent long-running malicious processes
    permissions:
      contents: read  # MINIMUM permissions
      # Do NOT add: actions: write, administration, workflows
    steps:
      - uses: actions/checkout@<SHA>  # Always pin to SHA
        with:
          persist-credentials: false  # Prevent token leakage

      - uses: oven-sh/setup-bun@<SHA>  # Pin to SHA
        with:
          bun-version: latest

      # CRITICAL: frozen lockfile in CI
      - name: Install dependencies
        run: bun install --frozen-lockfile

      # Audit after install
      - name: Security audit
        run: bun audit

      # Tests and build
      - name: Test
        run: bun test
      - name: Build
        run: bun run build
```

### CI Environment Variable Protection

```yaml
# BAD: Global env exposes tokens to ALL steps (including compromised dependencies)
env:
  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
  AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}

# GOOD: Step-level env exposes tokens ONLY to the step that needs them
steps:
  - name: Install (no secrets needed)
    run: bun install --frozen-lockfile
    # NO env: block - compromised dependency cannot access secrets

  - name: Deploy (needs secrets)
    env:
      AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    run: bun run deploy
```

### Restrict Network Egress in CI

```yaml
# Use GitHub Actions network restrictions (if available)
# Or use a custom container with restricted networking

jobs:
  build:
    runs-on: ubuntu-latest
    container:
      image: your-org/restricted-build-image
      # Container with iptables rules blocking non-essential outbound
```

### Prevent Workflow Injection

Shai-Hulud creates `discussion.yaml` and `add-linter-workflow-*` branches:

```yaml
# Branch protection rules (via GitHub settings):
# - Require PR reviews before merging
# - Require status checks
# - Restrict push to main branch
# - Require signed commits

# In workflow: only trigger on trusted events
on:
  push:
    branches: [main]  # NOT on all branches
  pull_request:
    branches: [main]  # NOT pull_request_target
```

### Monitor for Unauthorized Workflow Changes

```bash
# In CI: verify no unexpected workflows were added
git diff origin/main -- .github/workflows/
# Fail the build if unexpected workflow files appear
```

## Emergency Response: Suspected Compromise

If you suspect a dependency has been compromised:

1. **Do NOT run `bun install`** on the affected project
2. **Check the specific package version** against known compromised lists
3. **Review `bun.lock` (text)** for unexpected version changes
4. **Rotate ALL tokens** (npm, GitHub, cloud providers) if lifecycle scripts were executed
5. **Report the issue** to npm security and the package maintainers
6. **Pin to a known-good version** in package.json with exact version

## References

- [Bun bunfig.toml documentation](https://bun.sh/docs/runtime/bunfig)
- [Shai-Hulud 2.0 - Trend Micro Analysis](https://www.trendmicro.com/en_us/research/25/k/shai-hulud-2-0-targets-cloud-and-developer-systems.html)
- [PostHog Shai-Hulud Post-Mortem](https://posthog.com/blog/nov-24-shai-hulud-attack-post-mortem)
- [Datadog Shai-Hulud 2.0 Analysis](https://securitylabs.datadoghq.com/articles/shai-hulud-2.0-npm-worm/)
- [Socket.dev - Package Security](https://socket.dev/)
