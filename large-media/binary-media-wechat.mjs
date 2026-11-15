import {createCipheriv, randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {finished} from 'node:stream/promises';

const API = 'https://ilinkai.weixin.qq.com';

async function readSmallJson(response) {
  if (!response?.ok || !response.body) throw new Error('微信接口不可用');
  let size = 0;
  const parts = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 65536) throw new Error('微信接口响应过大');
    parts.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('微信接口响应无效');
  return value;
}

// 调用前必须完成来源验证和发送幂等预占，任何未知结果均不可自动重发。
export async function sendBinaryFile({path, size, md5, fileName, sessionToken, toUserId, contextToken, clientId,
  safeFilename, cdnUploadUrl, fetcher=fetch, deadline, clock=Date.now, trace=()=>{}}) {
  if (!path || !Number.isSafeInteger(size) || size < 1 || !/^[a-f0-9]{32}$/.test(md5) ||
      !sessionToken || !toUserId || !contextToken || !/^xiaodi:\d{1,16}-[0-9a-f]{8}$/.test(clientId) ||
      typeof safeFilename !== 'function' || typeof cdnUploadUrl !== 'function' || !Number.isFinite(deadline)) {
    throw new Error('无效的文件发送参数');
  }
  const aes = randomBytes(16), filekey = randomBytes(16).toString('hex');
  const encryptedSize = (Math.floor(size / 16) + 1) * 16;
  if (!Number.isSafeInteger(encryptedSize)) throw new Error('文件长度无法表示');
  const base_info = {channel_version:'2.4.10', bot_agent:'XiaodiWeixinBridge/0.1.0'};
  const headers = {'Content-Type':'application/json', AuthorizationType:'ilink_bot_token',
    'X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
    'iLink-App-Id':'bot', 'iLink-App-ClientVersion':String((2<<16)|(4<<8)|10), Authorization:'Bearer '+sessionToken};
  const signal = () => {
    const remaining = deadline-clock();
    if (remaining <= 0) throw new Error('文件发送已过期');
    return AbortSignal.timeout(Math.min(remaining, 2147483647));
  };
  try {
    trace({stage:'upload_url_start',at:clock()});
    const body = {filekey, media_type:3, to_user_id:toUserId, rawsize:size, rawfilemd5:md5,
      filesize:encryptedSize, no_need_thumb:true, aeskey:aes.toString('hex'), base_info};
    const upload = await readSmallJson(await fetcher(API+'/ilink/bot/getuploadurl',
      {method:'POST', headers, body:JSON.stringify(body), redirect:'error', signal:signal()}));
    if ((upload.ret !== undefined && upload.ret !== 0) || (upload.errcode != null && upload.errcode !== 0)) {
      trace({stage:'upload_url_rejected',at:clock(),ret:Number.isInteger(upload.ret)?upload.ret:null,errcode:Number.isInteger(upload.errcode)?upload.errcode:null});
      throw Object.assign(new Error('微信上传地址不可用'),{code:'upstream_upload_rejected'});
    }
    trace({stage:'upload_url_ready',at:clock()});
    const url = cdnUploadUrl({fullUrl:upload.upload_full_url, param:upload.upload_param, filekey});
    const source = createReadStream(path);
    const encrypted = source.pipe(createCipheriv('aes-128-ecb', aes, null));
    source.on('error', error => encrypted.destroy(error));
    let cdn;
    const uploadSignal = signal();
    const uploadDone = finished(encrypted,{signal:uploadSignal});
    // 如果服务器提前返回或请求失败，仍观察流错误，避免未处理的拒绝。
    void uploadDone.catch(()=>{});
    try {
      trace({stage:'cdn_upload_start',at:clock()});
      cdn = await fetcher(url, {method:'POST', headers:{'Content-Type':'application/octet-stream', 'Content-Length':String(encryptedSize)},
        body:encrypted, duplex:'half', redirect:'error', signal:uploadSignal});
      await uploadDone;
    } finally { source.destroy(); encrypted.destroy(); }
    const param = cdn?.headers?.get('x-encrypted-param');
    if (!cdn?.ok || typeof param !== 'string' || !param || param.length > 4096 || /[\x00-\x1f\x7f]/.test(param)) throw new Error('微信文件上传未确认');
    trace({stage:'cdn_upload_done',at:clock(),status:cdn.status});
    const media = {encrypt_query_param:param, aes_key:Buffer.from(aes.toString('hex'),'utf8').toString('base64'), encrypt_type:1};
    const msg = {from_user_id:'', to_user_id:toUserId, client_id:clientId, message_type:2, message_state:2, context_token:contextToken,
      item_list:[{type:4, file_item:{media, file_name:safeFilename(fileName), len:String(size)}}]};
    trace({stage:'message_send_start',at:clock()});
    const response = await readSmallJson(await fetcher(API+'/ilink/bot/sendmessage',
      {method:'POST', headers, body:JSON.stringify({msg,base_info}), redirect:'error', signal:signal()}));
    if ((response.ret !== undefined && response.ret !== 0) || (response.errcode != null && response.errcode !== 0)) {
      trace({stage:'message_rejected',at:clock(),ret:Number.isInteger(response.ret)?response.ret:null,errcode:Number.isInteger(response.errcode)?response.errcode:null});
      throw Object.assign(new Error('微信发送未确认'), {code:'upstream_media_rejected'});
    }
    trace({stage:'message_accepted',at:clock()});
    return {accepted:true};
  } finally { aes.fill(0); }
}
