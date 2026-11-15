// 只预取同一验证器的公开签名密钥；不缓存鉴权结果，不延长密钥或 JWT 有效期。
export function startJwksBackgroundRefresh(keys, {intervalMs=300000, onResult=()=>{}, setTimer=setInterval, clearTimer=clearInterval, setRetry=setTimeout, clearRetry=clearTimeout}={}) {
  if(typeof keys?.reload!=='function'||!Number.isSafeInteger(intervalMs)||intervalMs<30000||intervalMs>300000)
    throw new Error('Invalid refresh configuration');
  let stopped=false,pending=null,retryTimer=null;
  const refresh=()=>{
    if(stopped||pending)return pending??Promise.resolve();
    if(retryTimer){clearRetry(retryTimer);retryTimer=null}
    const started=Date.now();
    pending=Promise.resolve().then(()=>keys.reload()).then(
      ()=>{try{onResult({ok:true,elapsedMs:Date.now()-started})}catch{}},
      ()=>{
        try{onResult({ok:false,elapsedMs:Date.now()-started})}catch{}
        // 网络失败后提前恢复公开密钥获取，不等到原缓存临近过期。
        if(!stopped){retryTimer=setRetry(()=>{retryTimer=null;void refresh()},30000);retryTimer.unref?.()}
      }
    ).finally(()=>{pending=null});
    return pending;
  };
  const timer=setTimer(()=>{void refresh()},intervalMs);timer.unref?.();
  return {refresh,stop(){stopped=true;clearTimer(timer);if(retryTimer)clearRetry(retryTimer)}};
}
