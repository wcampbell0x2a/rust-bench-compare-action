# rust-bench-compare

Compare the performance of a PR with the base branch.

---

This GitHub action compares the benchmark results of a PR with the results of
the base branch. It uses the [criterion.rs](https://github.com/bheisler/criterion.rs/)
or [gungraun](https://github.com/gungraun/gungraun) benchmarks of the project.

The action builds and benchmarks the two branches in the same job on the same
runner. Thus the two results come from the same hardware. The action does not
store a history and does not use an external service.

Select the harness with the `harness` input:

| `harness`             | Measures                             | Notes                                                            |
| --------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `criterion` (default) | Wall-clock time                      | CI noise can change the result. Run the benchmark on your machine before you act on a result. |
| `gungraun`            | Instruction counts, estimated cycles | Uses Valgrind and has almost no noise. Good for CI. Linux only.  |

> ⚠️ Wall-clock results from the `criterion` harness can change with the load on
> GitHub Actions. Run these benchmarks on your machine before you make a
> decision. This warning is not applicable to `gungraun`, which counts
> instructions.

> **New name:** the previous name of this action was `criterion-compare-action`.
> The action now supports more than criterion. The GitHub repository redirect
> keeps the existing `uses: wcampbell0x2a/criterion-compare-action@v3`
> references correct, but change them to the new name. Versioning restarted
> under the new name, so `criterion-compare-action@v3` becomes
> `rust-bench-compare-action@v1`.

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
      - uses: actions/checkout@v4
      - uses: wcampbell0x2a/rust-bench-compare-action@v1
        with:
          # Optional. The benchmarking harness: `criterion` (default) or `gungraun`
          harness: "criterion"
          cwd: "subDirectory (optional)"
          # Optional. Compare only this package
          package: "example-package"
          # Optional. Compare only this benchmark target
          benchName: "example-bench-target"
          # Optional. Disables the default features of a crate
          defaultFeatures: false
          # Optional. Features activated in the benchmark
          features: "async,tokio-support"
          # Needed. The name of the branch to compare with. The default is the target branch of the pull request
          branchName: ${{ github.base_ref }}
          # Optional. Default is `${{ github.token }}`.
          token: ${{ secrets.GITHUB_TOKEN }}
```

### Gungraun

Gungraun needs the `gungraun-runner` binary and Valgrind. This action does **not**
install them. Use the official [`gungraun/setup-gungraun`](https://github.com/gungraun/setup-gungraun)
action first. That action also keeps the version of the runner the same as the
version of your `gungraun` library dependency:

```yml
on: [pull_request]
name: benchmark pull requests
jobs:
  runBenchmark:
    name: run benchmark
    runs-on: ubuntu-latest # gungraun requires Linux
    steps:
      - uses: actions/checkout@v4
      - uses: gungraun/setup-gungraun@v1
      - uses: wcampbell0x2a/rust-bench-compare-action@v1
        with:
          harness: "gungraun"
          # All of the criterion options above work here too.
          branchName: ${{ github.base_ref }}
```

Gungraun reports **Instructions** and **Estimated Cycles** for each benchmark.
These values are instruction counts and not wall-clock times. Thus they stay
stable between CI runs, and the warning above is not applicable.

Gungraun also needs debug symbols in the `bench` profile:

```toml
[profile.bench]
debug = true
```

## Troubleshooting

### `Unrecognized option: 'save-baseline'`

If this error occurs, read [this Criterion FAQ](https://bheisler.github.io/criterion.rs/book/faq.html#cargo-bench-gives-unrecognized-option-errors-for-valid-command-line-options)
to find a solution.

### `Missing required tool(s) for the gungraun harness`

Add `- uses: gungraun/setup-gungraun@v1` before this action. Also make sure that
the job runs on a Linux runner. Gungraun cannot run on Windows or macOS.

### `Unable to resolve action ... repository not found`

The redirect is not applicable if you use a commit SHA with the old
`criterion-compare-action` name. Change the `uses:` line to
`wcampbell0x2a/rust-bench-compare-action`.

### The gungraun benchmark names are missing or not clear

Gungraun needs debug symbols to find the names. Set `debug = true` in
`[profile.bench]`. If your release profile sets `strip = true`, set
`strip = false` for the benchmarks.
