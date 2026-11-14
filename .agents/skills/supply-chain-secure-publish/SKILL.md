---
name: supply-chain-secure-publish
description: Use when creating, publishing, or maintaining npm packages with Bun. Provides Shai-Hulud supply chain attack countermeasures including npm token management, 2FA enforcement, provenance signing, trusted publishing via GitHub Actions, and pre-publish security checklists.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
user-invocable: true
---

# Supply Chain Secure Publish

This skill provides comprehensive guidelines for securely creating and publishing npm packages with Bun, based on lessons learned from the Shai-Hulud supply chain attacks where compromised maintainer accounts were used to inject malware into trusted packages.

## When to Apply

Apply these guidelines when:
- Creating a new npm package
- Publishing package updates to npm registry
- Setting up CI/CD publishing pipelines
- Managing npm access tokens and permissions
- Auditing existing package publishing workflows

## Threat Model: How Packages Get Compromised

In the Shai-Hulud attacks, the publish-side attack chain was:

```
Phishing email -> Maintainer npm token stolen -> Malicious version published
     -> preinstall script injected -> Worm propagates to all maintainer's packages
```

Key attack details:
- Attackers obtained npm tokens via phishing and credential theft
- Used stolen tokens to `npm publish` backdoored versions (patch bump)
- Injected `preinstall` scripts pointing to `setup_bun.js` loader
- Automated: processed up to 100 packages per compromised account in parallel
- Patch version bumps appeared as routine bug fixes

## npm Account Security

### Mandatory: Enable 2FA

```bash
# Enable 2FA on your npm account (MANDATORY for all package maintainers)
npm profile enable-2fa auth-and-writes
```

| 2FA Mode | Protection Level | Recommendation |
|----------|-----------------|----------------|
| `auth-only` | Protects login only | INSUFFICIENT |
| `auth-and-writes` | Protects login AND publish | REQUIRED |

### Token Management

#### Token Types and When to Use

| Token Type | Use Case | Shai-Hulud Risk |
|------------|----------|-----------------|
| Classic token (deprecated) | Legacy systems | HIGH - long-lived, broad scope |
| Granular access token | CI/CD publishing | LOWER - scoped, time-limited |
| OIDC / Trusted Publishing | GitHub Actions | LOWEST - no stored secrets |

#### Granular Token Best Practices

When creating npm tokens:

1. **Use granular access tokens** (not classic tokens)
2. **Scope to specific packages** - never use tokens with access to all packages
3. **Set expiration** - 30 days maximum for CI tokens
4. **Use read-only tokens** where publish is not needed
5. **Set CIDR allowlist** - restrict token usage to known CI IP ranges

```bash
# Create a granular token via npm CLI
npm token create --read-only  # For CI install-only jobs
```

#### Token Storage

| Location | Safe? | Notes |
|----------|-------|-------|
| `.npmrc` in project directory | NO | Committed to git, stolen by malware |
| `~/.npmrc` in home directory | RISKY | Shai-Hulud specifically targets this file |
| CI/CD secrets manager | YES | Encrypted, scoped, auditable |
| Environment variable in CI | YES | Ephemeral, per-job |
| GitHub Actions OIDC | BEST | No stored secrets at all |

### .npmrc Token Hygiene

```bash
# Check if you have tokens in project .npmrc (should be EMPTY)
grep -r "authToken" .npmrc 2>/dev/null && echo "WARNING: Token found in project .npmrc!"

# Check home .npmrc
grep "authToken" ~/.npmrc 2>/dev/null && echo "Token found in ~/.npmrc (expected for local dev)"
```

**CRITICAL**: The Shai-Hulud worm specifically searches for `.npmrc` files in:
1. Current working directory
2. User home directory (`~/`)

Both locations are targeted for `_authToken` extraction.

## Trusted Publishing (OIDC)

### GitHub Actions Trusted Publishing (Recommended)

Trusted Publishing eliminates stored npm tokens entirely. GitHub Actions authenticates directly with npm via OIDC.

#### Setup Steps

1. **Link your npm package to a GitHub repository** on npmjs.com:
   - Go to package settings -> "Publishing access"
   - Add GitHub Actions as a trusted publisher
   - Specify: repository owner, repository name, workflow filename, optional environment

2. **Create the publish workflow**:

```yaml
name: Publish Package
on:
  release:
    types: [created]

permissions:
  contents: read
  id-token: write  # Required for OIDC

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: npm-publish  # Optional: add environment protection rules
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@<SHA>  # Pin to full SHA
        with:
          persist-credentials: false

      - uses: oven-sh/setup-bun@<SHA>  # Pin to full SHA
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run tests
        run: bun test

      - name: Type check
        run: bun run typecheck

      - name: Build
        run: bun run build

      # Publish with provenance (no NPM_TOKEN needed!)
      - name: Publish to npm
        run: bunx npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ""  # OIDC handles auth
```

### Benefits of Trusted Publishing

| Aspect | Token-based | Trusted Publishing |
|--------|------------|-------------------|
| Token theft risk | HIGH | NONE (no token) |
| Token rotation needed | YES | NO |
| Audit trail | Token ID only | Full workflow provenance |
| Scope limitation | Manual | Automatic (repo + workflow) |
| Setup complexity | Low | Medium (one-time) |

## Package Provenance

### npm Provenance

Publishing with `--provenance` creates a verifiable link between the published package and its source code:

```bash
# Publish with provenance (in GitHub Actions with OIDC)
bunx npm publish --provenance --access public
```

Provenance proves:
- Which source repository the package was built from
- Which commit SHA was used
- Which CI workflow built and published it
- That no human manually modified the package

### Verifying Provenance

```bash
# Check provenance of an installed package
npm audit signatures
```

## Pre-Publish Security Checklist

Before every publish, verify:

### 1. Package Contents Audit

```bash
# Preview what files will be published
bun pm pack --dry-run

# Or
bunx npm pack --dry-run
```

Verify:
- [ ] No `.npmrc` or credential files included
- [ ] No `.env` files included
- [ ] No private keys or certificates included
- [ ] No source maps with sensitive paths
- [ ] No test fixtures with real data
- [ ] No `.git` directory included
- [ ] Package size is reasonable (unexpected size = possible payload injection)

### 2. files / .npmignore Configuration

Use `files` in `package.json` (allowlist approach, more secure than `.npmignore`):

```json
{
  "files": [
    "dist/",
    "README.md",
    "LICENSE"
  ]
}
```

### 3. Script Injection Check

Verify `package.json` scripts have not been tampered with:

```bash
# Check for suspicious lifecycle scripts
bun pm info . | grep -E "(preinstall|postinstall|prepack|postpack|prepare)"
```

**Red flags in scripts**:
- `preinstall` that downloads and executes external scripts
- `postinstall` with `curl`, `wget`, or `fetch` calls
- Scripts that reference URLs or IP addresses
- Scripts that read environment variables or `.npmrc`
- Obfuscated or minified script commands

### 4. Dependency Review

```bash
# Check for new or changed dependencies
bun audit

# Review dependency tree for unexpected additions
bun pm ls
```

## Package.json Security Configuration

### Recommended Configuration

```json
{
  "name": "@scope/package-name",
  "version": "1.0.0",
  "files": ["dist/", "README.md", "LICENSE"],
  "scripts": {
    "build": "bun build src/main.ts --outdir dist --target bun",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "bun run test && bun run typecheck && bun run build"
  },
  "publishConfig": {
    "access": "public",
    "provenance": true
  },
  "trustedDependencies": []
}
```

### Key Points

1. **Use scoped packages** (`@scope/name`): Prevents dependency confusion attacks
2. **`files` allowlist**: Only publish what is necessary
3. **`prepublishOnly` script**: Runs tests and build before every publish
4. **`publishConfig.provenance`**: Enable provenance by default
5. **Empty `trustedDependencies`**: Do not trust install scripts by default

## CI/CD Publishing Pipeline Security

### Required Protections

| Protection | Implementation |
|-----------|---------------|
| Branch protection | Only publish from `main` or release tags |
| Environment protection | GitHub Environment with required reviewers |
| Action pinning | All `uses:` pinned to full commit SHA |
| Minimal permissions | `contents: read`, `id-token: write` only |
| Frozen lockfile | `bun install --frozen-lockfile` |
| Test gate | Tests must pass before publish |
| Timeout | `timeout-minutes` on all jobs |

### Anti-Patterns to Avoid

```yaml
# BAD: Publishing from any branch
on: push

# BAD: Using npm token as global env
env:
  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}

# BAD: No test gate before publish
steps:
  - run: bun publish  # No tests first!

# BAD: Unpinned actions
- uses: actions/checkout@v4  # Tag, not SHA!
```

## Version Management

### Safe Versioning Practices

```bash
# Bump version explicitly
bun version patch  # or minor, major

# NEVER publish with --tag latest on pre-release
bunx npm publish --tag next  # For pre-release versions
```

### Detecting Unauthorized Publishes

Monitor your packages for unexpected version bumps:

```bash
# Check recent publish history
bunx npm info <package> time
```

In the Shai-Hulud attack, the worm performed **patch version increments** to make compromised publishes look like routine bug fixes.

## Multi-Maintainer Security

### Package Access Control

```bash
# List current maintainers
bunx npm access ls-collaborators <package>

# Use teams instead of individual access
bunx npm team create <org>:<team>
bunx npm access grant read-write <org>:<team> <package>
```

### Rules for Multi-Maintainer Packages

1. **Require 2FA** for all maintainers
2. **Use granular tokens** scoped to specific packages
3. **Prefer Trusted Publishing** (OIDC) over individual tokens
4. **Monitor access changes** - set up alerts for new maintainer additions
5. **Review publish history** regularly

## Emergency Response: Package Compromise

If your published package has been compromised:

1. **Unpublish the compromised version** (within 72 hours of publish):
   ```bash
   bunx npm unpublish <package>@<version>
   ```

2. **Revoke ALL npm tokens** immediately:
   ```bash
   bunx npm token revoke <token-id>
   ```

3. **Rotate GitHub tokens and secrets**

4. **Publish a clean patch version** from verified source

5. **Notify downstream users** via GitHub Advisory

6. **Report to npm security**: security@npmjs.com

## References

- [npm Trusted Publishing (Provenance)](https://docs.npmjs.com/generating-provenance-statements)
- [GitHub Actions OIDC for npm](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-cloud-providers)
- [Shai-Hulud 2.0 - Self-Propagation Analysis](https://securitylabs.datadoghq.com/articles/shai-hulud-2.0-npm-worm/)
- [PostHog Incident Response](https://posthog.com/blog/nov-24-shai-hulud-attack-post-mortem)
- [npm Granular Access Tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens)
