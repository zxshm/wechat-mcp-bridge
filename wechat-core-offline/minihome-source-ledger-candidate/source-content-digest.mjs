import {createHash} from 'node:crypto';

// 原文只在当次调用内计算，不裁剪、不规范化、不落盘，也不证明来源真实性。
export function computeSyncContentDigest(text){
 if(typeof text!=='string'||!text.length||!text.isWellFormed()||Buffer.byteLength(text,'utf8')>8192)throw Error('source_text_invalid');
 return {contentDigest:createHash('sha256').update(text,'utf8').digest('hex'),digestAlgorithm:'SHA-256',digestEncoding:'utf-8',bodyStored:false,sourceVerified:false};
}
