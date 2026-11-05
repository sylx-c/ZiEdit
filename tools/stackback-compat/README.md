# ZiEdit test diagnostic stack adapter

This small module is newly implemented for ZiEdit under the project MIT license. It implements the `stackback(error) -> V8 CallSite[]` interface consumed by why-is-node-running 2.3.0, using the documented V8 structured stack API: https://v8.dev/docs/stack-trace-api . No source from the old stackback 0.0.2 package was copied.

The override removes the historical package whose exact source archive does not include a complete license grant. Already-materialized textual stacks return an empty frame list. The module always restores Error.prepareStackTrace. This is test-diagnostic tooling, not part of the desktop frontend payload.
