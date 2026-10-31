import {formatLoginError} from './wechat-login-diagnostics.mjs';
// Interactive only. Run in the owner's own terminal; never log QR or session data.
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline/promises';import {randomBytes} from 'node:crypto';import {setTimeout as wait} from 'node:timers/promises';
import {openPrivateBridge} from './wechat-private-bridge-live.mjs';import {QrSession} from './wechat-qr-session.mjs';import {prepareBaseline,armOwner} from './wechat-arm-flow.mjs';
import {ownerEmail} from '../wechat-core-offline/config.mjs';
async function renderQr(content){await new Promise((resolve,reject)=>{const p=spawn('qrencode',['-t','ANSIUTF8','-m','2'],{stdio:['pipe','inherit','ignore']});p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(new Error('QR display unavailable')));p.stdin.on('error',()=>{});p.stdin.end(content);});}
async function main(){
 const OWNER=ownerEmail();
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Use your own interactive SSH terminal');
 console.log('正在检查已保存的微信会话……');const {bridge,close}=await openPrivateBridge(OWNER);const io=createInterface({input:process.stdin,output:process.stdout});
 try{
  if(bridge.state.phase==='armed'){console.log('微信已绑定；无需再次扫码。');return;}
  if(bridge.state.phase==='unconfigured'){
   const session=new QrSession({bridge,owner:OWNER});const qr=await session.begin();console.log('请使用本人微信扫描下面的二维码：');await renderQr(qr.qrContent);console.log('等待扫码确认……');let status;for(;;){const r=await session.poll();status=r.status;if(status==='awaiting_owner_confirmation')break;if(status==='expired')throw new Error('二维码已过期，请重新运行');if(status==='additional_verification_required')throw new Error('微信要求额外验证，请按微信提示操作');await wait(1000)}
   const answer=(await io.question('确认二维码由你本人扫描？输入 YES 继续：')).trim();if(answer!=='YES'){session.cancel();throw new Error('本人确认未完成')};await session.confirmOwner(true);
  }
  if(bridge.state.phase==='bound'){console.log('正在准备新的消息游标……');await prepareBaseline({bridge,owner:OWNER});}
  if(bridge.state.phase==='challenge'){
   const challenge='确认连接-'+randomBytes(5).toString('hex');console.log('请在微信中向该机器人发送这条新文字：');console.log(challenge);await armOwner({bridge,owner:OWNER,challenge});console.log('本人单聊验证完成。');return;
  }
  throw new Error('当前状态需要人工检查');
 }finally{io.close();await close()}
}
main().catch(e=>{console.error(formatLoginError(e));process.exitCode=1});
