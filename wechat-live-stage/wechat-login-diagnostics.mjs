// Only fixed categories and numeric status codes are returned; never include error messages or bodies.
export function formatLoginError(error){
 const code=error?.code;
 if(code==='session_lock_unavailable')return '微信会话锁不可用，未修改会话；请检查是否已有服务运行。';
 if(code==='session_store_unavailable')return '已保存的微信会话暂不可读取，未修改会话；请检查状态目录权限。';
 if(code==='updates_pending_messages')return '检测到待处理消息，未更新游标；请先检查状态，不要公开消息内容。';
 if(code==='updates_cursor_unavailable')return '微信未返回有效游标，已保存扫码会话；无需重新扫码。';
 if(code==='updates_timeout')return '微信接口等待超时，已保存扫码会话；无需重新扫码。';
 if(code==='updates_http_error'&&Number.isInteger(error?.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599)return '微信接口返回 HTTP '+error.httpStatus+'，会话已保存。';
 if(code==='updates_api_error'&&Number.isSafeInteger(error?.apiCode)&&Math.abs(error.apiCode)<=100000)return '微信接口返回错误码 '+error.apiCode+'，会话已保存。';
 if(typeof code==='string'&&/^updates_(?:network_error|econnreset|econnrefused|enotfound|eai_again|etimedout|und_err_connect_timeout|und_err_headers_timeout|und_err_socket|response_error|body_too_large|invalid)$/.test(code))return '微信接口失败：'+code+'；会话已保存。';
 return '微信连接未完成，会话不会被重置。';
}
