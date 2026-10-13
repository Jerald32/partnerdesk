const enabled=import.meta.env.VITE_PERFORMANCE_DIAGNOSTICS==='true';
const pages=new Map(),active=new Set(),listeners=new Set();
export function startPageMeasure(page){
 if(!enabled)return ()=>{};
 const value={page,start:performance.now(),requests:0};active.add(value);
 return success=>{active.delete(value);if(!success)return;
  pages.set(page,{page,ms:Math.round(performance.now()-value.start),requests:value.requests});
  for(const notify of listeners)notify();
 };
}
export function recordGatewayRequest(){if(enabled)for(const page of active)page.requests++;}
export function performancePages(){return [...pages.values()];}
export function resetPerformancePages(){pages.clear();}
export function onPerformancePages(notify){if(!enabled)return ()=>{};listeners.add(notify);return ()=>listeners.delete(notify);}
export function diagnosticsEnabled(){return enabled;}
