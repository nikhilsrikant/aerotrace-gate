# Evidence connectors

Uploading a zip works, but evidence on a real program is spread out. Requirements, design and source sit in a repository. Problem reports live in Jira. Test results and coverage come out of CI. An evidence source pulls all three and builds the bundle for you, the same format described in [evidence-bundle.md](evidence-bundle.md).

Each sync either records a new dataset version, named `<source> @ <short commit>`, or reports `unchanged` when every input file is byte-for-byte what the last sync saw. A version keeps its provenance: repository, branch, commit, baseline tag and commit, the JQL and how many issues it returned, the CI run and artifact, and a SHA-256 over every input. The bundle it built is stored next to uploaded ones.

## What comes from where

| Bundle part | Default source | Replaced by |
| --- | --- | --- |
| `bundle.json`, `requirements/`, `design/`, `src/`, `plans/` | The repository at the branch, tag or commit, under the bundle folder | (always the repository) |
| `cm/baseline.csv` | The repository's own file, if it has one | **Baseline tag:** SHA-256 of every source file at that tag. Files changed since show up as baseline drift findings |
| `prs/problem_reports.csv` | The repository's own file | **Jira:** the issues a JQL query returns |
| `tests/*.xml`, `coverage/` | The repository's own files | **CI:** JUnit XML and coverage from the run for that commit |

## Setting one up

**Evidence datasets → Add source.** Or `POST /api/sources` (see [api.md](api.md)).

### Repository

- **GitHub:** `owner/name`. For GitHub Enterprise Server, also the server address (`https://github.example.com`); the API path is added for you.
- **GitLab:** the full project path (`group/subgroup/project`). For self-managed GitLab, also the server address.
- **Branch, tag or commit:** what to sync. A branch follows the latest commit each time.
- **Bundle folder:** where `bundle.json` sits, if not at the top.
- **Token:** read access to contents. GitHub: a fine-grained token with *Contents: read* (and *Actions: read* for CI artifacts), or a GitHub App installation token kept fresh in your secret store. GitLab: a project access token with `read_api` and `read_repository`.

### Jira

- **Cloud** uses the enhanced search API (`/rest/api/3/search/jql`) with an account email and an API token.
- **Server / Data Center** uses `/rest/api/2/search` with a personal access token.
- **Mapping:** issue key → id. Module comes from the first component by default, or a `module:<ID>` label, or a custom field. Priority Highest, Blocker or Critical → severity 1; High or Major → 2; anything else → 3. A `sev1`, `sev2` or `sev3` label overrides that. Status is CLOSED when the status category is Done. Changed files come from a custom field (text or list) and from `file:<path>` labels.
- Issues with no module are skipped and listed in the sync warnings.

### CI

- **GitHub Actions:** the artifact (default name `aerotrace-evidence`) of a successful run *for the synced commit*, optionally from one workflow file. If that commit has no successful run yet, the latest successful run on the branch is used and the sync warns about the mismatch.
- **GitLab:** the artifacts of the named job's latest successful pipeline on the branch.
- **Links:** JUnit XML URLs and one coverage URL, for Jenkins, Artifactory or anything else that serves files over https.
- Inside the artifact, any `*.xml` is treated as JUnit, `lcov.info` or `*.lcov` as LCOV, and a CSV with `coverage` in its name as `coverage.csv`.

A GitHub Actions step that publishes what AeroTrace reads:

```yaml
- uses: actions/upload-artifact@v4
  with:
    name: aerotrace-evidence
    path: |
      build/test-results/**/*.xml
      build/coverage/coverage.csv
```

### After a sync

- **Audit after new evidence:** module IDs or patterns to audit whenever a sync records a new version. Unchanged syncs don't re-audit.
- **Schedules:** pick *Sync a source first* in the schedule editor. Each run syncs, then audits the version that results, changed or not.
- **Dry run** fetches and imports in memory and stores nothing. Use it to check tokens and mappings.

## Tokens are references, never values

A source stores only a secret reference such as `aws-sm://aerotrace/connectors/github`, `azure-kv://aerotrace-kv/connector-jira` or `gcp-sm://projects/p/secrets/connector-gitlab/versions/latest`. The worker reads it when the sync runs. Only references under `CONNECTOR_SECRET_PREFIXES` are accepted (default `env://CONNECTOR_`), and each must have the exact shape its store uses with no `..` segments, so a source can't name the database password or session secret. Set the prefix to a path that holds connector tokens and nothing else, and give the app identity read access to that path.

## Network rules

- https only. Plain http is allowed only for hosts listed in `CONNECTOR_ALLOWED_HOSTS`.
- Private, loopback and link-local addresses are refused unless the host is in `CONNECTOR_ALLOWED_HOSTS`. Put an internal GitHub Enterprise or Jira Data Center there.
- Cloud metadata addresses are refused always.
- The address is checked when the connection opens, not only when the URL is saved.
- Redirects are followed and checked again; the token is not sent on to a different host.
- Downloads are capped by `CONNECTOR_MAX_BYTES` (512 MB by default).

## Failures

A failed sync sets the source's last sync to *Failed* with the reason ("GitHub (acme/fcc@main) answered 401 (check the token reference): Bad credentials"), writes `source.sync_failed` to the audit log, and puts the reason on the schedule if a schedule triggered it. The worker retries a sync up to three times with backoff.
