// Runs after `npm test` (see "posttest"): drops the module logins the tests left in the cluster.
import { dropLeftoverModuleLogins } from "@modunexo/core/testing";

const dropped = await dropLeftoverModuleLogins();
if (dropped > 0) console.log(`dropped ${dropped} module login(s) left by the tests`);
