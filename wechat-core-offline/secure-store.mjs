// Encrypted atomic single-writer state storage. Key provisioning and lifetime policy are separate concerns.
import { open, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
const MAGIC=Buffer.from('XDW1');
const MAX_STATE_BYTES=8*1024*1024, ENVELOPE_BYTES=32;
async function checkDirectory(directory) {
 const st=await lstat(directory);if(!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)!==0 || (process.getuid && st.uid!==process.getuid()))throw new Error('Private storage directory required');
 if(await realpath(directory)!==directory)throw new Error('Storage path must not contain symlinks');
}
export class SecureStore {
 constructor(directory,key){if(typeof directory!=='string'||!directory.startsWith('/')||!Buffer.isBuffer(key)||key.length!==32)throw new Error('Private directory and 256-bit key required');this.directory=directory;this.key=Buffer.from(key);this.serial=Promise.resolve();}
 save(value){const action=this.serial.then(()=>this.#write(value));this.serial=action.catch(()=>{});return action;}
 async #write(value){await checkDirectory(this.directory);const plaintext=Buffer.from(JSON.stringify(value),'utf8');if(plaintext.length>MAX_STATE_BYTES)throw new Error('State too large');
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(MAGIC);const encrypted=Buffer.concat([MAGIC,iv,cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);plaintext.fill(0);
  const dest=join(this.directory,'state.enc'),temp=join(this.directory,'.state-'+randomBytes(12).toString('hex')+'.tmp');let fh;
  try{fh=await open(temp,'wx',0o600);await fh.writeFile(encrypted);await fh.sync();await fh.close();fh=null;await rename(temp,dest);const dir=await open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}}finally{if(fh)await fh.close().catch(()=>{});await unlink(temp).catch(()=>{});}
 }
 async load(){await this.serial;await checkDirectory(this.directory);let fh;try{fh=await open(join(this.directory,'state.enc'),constants.O_RDONLY | constants.O_NOFOLLOW);const st=await fh.stat();if(!st.isFile()||(st.mode&0o077)!==0||(process.getuid && st.uid!==process.getuid())||st.size>MAX_STATE_BYTES+ENVELOPE_BYTES)throw new Error();const blob=await fh.readFile();if(blob.length<ENVELOPE_BYTES||blob.length>MAX_STATE_BYTES+ENVELOPE_BYTES||!blob.subarray(0,4).equals(MAGIC))throw new Error();const d=createDecipheriv('aes-256-gcm',this.key,blob.subarray(4,16));d.setAAD(MAGIC);d.setAuthTag(blob.subarray(-16));return JSON.parse(Buffer.concat([d.update(blob.subarray(16,-16)),d.final()]).toString('utf8'));}catch{throw new Error('Private state unavailable or invalid');}finally{if(fh)await fh.close();}}
 close(){this.key.fill(0);}
}
