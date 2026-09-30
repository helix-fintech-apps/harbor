# Money-correctness gate — deterministic check set

This folder is the **deterministic** specification of the money-correctness gate for Harbor —
machine-evaluable checks, not prose. Each check in `checks.yaml` is a detector with a fixed
pass/fail condition; a violation of any `blocking` check fails the merge.

- **Why deterministic:** a required merge gate must give the same verdict on the same code every
  run. Prose rules read by a model are advisory; these detectors are reproducible.
- **How it runs:** the gate emits a verdict (CHECKED / FINDING / NOT_CHECKED) for every check on
  every money-touching PR. Any NOT_CHECKED or FINDING blocks. See `checks.yaml` → verdict_contract.
- **Detector types:** `git-diff` (fully mechanical), `static` (AST/pattern on the diff),
  `semantic` (code analysis), `test-assertion`, `meta`.
- **Spec-dependent invariants** resolve to a FINDING only when the requirement demands it; when the
  spec is silent they emit `requirement-not-specified`, not a hard BLOCK.

This is the gate spec, not the full domain rulebook.
