import {spawnAgent} from "./agent-process.mjs";

/**
 * Spawn an agent child process and collect its output.
 *
 * This is the shared production helper used by autopilot.mjs relay() and by
 * regression tests.  It is the SINGLE source of truth for:
 *   - subprocess spawn + stdout/stderr collection
 *   - stdin write/end with EPIPE/ECONNRESET capture
 *   - double-resolution prevention (close vs error vs stdin error)
 *
 * Cross-platform stdin-delivery contract (Task 16.3D): `error:null` in the
 * returned result is NEVER proof that the child consumed the prompt, on
 * either platform — it only means no write/end/stream failure was observed.
 * On POSIX, once a pipe's reader has fully closed, the kernel reliably fails
 * the very next write() with EPIPE regardless of payload size, so an
 * errorless write is at least strong evidence the reader was present when
 * the OS accepted the bytes. On Windows, a named-pipe write below the OS
 * pipe's buffer capacity (empirically ~64-100KB against a real adapter
 * binary) can succeed with no error at all even after the reading process
 * has already exited and closed its handle — Windows only reports the pipe
 * broken once the buffer fills, not when the reader disappears. That is a
 * real Windows named-pipe reporting gap, not a defect in this function:
 * there is no OS-level signal available here to close it without inflating
 * the payload past that threshold (which would corrupt real prompts) or
 * guessing from timing (which would be flaky). Callers — see
 * failure-contract.mjs's classifyObservedFailure, which turns a captured
 * `error` into PROCESS_START_FAILED — must keep treating `error:null` as
 * "no failure observed", never as an affirmative delivery claim.
 *
 * @param {object} opts
 * @param {string}   opts.binary    - resolved binary path
 * @param {string[]} opts.args      - invocation arguments
 * @param {string}   opts.cwd       - working directory
 * @param {object}   opts.env       - environment map
 * @param {string}   [opts.stdinData] - data to write to stdin (null = skip write)
 * @param {boolean}  [opts.writeStdin] - false to skip writing (all current drivers use stdin, so callers normally leave this true)
 * @param {number}   [opts.timeoutMs] - kill the child if it hasn't closed within this
 *   many ms (undefined/0/negative = no deadline, the historical default every existing
 *   caller still gets). On expiry the child is sent SIGTERM, then SIGKILL after a short
 *   grace period if it is still alive, and the resolved result carries `timedOut:true` —
 *   the same field classifyObservedFailure() (failure-contract.mjs) already reads to
 *   produce a retryable TIMEOUT/infrastructure failure. This is the only place in the
 *   relay path that can turn an unbounded hang into a bounded, budgeted failure instead
 *   of a run that can only ever be recovered by a human finding and killing the process
 *   tree by hand.
 * @param {(info:{pid:number|null})=>void} [opts.onStart] - best-effort observability hook,
 *   invoked synchronously once the child is spawned (before any output arrives). Exceptions
 *   are swallowed — observability must never affect relay behavior. Optional; every existing
 *   caller that omits it is unaffected.
 * @param {(chunk:{stream:"stdout"|"stderr", chunk:string})=>void} [opts.onChunk] - best-effort
 *   observability hook, invoked once per stdout/stderr "data" event as it arrives — the same
 *   incremental chunks this function already accumulates into the final stdout/stderr strings,
 *   just also surfaced live instead of only once the child closes. Exceptions are swallowed.
 *   Optional; every existing caller that omits it is unaffected.
 * @returns {Promise<{status:number|null, signal:string|null, stdout:string, stderr:string, error:string|null, pid:number|null, timedOut:boolean}>}
 */
export function spawnRelayChild({binary, args, cwd, env, stdinData=null, writeStdin=true, timeoutMs=0, onStart=null, onChunk=null}){
  return new Promise(resolve=>{
    // Task 042-1.2: on POSIX the adapter leads its own process group
    // (setsid) so the SIGTERM/SIGINT flush can kill the whole adapter
    // tree with a single group signal. Windows has no POSIX groups.
    const child=spawnAgent(binary,args,{cwd,env,shell:false,stdio:["pipe","pipe","pipe"],...(process.platform!=="win32"?{detached:true}:{})});
    let stdout="",stderr="";
    let pid=null;
    try{pid=child.pid;}catch{}
    let resolved=false;
    let timedOut=false;
    let stdinError=null;
    let deadlineTimer=null;
    let killGraceTimer=null;
    const clearTimers=()=>{
      if(deadlineTimer){clearTimeout(deadlineTimer);deadlineTimer=null;}
      if(killGraceTimer){clearTimeout(killGraceTimer);killGraceTimer=null;}
    };
    if(Number(timeoutMs)>0){
      deadlineTimer=setTimeout(()=>{
        timedOut=true;
        try{child.kill("SIGTERM");}catch{}
        killGraceTimer=setTimeout(()=>{ try{child.kill("SIGKILL");}catch{} },5000);
      },Number(timeoutMs));
    }
    child.stdout?.on("data",d=>{
      stdout+=d;
      if(onChunk){ try{ onChunk({stream:"stdout",chunk:d}); }catch{} }
    });
    child.stderr?.on("data",d=>{
      stderr+=d;
      if(onChunk){ try{ onChunk({stream:"stderr",chunk:d}); }catch{} }
    });
    child.on("close",(code,signal)=>{
      if(resolved)return;
      resolved=true;
      clearTimers();
      resolve({status:code,signal,stdout,stderr,error:stdinError,pid,timedOut});
    });
    child.on("error",err=>{
      if(resolved)return;
      resolved=true;
      clearTimers();
      resolve({status:null,signal:null,stdout,stderr:String(err),error:err.message,pid,timedOut});
    });
    if(child.stdin){
      // Both the 'error' event and end()'s completion callback are
      // captured: Node's Writable does not guarantee a write-specific
      // failure is always observable via the 'error' event alone (it can
      // race against 'close' resolving this promise first), and end()'s
      // callback — which only fires once any pending write has flushed or
      // failed — is a second, independent channel for the same outcome.
      // (child.stdin.write(stdinData) itself keeps its original one-argument
      // form: the exact bytes handed to the authorized transport must reach
      // the child unmodified, by construction, not merely by convention.)
      const captureStdinError=err=>{ if(err && !stdinError) stdinError=String(err); };
      child.stdin.on("error",captureStdinError);
      try{
        if(writeStdin && stdinData!=null){child.stdin.write(stdinData);}
        child.stdin.end(captureStdinError);
      }catch(err){
        captureStdinError(err);
      }
    }
    // onStart runs AFTER the prompt is handed to the pipe. The caller's hook
    // is synchronous (initRun + a full WATCH-REPORT render, measured 5.3 s on
    // a 46-run mission over /mnt/d); run before the write it blocked the event
    // loop while the CLI was already waiting, and Claude Code (2.1.x) gives up
    // after 3 s of silent stdin: "no stdin data received in 3s … Input must be
    // provided" (mission 022 runs 45/46, code_reviewer).
    if(onStart){ try{ onStart({pid}); }catch{} }
  });
}
