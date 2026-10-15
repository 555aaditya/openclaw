# First transcript content investigation

Status: experiment in progress; no production change proposed.

The synthetic Team-scale first-content measurements previously attributed about 120 ms to transcript content. Rows attached at about 652 ms and initial placement released visibility at about 843 ms. Those are observations from an older baseline, not a measured idle delay.

Current source releases the normal end-first visibility gate after connected rows have been measured, the target end offset applied, and the virtual range committed. There is no normal-path font, image, animation-frame, or fixed-duration wait. The renderer schedules geometry after nested row commits through one microtask. Remaining synchronous rendering can prevent both that callback and browser paint.

The bounded frame wait belongs to restoration of a saved non-end reader offset outside the currently measurable range. Preserve that separate correctness contract. The already-landed transcript placement change (#172973) removes initial virtual-range churn and is included in this experiment's baseline.

Pending: quiet-host stage attribution, candidate comparison, focused regressions, and final outcome. No claim of an improvement yet.
