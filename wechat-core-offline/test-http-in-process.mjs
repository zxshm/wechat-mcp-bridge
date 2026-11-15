// Exercise the actual HTTP handler with synthetic streams, without a socket.
import {Readable,Writable} from 'node:stream';
export async function fetchInProcess(app,{method='POST',headers={},body=''}={}){
 const req=Readable.from(body?[Buffer.from(body)]:[]);
 req.method=method;req.url='/mcp';req.headers=Object.fromEntries(Object.entries(headers).map(([key,value])=>[key.toLowerCase(),value]));
 const chunks=[],responseHeaders=new Headers();
 const res=new Writable({write(chunk,encoding,done){chunks.push(Buffer.from(chunk));done()}});
 res.statusCode=200;res.headersSent=false;
 res.setHeader=(name,value)=>{responseHeaders.set(name,Array.isArray(value)?value.join(', '):String(value));return res};
 res.getHeader=name=>responseHeaders.get(name);
 res.writeHead=(status,values={})=>{res.statusCode=status;for(const [name,value] of Object.entries(values))res.setHeader(name,value);res.headersSent=true;return res};
 const finished=new Promise((resolve,reject)=>{res.once('finish',resolve);res.once('error',reject);res.once('close',()=>{if(!res.writableFinished)reject(new Error('Synthetic response closed before completion'))})});
 app.emit('request',req,res);await finished;
 return new Response(Buffer.concat(chunks),{status:res.statusCode,headers:responseHeaders});
}
