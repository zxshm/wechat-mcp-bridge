import {supervise} from './runner.mjs';
import {fileURLToPath} from 'node:url';
const guard=fileURLToPath(new URL('./test-no-network.cjs',import.meta.url));
const fixture=fileURLToPath(new URL('./linux-signal-fixture.mjs',import.meta.url));
const store={directory:'/tmp/synthetic',failures:0,enqueue(r){if(r.category==='edge_registered')process.stdout.write('READY\n');}};
const code=await supervise({executable:process.execPath,args:['--require',guard,fixture],store,cleanupFn:async()=>{}});
process.stdout.write(JSON.stringify({exitCode:code})+'\n');
process.exit(code);
