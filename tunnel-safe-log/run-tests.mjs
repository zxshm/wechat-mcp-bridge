import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url));
const env={...process.env};
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
const result=spawnSync(process.execPath,[
 '--require',path.join(directory,'test-no-network.cjs'),
 '--test',path.join(directory,'safe-log.test.mjs'),path.join(directory,'linux-integration.test.mjs'),
],{cwd:directory,env,stdio:'inherit',shell:false,windowsHide:true,timeout:60000});
if(result.error)process.stderr.write('Tunnel diagnostic test runner failed.\n');
process.exit(Number.isInteger(result.status)?result.status:1);
