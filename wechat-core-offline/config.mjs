import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
export function stateDirectory(env=process.env){const root=env.BRIDGE_STATE_DIR;if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('BRIDGE_STATE_DIR must be an absolute private directory');return path.resolve(root);}
export function ownerEmail(env=process.env){const owner=env.BRIDGE_OWNER_EMAIL;if(typeof owner!=='string'||!/^\S+@\S+\.\S+$/.test(owner)||owner.length>254)throw new Error('BRIDGE_OWNER_EMAIL is required');return owner;}
export function serverConfig(env=process.env){const owner=ownerEmail(env),stateDir=stateDirectory(env),audience=env.BRIDGE_ACCESS_AUDIENCE,publicHost=env.BRIDGE_PUBLIC_HOST;let issuer;try{issuer=new URL(env.BRIDGE_ACCESS_ISSUER)}catch{throw new Error('BRIDGE_ACCESS_ISSUER must be an HTTPS origin')}if(issuer.protocol!=='https:'||issuer.username||issuer.password||issuer.pathname!=='/'||issuer.search||issuer.hash)throw new Error('BRIDGE_ACCESS_ISSUER must be an HTTPS origin');if(typeof audience!=='string'||!audience||audience.length>256)throw new Error('BRIDGE_ACCESS_AUDIENCE is required');if(typeof publicHost!=='string'||!/^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(publicHost))throw new Error('BRIDGE_PUBLIC_HOST must be a DNS hostname');const port=Number(env.BRIDGE_PORT||4181);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('BRIDGE_PORT is invalid');return {owner,stateDir,audience,publicHost,issuer:issuer.origin,port};}

// 模块加载时只计算路径，主入口仍严格检查显式配置。
export function privatePath(name, env=process.env) {
  const root=env.BRIDGE_STATE_DIR || path.join(homedir(), '.local/state/wechat-mcp');
  return path.join(root,name);
}
export function largeMediaPaths(env=process.env) {
  const runtime=env.XDG_RUNTIME_DIR || path.join(tmpdir(),'wechat-mcp-'+(process.getuid?.() ?? 'user'));
  return {
    root:env.BRIDGE_LARGE_MEDIA_ROOT || privatePath('large-media',env),
    receiverSocket:env.BRIDGE_LARGE_MEDIA_SOCKET || path.join(runtime,'wechat-large-media/control.sock'),
    controlSocket:env.BRIDGE_LARGE_MEDIA_BRIDGE_SOCKET || path.join(runtime,'wechat-large-media-bridge/control.sock')
  };
}
