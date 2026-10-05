# Evidence bundle format

Upload one zip per program baseline under **Evidence datasets**, or let an evidence source build it from your repository, Jira and CI ([connectors.md](connectors.md)). The files are ones your tools already produce. Download the sample from that page (or run `aerotrace export-sample sample.zip`) to see a complete example with 3 modules.

```
bundle.json
requirements/hlr.csv
requirements/llr.csv
design/elements.csv
src/**                     (.c .h .adb .ads .cpp .hpp)
tests/*.xml                (JUnit)
coverage/coverage.csv      and/or coverage/lcov.info
cm/baseline.csv
prs/problem_reports.csv
plans/**                   (any documents; one record each)
```

A single top-level folder inside the zip is fine.

## bundle.json

```json
{
  "format": "aerotrace-bundle/1",
  "program": "FMS 4.2",
  "baseline": "a3f9c1",
  "modules": [
    { "id": "ALT-ALERT", "name": "Altitude alerting", "dal": "B", "src": "src/alt_alert/", "entryPoints": ["alt_alert_task"] }
  ]
}
```

`src` is the folder prefix that holds the module's code. `entryPoints` are functions called by the scheduler or RTOS, which is why nothing in the code calls them. You can mark them in source with `/* @entry */` instead.

## Requirements

`requirements/hlr.csv`: `id,module,text`
`requirements/llr.csv`: `id,module,parent,text` (`parent` is the HLR ID)

Export these from DOORS, Polarion or Jama as CSV. Commas and quotes inside text must follow standard CSV quoting.

## Design

`design/elements.csv`: `id,module,couplings,text`. `couplings` lists the other modules this module may call, separated by `;`. The Design agent flags calls into any other module as undocumented coupling.

## Source

Trace tags go in the comment block right above each function:

```c
/* Implements: LLR-ALT-0161, LLR-ALT-0162 */
int alt_alert_report_011(const alt_alert_in_t *in, alt_alert_out_t *out)
{
    if (in->bad_frames >= 4) {   /* LLR-ALT-0161 */
        out->status = STATUS_FAILED;
    }
    return OK;
}
```

Interrupt handlers marked with `__attribute__((interrupt))` (or a vector-table comment) are recognised by Layer 2, which then disputes Layer 1's "dead code" finding instead of letting it stand.

## Tests

JUnit XML, one `<testcase>` per test:

```xml
<testcase name="TC-ALT-0161" classname="ALT-ALERT">
  <properties>
    <property name="requirements" value="LLR-ALT-0161"/>
    <property name="function" value="alt_alert_report_011"/>
    <property name="run" value="2026-09-30"/>
  </properties>
  <failure message="expected output not produced"/>   <!-- omit when it passed -->
</testcase>
```

`<skipped/>` means no result was recorded on this baseline, and the Testing agent reports that.

## Coverage

`coverage/coverage.csv`: `function,statement,decision,mcdc` (percent). MC/DC isn't in LCOV, so DAL A programs need this file. `coverage/lcov.info` is read for statement and decision coverage per function when present. Values in the CSV win.

## Configuration

`cm/baseline.csv`: `file,sha256`, the checksum recorded for each file in the baseline. The importer hashes the files actually in the bundle and the CM agent reports every mismatch.

## Problem reports

`prs/problem_reports.csv`: `id,module,severity,status,files,title`. `severity` is 1 to 3, `status` is OPEN or CLOSED, and `files` are separated by `;`.

## What happens on upload

The zip is stored and a worker imports it in the background. The dataset shows **Importing**, then **Ready** with any warnings (unknown modules, files listed in the baseline but missing, tests with no requirements), or **Failed** with the reason. Nothing is audited until you start an audit or a schedule fires.
