import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// 无网络单元测试保留原预加载保护，真实回环 HTTP 测试单独执行。
const root=path.dirname(fileURLToPath(import.meta.url));
const protectedFiles=[],localFiles=[];
for(const directory of ['.','../wechat-live-stage','minihome-source-ledger-candidate','../large-media','../examples']){
  for(const name of await readdir(path.resolve(root,directory))){
    if(!name.endsWith('.test.mjs'))continue;
    const file=path.resolve(root,directory,name),source=await readFile(file,'utf8');
    (source.includes('TEST_NETWORK_DISABLED')||source.includes('test-no-network')?protectedFiles:localFiles).push(file);
  }
}
for(const [preload,files] of [[true,protectedFiles],[false,localFiles]]){
  const args=[...(preload?['--require',path.join(root,'test-no-network.cjs')]:[]),'--test',...files];
  const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});
  if(result.status!==0)process.exit(result.status||1);
}
const tunnel=spawnSync(process.execPath,[path.resolve(root,'../tunnel-safe-log/run-tests.mjs')],{cwd:root,stdio:'inherit'});
process.exitCode=Number.isInteger(tunnel.status)?tunnel.status:1;
