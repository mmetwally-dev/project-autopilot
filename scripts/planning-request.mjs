export function classifyPlanningRequest({request="", currentRequest="", stateStatus="missing"}={}) {
  const next=String(request||"").trim();
  const current=String(currentRequest||"").trim();
  if(!next) return {kind:"resume", reason:"no explicit request"};
  if(!current) return {kind:"new", reason:"no prior active request"};
  if(next===current) return {kind:"resume", reason:"request matches active planning request"};
  if(stateStatus==="complete" || stateStatus==="partial") return {kind:"new", reason:"explicit request differs from active planning request"};
  return {kind:"new", reason:"explicit request supplied while planning is not ready"};
}
