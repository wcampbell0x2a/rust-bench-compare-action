# criterion-compare

Compare the performance of a PR against the base branch.

---

> ⚠️ Performance benchmarks provided by this action may fluctuate as load on GitHub Actions does. Run benchmarks locally before making any decisions based on the results.

A GitHub action that will compare the benchmark output between a PR and the base branch, using the project's [criterion.rs](https://github.com/bheisler/criterion.rs/) or [gungraun](https://github.com/gungraun/gungraun) benchmarks.

Pick the harness with the `harness` input:

| `harness`             | Measures                             | Notes                                                                            |
| --------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `criterion` (default) | Wall-clock time                      | The original behaviour. Subject to CI noise.                                     |
| `gungraun`            | Instruction counts, estimated cycles | Valgrind-based and virtually noise-free, so it is well suited to CI. Linux only. |

## Example

![Example benchmark comparison comment](image.png)

## Usage

### Criterion

Create a `.github/workflows/pull_request.yml` file in your repo:

```yml
on: [pull_request]
name: benchmark pull requests
jobs:
  runBenchmark:
    name: run benchmark
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: boa-dev/criterion-compare-action@v3
        with:
          cwd: "subDirectory (optional)"
          # Optional. Compare only this package
          package: "example-package"
          # Optional. Compare only this benchmark target
          benchName: "example-bench-target"
          # Optional. Disables the default features of a crate
          defaultFeatures: false
          # Optional. Features activated in the benchmark
          features: "async,tokio-support"
          # Needed. The name of the branch to compare with. This default uses the branch which is being pulled against
          branchName: ${{ github.base_ref }}
          # Optional. Default is `${{ github.token }}`.
          token: ${{ secrets.GITHUB_TOKEN }}
```

### Gungraun

Gungraun needs the `gungraun-runner` binary and Valgrind. This action does **not**
install them — use the official [`gungraun/setup-gungraun`](https://github.com/gungraun/setup-gungraun)
action first, which also keeps the runner version in sync with your `gungraun`
library dependency:

```yml
on: [pull_request]
name: benchmark pull requests
jobs:
  runBenchmark:
    name: run benchmark
    runs-on: ubuntu-latest # gungraun requires Linux
    steps:
      - uses: actions/checkout@v3
      - uses: gungraun/setup-gungraun@v1
      - uses: boa-dev/criterion-compare-action@v3
        with:
          harness: "gungraun"
          # All of the criterion options above work here too.
          branchName: ${{ github.base_ref }}
```

Gungraun reports **Instructions** and **Estimated Cycles** for each benchmark.
Because these are instruction counts rather than wall-clock timings, they are
stable across CI runs and the fluctuation warning above does not apply.

Gungraun also requires debug symbols in the `bench` profile:

```toml
[profile.bench]
debug = true
```

## Troubleshooting

### `Unrecognized option: 'save-baseline'`

If you encounter this error, you can check [this Criterion FAQ](https://bheisler.github.io/criterion.rs/book/faq.html#cargo-bench-gives-unrecognized-option-errors-for-valid-command-line-options), to find a workaround.

### `Missing required tool(s) for the gungraun harness`

Add `- uses: gungraun/setup-gungraun@v1` before this action, and make sure the
job runs on a Linux runner. Gungraun cannot run on Windows or macOS.

### Gungraun benchmark names are missing or unhelpful

Gungraun needs debug symbols to resolve names. Set `debug = true` under
`[profile.bench]`, and if your release profile sets `strip = true`, disable it
for benchmarks with `strip = false`.
