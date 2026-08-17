/**
 * Bundle-guard fixture: pulls the whole public entry point the way a
 * consumer's `import ... from "tasker-effect"` would, so the guard test can
 * assert the index graph stays free of node builtins.
 */
import * as taskerEffect from "../../src/index.js";

console.log(Object.keys(taskerEffect).length);
