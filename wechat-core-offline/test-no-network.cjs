// 本地测试默认禁止所有真实网络；测试只能显式注入模拟传输。
const fail=()=>{throw new Error('TEST_NETWORK_DISABLED')};
globalThis.fetch=async()=>fail();
for(const name of ['node:http','node:https']){const mod=require(name);mod.request=fail;mod.get=fail;}
const net=require('node:net');net.connect=fail;net.createConnection=fail;net.Socket.prototype.connect=fail;
require('node:tls').connect=fail;
require('node:http2').connect=fail;
require('node:dgram').createSocket=fail;
const dns=require('node:dns');for(const name of ['lookup','resolve','resolve4','resolve6','reverse'])dns[name]=fail;
if(globalThis.WebSocket)globalThis.WebSocket=class{constructor(){fail()}};
