# Charts

A native-SVG chart consumer of the same full `WebBuilder` and Pi service used by the experiences example. No chart dependency is installed or approved. `config.ts` contains all chart-specific guidance, starters and public synthetic context.

Follow [shared setup and model configuration](../README.md#run-locally), then run:

```sh
npm --prefix examples/shared start -- charts
```

The synthetic dataset counts scheduled/completed deliveries:

| Month    | Scheduled | Completed |
| -------- | --------: | --------: |
| January  |        42 |        38 |
| February |        55 |        51 |
| March    |        49 |        47 |
| April    |        68 |        62 |
| May      |        73 |        70 |

Try the bar-chart starter, then ask: “Make the bars horizontal and preserve the delivery counts.” Each version is shown with its own turn. The guidance asks for labelled units/series and an accessible text table or summary; the model's output still needs human review for accuracy. There is no connection to operational data or a reporting service.

Use only public numbers. Backend Stop, Reset and preview disposal are library-owned. [Deterministic browser tests](../README.md#deterministic-verification) exercise the real generation path with synthetic HTTP model fixtures; they are not live inference or provider acceptance.
