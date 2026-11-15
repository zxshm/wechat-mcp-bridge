import {chmod, mkdir, rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {createLargeMediaService} from './large-media-service.mjs';

// 独立监听，不加载现有微信桥、凭据文件或微信发送账本。
const root=resolve(process.argv[2]||''),runtime=resolve(process.argv[3]||'');
if(!process.argv[2]||!process.argv[3]||root===runtime) throw new Error('需要独立的数据目录和运行目录');
await mkdir(runtime,{recursive:true,mode:0o700});
const socket=join(runtime,'control.sock');
// systemd 保证单实例；只移除本服务的旧套接字，不递归处理目录。
await rm(socket,{force:true});
const service=await createLargeMediaService({root});
service.app.listen(4183,'127.0.0.1');
await once(service.app,'listening');
service.control.listen(socket);
await once(service.control,'listening');
await chmod(socket,0o600);
const timer=setInterval(()=>void service.cleanup().catch(()=>{}),60000);
console.log(JSON.stringify({status:'ready',mode:'receive_only',port:4183}));
async function shutdown() {
  clearInterval(timer);
  service.app.close(); service.control.close();
  service.app.closeIdleConnections();service.control.closeIdleConnections();
}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
