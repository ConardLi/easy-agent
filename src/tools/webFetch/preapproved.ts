/**
 * Preapproved WebFetch hosts.
 *
 * Reference: claude-code-source-code/src/tools/WebFetchTool/preapproved.ts
 *
 * WebFetch normally requires the user to approve each domain. We make an
 * exception for a curated set of code-related documentation hosts so the
 * agent can read docs without a confirmation prompt for every lookup.
 *
 * SECURITY: this list is for WebFetch (GET only). It is deliberately NOT
 * shared with the sandbox's network rules — arbitrary network access to some
 * of these (uploads, POST) could enable exfiltration. Sandbox network access
 * still requires explicit user permission rules.
 */

export const PREAPPROVED_HOSTS = new Set<string>([
  // Anthropic / MCP
  "platform.claude.com",
  "code.claude.com",
  "modelcontextprotocol.io",
  "github.com/anthropics",
  "agentskills.io",

  // Top programming languages
  "docs.python.org",
  "en.cppreference.com",
  "docs.oracle.com",
  "learn.microsoft.com",
  "developer.mozilla.org",
  "go.dev",
  "pkg.go.dev",
  "www.php.net",
  "docs.swift.org",
  "kotlinlang.org",
  "ruby-doc.org",
  "doc.rust-lang.org",
  "www.typescriptlang.org",

  // Web & JS frameworks
  "react.dev",
  "angular.io",
  "vuejs.org",
  "nextjs.org",
  "expressjs.com",
  "nodejs.org",
  "bun.sh",
  "jquery.com",
  "getbootstrap.com",
  "tailwindcss.com",
  "d3js.org",
  "threejs.org",
  "redux.js.org",
  "webpack.js.org",
  "jestjs.io",
  "reactrouter.com",

  // Python frameworks & libs
  "docs.djangoproject.com",
  "flask.palletsprojects.com",
  "fastapi.tiangolo.com",
  "pandas.pydata.org",
  "numpy.org",
  "www.tensorflow.org",
  "pytorch.org",
  "scikit-learn.org",
  "matplotlib.org",
  "requests.readthedocs.io",
  "jupyter.org",

  // PHP / Java / .NET
  "laravel.com",
  "symfony.com",
  "wordpress.org",
  "docs.spring.io",
  "hibernate.org",
  "tomcat.apache.org",
  "gradle.org",
  "maven.apache.org",
  "asp.net",
  "dotnet.microsoft.com",
  "nuget.org",
  "blazor.net",

  // Mobile
  "reactnative.dev",
  "docs.flutter.dev",
  "developer.apple.com",
  "developer.android.com",

  // Databases / data
  "keras.io",
  "spark.apache.org",
  "huggingface.co",
  "www.kaggle.com",
  "www.mongodb.com",
  "redis.io",
  "www.postgresql.org",
  "dev.mysql.com",
  "www.sqlite.org",
  "graphql.org",
  "prisma.io",

  // Cloud & devops
  "docs.aws.amazon.com",
  "cloud.google.com",
  "kubernetes.io",
  "www.docker.com",
  "www.terraform.io",
  "www.ansible.com",
  "vercel.com/docs",
  "docs.netlify.com",
  "devcenter.heroku.com",

  // Testing / misc
  "cypress.io",
  "selenium.dev",
  "docs.unity.com",
  "docs.unrealengine.com",
  "git-scm.com",
  "nginx.org",
  "httpd.apache.org",
]);

// Split once: most entries are hostname-only (O(1) Set lookup); a few are
// path-scoped (e.g. "github.com/anthropics") and need a prefix check.
const { HOSTNAME_ONLY, PATH_PREFIXES } = (() => {
  const hosts = new Set<string>();
  const paths = new Map<string, string[]>();
  for (const entry of PREAPPROVED_HOSTS) {
    const slash = entry.indexOf("/");
    if (slash === -1) {
      hosts.add(entry);
    } else {
      const host = entry.slice(0, slash);
      const prefix = entry.slice(slash);
      const list = paths.get(host);
      if (list) list.push(prefix);
      else paths.set(host, [prefix]);
    }
  }
  return { HOSTNAME_ONLY: hosts, PATH_PREFIXES: paths };
})();

export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  if (HOSTNAME_ONLY.has(hostname)) return true;
  const prefixes = PATH_PREFIXES.get(hostname);
  if (prefixes) {
    for (const p of prefixes) {
      // Enforce path segment boundaries: "/anthropics" must not match
      // "/anthropics-evil". Only exact match or a "/" after the prefix.
      if (pathname === p || pathname.startsWith(p + "/")) return true;
    }
  }
  return false;
}

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isPreapprovedHost(parsed.hostname, parsed.pathname);
  } catch {
    return false;
  }
}
