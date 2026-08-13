## Criterion Benchmark for abc1234
  <details>
    <summary>Click to view benchmark</summary>

| Test | Base         | PR               | % |
|------|--------------|------------------|---|
| character module | 22.2±0.41ms | **21.6±0.53ms** | **-2.70%** |
| directory module – home dir | 21.7±0.69ms | 21.4±0.44ms | -1.38% |
| full prompt | 46.0±0.90ms | **42.7±0.79ms** | **-7.17%** |
| regressed bench | **10.0±0.10ms** | 12.5±0.10ms | **+25.00%** |
| only_in_base | 5.0±0.10ms | N/A | N/A |
| tiny ns bench | **500.0±5.00ns** | 550.0±5.00ns | **+10.00%** |
| micro bench | 12.0±0.20µs | 12.0±0.90µs | 0.00% |

  </details>
  