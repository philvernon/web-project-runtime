# Interactive experiences

A small games/interactive-experiments consumer of the library's full `WebBuilder`. It uses native DOM, Canvas or SVG, without a game dependency or a separate app runtime. `config.ts` owns its trusted guidance, public context and starters; its dependency approval list is empty.

Follow [shared setup and model configuration](../README.md#run-locally), then run:

```sh
npm --prefix examples/shared start -- experiences
```

Try the target-tapping starter, play it with Tab/Enter or touch, then ask: “Make the target blue and add a restart button.” Existing versions remain inline with their conversation turns until Reset. Stop cancels this example's backend turn; the frame's own Stop only disposes that preview. The library bounds preview lifetime to one minute.

This is a local developer example, not a hosted game platform. Do not submit private data. Generation quality depends on the explicitly configured model; there is no offline fixture mode in the application. [Deterministic browser tests](../README.md#deterministic-verification) use isolated synthetic model HTTP fixtures, not live inference.
