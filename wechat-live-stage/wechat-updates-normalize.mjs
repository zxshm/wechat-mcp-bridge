const fail=code=>Object.assign(new Error('WeChat updates response unavailable'),{code});
// Missing optional status and message fields are permitted by Tencent's protocol.
// An initial empty cursor is never accepted as proof that historical messages are absent.
export function normalizeUpdates(batch,{previousCursor='',bootstrap=false,allowMessagesWithoutCursor=false}={}){
 if(!batch||typeof batch!=='object'||Array.isArray(batch))throw fail('updates_invalid');
 if((batch.ret!==undefined&&batch.ret!==0)||(batch.errcode!==undefined&&batch.errcode!==0)){const e=fail('updates_api_error'),code=batch.errcode!==undefined&&batch.errcode!==0?batch.errcode:batch.ret;if(Number.isSafeInteger(code)&&Math.abs(code)<=100000)e.apiCode=code;throw e;}
 if(batch.msgs!==undefined&&!Array.isArray(batch.msgs))throw fail('updates_invalid');
 const msgs=batch.msgs??[];const next=batch.get_updates_buf;
 if(next!==undefined&&typeof next!=='string')throw fail('updates_invalid');
 if(bootstrap&&msgs.length>0)throw fail('updates_pending_messages');
 let cursor=next;
 if(!cursor&&!bootstrap&&(msgs.length===0||allowMessagesWithoutCursor)&&typeof previousCursor==='string'&&previousCursor)cursor=previousCursor;
 if(!cursor)throw fail('updates_cursor_unavailable');
 return {ret:0,errcode:0,msgs,get_updates_buf:cursor};
}
