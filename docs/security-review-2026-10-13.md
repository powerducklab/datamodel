# Security review — 2026-10-13

Scope: SQL identifier/value generation, examples, enum values and generated deployment scripts.

P1: MySQL backslash plus quote in untrusted examples/ENUM values escaped its SQL literal. Escape backslashes before quotes. Regression tests round-trip hostile literals. MySQL output targets default backslash-escape mode; SQL Server/Oracle preserve backslashes.

Validation: package type checks, existing automated tests, targeted regression tests for changes, and release build/package checks. The complete pre-change test/type-check baseline passed for all 17 owned libraries. Final release validation is recorded by the release workflow.

This is a focused P0/P1 review, not a guarantee that all vulnerabilities are absent. npm advisory severity alone is not evidence that a particular application path is exploitable.

Runtime metadata now requires Node.js 22+, matching the existing Scalar dependency requirement instead of claiming unsupported Node.js 18 compatibility. Browser entry points remain unchanged.
