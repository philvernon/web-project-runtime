---
name: right-sized-engineering
description: Use when implementing features, fixing bugs, refactoring, changing tests or reviewing code. Understand the existing solution, keep scope grounded in requirements, verify according to risk and finish without unnecessary machinery or process.
---

# Right-sized engineering

Follow explicit user instructions and repository requirements, including security and privacy boundaries. Scale the effort and process to the task; a small change should not require a formal plan or extra artefacts.

## Understand before changing

Establish the desired outcome, constraints and acceptance criteria from the request and available context. Inspect relevant code, callers, tests and repository guidance before choosing an approach. Identify existing behaviour and safeguards that must remain; ask only when a consequential decision cannot be resolved from the evidence.

For nontrivial work, briefly explain what will change, what can be reused, how correctness will be checked and what counts as done. Keep this in the conversation unless a persistent plan is requested or genuinely needed. Proceed when the work is clear and authorised; do not add routine approval gates.

## Implement proportionately

Satisfy the requirement fully, including necessary supporting work, without inventing adjacent features or hypothetical future needs. Reuse established functions, types, libraries and architecture where they fit. Add abstractions for concrete responsibilities or actual duplication, not possible future reuse.

Prefer readable, explicit code that is easy to modify. Neither minimum line count nor minimum diff size is a goal. Consider how the change fits the surrounding system, not just whether the edited code works in isolation. Preserve useful boundaries and required compatibility; inspect consumers and real data contracts before removing existing machinery. Maintain documentation at its source of truth rather than creating parallel explanations or checklists.

## Test according to risk

Choose tests based on required behaviour and the consequences of failure. Prioritise observable outcomes, meaningful boundary conditions, known regressions and security, privacy, financial or data-integrity safeguards. Similar assertions at distinct trust boundaries can be necessary.

Use representative cases and straightforward fixtures. Do not systematically enumerate equivalent permutations, duplicate coverage without a distinct purpose or build elaborate mocks for simple behaviour. Check that assertions would fail if the relevant behaviour were meaningfully broken.

When removing or consolidating tests, identify what failure each detects. Proceed only if the requirement is obsolete or retained/replacement coverage still detects that meaningful failure at the relevant boundary; briefly explain the coverage decision. Otherwise keep or improve the test. Suite size alone is not a reason to delete tests.

## Verify efficiently

Use focused checks while editing, then the project's required checks and builds. Tests must work after documented clean-checkout setup, supply their own synthetic inputs and manage their own temporary files. Preserve unrelated local work and satisfy applicable latest-head CI requirements.

Review the resulting change against its intended behaviour and surrounding interfaces. Use additional tools, independent review or repeated verification only to answer a concrete unresolved question whose risk justifies the effort—not as automatic stages. Correct demonstrated failures and verify the correction without turning it into an open-ended search for improvements.

## Finish clearly

Stop when the requested behaviour is implemented, important regressions are covered and required checks pass. Reopen only for a demonstrated functional defect, material security/privacy/data-integrity issue, failed acceptance criterion or concrete maintainability problem introduced by the change.

Report the outcome, verification actually performed and remaining concrete blockers. Distinguish defects from theoretical concerns and optional recommendations; a worthwhile improvement is not automatically required now. Separate automated verification from any live-service or human acceptance, without treating pending acceptance as permission to expand the task.
