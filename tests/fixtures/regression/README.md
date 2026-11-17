# Runtime lifecycle fixtures

These projects exercise contracts that need multiple interacting modules or independent sessions. The gallery under `examples/` contains the smaller introductory projects.

| Fixture                     | Contract                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `react-effect-dependencies` | An effect reconnects when a declared dependency changes                             |
| `react-stale-closure`       | An intentionally omitted dependency retains the earlier closure                     |
| `react-effect-events`       | Effect Events read current state while compatible edits preserve component identity |
| `react-counter`             | TypeScript, JSON, a prepared npm package, and stable component references           |
| `dom-counter`               | Explicit state transfer, listener disposal, and remounting                          |
| `compute-primes`            | Worker isolation, timeouts, progress, and state between runs                        |

The connection fixtures simulate asynchronous completion with a timer and use a prepared notification dependency. They make no external network requests. Browser tests edit the same modules to exercise refresh boundaries, cancellation, disposal, and error recovery. Unicode fixtures elsewhere deliberately contain non-ASCII text to verify input and source-map behavior.
