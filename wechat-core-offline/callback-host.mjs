import fs from 'node:fs/promises';import path from 'node:path';import {randomBytes} from 'node:crypto';import {parseCallback} from './webhook.mjs';import {stateDirectory} from './config.mjs';
export async function saveCallbackHostname(url,{destination=path.join(stateDirectory(),'callback-diagnostic-host')}={}){
 const hostname=parseCallback(url).hostname;
 const tmp=path.join(path.dirname(destination),'.callback-host-'+randomBytes(12).toString('hex'));
 try{await fs.writeFile(tmp,hostname+'\n',{mode:0o600,flag:'wx'});await fs.rename(tmp,destination);}finally{await fs.unlink(tmp).catch(()=>{});}
}
