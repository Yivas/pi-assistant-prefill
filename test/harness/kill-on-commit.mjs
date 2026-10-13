// Preload for the after-commit scenario of interruption.mjs. It loads before Pi's entry point and
// makes the process end with SIGKILL as soon as the commitment record has been appended to the
// session file. The host cannot run its own cleanup, and turn_end has not been emitted yet. Before
// the kill it writes its pid to PREFILL_HARNESS_KILL_MARKER, so the driver can tell the self-kill
// from an ordinary exit. On Windows the parent sees a self-sent SIGKILL as exit code 1, not as a
// signal, which is why the driver checks the marker and that the process is gone.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const appendFileSyncOriginal = fs.appendFileSync;
fs.appendFileSync = (file, data, ...rest) => {
  appendFileSyncOriginal(file, data, ...rest);
  if (String(data).includes('"phase":"committed"')) {
    fs.writeFileSync(process.env.PREFILL_HARNESS_KILL_MARKER, String(process.pid));
    process.kill(process.pid, "SIGKILL");
  }
};
syncBuiltinESMExports();
