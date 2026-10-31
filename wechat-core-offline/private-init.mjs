import {mkdir,lstat,open,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,hkdfSync} from 'node:crypto';
import {SecureStore} from './secure-store.mjs';
async function exists(path){try{await access(path);return true}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export async function initEventsStore(root){
 const rootInfo=await lstat(root);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||(rootInfo.mode&0o077)!==0||(process.getuid&&rootInfo.uid!==process.getuid()))throw new Error('Private directory required');
 const dir=join(root,'events-v2'),keyPath=join(root,'events-v2.key');
 try{await mkdir(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const dirInfo=await lstat(dir);if(!dirInfo.isDirectory()||dirInfo.isSymbolicLink()||(dirInfo.mode&0o077)!==0||(process.getuid&&dirInfo.uid!==process.getuid()))throw new Error('Private directory required');
 if(!await exists(keyPath)){
  if(await exists(join(dir,'state.enc')))throw new Error('State key missing');
  const key=randomBytes(32);let f;try{f=await open(keyPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await f.writeFile(key);await f.sync();}finally{key.fill(0);if(f)await f.close();}
 }
 const f=await open(keyPath,constants.O_RDONLY|constants.O_NOFOLLOW);let key;try{const st=await f.stat();if(!st.isFile()||(st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid())||st.size!==32)throw new Error('State key unavailable');key=await f.readFile();}finally{await f.close();}
 const derived=Buffer.from(hkdfSync('sha256',key,Buffer.from('xiaodi-wechat'),Buffer.from('events-v2'),32));key.fill(0);const store=new SecureStore(dir,derived);derived.fill(0);
 if(!await exists(join(dir,'state.enc')))await store.save({subscriptions:{}});
 return store;
}
