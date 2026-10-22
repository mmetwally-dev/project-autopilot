#!/usr/bin/env node
'use strict';

// Compatibility shim. Historically a separate release-internal dispatcher;
// the trusted-release/signature system it belonged to has been removed from
// the supported runtime. This file no longer returns BLOCKED_INTEGRITY — it
// simply delegates to the normal dispatcher in bin/ap.cjs so there is a
// single source of truth for command dispatch.
const {main} = require('./ap.cjs');

// `main()` may return a plain number (every command except `run`) or a
// Promise (task 15.5C's `run` routing, which awaits the runtime-mode
// router). Promise.resolve() normalizes both so this dispatcher never
// assigns a Promise directly to process.exitCode (that throws
// ERR_INVALID_ARG_TYPE) and never needs a second copy of ap.cjs's own
// dispatch logic — this file stays a thin compatibility shim.
if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2))).then(
    code => { process.exitCode = code; },
    error => {
      console.error(`ERROR: ${error && error.message ? error.message : error}`);
      process.exitCode = 1;
    }
  );
}

module.exports = {main};
