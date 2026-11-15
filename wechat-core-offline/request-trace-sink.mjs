import {privatePath,stateDirectory,largeMediaPaths} from './config.mjs';
import {createBoundedDiagnosticWriter} from './safe-diagnostics.mjs';

// 仅写追踪器已归一化的元数据；固定白名单避免意外携带正文、参数或凭据。
const write=createBoundedDiagnosticWriter(privatePath('mcp-request-trace.ndjson'));
export function safeTraceRow(row){
 const result={};
 for(const key of ['at','requestId','stage','method','tool','elapsedMs','httpStatus','errorClass','rpcCode','result'])
   if(typeof row[key]==='string'||typeof row[key]==='number')result[key]=row[key];
 return result;
}
export function persistMcpTrace(row){if(process.env.XDW_MCP_DIAGNOSTICS==='1')void write(safeTraceRow(row));}
