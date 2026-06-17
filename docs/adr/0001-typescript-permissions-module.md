# TypeScript module for permission config, not JSON

Permission groups and patterns are declared in `permissions/*.ts` files imported by the extension at runtime, rather than in a JSON/YAML config file. OMP loads `.ts` extensions natively via tsx/Bun, so no build step is required.

JSON with a closed combinator set (`extends`, `includes`) would have worked for simple hierarchies, but it recreates a type system in data: group references are strings resolved at runtime, circular dependencies are only caught at eval time, and the authoring model is disconnected from the TypeScript toolchain the rest of the codebase uses. TypeScript gives us structural composition via real variable references, compile-time detection of invalid `extends` chains, and a native `.pipe()`-style builder pattern consistent with the Effect-smol conventions used in sibling repos.

The negotiation agent (itself an OMP instance) writes TypeScript directly. On import error at startup, the extension stashes the bad commit and notifies the user rather than silently falling back.
